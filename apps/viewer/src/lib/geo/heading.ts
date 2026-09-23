/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Compass heading (0-360°, clockwise from North) of a model's local X-axis,
 * derived from `IfcMapConversion`'s `XAxisAbscissa`/`XAxisOrdinate`.
 *
 * Deliberately NOT `resolveKmzHeading` (kmz-export.ts) or the Rust
 * `ifc_angle_to_kml_heading` it feeds: KML's `<heading>` is not a compass
 * bearing — Google Earth defines heading=0 as "local +X faces map east" and
 * rotates clockwise from there, i.e. `bearing = (90 + kmlHeading) mod 360`.
 * Reusing that value here would silently apply the wrong convention.
 *
 * `computeAngleToGridNorth` (`@ifc-lite/parser`) gives the counterclockwise
 * angle from map East to the model's local X-axis. Converting that to a
 * standard compass bearing (clockwise from North):
 *   East  (angle=0)  -> bearing 90
 *   North (angle=90) -> bearing 0
 *   South (angle=-90)-> bearing 180
 * i.e. `bearing = (90 - angle) mod 360`.
 */

import { computeAngleToGridNorth } from '@ifc-lite/parser';

/**
 * Best-effort compass heading in degrees, or `null` when the model carries
 * no rotation (bare `xAxisAbscissa`/`xAxisOrdinate`). Cesium Ion's own
 * heading convention for a BIM_CAD asset is not documented publicly as of
 * writing — verify this against a real upload before trusting it blindly.
 */
export function headingDegreesFromAxis(
  xAxisAbscissa: number | undefined,
  xAxisOrdinate: number | undefined,
): number | null {
  const angle = computeAngleToGridNorth(xAxisAbscissa, xAxisOrdinate);
  if (angle === null) return null;
  const bearing = (90 - angle) % 360;
  return bearing < 0 ? bearing + 360 : bearing;
}
