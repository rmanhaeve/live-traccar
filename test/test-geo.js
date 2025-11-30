import assert from "node:assert/strict";
import { distanceMeters, toRad } from "../src/geo.js";

function approxEqual(a, b, tolerance = 1e-6) {
  assert.ok(Math.abs(a - b) <= tolerance, `${a} ≉ ${b} (tol ${tolerance})`);
}

// toRad should map degrees to radians accurately
approxEqual(toRad(0), 0);
approxEqual(toRad(180), Math.PI, 1e-12);

// distanceMeters should be symmetric and zero for identical points
approxEqual(distanceMeters([0, 0], [0, 0]), 0);
approxEqual(distanceMeters([1, 1], [1, 1]), 0);

// Rough check: 1 degree of lat/lon at equator is about 111.2 km
const distLat = distanceMeters([0, 0], [1, 0]);
const distLon = distanceMeters([0, 0], [0, 1]);
assert.ok(Math.abs(distLat - 111200) < 500);
assert.ok(Math.abs(distLon - 111200) < 500);

console.log("geo tests passed");
