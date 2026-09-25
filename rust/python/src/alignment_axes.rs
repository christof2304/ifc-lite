// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `IfcAlignment` axes sampled with their stations.
//!
//! Same directrix lookup and evaluator as the wasm `parseAlignmentLines`
//! (`locate_axis_curve` + `AlignmentCurve`), but in the frame of
//! [`crate::geometry_data_buffers`] (IFC Z-up, absolute-world metres) and with
//! the distance along the horizontal alignment for every sample, so a consumer
//! can place a section plane or a marker at a given station.

use ifc_lite_core::{
    build_entity_index, extract_length_unit_scale, keyword_eq, EntityDecoder, EntityScanner,
};
use ifc_lite_geometry::{locate_axis_curve, AlignmentCurve, GeometryRouter};
use pyo3::prelude::*;
use pyo3::types::{PyBytes, PyDict, PyList};

/// Sample spacing along the horizontal alignment, in metres.
const SAMPLE_STEP_M: f64 = 1.0;
/// Cap per alignment; longer ones fall back to a length-proportional step.
const MAX_SAMPLES: usize = 20_000;

const IDENTITY: [f64; 16] = [
    1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
];

struct Axis {
    express_id: u32,
    /// Distance along the horizontal alignment from its start, metres.
    stations: Vec<f64>,
    /// Sample positions, IFC Z-up absolute-world metres.
    points: Vec<[f64; 3]>,
    /// Unit tangents at the samples, same frame.
    tangents: Vec<[f64; 3]>,
}

fn sample_axes(content: &str) -> Vec<Axis> {
    let mut decoder = EntityDecoder::with_index(content, build_entity_index(content));

    let mut project_scanner = EntityScanner::new(content);
    let mut unit_scale = 1.0_f64;
    while let Some((id, type_name, _, _)) = project_scanner.next_entity() {
        if keyword_eq(type_name, "IFCPROJECT") {
            if let Ok(s) = extract_length_unit_scale(&mut decoder, id) {
                unit_scale = s;
            }
            break;
        }
    }
    let router = GeometryRouter::with_scale(unit_scale);

    let mut axes = Vec::new();
    let mut scanner = EntityScanner::new(content);
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if !keyword_eq(type_name, "IFCALIGNMENT") {
            continue;
        }
        let Ok(entity) = decoder.decode_at_with_id(id, start, end) else {
            continue;
        };
        let Some(directrix) = locate_axis_curve(&entity, &mut decoder) else {
            continue;
        };
        let Ok(Some(alignment)) = AlignmentCurve::parse(&directrix, &mut decoder) else {
            continue;
        };
        // Curve coordinates are relative to the alignment's ObjectPlacement
        // (metres, column-major); identity when it has none.
        let placement = router
            .resolve_scaled_placement(&entity, &mut decoder)
            .unwrap_or(IDENTITY);
        if let Some(axis) = sample(id, &alignment, unit_scale, &placement) {
            axes.push(axis);
        }
    }
    axes
}

fn sample(
    express_id: u32,
    alignment: &AlignmentCurve,
    unit_scale: f64,
    m: &[f64; 16],
) -> Option<Axis> {
    let length = alignment.horizontal_length();
    if !(length.is_finite() && length > 0.0 && unit_scale > 0.0) {
        return None;
    }
    let step_file = SAMPLE_STEP_M / unit_scale;
    let raw_count = ((length / step_file).ceil() as usize).max(1);
    let (step, count) = if raw_count > MAX_SAMPLES {
        (length / MAX_SAMPLES as f64, MAX_SAMPLES + 1)
    } else {
        (step_file, raw_count + 1)
    };

    let mut axis = Axis {
        express_id,
        stations: Vec::with_capacity(count),
        points: Vec::with_capacity(count),
        tangents: Vec::with_capacity(count),
    };
    for i in 0..count {
        let station = (i as f64 * step).min(length);
        let frame = alignment.evaluate(station);
        let (o, t) = (frame.origin, frame.tangent);
        let (lx, ly, lz) = (o.x * unit_scale, o.y * unit_scale, o.z * unit_scale);
        axis.points.push([
            m[0] * lx + m[4] * ly + m[8] * lz + m[12],
            m[1] * lx + m[5] * ly + m[9] * lz + m[13],
            m[2] * lx + m[6] * ly + m[10] * lz + m[14],
        ]);
        let d = [
            m[0] * t.x + m[4] * t.y + m[8] * t.z,
            m[1] * t.x + m[5] * t.y + m[9] * t.z,
            m[2] * t.x + m[6] * t.y + m[10] * t.z,
        ];
        let n = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
        axis.tangents.push(if n > 1e-12 {
            [d[0] / n, d[1] / n, d[2] / n]
        } else {
            [1.0, 0.0, 0.0]
        });
        axis.stations.push(station * unit_scale);
    }
    Some(axis)
}

fn le_bytes(values: impl IntoIterator<Item = f64>) -> Vec<u8> {
    values.into_iter().flat_map(f64::to_le_bytes).collect()
}

/// Sample every `IfcAlignment` axis of an IFC file.
///
/// Returns a list of dicts, one per alignment with a resolvable directrix:
/// `{ express_id, stations: bytes, points: bytes, tangents: bytes }`, where
/// the byte buffers are little-endian f64 for `numpy.frombuffer`: `stations`
/// (n,) in metres along the horizontal alignment from its start, `points` and
/// `tangents` (n, 3) in the frame of `geometry_data_buffers` (IFC Z-up,
/// absolute-world metres; tangents are unit vectors). Samples are about 1 m
/// apart and always include both ends. Alignments without a directrix the
/// kernel can evaluate are left out, so the list may be empty.
#[pyfunction]
pub(crate) fn alignment_axes(py: Python<'_>, ifc_bytes: Vec<u8>) -> PyResult<Py<PyAny>> {
    let axes = py.detach(|| {
        let content = String::from_utf8_lossy(&ifc_bytes);
        sample_axes(&content)
    });
    let out = PyList::empty(py);
    for axis in axes {
        let d = PyDict::new(py);
        d.set_item("express_id", axis.express_id)?;
        d.set_item("stations", PyBytes::new(py, &le_bytes(axis.stations)))?;
        d.set_item(
            "points",
            PyBytes::new(py, &le_bytes(axis.points.into_iter().flatten())),
        )?;
        d.set_item(
            "tangents",
            PyBytes::new(py, &le_bytes(axis.tangents.into_iter().flatten())),
        )?;
        out.append(d)?;
    }
    Ok(out.into_any().unbind())
}
