// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! IfcAlignment centerline extraction for the 3D viewport.
//!
//! IFC4x1 `IfcAlignment` carries its geometry in the `Axis` curve (an
//! `IfcAlignmentCurve` or an `IfcPolyline`); IFC4x3 moved it into the
//! `Representation` (`'Axis'` → `IfcGradientCurve` /
//! `IfcSegmentedReferenceCurve`, `'FootPrint'` → 2D `IfcCompositeCurve`),
//! positioned by the alignment's `ObjectPlacement`. Rather
//! than render it as a triangulated ribbon mesh — which reads as a thin solid
//! strip and not the thin LINE users expect (matching IfcGrid axes and
//! IfcAnnotation curves) — we sample the alignment directrix into a flat
//! line-list vertex buffer and feed it through the renderer's existing
//! `setLineOverlay('alignment', …)` line pipeline.
//!
//! The output is `[x0,y0,z0, x1,y1,z1, …]` line-list pairs in renderer
//! **Y-up, metres** space. The explicit-frame binding uses the exact mesh
//! pre-pass RTC decision before the IFC Z-up → WebGL Y-up swap, so its lines
//! share the mesh frame. The legacy standalone binding detects RTC from the
//! whole source and can differ from an earlier streaming sample or federation
//! override.

use super::IfcAPI;
use ifc_lite_core::{
    build_entity_index, extract_length_unit_scale, EntityDecoder, EntityScanner, IfcType,
};
use ifc_lite_geometry::{AlignmentCurve, GeometryRouter};
use ifc_lite_processing::MeshFrame;
use wasm_bindgen::prelude::*;

/// Station spacing for centerline sampling, in file length units. Mirrors the
/// (now-removed) ribbon processor: 1 unit ≈ 1 m for metre files, with a hard
/// sample cap so sub-metre-unit files on long alignments fall back to a
/// coarser, length-proportional step instead of emitting millions of points.
const SAMPLE_STEP_FILE_UNITS: f64 = 1.0;
const MAX_SAMPLES: usize = 5_000;

#[wasm_bindgen]
impl IfcAPI {
    /// Parse the file and return every `IfcAlignment` directrix as a flat
    /// `Float32Array` of 3D line-list vertices `[x0,y0,z0, x1,y1,z1, …]` in
    /// the renderer's Y-up world space (RTC-subtracted, metres). Consecutive
    /// samples form line segments. Feed straight to
    /// `renderer.setLineOverlay('alignment', ...)`.
    ///
    /// Returns an empty array when the file has no alignments (or none with a
    /// resolvable Axis curve), so the caller can clear the overlay cheaply.
    #[wasm_bindgen(js_name = parseAlignmentLines)]
    pub fn parse_alignment_lines(&self, content: String) -> js_sys::Float32Array {
        let verts = extract_alignment_line_vertices(&content, None);
        js_sys::Float32Array::from(&verts[..])
    }

    /// Parse alignments in the exact RTC frame selected by the mesh pre-pass.
    #[wasm_bindgen(js_name = parseAlignmentLinesInFrame)]
    pub fn parse_alignment_lines_in_frame(
        &self,
        content: String,
        #[wasm_bindgen(unchecked_param_type = "RtcFrame")] frame: JsValue,
    ) -> Result<js_sys::Float32Array, JsValue> {
        let frame = super::overlay_frame::parse_overlay_frame(&frame)?;
        let verts = extract_alignment_line_vertices(&content, Some(frame));
        Ok(js_sys::Float32Array::from(&verts[..]))
    }
}

/// Pure-Rust core (unit-testable without wasm-bindgen).
pub(crate) fn extract_alignment_line_vertices(
    content: &str,
    frame: Option<MeshFrame>,
) -> Vec<f32> {
    let entity_index = build_entity_index(content);
    let mut decoder = EntityDecoder::with_index(content, entity_index);

    // Unit scale (file units → metres) resolved the same way the mesh
    // pipeline does, so the alignment shares the model's scale.
    let mut project_scanner = EntityScanner::new(content);
    let mut unit_scale = 1.0_f64;
    while let Some((id, type_name, _, _)) = project_scanner.next_entity() {
        if ifc_lite_core::keyword_eq(type_name, "IFCPROJECT") {
            if let Ok(s) = extract_length_unit_scale(&mut decoder, id) {
                unit_scale = s;
            }
            break;
        }
    }

    // RTC offset (metres): exact when supplied by the browser mesh pre-pass;
    // otherwise the standalone whole-source choice (#4665, #4799).
    // Not drained: meshes nothing. Pinned by rust/geometry/tests/issue_3821_auxiliary_routers_mesh_nothing.rs.
    let router = GeometryRouter::with_scale(unit_scale);
    let rtc = frame
        .unwrap_or_else(|| MeshFrame::for_overlay(&router, content.as_bytes(), &mut decoder))
        .rtc_offset();

    let mut out: Vec<f32> = Vec::new();
    let mut scanner = EntityScanner::new(content);
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if !ifc_lite_core::keyword_eq(type_name, "IFCALIGNMENT") {
            continue;
        }
        let Ok(entity) = decoder.decode_at_with_id(id, start, end) else {
            continue;
        };
        let Some(axis) = locate_axis_curve(&entity, &mut decoder) else {
            continue;
        };
        let Ok(Some(alignment)) = AlignmentCurve::parse(&axis, &mut decoder) else {
            continue;
        };
        // Curve coordinates are relative to the alignment's ObjectPlacement
        // (metres, column-major); identity when it has none.
        let placement = router
            .resolve_scaled_placement(&entity, &mut decoder)
            .unwrap_or(IDENTITY);
        append_alignment_segments(&alignment, unit_scale, &placement, rtc, &mut out);
    }
    out
}

/// Sample one alignment's centerline and append its line-list segments to
/// `out`, in renderer Y-up / RTC-subtracted / metres space.
const IDENTITY: [f64; 16] = [
    1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
];

fn append_alignment_segments(
    alignment: &AlignmentCurve,
    unit_scale: f64,
    placement: &[f64; 16],
    rtc: (f64, f64, f64),
    out: &mut Vec<f32>,
) {
    let length = alignment.horizontal_length();
    if !(length.is_finite() && length > 0.0) {
        return;
    }

    let raw_count = ((length / SAMPLE_STEP_FILE_UNITS).ceil() as usize).max(1);
    let (step, count) = if raw_count > MAX_SAMPLES {
        (length / MAX_SAMPLES as f64, MAX_SAMPLES + 1)
    } else {
        (SAMPLE_STEP_FILE_UNITS, raw_count + 1)
    };

    // Collect sampled vertices in renderer space.
    let mut pts: Vec<[f32; 3]> = Vec::with_capacity(count);
    for i in 0..count {
        let station = (i as f64 * step).min(length);
        let o = alignment.evaluate(station).origin;
        // file units → metres, then the (already metre-scaled) placement.
        let (lx, ly, lz) = (o.x * unit_scale, o.y * unit_scale, o.z * unit_scale);
        let m = placement;
        let mx = m[0] * lx + m[4] * ly + m[8] * lz + m[12] - rtc.0;
        let my = m[1] * lx + m[5] * ly + m[9] * lz + m[13] - rtc.1;
        let mz = m[2] * lx + m[6] * ly + m[10] * lz + m[14] - rtc.2;
        // IFC Z-up → WebGL Y-up: (x, z, -y). Matches MeshDataJs::new so the
        // line lands on the same ground as the terrain meshes.
        pts.push([mx as f32, mz as f32, -my as f32]);
    }

    // Emit as a line-list: each adjacent pair is one segment.
    for w in pts.windows(2) {
        out.extend_from_slice(&w[0]);
        out.extend_from_slice(&w[1]);
    }
}

/// Resolve an `IfcAlignment`'s directrix curve.
///
/// IFC4x3: `Representation` (attr 6) → the `'Axis'` shape representation's
/// curve (`IfcGradientCurve`; an `IfcSegmentedReferenceCurve` contributes
/// its gradient `BaseCurve`), else the `'FootPrint'` 2D curve.
///
/// IFC4x1: `Axis` at attribute 7; some publishers reuse `Representation`
/// (6) or hang it at 8. Accept the first ref that resolves to an
/// `IfcAlignmentCurve` or `IfcPolyline`.
fn locate_axis_curve(
    entity: &ifc_lite_core::DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Option<ifc_lite_core::DecodedEntity> {
    if let Some(curve) = representation_axis_curve(entity, decoder) {
        return Some(curve);
    }
    let alignment_curve = IfcType::from_str("IFCALIGNMENTCURVE");
    for idx in [7usize, 8, 6] {
        let Some(attr) = entity.get(idx) else { continue };
        if attr.is_null() {
            continue;
        }
        if let Ok(Some(resolved)) = decoder.resolve_ref(attr) {
            if resolved.ifc_type == alignment_curve || resolved.ifc_type == IfcType::IfcPolyline {
                return Some(resolved);
            }
        }
    }
    None
}

/// IFC4x3 path of [`locate_axis_curve`]: prefer the `'Axis'` representation
/// (3D, carries the vertical profile) over `'FootPrint'` (plan only).
fn representation_axis_curve(
    entity: &ifc_lite_core::DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Option<ifc_lite_core::DecodedEntity> {
    let shape = decoder.decode_by_id(entity.get_ref(6)?).ok()?;
    if shape.ifc_type != IfcType::IfcProductDefinitionShape {
        return None;
    }
    let mut footprint = None;
    for rep_id in shape.get_refs(2)? {
        let Ok(rep) = decoder.decode_by_id(rep_id) else { continue };
        let identifier = rep.get(1).and_then(|v| v.as_string()).unwrap_or("").to_ascii_uppercase();
        for item_id in rep.get_refs(3).unwrap_or_default() {
            let Ok(item) = decoder.decode_by_id(item_id) else { continue };
            let curve = if item.ifc_type == IfcType::IfcSegmentedReferenceCurve {
                // IfcSegmentedReferenceCurve: 0 Segments, 1 SelfIntersect, 2 BaseCurve
                match item.get_ref(2).and_then(|id| decoder.decode_by_id(id).ok()) {
                    Some(base) => base,
                    None => continue,
                }
            } else {
                item
            };
            let usable = matches!(
                curve.ifc_type,
                IfcType::IfcGradientCurve | IfcType::IfcPolyline | IfcType::IfcCompositeCurve
            );
            if !usable {
                continue;
            }
            if identifier == "AXIS" {
                return Some(curve);
            }
            if identifier == "FOOTPRINT" && footprint.is_none() {
                footprint = Some(curve);
            }
        }
    }
    footprint
}

#[cfg(test)]
mod tests {
    use super::*;

    // Minimal IFC4X1 alignment: IfcAlignment whose Axis (attr 7) is a
    // 3-point IfcPolyline directrix (0,0,0)->(10,0,0)->(10,10,0), metres.
    const CONTENT: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('','',(''),(''),'','','');
FILE_SCHEMA(('IFC4X1'));
ENDSEC;
DATA;
#1=IFCCARTESIANPOINT((0.,0.,0.));
#2=IFCCARTESIANPOINT((10.,0.,0.));
#3=IFCCARTESIANPOINT((10.,10.,0.));
#4=IFCPOLYLINE((#1,#2,#3));
#10=IFCALIGNMENT('0aBcDeFgHiJkLmNoPqRsT0',$,'Test Alignment',$,$,$,$,#4,$);
ENDSEC;
END-ISO-10303-21;
"#;

    #[test]
    fn emits_line_list_for_polyline_alignment() {
        let verts = extract_alignment_line_vertices(CONTENT, None);
        assert!(!verts.is_empty(), "alignment must emit centerline vertices");
        // Flat [x,y,z] triples, even count of vertices (line-list pairs).
        assert_eq!(verts.len() % 3, 0, "vertices must be xyz triples");
        assert_eq!((verts.len() / 3) % 2, 0, "line-list = even vertex count");

        // First sample is the directrix start (0,0,0) → renderer (0,0,-0).
        assert!(verts[0].abs() < 1e-4, "start x≈0, got {}", verts[0]);
        assert!(verts[1].abs() < 1e-4, "start y(elev)≈0, got {}", verts[1]);
        assert!(verts[2].abs() < 1e-4, "start z≈0, got {}", verts[2]);

        // The 20 m polyline lies in the plan (z_ifc = 0) so every renderer-Y
        // (elevation) must stay 0, and the path must span ~10 m in renderer X
        // and ~10 m in renderer Z (plan Y, negated).
        let mut max_x = f32::MIN;
        let mut max_abs_z = 0.0_f32;
        for v in verts.chunks_exact(3) {
            assert!(v[1].abs() < 1e-3, "planar alignment elevation must be ~0");
            max_x = max_x.max(v[0]);
            max_abs_z = max_abs_z.max(v[2].abs());
        }
        assert!((max_x - 10.0).abs() < 0.5, "max renderer-x ≈10, got {max_x}");
        assert!((max_abs_z - 10.0).abs() < 0.5, "max |renderer-z| ≈10, got {max_abs_z}");
    }

    // IFC4x3: the directrix lives in Representation 'Axis' as an
    // IfcGradientCurve (quarter arc R = 100 on a +1 % grade from 50 m) and
    // the alignment is placed at (1000, 0, 0).
    const CONTENT_4X3: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('','',(''),(''),'','','');
FILE_SCHEMA(('IFC4X3_ADD2'));
ENDSEC;
DATA;
#20=IFCCARTESIANPOINT((0.,0.));
#21=IFCDIRECTION((1.,0.));
#22=IFCAXIS2PLACEMENT2D(#20,#21);
#23=IFCVECTOR(#21,1.);
#24=IFCLINE(#20,#23);
#25=IFCCIRCLE(#22,100.);
#26=IFCCURVESEGMENT(.CONTINUOUS.,#22,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(157.0796326795),#25);
#27=IFCCARTESIANPOINT((100.,100.));
#28=IFCDIRECTION((0.,1.));
#29=IFCAXIS2PLACEMENT2D(#27,#28);
#30=IFCCURVESEGMENT(.DISCONTINUOUS.,#29,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(0.),#24);
#31=IFCCOMPOSITECURVE((#26,#30),.F.);
#32=IFCCARTESIANPOINT((0.,50.));
#33=IFCDIRECTION((1.,0.01));
#34=IFCAXIS2PLACEMENT2D(#32,#33);
#35=IFCCURVESEGMENT(.CONTINUOUS.,#34,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(157.08),#24);
#36=IFCCARTESIANPOINT((157.0796326795,51.570796326795));
#37=IFCAXIS2PLACEMENT2D(#36,#33);
#38=IFCCURVESEGMENT(.DISCONTINUOUS.,#37,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(0.),#24);
#39=IFCGRADIENTCURVE((#35,#38),.F.,#31,$);
#40=IFCSHAPEREPRESENTATION($,'Axis','Curve3D',(#39));
#41=IFCSHAPEREPRESENTATION($,'FootPrint','Curve2D',(#31));
#42=IFCPRODUCTDEFINITIONSHAPE($,$,(#41,#40));
#43=IFCCARTESIANPOINT((1000.,0.,0.));
#44=IFCAXIS2PLACEMENT3D(#43,$,$);
#45=IFCLOCALPLACEMENT($,#44);
#46=IFCALIGNMENT('1aBcDeFgHiJkLmNoPqRsT0',$,'Road',$,$,#45,#42,$);
ENDSEC;
END-ISO-10303-21;
"#;

    #[test]
    fn ifc4x3_axis_representation_follows_arc_grade_and_placement() {
        let verts = extract_alignment_line_vertices(
            CONTENT_4X3,
            Some(MeshFrame::ModelRtc { anchor: (0.0, 0.0, 0.0) }),
        );
        assert!(!verts.is_empty(), "IFC4x3 alignment must emit a centerline");
        let (mut min_x, mut max_x, mut min_e, mut max_e) = (f32::MAX, f32::MIN, f32::MAX, f32::MIN);
        for v in verts.chunks_exact(3) {
            min_x = min_x.min(v[0]);
            max_x = max_x.max(v[0]);
            min_e = min_e.min(v[1]);
            max_e = max_e.max(v[1]);
        }
        // Placement shifts x by 1000; the arc spans 100 m in x.
        assert!((min_x - 1000.0).abs() < 0.1, "min x {min_x}");
        assert!((max_x - 1100.0).abs() < 0.1, "max x {max_x}");
        // Elevation (renderer Y) comes from the gradient: 50 → 51.57 m.
        assert!((min_e - 50.0).abs() < 0.01, "start elevation {min_e}");
        assert!((max_e - 51.5708).abs() < 0.01, "end elevation {max_e}");
    }

    #[test]
    fn explicit_model_rtc_overrides_standalone_alignment_detection() {
        let verts = extract_alignment_line_vertices(
            CONTENT,
            Some(MeshFrame::ModelRtc {
                anchor: (5.0, 0.0, 0.0),
            }),
        );
        assert!((verts[0] + 5.0).abs() < 1e-4);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Render-frame conversion
    // ═══════════════════════════════════════════════════════════════════════
    //
    // `CONTENT` above is a metre file (unit_scale exactly 1) with no
    // IfcProject at all, sits at the origin (RTC exactly 0), and its
    // assertions take `.abs()` of the renderer Z. Between them, three
    // independent halves of `append_alignment_segments` are unobservable:
    // dropping the `unit_scale` multiply, adding the RTC offset instead of
    // subtracting it, and dropping the negation on the renderer Z all pass
    // that test unchanged. These two pin each one on its own.

    /// Millimetre file (`IfcSIUnit` with the `.MILLI.` prefix): every file
    /// coordinate is 1000x its metre value, so a dropped `unit_scale` puts the
    /// centerline kilometres away. The directrix runs to `(10000, 4000)` mm =
    /// `(10, 4)` m, whose renderer Z is `-4` — SIGNED, so the negation cannot
    /// hide behind an absolute value either.
    const MILLIMETRE_ALIGNMENT: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('','',(''),(''),'','','');
FILE_SCHEMA(('IFC4X1'));
ENDSEC;
DATA;
#6=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#7=IFCUNITASSIGNMENT((#6));
#8=IFCPROJECT('0PrOjEcTpRoJeCtPrOjEc',$,'P',$,$,$,$,$,#7);
#1=IFCCARTESIANPOINT((0.,0.,0.));
#2=IFCCARTESIANPOINT((10000.,4000.,0.));
#4=IFCPOLYLINE((#1,#2));
#10=IFCALIGNMENT('0aBcDeFgHiJkLmNoPqRsT0',$,'Test Alignment',$,$,$,$,#4,$);
ENDSEC;
END-ISO-10303-21;
"#;

    #[test]
    fn millimetre_alignment_is_unit_scaled_and_yup_swapped() {
        let verts = extract_alignment_line_vertices(MILLIMETRE_ALIGNMENT, None);
        assert!(!verts.is_empty(), "alignment must emit centerline vertices");
        assert_eq!(verts.len() % 3, 0, "vertices must be xyz triples");

        let mut max_x = f32::MIN;
        let mut min_z = f32::MAX;
        let mut max_z = f32::MIN;
        for v in verts.chunks_exact(3) {
            assert!(v[1].abs() < 1e-2, "planar alignment elevation must be ~0, got {}", v[1]);
            max_x = max_x.max(v[0]);
            min_z = min_z.min(v[2]);
            max_z = max_z.max(v[2]);
        }
        // 10 000 mm -> 10 m. Unscaled it would read 10 000.
        assert!((max_x - 10.0).abs() < 0.05, "max renderer-x = 10 m, got {max_x}");
        // 4 000 mm -> 4 m, NEGATED on the way into the renderer frame: the
        // whole path lies at z <= 0, so a dropped negation flips the interval.
        assert!((min_z + 4.0).abs() < 0.05, "min renderer-z = -4 m, got {min_z}");
        assert!(max_z <= 1e-2, "renderer-z must never go positive, got {max_z}");
    }

    /// A georeferenced metre file: a wall out at survey coordinates trips RTC
    /// detection, and the alignment shares that frame. The offset is
    /// SUBTRACTED, so the centerline lands near the origin; adding it instead
    /// (or subtracting the wrong component) puts it ~2x the offset out, i.e.
    /// megametres away, which no near-origin bound can miss.
    #[test]
    fn georeferenced_alignment_is_rebased_near_the_origin() {
        let content = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('','',(''),(''),'','','');
FILE_SCHEMA(('IFC4X1'));
ENDSEC;
DATA;
#2=IFCDIRECTION((0.,0.,1.));
#3=IFCDIRECTION((1.,0.,0.));
/* a wall far out at survey coords so RTC detection trips (>10 km) */
#6=IFCCARTESIANPOINT((10400000.,2000000.,0.));
#7=IFCAXIS2PLACEMENT3D(#6,#2,#3);
#8=IFCLOCALPLACEMENT($,#7);
#9=IFCPRODUCTDEFINITIONSHAPE($,$,(#41));
#40=IFCCARTESIANPOINT((10400000.,2000000.,0.));
#41=IFCSHAPEREPRESENTATION($,'Body','Curve2D',(#42));
#42=IFCPOLYLINE((#40,#40));
#43=IFCWALL('1WaLLWaLLWaLLWaLLWaLL00',$,'W',$,$,#8,#9,$,$);
/* the alignment directrix in the same survey frame */
#50=IFCCARTESIANPOINT((10400000.,2000000.,0.));
#51=IFCCARTESIANPOINT((10400010.,2000004.,0.));
#52=IFCPOLYLINE((#50,#51));
#10=IFCALIGNMENT('0aBcDeFgHiJkLmNoPqRsT0',$,'A',$,$,$,$,#52,$);
ENDSEC;
END-ISO-10303-21;
"#;
        let verts = extract_alignment_line_vertices(content, None);
        assert!(!verts.is_empty(), "alignment must emit centerline vertices");
        for v in verts.chunks_exact(3) {
            for c in v {
                assert!(
                    c.abs() < 1000.0,
                    "render-frame coord must be near origin after RTC, got {c}"
                );
            }
        }


        let raw = extract_alignment_line_vertices(content, Some(MeshFrame::RawIfc));
        assert!(
            raw[0] > 1_000_000.0,
            "an explicit known-false frame must not fall back to standalone RTC detection",
        );
    }

    /// `locate_axis_curve` tries attributes 7, 8, then 6 — `Axis` first, with
    /// `Representation` (6) only as a last-resort fallback for publishers that
    /// reuse it. Every other fixture here leaves 6 null, so the ORDER of that
    /// list is unobservable: searching 6 first passes them all. Here both
    /// resolve to a polyline and only `Axis` gives the right geometry.
    #[test]
    fn axis_attribute_wins_over_the_representation_fallback() {
        let content = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('','',(''),(''),'','','');
FILE_SCHEMA(('IFC4X1'));
ENDSEC;
DATA;
/* Axis (attr 7): runs 10 m along +X. */
#1=IFCCARTESIANPOINT((0.,0.,0.));
#2=IFCCARTESIANPOINT((10.,0.,0.));
#4=IFCPOLYLINE((#1,#2));
/* Representation (attr 6): a decoy running 500 m along +X. */
#5=IFCCARTESIANPOINT((500.,0.,0.));
#6=IFCPOLYLINE((#1,#5));
#10=IFCALIGNMENT('0aBcDeFgHiJkLmNoPqRsT0',$,'A',$,$,$,#6,#4,$);
ENDSEC;
END-ISO-10303-21;
"#;
        let verts = extract_alignment_line_vertices(content, None);
        assert!(!verts.is_empty(), "alignment must emit centerline vertices");
        let max_x = verts
            .chunks_exact(3)
            .map(|v| v[0])
            .fold(f32::MIN, f32::max);
        assert!(
            (max_x - 10.0).abs() < 0.5,
            "the Axis curve (10 m) must win over the Representation decoy (500 m), got {max_x}"
        );
    }

    #[test]
    fn empty_for_no_alignment() {
        let none = "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n";
        assert!(extract_alignment_line_vertices(none, None).is_empty());
    }
}
