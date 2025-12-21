import assert from "node:assert/strict";
import { DOMParser } from "xmldom";
import {
  buildRouteProfile,
  matchPositionToRoute,
} from "../src/route.js";

global.DOMParser = DOMParser;

function buildSimpleRoute() {
  const segments = [
    [
      [0, 0],
      [0, 0.001],
      [0, 0.002],
    ],
  ];
  buildRouteProfile(segments);
  return segments;
}

// Test 1: Cache hit on repeated identical inputs
buildSimpleRoute();
const point1 = { lat: 0.0001, lng: 0.0005 };
const result1 = matchPositionToRoute(point1);
const result2 = matchPositionToRoute(point1);
// Results should be identical (same object reference if cached)
assert.deepEqual(result1, result2);
assert.strictEqual(result1, result2, "Cache should return same object reference");

// Test 2: Cache miss on different inputs
const point2 = { lat: 0.0002, lng: 0.0005 };
const result3 = matchPositionToRoute(point2);
assert.notStrictEqual(result1, result3, "Different input should produce different cache entry");

// Test 3: Cache distinguishes between different hint values
const point3 = { lat: 0.0001, lng: 0.001 };
const resultNoHint = matchPositionToRoute(point3);
const resultWithHint = matchPositionToRoute(point3, { hintDistanceAlong: 100 });
assert.notStrictEqual(resultNoHint, resultWithHint, "Different hints should produce different cache entries");

// Test 4: Cache distinguishes between different heading values
const point4 = { lat: 0, lng: 0.0005 };
const resultNoHeading = matchPositionToRoute(point4);
const resultWithHeading = matchPositionToRoute(point4, { headingDeg: 90 });
assert.notStrictEqual(resultNoHeading, resultWithHeading, "Different headings should produce different cache entries");

// Test 5: Cache is cleared when route is rebuilt
const cachedResult = matchPositionToRoute(point1);
buildSimpleRoute(); // Rebuild the same route
const newResult = matchPositionToRoute(point1);
// Results should be deeply equal but different object references (cache was cleared)
assert.deepEqual(cachedResult, newResult, "Results should be equivalent after rebuild");
assert.notStrictEqual(cachedResult, newResult, "Cache should be cleared on route rebuild");

// Test 6: Cache handles null/undefined coordinates gracefully
const invalidPoint = { lat: undefined, lng: 0.001 };
const resultInvalid = matchPositionToRoute(invalidPoint);
// Should return null for routePoints.length check or handle NaN gracefully
assert.ok(resultInvalid === null || typeof resultInvalid === "object");

// Test 7: Verify cache works with exact float values (no quantization)
const point5a = { lat: 0.00010000000001, lng: 0.0005 };
const point5b = { lat: 0.00010000000002, lng: 0.0005 };
const result5a = matchPositionToRoute(point5a);
const result5b = matchPositionToRoute(point5b);
// Should be different cache entries due to exact matching (no quantization)
assert.notStrictEqual(result5a, result5b, "Slightly different coordinates should produce different cache entries");

// Test 8: Cache hit with exact same inputs including options
const point6 = { lat: 0.0001, lng: 0.001 };
const opts = { hintDistanceAlong: 50, headingDeg: 45 };
const resultWithOpts1 = matchPositionToRoute(point6, opts);
const resultWithOpts2 = matchPositionToRoute(point6, opts);
assert.strictEqual(resultWithOpts1, resultWithOpts2, "Same point with same options should hit cache");

console.log("route cache tests passed");
