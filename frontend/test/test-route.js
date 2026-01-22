import assert from "node:assert/strict";
import { DOMParser } from "xmldom";
import {
  buildRouteProfile,
  getRouteDistances,
  getRoutePoints,
  getRouteTotal,
  mapWaypoints,
  matchPositionToRoute,
  parseGpx,
  pointAtDistance,
} from "../src/route.js";

global.DOMParser = DOMParser;

function approxEqual(a, b, tolerance = 1e-6) {
  assert.ok(Math.abs(a - b) <= tolerance, `${a} ≉ ${b} (tol ${tolerance})`);
}

function buildSimpleRoute() {
  const segments = [
    [
      [0, 0],
      [0, 0.001],
    ],
    [
      [0, 0.001],
      [0, 0.002],
    ],
  ];
  buildRouteProfile(segments);
  return segments;
}

// buildRouteProfile should reset internal state even for empty input
buildRouteProfile([]);
assert.equal(getRouteTotal(), 0);
assert.equal(getRouteDistances().length, 0);
assert.equal(getRoutePoints().length, 0);

// After building a simple route, distances and interpolation should work
buildSimpleRoute();
const distances = getRouteDistances();
assert.equal(distances.length, 4);
assert.equal(distances[0], 0);
assert.ok(distances[1] > 0);
assert.ok(distances[3] > distances[1]);

const total = getRouteTotal();
assert.ok(total > 0);

// pointAtDistance should return the start, mid and end correctly
const start = pointAtDistance(0);
approxEqual(start.lat, 0);
approxEqual(start.lng, 0);

const mid = pointAtDistance(total / 2);
approxEqual(mid.lat, 0);
approxEqual(mid.lng, 0.001, 1e-5);

const end = pointAtDistance(total);
approxEqual(end.lat, 0);
approxEqual(end.lng, 0.002, 1e-6);

// matchPositionToRoute should project nearby points and flag off-track ones
const nearStart = matchPositionToRoute({ lat: 0.0001, lng: 0 });
assert(nearStart);
assert.ok(nearStart.distanceAlong >= 0 && nearStart.distanceAlong < 50);
assert.equal(nearStart.offtrack, false);

const farAway = matchPositionToRoute({ lat: 1, lng: 1 });
assert(farAway);
assert.equal(farAway.offtrack, true);

// mapWaypoints should sort along the route and provide defaults
const waypoints = mapWaypoints([
  { lat: 0, lng: 0.0015, name: "Mid" },
  { lat: 0, lng: 0.0001, desc: "Near start" },
]);
assert.equal(waypoints[0].name, "Near start");
assert.equal(waypoints[1].name, "Mid");
assert.ok(waypoints[1].distanceAlong > waypoints[0].distanceAlong);

const fallbackWaypoints = mapWaypoints([]);
assert.equal(fallbackWaypoints.length, 2);
assert.equal(fallbackWaypoints[0].name, "Start");
assert.equal(fallbackWaypoints[1].name, "Finish");

// Hinted matching should disambiguate overlapping out-and-back sections
buildRouteProfile([
  [
    [0, 0],
    [0, 0.001],
    [0, 0.002],
    [0, 0.001],
    [0, 0],
  ],
]);
const overlapPoint = { lat: 0, lng: 0.001 };
const noHint = matchPositionToRoute(overlapPoint);
assert(noHint);
assert.ok(noHint.distanceAlong < 200);
const hinted = matchPositionToRoute(overlapPoint, { hintDistanceAlong: 330 });
assert(hinted);
assert.ok(hinted.distanceAlong > 250);
assert.equal(hinted.offtrack, false);

// parseGpx should extract segments and waypoints from GPX XML
const gpx = `
<gpx>
  <trk>
    <trkseg>
      <trkpt lat="0" lon="0" />
      <trkpt lat="0" lon="0.001" />
    </trkseg>
  </trk>
  <wpt lat="1" lon="2"><name>WP1</name><desc>Desc</desc></wpt>
</gpx>`;
const parsed = parseGpx(gpx);
assert.equal(parsed.segments.length, 1);
assert.equal(parsed.segments[0].length, 2);
assert.deepEqual(parsed.waypoints[0], { lat: 1, lng: 2, name: "WP1", desc: "Desc" });

console.log("route tests passed");
