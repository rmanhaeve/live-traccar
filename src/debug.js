import { pointAtDistance, getRoutePoints, getRouteTotal } from "./route.js";
import { getAverageSpeedMs, getRecentHeading } from "./stats.js";

export function buildDebugPositions(debugState, config, routeTotalOverride = null, routePointsOverride = null) {
  const now = new Date().toISOString();
  const total = routeTotalOverride || getRouteTotal() || 0;
  const points = routePointsOverride || getRoutePoints() || [];
  if (!total || !points.length) {
    return [
      { deviceId: 10001, latitude: 0, longitude: 0, speed: 0, deviceTime: now },
      { deviceId: 10002, latitude: 0.01, longitude: 0.01, speed: 0, deviceTime: now },
      { deviceId: 10003, latitude: 0.02, longitude: 0.02, speed: 0, deviceTime: now },
    ];
  }
  const stepSeconds = config?.refreshSeconds || 10;
  const debugSpeedMs = 6; // ~22 km/h
  const deltaFraction = total > 0 ? (debugSpeedMs * stepSeconds) / total : 0;
  const onTrack = (deviceId, initialFraction) => {
    const state = debugState.get(deviceId) || { fraction: initialFraction };
    state.fraction = Math.min(1, state.fraction + deltaFraction);
    debugState.set(deviceId, state);
    const dist = total * state.fraction;
    const pt = pointAtDistance(dist) || points[0];
    return {
      deviceId,
      latitude: pt.lat,
      longitude: pt.lng,
      speed: debugSpeedMs / 0.514444, // convert m/s to knots
      deviceTime: now,
    };
  };
  const offTrack = () => {
    const mid = pointAtDistance(total * 0.5) || { lat: 0, lng: 0 };
    return {
      deviceId: 10003,
      latitude: mid.lat + 0.05,
      longitude: mid.lng + 0.05,
      speed: 0,
      deviceTime: now,
    };
  };
  return [onTrack(10001, Math.random() * 0.8), onTrack(10002, 0.2 + Math.random() * 0.6), offTrack()];
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
