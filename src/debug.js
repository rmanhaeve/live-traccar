import { pointAtDistance, getRoutePoints, getRouteTotal } from "./route.js";
import { getAverageSpeedMs, getRecentHeading } from "./stats.js";

const DEBUG_DEVICE_IDS = [10001, 10002, 10003, 10004, 10005];
const DEBUG_SPEED_MS = 60 / 3.6; // 60 km/h
const DEBUG_JITTER_METERS = 5;

function jitterPoint(base) {
  const theta = Math.random() * Math.PI * 2;
  const r = Math.sqrt(Math.random()) * DEBUG_JITTER_METERS; // uniform in circle
  const dx = r * Math.cos(theta);
  const dy = r * Math.sin(theta);
  const latScale = 111_000; // meters per degree latitude
  const lngScale = Math.max(Math.cos((base.lat * Math.PI) / 180), 1e-6) * latScale;
  return { lat: base.lat + dy / latScale, lng: base.lng + dx / lngScale };
}

export function buildDebugPositions(debugState, config, routeTotalOverride = null, routePointsOverride = null) {
  const nowIso = new Date().toISOString();
  const total = routeTotalOverride || getRouteTotal() || 0;
  const points = routePointsOverride || getRoutePoints() || [];
  if (!total || !points.length) {
    return DEBUG_DEVICE_IDS.map((id, idx) => ({
      deviceId: id,
      latitude: idx * 0.01,
      longitude: idx * 0.01,
      speed: 0,
      deviceTime: nowIso,
    }));
  }
  const stepSeconds = config?.refreshSeconds || 10;
  const maybeAdvance = (deviceId, idx) => {
    const state = debugState.get(deviceId) || {
      distanceAlong: (total * idx) / DEBUG_DEVICE_IDS.length,
      lastMs: Date.now() - stepSeconds * 1000,
    };
    const nowMs = Date.now();
    const elapsedSeconds = state.lastMs ? (nowMs - state.lastMs) / 1000 : stepSeconds;
    const delta = Math.max(elapsedSeconds, 0) * DEBUG_SPEED_MS;
    state.distanceAlong = (state.distanceAlong + delta) % total;
    state.lastMs = nowMs;
    debugState.set(deviceId, state);
    const basePt = pointAtDistance(state.distanceAlong) || points[0];
    const noisy = jitterPoint(basePt);
    return {
      deviceId,
      latitude: noisy.lat,
      longitude: noisy.lng,
      speed: DEBUG_SPEED_MS / 0.514444, // knots
      deviceTime: nowIso,
    };
  };
  return DEBUG_DEVICE_IDS.map((id, idx) => maybeAdvance(id, idx));
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
