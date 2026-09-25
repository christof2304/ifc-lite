// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The one answer to "which curve is this `IfcAlignment`'s directrix?",
//! shared by the alignment processor (`processors/alignment.rs`) and the
//! wasm centerline overlay (`wasm-bindings/src/api/alignment_lines.rs`).
//! Two private copies of this lookup used to exist and could silently
//! disagree about what an alignment's axis is (#5327).

use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};

/// Resolve an `IfcAlignment`'s directrix curve. IFC4X1 puts `Axis` at
/// attribute 7; some publishers reuse `Representation` (6) or hang it at 8.
/// Accept the first ref that resolves to an `IfcAlignmentCurve` or
/// `IfcPolyline` (the curves `AlignmentCurve::parse` understands). A ref that
/// fails to resolve is skipped, not fatal. `None` when no attribute yields one.
pub fn locate_axis_curve(entity: &DecodedEntity, decoder: &mut EntityDecoder) -> Option<DecodedEntity> {
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
