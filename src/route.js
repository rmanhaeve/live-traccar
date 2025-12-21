import { distanceMeters } from "./geo.js";

let routePoints = [];
let routeDistances = [];
let routeAvgLat = 0;
let routeTotal = 0;
let routeElevations = [];
const HINT_TOLERANCE_METERS = 150;
const HINT_PENALTY_PER_METER = 0.2;
const HEADING_PENALTY_METERS = 30;

let cacheTrack = new Map();
const CACHE_TRACK_MAX_ENTRIES = 10000;

function makeCacheKey(latlng, opts) {
  const lat = Number(latlng?.lat);
  const lng = Number(latlng?.lng);
  const hint = Number.isFinite(opts?.hintDistanceAlong) ? opts.hintDistanceAlong : "";
  const heading = Number.isFinite(opts?.headingDeg) ? opts.headingDeg : "";
  return `${lat}:${lng}:${hint}:${heading}`;
}

export function parseGpx(xmlText) {
  const xml = new DOMParser().parseFromString(xmlText, "application/xml");
  const error =
    typeof xml.querySelector === "function"
      ? xml.querySelector("parsererror")
      : xml.getElementsByTagName && xml.getElementsByTagName("parsererror").length
        ? xml.getElementsByTagName("parsererror")[0]
        : null;
  if (error) throw new Error("GPX parse error");
  const segments = [];
  const trackNodes = Array.from(xml.getElementsByTagName("trk"));
  trackNodes.forEach((trk) => {
    const segs = Array.from(trk.getElementsByTagName("trkseg"));
    segs.forEach((seg) => {
      const pts = Array.from(seg.getElementsByTagName("trkpt")).map((pt) => [
        Number(pt.getAttribute("lat")),
        Number(pt.getAttribute("lon")),
        Number(
          (typeof pt.querySelector === "function"
            ? pt.querySelector("ele")
            : pt.getElementsByTagName && pt.getElementsByTagName("ele")[0])?.textContent
        ),
      ]);
      if (pts.length) segments.push(pts);
    });
  });
  const waypoints = Array.from(xml.getElementsByTagName("wpt")).map((wpt) => ({
    lat: Number(wpt.getAttribute("lat")),
    lng: Number(wpt.getAttribute("lon")),
    name: (typeof wpt.querySelector === "function"
      ? wpt.querySelector("name")
      : wpt.getElementsByTagName && wpt.getElementsByTagName("name")[0]
    )?.textContent?.trim(),
    desc: (typeof wpt.querySelector === "function"
      ? wpt.querySelector("desc")
      : wpt.getElementsByTagName && wpt.getElementsByTagName("desc")[0]
    )?.textContent?.trim(),
  }));
  return { segments, waypoints };
}

export function buildRouteProfile(segments) {
  routePoints = [];
  routeDistances = [];
  routeElevations = [];
  routeAvgLat = 0;
  routeTotal = 0;
  segments.forEach((seg) => {
    seg.forEach((pt) => routePoints.push({ lat: pt[0], lng: pt[1], ele: Number.isFinite(pt[2]) ? pt[2] : null }));
  });
  if (!routePoints.length) return;
  routeAvgLat = routePoints.reduce((sum, p) => sum + p.lat, 0) / routePoints.length;
  routeDistances = new Array(routePoints.length).fill(0);
  routeElevations = new Array(routePoints.length).fill(null);
  for (let i = 1; i < routePoints.length; i += 1) {
    routeDistances[i] =
      routeDistances[i - 1] + distanceMeters([routePoints[i - 1].lat, routePoints[i - 1].lng], [routePoints[i].lat, routePoints[i].lng]);
  }
  for (let i = 0; i < routePoints.length; i += 1) {
    routeElevations[i] = routePoints[i].ele;
  }
  routeTotal = routeDistances[routeDistances.length - 1] || 0;
  const rad = Math.PI / 180;
  const R = 6371000;
  const refLat = routeAvgLat || (routePoints[0] && routePoints[0].lat) || 0;
  for (let i = 0; i < routePoints.length; i += 1) {
    const p = routePoints[i];
    p._x = p.lng * rad * Math.cos(refLat * rad) * R;
    p._y = p.lat * rad * R;
  }
  for (let i = 0; i < routePoints.length - 1; i += 1) {
    const a = routePoints[i];
    const b = routePoints[i + 1];
    const dx = b._x - a._x;
    const dy = b._y - a._y;
    a._segAngle = Math.atan2(dy, dx);
    a._segLen2 = dx * dx + dy * dy;
  }
  cacheTrack.clear();
}

export function pointAtDistance(distanceAlong) {
  if (!routePoints.length || !routeDistances.length) return null;
  const target = Math.min(Math.max(distanceAlong, 0), routeDistances[routeDistances.length - 1]);
  let idx = routeDistances.findIndex((d) => d >= target);
  if (idx <= 0) return routePoints[0];
  if (routeDistances[idx] === target) return routePoints[idx];
  const prevIdx = idx - 1;
  const segmentLen = routeDistances[idx] - routeDistances[prevIdx];
  const t = segmentLen > 0 ? (target - routeDistances[prevIdx]) / segmentLen : 0;
  const a = routePoints[prevIdx];
  const b = routePoints[idx];
  return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
}

export function matchPositionToRoute(latlng, opts = {}) {
  if (!routePoints.length) return null;
  const key = makeCacheKey(latlng, opts);
  if (cacheTrack.has(key)) {
    return cacheTrack.get(key);
  }
  const refLat = routeAvgLat || latlng.lat;
  const rad = Math.PI / 180;
  const R = 6371000;
  const tx = latlng.lng * rad * Math.cos(refLat * rad) * R;
  const ty = latlng.lat * rad * R;
  const hint = opts.hintDistanceAlong;
  const wantHeading = Number.isFinite(opts.headingDeg);
  const headingRad = wantHeading ? (opts.headingDeg * Math.PI) / 180 : null;
  const candidates = [];
  for (let i = 0; i < routePoints.length - 1; i += 1) {
    const a = routePoints[i];
    const b = routePoints[i + 1];
    const seg = { x: b._x - a._x, y: b._y - a._y };
    const segLen2 = a._segLen2 || (seg.x * seg.x + seg.y * seg.y);
    if (segLen2 === 0) continue;
    const apx = tx - a._x;
    const apy = ty - a._y;
    let t = (apx * seg.x + apy * seg.y) / segLen2;
    t = Math.max(0, Math.min(1, t));
    const px = a._x + seg.x * t;
    const py = a._y + seg.y * t;
    const d2 = (px - tx) * (px - tx) + (py - ty) * (py - ty);
    const segDist = (routeDistances[i] || 0) + Math.sqrt(segLen2) * t;
    let headingPenalty = 0;
    if (wantHeading) {
      const segAngle = a._segAngle;
      let diff = Math.abs(segAngle - headingRad);
      diff = Math.min(diff, Math.abs(2 * Math.PI - diff));
      headingPenalty = (1 - Math.cos(diff)) * HEADING_PENALTY_METERS;
    }
    const lateral = Math.sqrt(d2);
    const hintPenalty =
      hint != null
        ? Math.max(Math.abs(segDist - hint) - HINT_TOLERANCE_METERS, 0) * HINT_PENALTY_PER_METER
        : 0;
    const combined = lateral + hintPenalty + headingPenalty;
    candidates.push({
      i,
      t,
      d2,
      segDist,
      combined,
      lateral,
      point: { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t },
    });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    if (a.combined === b.combined) return a.lateral - b.lateral;
    return a.combined - b.combined;
  });
  const best = candidates[0];
  const offtrack = Math.sqrt(best.d2) > 200;
  const result = { dist2: best.d2, distanceAlong: best.segDist, point: best.point, offtrack };
  cacheTrack.set(key, result);
  if (cacheTrack.size > CACHE_TRACK_MAX_ENTRIES) {
    const firstKey = cacheTrack.keys().next().value;
    cacheTrack.delete(firstKey);
  }
  return result;
}

export function projectOnRoute(latlng) {
  return matchPositionToRoute(latlng, {});
}

export function projectOnRouteWithHint(latlng, hintDistanceAlong, headingDeg = null) {
  return matchPositionToRoute(latlng, { hintDistanceAlong, headingDeg });
}

export function mapWaypoints(rawWaypoints) {
  if (!routePoints.length) return [];
  const result = [];
  rawWaypoints.forEach((wp, idx) => {
    const proj = projectOnRoute({ lat: wp.lat, lng: wp.lng });
    if (!proj) return;
    result.push({
      name: wp.name || wp.desc || `Point ${idx + 1}`,
      desc: wp.desc || "",
      distanceAlong: proj.distanceAlong,
      coord: proj.point,
    });
  });
  if (!result.length && routePoints.length) {
    result.push(
      { name: "Start", distanceAlong: 0, coord: routePoints[0] },
      {
        name: "Finish",
        distanceAlong: routeDistances[routeDistances.length - 1] || 0,
        coord: routePoints[routePoints.length - 1],
      }
    );
  }
  result.sort((a, b) => a.distanceAlong - b.distanceAlong);
  return result;
}

export function getRoutePoints() {
  return routePoints;
}

export function getRouteDistances() {
  return routeDistances;
}

export function getRouteTotal() {
  return routeTotal;
}

export function getRouteAvgLat() {
  return routeAvgLat;
}

export function getRouteElevationProfile() {
  return { distances: routeDistances, elevations: routeElevations };
}
