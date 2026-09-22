---
"@ifc-lite/mutations": patch
---

Fix `CsvConnector.matchRow()` (all three match strategies — GlobalId, Express ID, and Name) matching, counting, and mutating entities that were already deleted in the mutation view. The deleted entities' writes previously survived `restoreFromTombstone` (undo of the delete).
