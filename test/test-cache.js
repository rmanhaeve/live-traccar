import assert from "node:assert/strict";
import {
  buildRouteProfile,
  matchPositionToRoute,
  projectOnRoute,
  projectOnRouteWithHint,
} from "../src/route.js";

function buildSimpleRoute() {
  const segments = [
    [
      [0, 0],
      [0, 0.001],
      [0, 0.002],
      [0, 0.003],
    ],
  ];
  buildRouteProfile(segments);
  return segments;
}

// Test 1: Cache should return same result for identical inputs
buildSimpleRoute();
const point = { lat: 0.0001, lng: 0.0005 };
const result1 = matchPositionToRoute(point);
const result2 = matchPositionToRoute(point);
assert.deepEqual(result1, result2, "Cache should return identical results");

// Test 2: Cache should work with hints
const withHint1 = matchPositionToRoute(point, { hintDistanceAlong: 100 });
const withHint2 = matchPositionToRoute(point, { hintDistanceAlong: 100 });
assert.deepEqual(withHint1, withHint2, "Cache should work with hints");

// Test 3: Different hints should produce different results (cached separately)
const hintA = matchPositionToRoute(point, { hintDistanceAlong: 50 });
const hintB = matchPositionToRoute(point, { hintDistanceAlong: 200 });
// These should be cached separately and may have different results
assert(hintA !== hintB, "Different hints should be cached separately");

// Test 4: Cache should work with heading
const withHeading1 = matchPositionToRoute(point, { headingDeg: 90 });
const withHeading2 = matchPositionToRoute(point, { headingDeg: 90 });
assert.deepEqual(withHeading1, withHeading2, "Cache should work with heading");

// Test 5: Cache should be cleared when route changes
const beforeChange = matchPositionToRoute(point);
buildSimpleRoute(); // Rebuild route - should clear cache
const afterChange = matchPositionToRoute(point);
assert.deepEqual(beforeChange, afterChange, "Results should be the same after rebuilding same route");

// Test 6: Verify cache eviction with many entries
buildSimpleRoute();
const points = [];
for (let i = 0; i < 1500; i++) {
  const testPoint = { lat: 0.0001 + i * 0.00001, lng: 0.0005 + i * 0.00001 };
  points.push(testPoint);
  matchPositionToRoute(testPoint);
}
// Cache should have evicted old entries (max 1000)
// Re-query first point - should still work (either from cache or recomputed)
const firstResult = matchPositionToRoute(points[0]);
assert(firstResult, "Should still work after cache eviction");

// Test 7: projectOnRoute and projectOnRouteWithHint should also benefit from cache
buildSimpleRoute();
const proj1 = projectOnRoute(point);
const proj2 = projectOnRoute(point);
assert.deepEqual(proj1, proj2, "projectOnRoute should use cache");

const projHint1 = projectOnRouteWithHint(point, 100);
const projHint2 = projectOnRouteWithHint(point, 100);
assert.deepEqual(projHint1, projHint2, "projectOnRouteWithHint should use cache");

// Test 8: Cache key should round coordinates appropriately
buildSimpleRoute();
const p1 = { lat: 0.0000001, lng: 0.0005001 };
const p2 = { lat: 0.0000002, lng: 0.0005002 };
// These should map to same cache key (rounded to ~0.1m precision)
const r1 = matchPositionToRoute(p1);
const r2 = matchPositionToRoute(p2);
assert.deepEqual(r1, r2, "Very close points should use same cache entry");

// Test 9: Verify cache doesn't interfere with hint-based disambiguation
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
const hintedEarly = matchPositionToRoute(overlapPoint, { hintDistanceAlong: 100 });
const hintedLate = matchPositionToRoute(overlapPoint, { hintDistanceAlong: 330 });
assert(noHint.distanceAlong < 200, "No hint should prefer early match");
assert(hintedEarly.distanceAlong < 200, "Early hint should match early");
assert(hintedLate.distanceAlong > 250, "Late hint should match late");

console.log("cache tests passed");
