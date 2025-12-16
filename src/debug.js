import { pointAtDistance, getRoutePoints, getRouteTotal } from "./route.js";
import { getAverageSpeedMs, getRecentHeading } from "./stats.js";
import { getNowDate, getNowMs } from "./time.js";

const DEBUG_DEVICE_IDS = [10001, 10002, 10003, 10004, 10005];
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

function parseStartMs(config, nowMs) {
  const raw = config?.debugStartTime || config?.startTime;
  const parsed = raw ? Date.parse(raw) : NaN;
  if (Number.isFinite(parsed)) return parsed;
  return nowMs;
}

function initialStartMsForDevice(idx, total, speedMs, baseStartMs, nowMs, deviceCount) {
  const spacing = total > 0 ? total / Math.max(deviceCount, 1) : 0;
  const targetDist = Math.min(total, spacing * idx);
  const offsetMs = speedMs > 0 ? (targetDist / speedMs) * 1000 : 0;
  // Start earlier for higher target distances so they appear staggered along the track
  const estStart = baseStartMs - offsetMs;
  // Avoid future start dates that would put them behind the start
  return Math.min(estStart, nowMs);
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
  const nowMs = getNowMs();
  const speedKph = config?.expectedAvgSpeedKph ?? 60;
  const speedMs = Math.max(speedKph / 3.6, 0);
  const baseStartMs = parseStartMs(config, nowMs);

  if (!total || !points.length || !speedMs) {
    return DEBUG_DEVICE_IDS.map((id, idx) => ({
      deviceId: id,
      latitude: idx * 0.01,
      longitude: idx * 0.01,
      speed: speedMs / 0.514444 || 0,
      deviceTime: new Date(nowMs).toISOString(),
    }));
  }

  const devices = config?.debugDeviceIds && Array.isArray(config.debugDeviceIds) && config.debugDeviceIds.length
    ? config.debugDeviceIds
    : DEBUG_DEVICE_IDS;

  const results = [];
  devices.forEach((deviceId, idx) => {
    let state = debugState.get(deviceId);
    if (!state) {
      const startMs = initialStartMsForDevice(idx, total, speedMs, baseStartMs, nowMs, devices.length);
      state = { startMs };
      debugState.set(deviceId, state);
    }
    const elapsedSec = Math.max(0, (nowMs - state.startMs) / 1000);
    const traveled = Math.min(total, speedMs * elapsedSec);
    const basePt = pointAtDistance(traveled) || points[points.length - 1] || points[0];
    const noisy = jitterPoint(basePt);
    ensureHistory(deviceId, state.startMs, nowMs, positionsHistory, points, speedMs, total);
    results.push({
      deviceId,
      latitude: noisy.lat,
      longitude: noisy.lng,
      speed: speedMs / 0.514444, // knots
      deviceTime: new Date(nowMs).toISOString(),
      projHintDistanceAlong: traveled,
    });
  });

  return results;
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
    return { ts: getNowDate().toISOString(), devices: devicesInfo, routePoints: getRoutePoints().length };
  };
}
