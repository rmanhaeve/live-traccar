import { ACTIVE_DISTANCE_THRESHOLD, HISTORY_WINDOW_MS } from "./constants.js";
import { distanceMeters, toRad } from "./geo.js";
import { getRouteTotal, projectOnRouteWithHint } from "./route.js";

const ENDPOINT_PROXIMITY_METERS = 30;

function inferEndpoint(deviceId, distanceAlong, total, lastProjection, positionsHistory) {
  if (!Number.isFinite(distanceAlong) || !Number.isFinite(total) || total <= 0) return null;
  const distToStart = distanceAlong;
  const distToFinish = Math.max(total - distanceAlong, 0);
  const nearStart = distToStart <= ENDPOINT_PROXIMITY_METERS;
  const nearFinish = distToFinish <= ENDPOINT_PROXIMITY_METERS;
  if (!nearStart && !nearFinish) return null;
  if (nearStart && !nearFinish) return "start";
  if (!nearStart && nearFinish) return "finish";
  const prevDist = lastProjection?.distanceAlong;
  if (Number.isFinite(prevDist)) {
    return prevDist > total / 2 ? "finish" : "start";
  }
  const hist = positionsHistory?.get ? positionsHistory.get(deviceId) : null;
  const prevSample = hist && hist.length > 1 ? hist[hist.length - 2] : hist?.[0];
  if (prevSample) {
    const prevProj = projectOnRouteWithHint({ lat: prevSample.lat, lng: prevSample.lng }, prevDist);
    if (prevProj?.distanceAlong != null) {
      return prevProj.distanceAlong > total / 2 ? "finish" : "start";
    }
  }
  return "start";
}

export function getAverageSpeedMs(positionsHistory, deviceId, activeStartTimes, now = Date.now()) {
  const hist = positionsHistory.get(deviceId) || [];
  const activeSince = activeStartTimes.get(deviceId) || null;
  const cutoff = now - HISTORY_WINDOW_MS;
  const filtered = hist.filter((p) => p.t >= cutoff && (!activeSince || p.t >= activeSince));
  const samples = filtered.length >= 2 ? filtered : filtered.length ? filtered : hist.length ? hist : null;
  if (!samples || samples.length < 2) return 0;
  let dist = 0;
  const startT = samples[0].t;
  const endT = samples[samples.length - 1].t;
  for (let i = 1; i < samples.length; i += 1) {
    dist += distanceMeters([samples[i - 1].lat, samples[i - 1].lng], [samples[i].lat, samples[i].lng]);
  }
  const span = (endT || 0) - (startT || 0);
  if (span <= 0) return 0;
  return dist / (span / 1000);
}

export function getRecentHeading(positionsHistory, deviceId, points = 5) {
  const hist = positionsHistory.get(deviceId) || [];
  if (!hist.length) return null;
  const n = Math.min(points, hist.length);
  const a = hist[hist.length - n];
  const b = hist[hist.length - 1];
  if (!a || !b || a.lat == null || a.lng == null || b.lat == null || b.lng == null) return null;
  const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
  const x =
    Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
    Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
  let brng = (Math.atan2(y, x) * 180) / Math.PI;
  brng = (brng + 360) % 360;
  return brng;
}

export function computeDeviceProgress(deviceId, {
  lastPositions,
  lastProjection,
  positionsHistory,
}) {
  const pos = lastPositions.get(deviceId);
  if (!pos) return null;
  const last = lastProjection.get(deviceId);
  const hint = last?.distanceAlong;
  const heading = getRecentHeading(positionsHistory, deviceId);
  const proj = projectOnRouteWithHint({ lat: pos.latitude, lng: pos.longitude }, hint, heading);
  if (!proj) return null;
  const offtrack = Boolean(proj.offtrack);
  const total = getRouteTotal();
  const endpoint = !offtrack ? inferEndpoint(deviceId, proj.distanceAlong, total, last, positionsHistory) : null;
  // store last projection for continuity
  lastProjection.set(deviceId, { distanceAlong: proj.distanceAlong, t: Date.now() });
  return { proj, pos, offtrack, endpoint };
}

export function markActiveOnRoute(deviceId, progress, activeStartTimes, now = Date.now()) {
  if (!progress || progress.offtrack) return;
  if (progress.proj?.distanceAlong == null) return;
  if (progress.proj.distanceAlong < ACTIVE_DISTANCE_THRESHOLD) return;
  if (!activeStartTimes.has(deviceId)) {
    activeStartTimes.set(deviceId, now);
  }
}

export function computeEta(deviceId, targetDistance, {
  lastPositions,
  lastProjection,
  positionsHistory,
  activeStartTimes,
}) {
  const progress = computeDeviceProgress(deviceId, { lastPositions, lastProjection, positionsHistory });
  if (!progress || progress.offtrack) return { status: "offtrack" };
  const speedMs = getAverageSpeedMs(positionsHistory, deviceId, activeStartTimes);
  const delta = targetDistance - progress.proj.distanceAlong;
  if (delta <= 0) return { status: "passed" };
  if (!speedMs || speedMs <= 0) return { status: "unknown" };
  const arrival = new Date(Date.now() + (delta / speedMs) * 1000);
  return { status: "eta", arrival };
}
