import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { DOMParser } from "xmldom";
import { buildDebugPositions } from "../src/debug.js";
import {
  buildRouteProfile,
  pointAtDistance,
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

function assert(condition, msg) {
  if (!condition) {
    throw new Error(msg);
  }
}

function timesStrictlyIncreasing(samples) {
  for (let i = 1; i < samples.length; i += 1) {
    if (!(samples[i].t > samples[i - 1].t)) return false;
  }
  return true;
}

async function run() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const gpxPath = path.join(here, "..", "tracks", "10k.gpx");
  const pts = parseGpx(gpxPath);
  buildRouteProfile([pts]);
  const total = getRouteTotal();
  assert(total > 0, "route total should be > 0");
  const debugSpeedMs = 60 / 3.6;

  const debugState = new Map();
  const positionsHistory = new Map();
  buildDebugPositions(debugState, { refreshSeconds: 10, debug: true }, total, pts.map((p) => ({ lat: p[0], lng: p[1] })), positionsHistory);

  const finishHist = positionsHistory.get(10007);
  assert(finishHist && finishHist.length > 2, "finish rider should have history samples");
  assert(timesStrictlyIncreasing(finishHist), "finish rider history timestamps should increase");

  const lastSample = finishHist[finishHist.length - 1];
  const proj = projectOnRouteWithHint({ lat: lastSample.lat, lng: lastSample.lng }, total);
  const diff = proj ? Math.abs(proj.distanceAlong - total) : Infinity;
  if (!proj) {
    console.log("No projection for finish last sample", lastSample);
  } else {
    console.log("Finish diff", diff, "proj", proj.distanceAlong, "total", total);
  }
  assert(proj && diff < 1000, `finish rider last sample should be near finish (diff ${diff})`);

  const startHist = positionsHistory.get(10006);
  assert(startHist && startHist.length >= 1, "start rider should have history");
  if (startHist.length > 1) {
    assert(timesStrictlyIncreasing(startHist), "start rider history timestamps should increase");
  }
  const firstStart = startHist[0];
  const projStart = projectOnRouteWithHint({ lat: firstStart.lat, lng: firstStart.lng }, 0);
  assert(projStart && projStart.distanceAlong < 50, "start rider first sample should be near start");
  assert(firstStart.t <= lastSample.t, "start rider time should not be after finisher time");

  // check finisher travel time roughly matches distance/speed
  const firstFinish = finishHist[0];
  const projFinishStart = projectOnRouteWithHint({ lat: firstFinish.lat, lng: firstFinish.lng }, 0);
  const startDist = projFinishStart?.distanceAlong ?? 0;
  const travelDist = Math.max(0, total - startDist);
  const expectedMs = (travelDist / debugSpeedMs) * 1000;
  const actualMs = lastSample.t - firstFinish.t;
  const errPct = Math.abs(actualMs - expectedMs) / expectedMs;
  assert(errPct < 0.2, `finish rider history time should align with speed (error ${Math.round(errPct * 100)}%)`);

  // simulate history table timing: start should precede finish
  const ticks = [0, total];
  const events = { km: new Map(), waypoints: new Map() };
  let firstDist = null;
  let firstTime = null;
  let lastDist = null;
  let lastTime = null;
  let hint = null;
  finishHist.forEach((sample) => {
    if (!Number.isFinite(sample.t)) return;
    const proj = projectOnRouteWithHint({ lat: sample.lat, lng: sample.lng }, hint);
    if (!proj || proj.distanceAlong == null) return;
    const dist = proj.distanceAlong;
    if (firstDist == null) {
      firstDist = dist;
      firstTime = sample.t;
    }
    if (lastDist != null) {
      ticks.forEach((tick) => {
        if (events.km.has(tick)) return;
        if (dist >= tick && lastDist < tick) events.km.set(tick, sample.t);
      });
    }
    lastDist = dist;
    lastTime = sample.t;
    hint = dist;
  });
  ticks.forEach((tick) => {
    if (events.km.has(tick)) return;
    if (lastDist != null && lastDist >= tick) {
      const t = firstDist != null && tick <= firstDist ? firstTime : lastTime;
      events.km.set(tick, t);
    }
  });
  const startTick = events.km.get(0);
  const finishTick = events.km.get(total);
  assert(startTick != null && finishTick != null, "start and finish tick times should exist");
  assert(startTick < finishTick, "start tick time should be before finish tick time");

  console.log("debug history test passed");
}

run();
