// Macro for `ifc-lite run`. Tags every entity with a Pset "CESIUM" /
// property "Stage" = 1, then prints the modified IFC (STEP text) to stdout.
//
// Usage:
//   ifc-lite run scripts/tag-cesium-stage.js model.ifc > model_stage1.ifc
//
// Notes:
// - Restricted to `IfcElement` — an abstract IFC supertype, so the query
//   matches every concrete physical subtype (IfcWall, IfcDoor, IfcSlab, ...)
//   without also tagging non-physical entities (IfcOwnerHistory, IfcSIUnit,
//   property definitions, etc.).
// - No filesystem access inside the script sandbox (`ifc-lite run` executes
//   it via `new Function`, no `require`/`fs`) — that's why this prints to
//   stdout instead of writing the file itself; redirect it from the shell.

const all = bim.query().byType('IfcElement').toArray();
console.error(`Tagging ${all.length} elements with CESIUM.Stage = 1 ...`);

for (const entity of all) {
  bim.mutate.setProperty(entity.ref, 'CESIUM', 'Stage', 1);
}

const stepText = bim.export.ifc(null, { includeMutations: true });
console.log(stepText);
