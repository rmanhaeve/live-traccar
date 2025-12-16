import { ACTIVE_DISTANCE_THRESHOLD, HISTORY_WINDOW_MS } from "./constants.js";
import { distanceMeters, toRad } from "./geo.js";
import { getRouteTotal, projectOnRoute, projectOnRouteWithHint } from "./route.js";
import { getNowMs } from "./time.js";

const ENDPOINT_PROXIMITY_METERS = 30;
const ETA_CONFIDENCE_Z = 1.645; // ~90% confidence assuming roughly normal speed distribution
const HINT_STALE_MS = 5 * 60 * 1000;

function selectHistorySamples(positionsHistory, deviceId, activeStartTimes, now) {
  const hist = positionsHistory.get(deviceId) || [];
  const activeSince = activeStartTimes.get(deviceId) || null;
  const cutoff = now - HISTORY_WINDOW_MS;
  const filtered = hist.filter((p) => p.t >= cutoff && (!activeSince || p.t >= activeSince));
  if (filtered.length >= 2) return filtered;
  if (filtered.length) return filtered;
  if (hist.length) return hist;
  return [];
}

function summarizeSpeeds(samples) {
  if (!samples || samples.length < 2) return null;
  const speeds = [];
  let totalDist = 0;
  let totalTimeMs = 0;
  for (let i = 1; i < samples.length; i += 1) {
    const prev = samples[i - 1];
    const curr = samples[i];
    if (!prev || !curr) continue;
    const spanMs = (curr.t || 0) - (prev.t || 0);
    if (!Number.isFinite(spanMs) || spanMs <= 0) continue;
    const segDist = distanceMeters([prev.lat, prev.lng], [curr.lat, curr.lng]);
    const segSpeed = segDist / (spanMs / 1000);
    if (Number.isFinite(segSpeed) && segSpeed >= 0) {
      speeds.push(segSpeed);
      totalDist += segDist;
      totalTimeMs += spanMs;
    }
  }
  if (!speeds.length || totalTimeMs <= 0) return null;
  const averageMs = totalDist / (totalTimeMs / 1000);
  const varianceSum = speeds.reduce((acc, s) => acc + (s - averageMs) ** 2, 0);
  const speedStdDev = Math.sqrt(speeds.length > 1 ? varianceSum / (speeds.length - 1) : 0);
  return { averageMs, speedStdDev, segmentCount: speeds.length };
}

function getSpeedStats(positionsHistory, deviceId, activeStartTimes, now = getNowMs()) {
  const samples = selectHistorySamples(positionsHistory, deviceId, activeStartTimes, now);
  if (!samples || samples.length < 2) return null;
  return summarizeSpeeds(samples);
}

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

export function getAverageSpeedMs(positionsHistory, deviceId, activeStartTimes, now = getNowMs()) {
  const stats = getSpeedStats(positionsHistory, deviceId, activeStartTimes, now);
  return stats?.averageMs || 0;
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
  const now = getNowMs();
  const last = lastProjection.get(deviceId);
  const hintFresh = last && last.t && now - last.t > HINT_STALE_MS ? null : last?.distanceAlong;
  const heading = getRecentHeading(positionsHistory, deviceId);
  let proj = projectOnRouteWithHint({ lat: pos.latitude, lng: pos.longitude }, hintFresh, heading);
  if (!proj || proj.offtrack) {
    const fallback = projectOnRoute({ lat: pos.latitude, lng: pos.longitude });
    if (fallback && (!fallback.offtrack || (proj?.dist2 != null && fallback.dist2 < (proj?.dist2 ?? Infinity)))) {
      proj = fallback;
    }
  }
  if (!proj) return null;
  const offtrack = Boolean(proj.offtrack);
  const total = getRouteTotal();
  const endpoint = !offtrack ? inferEndpoint(deviceId, proj.distanceAlong, total, last, positionsHistory) : null;
  // store last projection for continuity
  lastProjection.set(deviceId, { distanceAlong: proj.distanceAlong, t: now });
  return { proj, pos, offtrack, endpoint };
}

function findActiveStartTime(deviceId, positionsHistory) {
  if (!positionsHistory?.get) return null;
  const hist = positionsHistory.get(deviceId) || [];
  let hint = null;
  for (let i = 0; i < hist.length; i += 1) {
    const sample = hist[i];
    if (!sample || !Number.isFinite(sample.t)) continue;
    const proj = projectOnRouteWithHint({ lat: sample.lat, lng: sample.lng }, hint);
    if (!proj || proj.distanceAlong == null) continue;
    hint = proj.distanceAlong;
    if (proj.distanceAlong >= ACTIVE_DISTANCE_THRESHOLD) {
      return sample.t;
    }
  }
  return null;
}

export function markActiveOnRoute(deviceId, progress, activeStartTimes, now = getNowMs(), positionsHistory = null) {
  if (!progress || progress.offtrack) return;
  if (progress.proj?.distanceAlong == null) return;
  if (progress.proj.distanceAlong < ACTIVE_DISTANCE_THRESHOLD) return;
  if (!activeStartTimes.has(deviceId)) {
    const histStart = findActiveStartTime(deviceId, positionsHistory);
    const startMs = Number.isFinite(histStart) ? histStart : now;
    activeStartTimes.set(deviceId, startMs);
  }
}

function computeEtaInterval(delta, speedStats, now) {
  if (!speedStats) return null;
  const { averageMs, speedStdDev, segmentCount } = speedStats;
  if (!averageMs || averageMs <= 0) return null;
  if (!speedStdDev || speedStdDev <= 0) return null;
  if (!segmentCount || segmentCount < 2) return null;
  const standardError = speedStdDev / Math.sqrt(segmentCount);
  if (!Number.isFinite(standardError) || standardError <= 0) return null;
  const margin = ETA_CONFIDENCE_Z * standardError;
  if (!Number.isFinite(margin) || margin <= 0 || margin >= averageMs) return null;
  const fastSpeed = averageMs + margin;
  const slowSpeed = averageMs - margin;
  if (fastSpeed <= 0 || slowSpeed <= 0) return null;
  const lowArrival = new Date(now + (delta / fastSpeed) * 1000);
  const highArrival = new Date(now + (delta / slowSpeed) * 1000);
  if (Number.isNaN(lowArrival.getTime()) || Number.isNaN(highArrival.getTime())) return null;
  return { low: lowArrival, high: highArrival, confidence: 0.9 };
}

export function computeEta(deviceId, targetDistance, {
  lastPositions,
  lastProjection,
  positionsHistory,
  activeStartTimes,
  expectedSpeedMs = 0,
}) {
  const now = getNowMs();
  const progress = computeDeviceProgress(deviceId, { lastPositions, lastProjection, positionsHistory });
  if (!progress || progress.offtrack) return { status: "offtrack" };
  const speedStats = getSpeedStats(positionsHistory, deviceId, activeStartTimes, now);
  const speedMs = speedStats?.averageMs || 0;
  const delta = targetDistance - progress.proj.distanceAlong;
  if (delta <= 0) return { status: "passed" };
  const effectiveSpeed = speedMs > 0 ? speedMs : Math.max(expectedSpeedMs || 0, 0);
  if (!effectiveSpeed) return { status: "unknown" };
  const arrival = new Date(now + (delta / effectiveSpeed) * 1000);
  const interval = speedMs > 0 ? computeEtaInterval(delta, speedStats, now) : null;
  return { status: "eta", arrival, interval };
}

export function computeElevationTotals(profile, limitDistance = null) {
  if (!profile?.distances?.length || !profile?.elevations?.length) return { gain: 0, loss: 0 };
  const distances = profile.distances;
  const elevations = profile.elevations;
  const totalDist = distances[distances.length - 1] || 0;
  const target = limitDistance != null ? Math.max(0, Math.min(limitDistance, totalDist)) : totalDist;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i < distances.length; i += 1) {
    const d0 = distances[i - 1];
    const d1 = distances[i];
    if (!Number.isFinite(d0) || !Number.isFinite(d1)) continue;
    if (!Number.isFinite(elevations[i - 1]) || !Number.isFinite(elevations[i])) continue;
    if (d0 >= target) break;
    const cappedEnd =
      target >= d1
        ? { dist: d1, ele: elevations[i] }
        : {
            dist: target,
            ele: elevations[i - 1] + ((elevations[i] - elevations[i - 1]) * (target - d0)) / (d1 - d0),
          };
    const segStartEle = elevations[i - 1];
    const segEndEle = cappedEnd.ele;
    const diff = segEndEle - segStartEle;
    if (diff > 0) gain += diff;
    else if (diff < 0) loss += Math.abs(diff);
    if (cappedEnd.dist >= target) break;
  }
  return { gain, loss };
}
