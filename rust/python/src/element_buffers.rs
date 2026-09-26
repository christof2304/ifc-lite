// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! One element of [`crate::geometry_data_buffers`] as a Python dict.

use ifc_lite_processing::ExportedElement;
use pyo3::prelude::*;
use pyo3::types::{PyBytes, PyDict};

pub(crate) fn element_dict<'py>(
    py: Python<'py>,
    el: &ExportedElement,
) -> PyResult<Bound<'py, PyDict>> {
    let d = PyDict::new(py);
    d.set_item("ifc_type", &el.ifc_type)?;
    // Mirror the JSON path so both exports carry the same identity fields;
    // `None` maps to Python `None` (key always present).
    d.set_item("global_id", el.global_id.clone())?;
    d.set_item("name", el.name.clone())?;
    d.set_item("color", el.color.to_vec())?;
    // Reinterpret the contiguous `[f64;3]` / `[u32;3]` vecs as little-endian
    // bytes (zero-copy; PyBytes copies into Python). Targets are all LE.
    let vbytes: &[u8] = unsafe {
        std::slice::from_raw_parts(
            el.vertices.as_ptr() as *const u8,
            std::mem::size_of_val(el.vertices.as_slice()),
        )
    };
    let fbytes: &[u8] = unsafe {
        std::slice::from_raw_parts(
            el.faces.as_ptr() as *const u8,
            std::mem::size_of_val(el.faces.as_slice()),
        )
    };
    d.set_item("vertices", PyBytes::new(py, vbytes))?;
    d.set_item("faces", PyBytes::new(py, fbytes))?;
    // Multi-colour elements only: palette of RGBA and a u16 palette index
    // per face (little-endian bytes), so consumers keep per-material colours.
    if !el.palette.is_empty() {
        let palette: Vec<Vec<f32>> = el.palette.iter().map(|c| c.to_vec()).collect();
        d.set_item("palette", palette)?;
        let cbytes: Vec<u8> = el.face_colors.iter().flat_map(|c| c.to_le_bytes()).collect();
        d.set_item("face_colors", PyBytes::new(py, &cbytes))?;
    }
    Ok(d)
}
