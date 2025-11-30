import { pointAtDistance, getRoutePoints, getRouteTotal } from "./route.js";
import { getAverageSpeedMs, getRecentHeading } from "./stats.js";

const MOVING_DEVICE_IDS = [10001, 10002, 10003, 10004, 10005];
const STATIC_START_ID = 10006;
const STATIC_FINISH_ID = 10007;
const DEBUG_SPEED_MS = 60 / 3.6; // 60 km/h
const DEBUG_JITTER_METERS = 5;
const HISTORY_INTERVAL_SECONDS = 5;

function jitterPoint(base) {
  const theta = Math.random() * Math.PI * 2;
  const r = Math.sqrt(Math.random()) * DEBUG_JITTER_METERS; // uniform in circle
  const dx = r * Math.cos(theta);
  const dy = r * Math.sin(theta);
  const latScale = 111_000; // meters per degree latitude
  const lngScale = Math.max(Math.cos((base.lat * Math.PI) / 180), 1e-6) * latScale;
  return { lat: base.lat + dy / latScale, lng: base.lng + dx / lngScale };
}

function ensureHistory(deviceId, startMs, nowMs, positionsHistory, points, travelSpeedMs, total) {
  if (!positionsHistory || !points.length) return;
  const hist = positionsHistory.get(deviceId) || [];
  if (!Number.isFinite(startMs)) startMs = nowMs;
  if (!hist.length) {
    const pt0 = points[0];
    hist.push({ t: startMs, lat: pt0.lat, lng: pt0.lng });
  }
  const intervalMs = HISTORY_INTERVAL_SECONDS * 1000;
  const lastT = hist[hist.length - 1]?.t ?? startMs;
  for (let t = lastT + intervalMs; t <= nowMs; t += intervalMs) {
    const elapsedSec = Math.max(0, (t - startMs) / 1000);
    const dist = travelSpeedMs > 0 ? Math.min(total, travelSpeedMs * elapsedSec) : 0;
    const pt = pointAtDistance(dist) || points[0];
    hist.push({ t, lat: pt.lat, lng: pt.lng });
  }
  // ensure a final sample at nowMs
  const elapsedSecNow = Math.max(0, (nowMs - startMs) / 1000);
  const distNow = travelSpeedMs > 0 ? Math.min(total, travelSpeedMs * elapsedSecNow) : 0;
  const ptNow = pointAtDistance(distNow) || points[0];
  if (!hist.length || hist[hist.length - 1].t !== nowMs) {
    hist.push({ t: nowMs, lat: ptNow.lat, lng: ptNow.lng });
  }
  positionsHistory.set(deviceId, hist);
}

export function buildDebugPositions(
  debugState,
  config,
  routeTotalOverride = null,
  routePointsOverride = null,
  positionsHistory = null
) {
  const total = routeTotalOverride || getRouteTotal() || 0;
  const points = routePointsOverride || getRoutePoints() || [];
  if (!total || !points.length) {
    const fallbackIds = [...MOVING_DEVICE_IDS, STATIC_START_ID, STATIC_FINISH_ID];
    return fallbackIds.map((id, idx) => ({
      deviceId: id,
      latitude: idx * 0.01,
      longitude: idx * 0.01,
      speed: 0,
      deviceTime: new Date().toISOString(),
    }));
  }
  const stepSeconds = config?.refreshSeconds || 10;
  const nowMs = Date.now();
  const maybeAdvance = (deviceId, idx) => {
    const state = debugState.get(deviceId) || {
      distanceAlong: (total * idx) / MOVING_DEVICE_IDS.length,
      lastMs: nowMs - stepSeconds * 1000,
      startMs: nowMs - ((total * idx) / MOVING_DEVICE_IDS.length / DEBUG_SPEED_MS) * 1000,
    };
    const elapsedSeconds = state.lastMs ? (nowMs - state.lastMs) / 1000 : stepSeconds;
    const delta = Math.max(elapsedSeconds, 0) * DEBUG_SPEED_MS;
    state.distanceAlong = Math.min(total, state.distanceAlong + delta);
    state.lastMs = nowMs;
    if (!state.startMs) state.startMs = nowMs - (state.distanceAlong / DEBUG_SPEED_MS) * 1000;
    debugState.set(deviceId, state);
    const basePt = pointAtDistance(state.distanceAlong) || points[0];
    const noisy = jitterPoint(basePt);
    ensureHistory(deviceId, state.startMs, nowMs, positionsHistory, points, DEBUG_SPEED_MS, total);
    return {
      deviceId,
      latitude: noisy.lat,
      longitude: noisy.lng,
      speed: DEBUG_SPEED_MS / 0.514444, // knots
      deviceTime: new Date(nowMs).toISOString(),
    };
  };
  const startPt = points[0] || { lat: 0, lng: 0 };
  const finishPt = pointAtDistance(total) || points[points.length - 1] || startPt;
  const ensureStatic = (deviceId, basePt, hintDistanceAlong, traveledDistance, travelSpeedMs, startMsOverride) => {
    let state = debugState.get(deviceId);
    if (!state || !state.static) {
      const noisy = jitterPoint(basePt);
      state = { static: true, lat: noisy.lat, lng: noisy.lng };
      debugState.set(deviceId, state);
    }
    const startMs =
      startMsOverride != null
        ? startMsOverride
        : travelSpeedMs > 0
          ? nowMs - (traveledDistance / travelSpeedMs) * 1000
          : nowMs - HISTORY_INTERVAL_SECONDS * 1000 * 3;
    ensureHistory(deviceId, startMs, nowMs, positionsHistory, points, travelSpeedMs, total);
    return {
      deviceId,
      latitude: state.lat,
      longitude: state.lng,
      speed: 0,
      deviceTime: new Date().toISOString(),
      projHintDistanceAlong: hintDistanceAlong,
    };
  };
  const moving = MOVING_DEVICE_IDS.map((id, idx) => maybeAdvance(id, idx));
  const staticOnes = [
    ensureStatic(STATIC_START_ID, startPt, 0, 0, 0, nowMs - HISTORY_INTERVAL_SECONDS * 1000 * 5),
    ensureStatic(STATIC_FINISH_ID, finishPt, total, total, DEBUG_SPEED_MS, nowMs - (total / DEBUG_SPEED_MS) * 1000),
  ];
  return [...moving, ...staticOnes];
}

export function installDebugInfoHook({
  devices,
  lastPositions,
  lastProjection,
  positionsHistory,
  activeStartTimes,
}) {
  window.__getDebugInfo = function debugInfo() {
    const devicesInfo = Array.from(devices.keys()).map((id) => {
      const pos = lastPositions.get(id) || null;
      const proj = lastProjection.get(id) || null;
      const hist = positionsHistory.get(id) || [];
      const heading = getRecentHeading(positionsHistory, id);
      const speedMs = getAverageSpeedMs(positionsHistory, id, activeStartTimes);
      return { id, pos, proj, heading, speedMs, historySamples: hist.length };
    });
    return { ts: new Date().toISOString(), devices: devicesInfo, routePoints: getRoutePoints().length };
  };
}
