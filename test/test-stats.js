import assert from "node:assert/strict";
import { buildRouteProfile } from "../src/route.js";
import {
  computeDeviceProgress,
  computeEta,
  getAverageSpeedMs,
  getRecentHeading,
  markActiveOnRoute,
} from "../src/stats.js";

function approxEqual(a, b, tolerance = 1e-6) {
  assert.ok(Math.abs(a - b) <= tolerance, `${a} ≉ ${b} (tol ${tolerance})`);
}

function setupRoute() {
  buildRouteProfile([
    [
      [0, 0],
      [0, 0.001],
    ],
  ]);
}

setupRoute();

// getAverageSpeedMs should use samples within the window and return 0 for sparse data
const positionsHistory = new Map();
const deviceId = 42;
positionsHistory.set(deviceId, [
  { t: 0, lat: 0, lng: 0 },
  { t: 10000, lat: 0, lng: 0.001 },
]);
const activeStartTimes = new Map();
let speed = getAverageSpeedMs(positionsHistory, deviceId, activeStartTimes, 20000);
approxEqual(Math.round(speed), 11); // ~11 m/s for ~111 m in 10s

// Should ignore samples before active start time
activeStartTimes.set(deviceId, 8000);
speed = getAverageSpeedMs(positionsHistory, deviceId, activeStartTimes, 20000);
approxEqual(speed, 0); // only one sample after active start

// getRecentHeading should return bearing from early to recent samples
positionsHistory.set(deviceId, [
  { t: 0, lat: 0, lng: 0 },
  { t: 10000, lat: 0, lng: 0.001 },
]);
const heading = getRecentHeading(positionsHistory, deviceId);
approxEqual(heading, 90, 1); // eastward

// computeDeviceProgress should infer endpoints and project on the route
const lastPositions = new Map([[deviceId, { latitude: 0, longitude: 0.001 }]]);
const lastProjection = new Map();
const progress = computeDeviceProgress(deviceId, { lastPositions, lastProjection, positionsHistory });
assert(progress);
assert.equal(progress.offtrack, false);
assert.equal(progress.endpoint, "finish");

// markActiveOnRoute should set active start when device is sufficiently along the route
const now = 50000;
activeStartTimes.delete(deviceId);
markActiveOnRoute(deviceId, progress, activeStartTimes, now);
assert.equal(activeStartTimes.get(deviceId), now);

// computeEta should cover offtrack, passed, unknown and eta statuses
const etaOfftrack = computeEta(99, 10, { lastPositions: new Map(), lastProjection: new Map(), positionsHistory, activeStartTimes });
assert.deepEqual(etaOfftrack, { status: "offtrack" });

const etaPassed = computeEta(deviceId, 50, { lastPositions, lastProjection, positionsHistory, activeStartTimes });
assert.equal(etaPassed.status, "passed");

// No speed history -> unknown
const slowHistory = new Map([[deviceId, [{ t: 0, lat: 0, lng: 0 }]]]);
const etaUnknown = computeEta(deviceId, progress.proj.distanceAlong + 10, {
  lastPositions,
  lastProjection,
  positionsHistory: slowHistory,
  activeStartTimes,
});
assert.equal(etaUnknown.status, "unknown");

// With valid speed we should get an ETA Date
const eta = computeEta(deviceId, progress.proj.distanceAlong + 50, {
  lastPositions,
  lastProjection,
  positionsHistory,
  activeStartTimes,
});
assert.equal(eta.status, "eta");
assert.ok(eta.arrival instanceof Date);

// With varied speeds we should expose a confidence interval range
const variedHistory = new Map([[deviceId, [
  { t: 0, lat: 0, lng: 0 },
  { t: 8000, lat: 0, lng: 0.001 },
  { t: 16000, lat: 0, lng: 0.0025 },
  { t: 24000, lat: 0, lng: 0.003 },
]]]);
const etaWithInterval = computeEta(deviceId, progress.proj.distanceAlong + 50, {
  lastPositions,
  lastProjection: new Map(),
  positionsHistory: variedHistory,
  activeStartTimes,
});
assert.equal(etaWithInterval.status, "eta");
assert.ok(etaWithInterval.arrival instanceof Date);
assert.ok(etaWithInterval.interval?.low instanceof Date);
assert.ok(etaWithInterval.interval?.high instanceof Date);
assert(etaWithInterval.interval.low < etaWithInterval.interval.high);

console.log("stats tests passed");
