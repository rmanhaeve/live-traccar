import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { DOMParser } from "xmldom";
import { buildDebugPositions } from "../src/debug.js";
import {
  buildRouteProfile,
  getRouteTotal,
  projectOnRouteWithHint,
} from "../src/route.js";

function parseGpx(file) {
  const xml = new DOMParser().parseFromString(fs.readFileSync(file, "utf8"));
  const pts = [];
  const trkpts = xml.getElementsByTagName("trkpt");
  for (let i = 0; i < trkpts.length; i += 1) {
    const el = trkpts[i];
    const lat = parseFloat(el.getAttribute("lat"));
    const lon = parseFloat(el.getAttribute("lon"));
    pts.push([lat, lon]);
  }
  return pts;
}

function timesStrictlyIncreasing(samples) {
  for (let i = 1; i < samples.length; i += 1) {
    if (!(samples[i].t > samples[i - 1].t)) return false;
  }
  return true;
}

async function run() {
  const realNow = Date.now;
  const realRandom = Math.random;
  const fixedNow = Date.parse("2023-01-01T00:30:00Z");
  Date.now = () => fixedNow;
  Math.random = () => 0.5; // deterministic jitter

  const here = path.dirname(fileURLToPath(import.meta.url));
  const gpxPath = path.join(here, "..", "tracks", "10k.gpx");
  const pts = parseGpx(gpxPath);
  buildRouteProfile([pts]);
  const total = getRouteTotal();
  assert(total > 0, "route total should be > 0");
  const debugSpeedMs = 20 / 3.6;

  const debugState = new Map();
  const positionsHistory = new Map();
  const config = { refreshSeconds: 10, debug: true, debugStartTime: "2023-01-01T00:00:00Z", expectedAvgSpeedKph: 20 };

  try {
    const positions = buildDebugPositions(
      debugState,
      config,
      total,
      pts.map((p) => ({ lat: p[0], lng: p[1] })),
      positionsHistory
    );

    const ids = [10001, 10002, 10003, 10004, 10005];
    ids.forEach((id, idx) => {
      const hint = positions.find((p) => p.deviceId === id)?.projHintDistanceAlong || null;
      const hist = positionsHistory.get(id);
      assert(hist && hist.length > 2, `rider ${id} should have history samples`);
      assert(timesStrictlyIncreasing(hist), `rider ${id} history timestamps should increase`);
      const lastSample = hist[hist.length - 1];
      assert.equal(lastSample.t, fixedNow, "last history sample should align with now");
      const proj = projectOnRouteWithHint({ lat: lastSample.lat, lng: lastSample.lng }, hint);
      assert(proj, `projection should exist for rider ${id}`);

      const startMs = debugState.get(id).startMs;
      const elapsedMs = Math.max(0, fixedNow - startMs);
      const expectedDist = Math.min(total, debugSpeedMs * (elapsedMs / 1000));
      const diff = Math.abs((proj?.distanceAlong ?? 0) - expectedDist);
      assert(
        diff < 100,
        `rider ${id} expected distance ${expectedDist} within 100m (got ${proj?.distanceAlong}, diff ${diff})`
      );

      if (idx > 0) {
        const prevStart = debugState.get(ids[idx - 1]).startMs;
        assert(prevStart >= startMs, "start times should stagger earlier for later riders");
      }
    });

    console.log("debug history test passed");
  } finally {
    Date.now = realNow;
    Math.random = realRandom;
  }
}

run();
