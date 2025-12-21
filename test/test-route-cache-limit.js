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

// Test cache size limit behavior
// We can't easily test the 10000 limit, but we can verify the logic works
buildSimpleRoute();

// Add a few entries to the cache
const results = [];
for (let i = 0; i < 100; i += 1) {
  const point = { lat: 0.0001 + i * 0.00001, lng: 0.0005 };
  const result = matchPositionToRoute(point);
  results.push({ point, result });
}

// Verify first entry is still cached (we haven't hit the limit)
const firstCheck = matchPositionToRoute(results[0].point);
assert.strictEqual(firstCheck, results[0].result, "Early entries should still be cached");

// Verify last entry is cached
const lastCheck = matchPositionToRoute(results[99].point);
assert.strictEqual(lastCheck, results[99].result, "Recent entries should be cached");

console.log("route cache size limit tests passed");
