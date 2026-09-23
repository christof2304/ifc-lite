---
"@ifc-lite/wasm": patch
---

IFC4x3 alignment geometry: `IfcSectionedSolidHorizontal` now accepts `IfcAxis2PlacementLinear` cross-section positions (previously every such solid was dropped), `IfcLinearPlacement` and sectioned-solid directrices on an `IfcGradientCurve` follow its vertical profile instead of sitting at z = 0, and alignment `IfcCurveSegment`s (line / circle / clothoid) are sampled densely instead of as one chord per segment.

`parseAlignmentLines` also finds IFC4x3 alignments: the centerline is read from the `'Axis'` (else `'FootPrint'`) shape representation — `IfcGradientCurve`, `IfcSegmentedReferenceCurve` or `IfcCompositeCurve` — and the alignment's `ObjectPlacement` is applied. Previously only IFC4x1 `Axis` attributes were recognised, so no IFC4x3 alignment line was drawn.
