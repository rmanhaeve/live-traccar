import {
  DEFAULT_CONFIG,
  DEFAULT_TEXTS,
  TRANSLATIONS_MAP,
  LANGUAGE_COOKIE,
  HISTORY_WINDOW_MS,
} from "./src/constants.js";
import {
  parseGpx,
  buildRouteProfile,
  mapWaypoints,
  projectOnRoute,
  projectOnRouteWithHint,
  pointAtDistance,
  getRouteDistances,
  getRoutePoints,
  getRouteTotal,
} from "./src/route.js";
import {
  computeDeviceProgress,
  computeEta,
  getAverageSpeedMs,
  getRecentHeading,
  markActiveOnRoute,
} from "./src/stats.js";
import { fetchDevices, fetchPositions, fetchRecentHistory } from "./src/traccar.js";
import { buildDebugPositions, installDebugInfoHook } from "./src/debug.js";
import {
  setupVisualization,
  initMap,
  initContextMenu,
  renderRoute,
  rebuildKmMarkers,
  renderWaypoints,
  renderLegend,
  renderToggles,
  updateMarker,
  extendBounds,
  fitToData,
  clearRoute,
  setRouteWaypoints,
  startViewerLocation as vizStartViewerLocation,
  stopViewerLocation as vizStopViewerLocation,
  updateHelpContent,
} from "./src/visualization.js";

const statusEl = document.getElementById("status");
const titleEl = document.getElementById("title");
let config = { ...DEFAULT_CONFIG };
let texts = { ...DEFAULT_TEXTS };
let currentLanguage = "en";
let selectedDeviceId = null;
let refreshTimer;
let downloadButton;
let langSelector;
let userPreferences;
let routeWaypoints = [];
let distanceTicks = [];

const devices = new Map();
const lastSeen = new Map();
const lastPositions = new Map();
const positionsHistory = new Map();
const lastProjection = new Map();
const activeStartTimes = new Map();
const debugState = new Map();
const progressEvents = new Map();

function parseBoolParam(params, key) {
  if (!params.has(key)) return null;
  const raw = params.get(key);
  if (raw === null || raw === "") return true;
  const val = raw.toString().toLowerCase();
  return ["1", "true", "yes", "on"].includes(val);
}

function applyUrlOverrides() {
  const params = new URLSearchParams(window.location.search);
  const debugParam = parseBoolParam(params, "debug");
  config.debug = debugParam === null ? false : debugParam;
}

function t(key, vars = {}) {
  const str = (texts && texts[key]) || DEFAULT_TEXTS[key] || key;
  return Object.keys(vars).reduce((acc, k) => acc.replace(`{${k}}`, vars[k]), str);
}

function setStatus(text, isError = false) {
  if (isError && text) {
    // eslint-disable-next-line no-alert
    alert(text);
  }
  if (statusEl) statusEl.textContent = text || "";
}

function formatTimeLabel(timeStr) {
  if (!timeStr) return "";
  const d = new Date(timeStr);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  if (sameDay) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${d.toLocaleTimeString(
    [],
    { hour: "2-digit", minute: "2-digit" }
  )}`;
}

function formatDateTimeFull(timeStr) {
  if (!timeStr) return "";
  const d = timeStr instanceof Date ? timeStr : new Date(timeStr);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function getCookie(name) {
  const parts = document.cookie.split(";").map((c) => c.trim());
  const match = parts.find((c) => c.startsWith(`${name}=`));
  if (!match) return null;
  return decodeURIComponent(match.slice(name.length + 1));
}

function setCookie(name, value, days = 365) {
  const expires = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/`;
}

function readPreferences() {
  if (userPreferences) return userPreferences;
  const raw = getCookie(LANGUAGE_COOKIE);
  if (!raw) {
    userPreferences = {};
    return userPreferences;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      userPreferences = parsed;
      return userPreferences;
    }
  } catch (e) {
    // fall through to legacy value handling
  }
  userPreferences = { lang: raw };
  return userPreferences;
}

function persistPreferences(partial) {
  const current = readPreferences();
  const merged = { ...current, ...partial };
  userPreferences = merged;
  setCookie(LANGUAGE_COOKIE, JSON.stringify(merged));
}

function persistToggles() {
  persistPreferences({
    toggles: {
      showKmMarkers: Boolean(config?.showKmMarkers),
      showWaypoints: Boolean(config?.showWaypoints),
      showViewerLocation: Boolean(config?.showViewerLocation),
    },
  });
}

function rebuildDistanceTicks() {
  const total = getRouteTotal() || 0;
  const baseKm = Number(config?.kmMarkerInterval ?? DEFAULT_CONFIG.kmMarkerInterval);
  distanceTicks = [];
  if (!total || !baseKm || baseKm <= 0) return;
  const step = baseKm * 1000;
  for (let d = step; d <= total + 1e-6; d += step) {
    distanceTicks.push(d);
  }
}

function applySavedTogglePreferences() {
  const prefs = readPreferences();
  const toggles = prefs?.toggles;
  if (!toggles || typeof toggles !== "object") return;
  if (typeof toggles.showKmMarkers === "boolean") config.showKmMarkers = toggles.showKmMarkers;
  if (typeof toggles.showWaypoints === "boolean") config.showWaypoints = toggles.showWaypoints;
  if (typeof toggles.showViewerLocation === "boolean") config.showViewerLocation = toggles.showViewerLocation;
}

function getSelectedDeviceId() {
  return selectedDeviceId;
}

function filterDevice(id) {
  if (config?.debug) return true;
  if (!config?.deviceIds || !Array.isArray(config.deviceIds)) return true;
  return config.deviceIds.includes(id);
}

function isStale(deviceId) {
  const minutes = Number(config?.staleMinutes ?? DEFAULT_CONFIG.staleMinutes);
  if (!minutes || minutes <= 0) return false;
  const ts = lastSeen.get(deviceId);
  if (!ts) return false;
  const ageMs = Date.now() - new Date(ts).getTime();
  return Number.isFinite(ageMs) && ageMs > minutes * 60 * 1000;
}

function getDeviceProgress(deviceId) {
  return computeDeviceProgress(deviceId, { lastPositions, lastProjection, positionsHistory });
}

function getAverageSpeedForDevice(deviceId) {
  return getAverageSpeedMs(positionsHistory, deviceId, activeStartTimes);
}

function computeEtaForDevice(deviceId, targetDistance) {
  return computeEta(deviceId, targetDistance, {
    lastPositions,
    lastProjection,
    positionsHistory,
    activeStartTimes,
  });
}

async function loadConfig() {
  try {
    const res = await fetch("config.json", { cache: "no-store" });
    if (!res.ok) throw new Error("config.json missing");
    const cfg = await res.json();
    Object.assign(config, DEFAULT_CONFIG, cfg);
    applyUrlOverrides();
    applySavedTogglePreferences();
    texts = { ...DEFAULT_TEXTS };
    setStatus("");
    const pageTitle = config.title || DEFAULT_CONFIG.title;
    if (titleEl) titleEl.textContent = pageTitle;
    document.title = pageTitle;
    rebuildKmMarkers();
    renderWaypoints();
    renderToggles();
    persistToggles();
  } catch (err) {
    setStatus("");
  }
}

async function loadTranslations(preferredLang) {
  const prefs = readPreferences();
  const savedLang = preferredLang || prefs.lang;
  const browserLang = (navigator.language || "en").slice(0, 2).toLowerCase();
  const targetLang =
    savedLang ||
    Object.keys(TRANSLATIONS_MAP).find((code) => code === browserLang) ||
    null;
  let path;
  if (targetLang && TRANSLATIONS_MAP[targetLang]) {
    path = TRANSLATIONS_MAP[targetLang];
    currentLanguage = targetLang;
  } else if (config?.translationFile) {
    path = config.translationFile;
    currentLanguage = targetLang || "en";
  } else {
    path = TRANSLATIONS_MAP.en || "translations/en.json";
    currentLanguage = "en";
  }
  persistPreferences({
    lang: currentLanguage,
    toggles: prefs.toggles,
  });
  try {
    const res = await fetch(path, { cache: "no-store" });
    if (!res.ok) throw new Error("no translation file");
    const data = await res.json();
    texts = { ...DEFAULT_TEXTS, ...data };
  } catch (err) {
    texts = { ...DEFAULT_TEXTS };
  }
  updateLangSelector();
  updateHelpContent();
  updateDownloadButtonLabel();
  renderLegend();
  renderWaypoints();
  renderToggles();
}

function initLangSelector() {
  langSelector = document.getElementById("lang-select");
  if (!langSelector) return;
  langSelector.addEventListener("change", async (e) => {
    const code = e.target.value;
    persistPreferences({ lang: code });
    await loadTranslations(code);
    renderToggles();
  });
  updateLangSelector();
}

function updateLangSelector() {
  if (!langSelector) return;
  const fallback = "en";
  const desired = currentLanguage || fallback;
  const values = Array.from(langSelector.options).map((opt) => opt.value);
  langSelector.value = values.includes(desired) ? desired : fallback;
}

function initDownloadButton() {
  downloadButton = document.getElementById("download-gpx");
  if (!downloadButton) return;
  downloadButton.addEventListener("click", () => {
    const trackFile = config?.trackFile || "tracks/track.gpx";
    const link = document.createElement("a");
    link.href = trackFile;
    link.download = trackFile.split("/").pop() || "track.gpx";
    document.body.appendChild(link);
    link.click();
    link.remove();
  });
  updateDownloadButtonLabel();
}

function updateDownloadButtonLabel() {
  if (!downloadButton) return;
  downloadButton.textContent = t("downloadGpx");
}

async function loadRoute() {
  const trackFile = config?.trackFile || "tracks/track.gpx";
  try {
    const res = await fetch(trackFile, { cache: "no-store" });
    if (!res.ok) throw new Error(`Track ${trackFile} missing`);
    const text = await res.text();
    const { segments, waypoints } = parseGpx(text);
    if (!segments.length) throw new Error(`Track ${trackFile} has no segments`);
    clearRoute();
    buildRouteProfile(segments);
    renderRoute(segments, "#0c8bc7");
    const mappedWps = mapWaypoints(waypoints || []);
    routeWaypoints = mappedWps;
    progressEvents.clear();
    rebuildDistanceTicks();
    setRouteWaypoints(mappedWps);
    renderWaypoints();
    rebuildKmMarkers();
    segments.forEach((seg) => seg.forEach((pt) => extendBounds(pt)));
    fitToData();
  } catch (err) {
    console.error(err);
    setStatus(`Track error: ${trackFile}`, true);
  }
}

function selectDevice(deviceId, { focus = false } = {}) {
  selectedDeviceId = deviceId;
  renderLegend();
  renderWaypoints();
  renderToggles();
  const pos = lastPositions.get(deviceId);
  if (pos) updateMarker(pos);
  if (focus) {
    // focus handled within visualization renderLegend
  }
}

async function refreshDevices() {
  let list = [];
  if (config?.traccarUrl && config?.token) {
    list = await fetchDevices(config);
  }
  if (config?.debug) {
    list.push(
      { id: 10001, name: "Debug Rider 1" },
      { id: 10002, name: "Debug Rider 2" },
      { id: 10003, name: "Debug Rider 3" },
      { id: 10004, name: "Debug Rider 4" },
      { id: 10005, name: "Debug Rider 5" },
      { id: 10006, name: "Debug Start (idle)" },
      { id: 10007, name: "Debug Finish (stopped)" }
    );
  }
  devices.clear();
  list.forEach((d) => devices.set(d.id, d));
  renderLegend();
  if (!selectedDeviceId && list.length) {
    selectDevice(list[0].id);
  }
}

async function fetchRecentHistoryForDevice(deviceId) {
  if (!config?.traccarUrl || !config?.token) return;
  if (!filterDevice(deviceId)) return;
  const now = new Date();
  const from = new Date(now.getTime() - HISTORY_WINDOW_MS);
  const data = await fetchRecentHistory(config, deviceId, from, now);
  const startMs = config?.startTime ? Date.parse(config.startTime) : null;
  const samples = data
    .map((p) => {
      const time = p.deviceTime || p.fixTime || p.serverTime;
      const tVal = time ? Date.parse(time) : NaN;
      return { t: tVal, lat: p.latitude, lng: p.longitude };
    })
    .filter((p) => Number.isFinite(p.t) && (!startMs || p.t >= startMs))
    .sort((a, b) => a.t - b.t);
  positionsHistory.set(deviceId, samples);
}

async function preloadHistory() {
  if (config?.debug) return;
  if (!config?.traccarUrl || !config?.token) return;
  const ids = Array.from(devices.keys()).filter((id) => filterDevice(id));
  await Promise.all(ids.map((id) => fetchRecentHistoryForDevice(id).catch((err) => console.error(err))));
}

function updatePositionHistory(deviceId, coords, timeMs) {
  if (!timeMs) return;
  const startMs = config?.startTime ? Date.parse(config.startTime) : null;
  if (startMs && timeMs < startMs) return;
  const list = positionsHistory.get(deviceId) || [];
  list.push({ t: timeMs, lat: coords[0], lng: coords[1] });
  const cutoff = Date.now() - HISTORY_WINDOW_MS;
  while (list.length && list[0].t < cutoff) list.shift();
  positionsHistory.set(deviceId, list);
}

function ensureProgressEvents(deviceId) {
  let entry = progressEvents.get(deviceId);
  if (!entry) {
    entry = { km: new Map(), waypoints: new Map(), backfilled: false };
    progressEvents.set(deviceId, entry);
  }
  return entry;
}

function backfillProgressFromHistory(deviceId) {
  const events = ensureProgressEvents(deviceId);
  if (events.backfilled) return;
  const hist = positionsHistory.get(deviceId) || [];
  if (!hist.length) return;
  let maxDist = 0;
  let lastTime = null;
  let firstDist = null;
  let firstTime = null;
  let lastDist = null;
  let hint = null;
  hist.forEach((sample) => {
    if (!Number.isFinite(sample.t)) return;
    const proj = projectOnRouteWithHint({ lat: sample.lat, lng: sample.lng }, hint);
    if (!proj || proj.distanceAlong == null) return;
    const dist = proj.distanceAlong;
    if (firstDist == null) {
      firstDist = dist;
      firstTime = sample.t;
    }
    maxDist = Math.max(maxDist, dist);
    lastTime = sample.t;
    if (lastDist != null) {
      distanceTicks.forEach((tick) => {
        if (events.km.has(tick)) return;
        const crossed = dist >= tick && lastDist < tick;
        if (crossed) events.km.set(tick, sample.t);
      });
      routeWaypoints.forEach((wp, idx) => {
        const key = `${idx}:${Math.round(wp.distanceAlong)}`;
        if (events.waypoints.has(key)) return;
        const crossed = dist >= wp.distanceAlong && lastDist < wp.distanceAlong;
        if (crossed) {
          events.waypoints.set(key, { name: wp.name, distanceAlong: wp.distanceAlong, timeMs: sample.t });
        }
      });
    }
    lastDist = dist;
    hint = dist;
  });
  if (maxDist >= 0 && lastTime != null) {
    distanceTicks.forEach((tick) => {
      if (events.km.has(tick)) return;
      if (maxDist >= tick) {
        const t = firstDist != null && tick <= firstDist ? firstTime : lastTime;
        events.km.set(tick, t);
      }
    });
    routeWaypoints.forEach((wp, idx) => {
      const key = `${idx}:${Math.round(wp.distanceAlong)}`;
      if (events.waypoints.has(key)) return;
      if (maxDist >= wp.distanceAlong) {
        const t = firstDist != null && wp.distanceAlong <= firstDist ? firstTime : lastTime;
        events.waypoints.set(key, { name: wp.name, distanceAlong: wp.distanceAlong, timeMs: t });
      }
    });
  }
  events.backfilled = true;
}

function recordProgressEvents(deviceId, prevProj, currProj, timeMs) {
  backfillProgressFromHistory(deviceId);
  if (!currProj || currProj.distanceAlong == null || !timeMs) return;
  const prev = prevProj?.distanceAlong ?? null;
  const curr = currProj.distanceAlong;
  const events = ensureProgressEvents(deviceId);
  distanceTicks.forEach((tick) => {
    if (events.km.has(tick)) return;
    const crossed = prev == null ? curr >= tick : curr >= tick && prev < tick;
    if (crossed) events.km.set(tick, timeMs);
  });
  routeWaypoints.forEach((wp, idx) => {
    const key = `${idx}:${Math.round(wp.distanceAlong)}`;
    if (events.waypoints.has(key)) return;
    const crossed = prev == null ? curr >= wp.distanceAlong : curr >= wp.distanceAlong && prev < wp.distanceAlong;
    if (crossed) {
      events.waypoints.set(key, { name: wp.name, distanceAlong: wp.distanceAlong, timeMs });
    }
  });
}

function getProgressHistory(deviceId) {
  const events = progressEvents.get(deviceId);
  if (!events) return { distances: [], waypoints: [] };
  const distances = Array.from(events.km.entries())
    .map(([distanceAlong, timeMs]) => ({ distanceAlong, timeMs }))
    .sort((a, b) => a.distanceAlong - b.distanceAlong);
  const waypoints = Array.from(events.waypoints.values()).sort(
    (a, b) => a.distanceAlong - b.distanceAlong
  );
  return { distances, waypoints };
}

function handlePosition(position) {
  if (!filterDevice(position.deviceId)) return;
  const time = position.deviceTime || position.fixTime || position.serverTime;
  const timeMs = time ? Date.parse(time) : null;
  const coords = [position.latitude, position.longitude];
  if (time) lastSeen.set(position.deviceId, time);
  const prevProj = lastProjection.get(position.deviceId);
  lastPositions.set(position.deviceId, position);
  if (position.projHintDistanceAlong != null) {
    const t = timeMs || Date.now();
    lastProjection.set(position.deviceId, { distanceAlong: position.projHintDistanceAlong, t });
  }
  if (timeMs) updatePositionHistory(position.deviceId, coords, timeMs);
  const prog = getDeviceProgress(position.deviceId);
  markActiveOnRoute(position.deviceId, prog, activeStartTimes, timeMs || Date.now());
  if (timeMs) recordProgressEvents(position.deviceId, prevProj, prog?.proj, timeMs);
  updateMarker(position);
}

async function refreshPositions() {
  let positions = [];
  if (config?.traccarUrl && config?.token) {
    positions = await fetchPositions(config);
  }
  if (config?.debug) {
    const debugPos = buildDebugPositions(
      debugState,
      config,
      getRouteTotal(),
      getRoutePoints(),
      positionsHistory
    );
    positions.push(...debugPos);
  }
  positions.forEach(handlePosition);
  renderLegend();
  renderWaypoints();
  fitToData();
}

async function startPolling() {
  if ((!config?.token || !config?.traccarUrl) && !config?.debug) return;
  await refreshDevices().catch((err) => {
    console.error(err);
    setStatus("");
  });
  await preloadHistory().catch((err) => {
    console.error(err);
    setStatus("");
  });
  await refreshPositions().catch((err) => {
    console.error(err);
    setStatus("");
  });
  renderToggles();
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    refreshPositions().catch((err) => {
      console.error(err);
      setStatus("");
    });
  }, (config.refreshSeconds || DEFAULT_CONFIG.refreshSeconds) * 1000);
}

function setupUiBindings() {
  setupVisualization({
    config,
    t,
    computeEta: computeEtaForDevice,
    getDeviceProgress,
    getAverageSpeedMs: getAverageSpeedForDevice,
    getProgressHistory,
    isStale,
    formatDateTimeFull,
    formatTimeLabel,
    selectDevice,
    getSelectedDeviceId,
    filterDevice,
    projectOnRoute,
    startViewerLocation: () => vizStartViewerLocation(),
    stopViewerLocation: () => vizStopViewerLocation(),
    persistToggles,
    devices,
    lastSeen,
    lastPositions,
  });
}

async function bootstrap() {
  setupUiBindings();
  initMap();
  initContextMenu();
  await loadConfig();
  initLangSelector();
  initDownloadButton();
  await loadTranslations();
  await loadRoute();
  await startPolling();
  vizStartViewerLocation();
  installDebugInfoHook({
    devices,
    lastPositions,
    lastProjection,
    positionsHistory,
    activeStartTimes,
  });
}

bootstrap();
