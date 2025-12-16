import {
  DEFAULT_CONFIG,
  DEFAULT_TEXTS,
  TRANSLATIONS_MAP,
  LANGUAGE_COOKIE,
  KM_MARKER_BASE_KM,
  ACTIVE_DISTANCE_THRESHOLD,
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
  getRouteAvgLat,
  getRouteElevationProfile,
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
  setElevationProfile,
  setElevationProgress,
  startViewerLocation as vizStartViewerLocation,
  stopViewerLocation as vizStopViewerLocation,
  updateHelpContent,
  refreshHistoryOverlay,
} from "./src/visualization.js";
import {
  clearNowOverride,
  getNowDate,
  getNowMs,
  getOverrideTicking,
  hasNowOverride,
  setNowOverride,
  setOverrideTicking,
} from "./src/time.js";

const statusEl = document.getElementById("status");
const titleEl = document.getElementById("title");
const countdownEl = document.getElementById("countdown");
const countdownLabelEl = document.getElementById("countdown-label");
const countdownTimeEl = document.getElementById("countdown-time");
const countdownStartEl = document.getElementById("countdown-start");
const countdownOverlayEl = document.getElementById("countdown-overlay");
const countdownOverlayLabelEl = document.getElementById("countdown-overlay-label");
const countdownOverlayTimeEl = document.getElementById("countdown-overlay-time");
const countdownOverlayStartEl = document.getElementById("countdown-overlay-start");
const countdownOverlayCloseEl = document.getElementById("countdown-overlay-close");
const countdownOverlayDismissEl = document.getElementById("countdown-overlay-dismiss");
const countdownOverlayNeverEl = document.getElementById("countdown-overlay-never");
const debugTimeWrapEl = document.getElementById("debug-time");
const debugTimeInputEl = document.getElementById("debug-time-input");
const debugTimeApplyEl = document.getElementById("debug-time-apply");
const debugTimeToggleEl = document.getElementById("debug-time-toggle");
const debugTimeToggleStateEl = document.getElementById("debug-time-toggle-state");
const debugTimeLabelEl = document.getElementById("debug-time-label");
let config = { ...DEFAULT_CONFIG };
let texts = { ...DEFAULT_TEXTS };
let currentLanguage = "en";
let selectedDeviceId = null;
let refreshTimer;
let countdownTimer;
let downloadButton;
let langSelector;
let userPreferences;
let panelPreferencesCache = null;
let routeWaypoints = [];
let distanceTicks = [];
let weatherToggle;
let weatherPanel;
let weatherForecastEl;
let weatherErrorEl;
let weatherSummaryEl;
let weatherUpdatedEl;
const weatherState = { expanded: false, pending: false };
let weatherOverlay;
const WEATHER_PAGE_SIZE = 6;
const WEATHER_MAX_HOURS = 24;
let weatherPageOffset = 0;
const WEATHER_STALE_MS = 10 * 60 * 1000;
const weatherCache = new Map();
const DEFAULT_HISTORY_HOURS = 24;
let initialSelectedDeviceId = null;
let eventStartMs = null;
let countdownOverlayDismissed = false;
const COUNTDOWN_OVERLAY_PREF = "hideCountdownOverlay";
let initialTimeOverrideMs = null;
let initialTimeOverrideTicking = true;
let mapViewPreference = null;

function getHistoryRetentionMs() {
  const hours = Number(config?.historyHours ?? DEFAULT_HISTORY_HOURS);
  if (!Number.isFinite(hours) || hours <= 0) return DEFAULT_HISTORY_HOURS * 60 * 60 * 1000;
  return hours * 60 * 60 * 1000;
}

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
  if (debugParam !== null) {
    config.debug = debugParam;
  }
  const timeParam = params.get("debugTime");
  if (timeParam) {
    const parsed = Number.isFinite(Number(timeParam)) ? Number(timeParam) : Date.parse(timeParam);
    if (Number.isFinite(parsed)) initialTimeOverrideMs = parsed;
  }
  const freezeParam = parseBoolParam(params, "debugTimeFreeze");
  if (freezeParam !== null) {
    initialTimeOverrideTicking = !freezeParam;
    if (!timeParam && freezeParam) {
      initialTimeOverrideMs = Date.now();
    }
  }
}

function normalizeDebugTimeParamIfNeeded() {
  const params = new URLSearchParams(window.location.search);
  const debugParam = parseBoolParam(params, "debug");
  const isDebug = debugParam === null ? Boolean(config?.debug) : debugParam;
  if (!isDebug) return false;
  const timeParam = params.get("debugTime");
  if (!timeParam) {
    const nowIso = new Date().toISOString();
    params.set("debugTime", nowIso);
    const next = `${window.location.pathname}?${params.toString()}${window.location.hash}`;
    window.location.replace(next);
    return true;
  }
  return false;
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
  const today = getNowDate();
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

function parseEventStart(raw) {
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatCountdownMs(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (days || hours) parts.push(`${hours}h`);
  if (days || hours || minutes) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(" ");
}

function getEventStartMs() {
  return Number.isFinite(eventStartMs) ? eventStartMs : null;
}

function getExpectedSpeedMs() {
  if (!Number.isFinite(config?.expectedAvgSpeedKph)) return 0;
  if (config.expectedAvgSpeedKph <= 0) return 0;
  return config.expectedAvgSpeedKph / 3.6;
}

function shouldHideCountdownOverlay() {
  const prefs = readPreferences();
  return Boolean(prefs?.[COUNTDOWN_OVERLAY_PREF]);
}

function hideCountdownOverlay({ persist = false } = {}) {
  if (persist) persistPreferences({ [COUNTDOWN_OVERLAY_PREF]: true });
  countdownOverlayDismissed = true;
  if (countdownOverlayEl) countdownOverlayEl.classList.add("hidden");
}

function updateCountdownOverlayCopy() {
  if (countdownOverlayLabelEl) countdownOverlayLabelEl.textContent = t("countdownOverlayHeading");
  if (countdownOverlayDismissEl) countdownOverlayDismissEl.textContent = t("countdownOverlayDismiss");
  if (countdownOverlayNeverEl) countdownOverlayNeverEl.textContent = t("countdownOverlayNever");
}

function formatDatetimeLocalValue(ms) {
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const min = pad(d.getMinutes());
  return `${yyyy}-${mm}-${dd}T${hh}:${min}`;
}

function updateDebugTimeTexts() {
  if (debugTimeLabelEl) debugTimeLabelEl.textContent = t("debugTimeLabel");
  if (debugTimeApplyEl) debugTimeApplyEl.textContent = t("debugTimeApply");
  if (debugTimeToggleStateEl) {
    const ticking = debugTimeToggleEl ? debugTimeToggleEl.checked : getOverrideTicking();
    debugTimeToggleStateEl.textContent = ticking === false ? t("debugTimeFrozen") : t("debugTimeTicking");
  }
}

function setDebugTimeInputValue(ms) {
  if (!debugTimeInputEl) return;
  debugTimeInputEl.value = formatDatetimeLocalValue(ms);
}

function updateUrlDebugTimeParams({ timeMs, ticking } = {}) {
  const params = new URLSearchParams(window.location.search);
  if (!params.has("debug") && !config?.debug) return;
  if (Number.isFinite(timeMs)) {
    params.set("debugTime", new Date(timeMs).toISOString());
  } else {
    params.delete("debugTime");
  }
  if (typeof ticking === "boolean") {
    params.set("debugTimeFreeze", ticking ? "false" : "true");
  }
  const next = `${window.location.pathname}?${params.toString()}${window.location.hash}`;
  window.history.replaceState({}, "", next);
}

function applyDebugTimeOverride(ms) {
  if (!config?.debug) {
    clearNowOverride();
    return;
  }
  if (!Number.isFinite(ms)) {
    clearNowOverride();
    setDebugTimeInputValue(null);
    const ticking = debugTimeToggleEl ? debugTimeToggleEl.checked : true;
    if (!ticking) {
      setNowOverride(Date.now(), { ticking: false });
    }
  } else {
    const ticking = debugTimeToggleEl ? debugTimeToggleEl.checked : true;
    setNowOverride(ms, { ticking });
    setDebugTimeInputValue(ms);
  }
  updateUrlDebugTimeParams({ timeMs: Number.isFinite(ms) ? ms : null, ticking: debugTimeToggleEl ? debugTimeToggleEl.checked : null });
  countdownOverlayDismissed = false;
  refreshCountdownTimer();
  refreshWeather(true).catch((err) => console.error(err));
  if (config?.debug) {
    refreshPositions().catch((err) => console.error(err));
  }
}

function restoreDebugTimeOverride() {
  if (!config?.debug) {
    clearNowOverride();
    setDebugTimeInputValue(null);
    return false;
  }
  if (Number.isFinite(initialTimeOverrideMs)) {
    setNowOverride(initialTimeOverrideMs, { ticking: initialTimeOverrideTicking });
    setDebugTimeInputValue(initialTimeOverrideMs);
    if (debugTimeToggleEl) debugTimeToggleEl.checked = Boolean(initialTimeOverrideTicking);
    return true;
  }
  clearNowOverride();
  setDebugTimeInputValue(null);
  return false;
}

function stopCountdownTimer() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

function renderCountdown() {
  const startMs = getEventStartMs();
  if (!startMs) {
    if (countdownLabelEl) countdownLabelEl.textContent = "";
    if (countdownTimeEl) countdownTimeEl.textContent = "";
    if (countdownStartEl) countdownStartEl.textContent = "";
    if (countdownEl) countdownEl.classList.add("hidden");
    if (countdownOverlayTimeEl) countdownOverlayTimeEl.textContent = "";
    if (countdownOverlayStartEl) countdownOverlayStartEl.textContent = "";
    if (countdownOverlayEl) countdownOverlayEl.classList.add("hidden");
    stopCountdownTimer();
    return;
  }
  const diff = startMs - getNowMs();
  if (diff <= 0) {
    if (countdownLabelEl) countdownLabelEl.textContent = "";
    if (countdownTimeEl) countdownTimeEl.textContent = "";
    if (countdownStartEl) countdownStartEl.textContent = "";
    if (countdownEl) countdownEl.classList.add("hidden");
    if (countdownOverlayEl) countdownOverlayEl.classList.add("hidden");
    stopCountdownTimer();
    return;
  }
  if (countdownEl) countdownEl.classList.remove("hidden");
  if (countdownLabelEl) countdownLabelEl.textContent = t("countdownStartsIn");
  if (countdownTimeEl) countdownTimeEl.textContent = formatCountdownMs(diff);
  if (countdownStartEl) {
    countdownStartEl.textContent = t("countdownStartAt", {
      time: formatDateTimeFull(new Date(startMs)),
    });
  }
  renderCountdownOverlay(startMs, diff);
}

function renderCountdownOverlay(startMs, diff) {
  if (!countdownOverlayEl) return;
  const shouldShow =
    Number.isFinite(startMs) &&
    diff > 0 &&
    !countdownOverlayDismissed &&
    !shouldHideCountdownOverlay();
  countdownOverlayEl.classList.toggle("hidden", !shouldShow);
  if (!shouldShow) return;
  if (countdownOverlayTimeEl) countdownOverlayTimeEl.textContent = formatCountdownMs(diff);
  if (countdownOverlayStartEl) {
    countdownOverlayStartEl.textContent = t("countdownStartAt", {
      time: formatDateTimeFull(new Date(startMs)),
    });
  }
  updateCountdownOverlayCopy();
}

function refreshCountdownTimer() {
  stopCountdownTimer();
  renderCountdown();
  const startMs = getEventStartMs();
  if (startMs && startMs > getNowMs()) {
    countdownTimer = setInterval(renderCountdown, 1000);
  }
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

function getPanelPreferences() {
  const prefs = readPreferences();
  const panels = prefs?.panels;
  if (panels && typeof panels === "object") {
    panelPreferencesCache = panels;
    return panels;
  }
  panelPreferencesCache = panelPreferencesCache || {};
  return panelPreferencesCache;
}

function persistPanels(partial) {
  const merged = { ...getPanelPreferences(), ...partial };
  panelPreferencesCache = merged;
  persistPreferences({ panels: merged });
}

function getMapViewPreference() {
  if (mapViewPreference) return mapViewPreference;
  const prefs = readPreferences();
  const mv = prefs?.mapView;
  if (
    mv &&
    typeof mv === "object" &&
    Number.isFinite(mv.lat) &&
    Number.isFinite(mv.lng) &&
    Number.isFinite(mv.zoom)
  ) {
    mapViewPreference = { lat: mv.lat, lng: mv.lng, zoom: mv.zoom };
    return mapViewPreference;
  }
  return null;
}

function persistMapViewPreference(view) {
  if (
    !view ||
    !Number.isFinite(view.lat) ||
    !Number.isFinite(view.lng) ||
    !Number.isFinite(view.zoom)
  ) {
    return;
  }
  mapViewPreference = { lat: view.lat, lng: view.lng, zoom: view.zoom };
  persistPreferences({ mapView: mapViewPreference });
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
  distanceTicks = [];
  if (!total) return;
  const step = 1000; // always track history ticks every 1 km
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

function applySavedSelectedDevice(list) {
  const prefs = readPreferences();
  const preferredId = prefs?.selectedDeviceId;
  const hasPreferred = preferredId && list?.some((d) => d.id === preferredId);
  initialSelectedDeviceId = hasPreferred ? preferredId : null;
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
  const ageMs = getNowMs() - new Date(ts).getTime();
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
    expectedSpeedMs: getExpectedSpeedMs(),
  });
}

async function loadConfig() {
  try {
    const res = await fetch("config.json", { cache: "no-store" });
    if (!res.ok) throw new Error("config.json missing");
    const cfg = await res.json();
    Object.assign(config, DEFAULT_CONFIG, cfg);
    eventStartMs = parseEventStart(config.startTime);
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
    refreshCountdownTimer();
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
  updateCountdownOverlayCopy();
  updateDebugTimeTexts();
  renderCountdown();
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

function setupCountdownOverlay() {
  if (countdownOverlayCloseEl) {
    countdownOverlayCloseEl.addEventListener("click", () => hideCountdownOverlay());
  }
  if (countdownOverlayDismissEl) {
    countdownOverlayDismissEl.addEventListener("click", () => hideCountdownOverlay());
  }
  if (countdownOverlayNeverEl) {
    countdownOverlayNeverEl.addEventListener("click", () => hideCountdownOverlay({ persist: true }));
  }
  updateCountdownOverlayCopy();
}

function setupDebugTimeControls() {
  if (!debugTimeWrapEl) return;
  const show = Boolean(config?.debug);
  debugTimeWrapEl.classList.toggle("hidden", !show);
  updateDebugTimeTexts();
  if (!show) {
    clearNowOverride();
    return;
  }
  const restored = restoreDebugTimeOverride();
  if (restored) {
    updateUrlDebugTimeParams({
      timeMs: Number.isFinite(initialTimeOverrideMs) ? initialTimeOverrideMs : null,
      ticking: initialTimeOverrideTicking,
    });
    refreshCountdownTimer();
    refreshWeather(true).catch((err) => console.error(err));
    if (config?.debug) {
      refreshPositions().catch((err) => console.error(err));
    }
  }
  if (debugTimeApplyEl) {
    debugTimeApplyEl.addEventListener("click", () => {
      const raw = debugTimeInputEl?.value;
      if (!raw) {
        applyDebugTimeOverride(NaN);
        updateDebugTimeTexts();
        return;
      }
      const parsed = Date.parse(raw);
      if (!Number.isFinite(parsed)) return;
      applyDebugTimeOverride(parsed);
      updateDebugTimeTexts();
    });
  }
  if (debugTimeToggleEl) {
    debugTimeToggleEl.addEventListener("change", () => {
      const ticking = debugTimeToggleEl.checked;
      if (hasNowOverride()) {
        setNowOverride(getNowMs(), { ticking });
      } else if (!ticking) {
        setNowOverride(Date.now(), { ticking: false });
        setDebugTimeInputValue(Date.now());
      } else {
        clearNowOverride();
        setDebugTimeInputValue(null);
      }
      updateUrlDebugTimeParams({
        timeMs: hasNowOverride() ? getNowMs() : null,
        ticking,
      });
      updateDebugTimeTexts();
      countdownOverlayDismissed = false;
      refreshCountdownTimer();
      refreshWeather(true).catch((err) => console.error(err));
      if (config?.debug) {
        refreshPositions().catch((err) => console.error(err));
      }
    });
  }
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
  const label = t("downloadGpx");
  downloadButton.setAttribute("aria-label", label);
  downloadButton.setAttribute("title", label);
}

function getRouteCenter() {
  const pts = getRoutePoints();
  if (!pts?.length) return null;
  const avgLat = getRouteAvgLat();
  const avgLng = pts.reduce((sum, p) => sum + p.lng, 0) / pts.length;
  return { lat: avgLat, lng: avgLng };
}

function renderWeatherSummary(data) {
  if (!weatherSummaryEl) return;
  const summary = data?.summary;
  if (!summary) {
    weatherSummaryEl.textContent = t("weatherUnavailable");
    return;
  }
  const temp = summary.temp;
  const wind = summary.wind;
  const precip = summary.precip;
  const parts = [];
  if (Number.isFinite(precip)) parts.push(`${precip.toFixed(1)} mm ${t("weatherPrecip")}`);
  if (Number.isFinite(temp)) parts.push(`${Math.round(temp)}°C`);
  if (Number.isFinite(wind)) parts.push(`${Math.round(wind)} km/h ${t("weatherWind")}`);
  weatherSummaryEl.textContent = parts.join(" · ") || t("weatherUnavailable");
}

function renderWeatherForecast(data) {
  if (!weatherForecastEl) return;
  const rows = data?.rows || [];
  weatherForecastEl.innerHTML = "";
  if (!rows.length) {
    weatherForecastEl.textContent = t("weatherUnavailable");
    return;
  }
  rows.forEach((row) => {
    const div = document.createElement("button");
    div.type = "button";
    div.className = "weather-row";
    const left = document.createElement("div");
    left.className = "weather-label";
    left.textContent = row.label;
    const right = document.createElement("div");
    right.className = "weather-meta";
    const bits = [];
    if (row.temp != null) bits.push(`${row.temp}°C`);
    if (row.precip != null) bits.push(`${row.precip}% rain`);
    if (row.wind != null) bits.push(`${row.wind} km/h`);
    const distanceLabel =
      row.distanceAlong != null && Number.isFinite(row.distanceAlong)
        ? `${Math.round((row.distanceAlong / 1000) * 10) / 10} km`
        : null;
    if (distanceLabel) bits.push(distanceLabel);
    right.textContent = bits.join(" · ");
    div.append(left, right);
    if (row.coord) {
      div.addEventListener("click", () => {
        const ts = row.timeMs ? new Date(row.timeMs).toISOString() : "";
    const url = `https://www.accuweather.com/en/search-locations?query=${row.coord.lat.toFixed(4)},${row.coord.lng.toFixed(4)}`;
    window.open(url, "_blank", "noopener");
  });
}
    weatherForecastEl.appendChild(div);
  });
}

function setWeatherExpanded(expanded) {
  weatherState.expanded = expanded;
  if (weatherPanel) weatherPanel.classList.toggle("hidden", !expanded);
}

function hideWeatherOverlay() {
  if (weatherOverlay && weatherOverlay.parentNode) {
    weatherOverlay.parentNode.removeChild(weatherOverlay);
  }
  weatherOverlay = null;
}

function formatWeatherDetails(row) {
  const bits = [];
  if (row.temp != null) bits.push(`${row.temp}°C`);
  if (row.precip != null) bits.push(`${row.precip}% ${t("weatherPrecip")}`);
  if (row.wind != null) bits.push(`${row.wind} km/h ${t("weatherWind")}`);
  return bits.join(" · ") || t("weatherUnavailable");
}

function renderWeatherOverlay(data) {
  hideWeatherOverlay();
  const overlay = document.createElement("div");
  overlay.className = "weather-modal-overlay";
  const modal = document.createElement("div");
  modal.className = "weather-modal";
  const header = document.createElement("div");
  header.className = "weather-modal-header";
  const title = document.createElement("div");
  title.className = "weather-modal-title";
  title.textContent = t("weatherNextHours", { hours: WEATHER_PAGE_SIZE });
  const nav = document.createElement("div");
  nav.className = "weather-modal-nav";
  const prevBtn = document.createElement("button");
  prevBtn.type = "button";
  prevBtn.className = "weather-nav-btn";
  prevBtn.textContent = t("weatherPrev");
  prevBtn.disabled = weatherPageOffset <= 0;
  prevBtn.addEventListener("click", async () => {
    weatherPageOffset = Math.max(0, weatherPageOffset - WEATHER_PAGE_SIZE);
    const nextData = await refreshWeather(true, selectedDeviceId, WEATHER_PAGE_SIZE, weatherPageOffset);
    renderWeatherOverlay(nextData);
  });
  const nextBtn = document.createElement("button");
  nextBtn.type = "button";
  nextBtn.className = "weather-nav-btn";
  nextBtn.textContent = t("weatherNext");
  nextBtn.disabled = weatherPageOffset + WEATHER_PAGE_SIZE >= WEATHER_MAX_HOURS;
  nextBtn.addEventListener("click", async () => {
    weatherPageOffset = Math.min(WEATHER_MAX_HOURS - WEATHER_PAGE_SIZE, weatherPageOffset + WEATHER_PAGE_SIZE);
    const nextData = await refreshWeather(true, selectedDeviceId, WEATHER_PAGE_SIZE, weatherPageOffset);
    renderWeatherOverlay(nextData);
  });
  nav.append(prevBtn, nextBtn);
  const updated = document.createElement("div");
  updated.className = "weather-modal-updated";
  if (weatherUpdatedEl?.textContent) updated.textContent = weatherUpdatedEl.textContent;
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "weather-modal-close";
  closeBtn.textContent = t("closeLabel");
  closeBtn.addEventListener("click", hideWeatherOverlay);
  header.append(title, nav, updated, closeBtn);

  const rows = data?.rows || [];
  const list = document.createElement("div");
  list.className = "weather-modal-list";
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "weather-modal-empty";
    empty.textContent = t("weatherUnavailable");
    list.appendChild(empty);
  } else {
    rows.forEach((row) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "weather-modal-row";
      const timeCol = document.createElement("div");
      timeCol.className = "weather-modal-col time";
      timeCol.textContent = row.timeMs ? formatTimeLabel(new Date(row.timeMs)) : row.label || "";
      const distCol = document.createElement("div");
      distCol.className = "weather-modal-col distance";
      distCol.textContent =
        row.distanceAlong != null && Number.isFinite(row.distanceAlong)
          ? `${Math.round((row.distanceAlong / 1000) * 10) / 10} km`
          : "—";
      const condCol = document.createElement("div");
      condCol.className = "weather-modal-col conditions";
      condCol.textContent = formatWeatherDetails(row);
      item.append(timeCol, distCol, condCol);
      if (row.coord) {
        item.addEventListener("click", () => {
          const url = `https://www.accuweather.com/en/search-locations?query=${row.coord.lat.toFixed(4)},${row.coord.lng.toFixed(4)}`;
          window.open(url, "_blank", "noopener");
        });
      }
      list.appendChild(item);
    });
  }

  modal.append(header, list);
  overlay.appendChild(modal);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) hideWeatherOverlay();
  });
  document.body.appendChild(overlay);
  weatherOverlay = overlay;
}

async function showWeatherOverlay(deviceId = selectedDeviceId) {
  weatherPageOffset = 0;
  const data = await refreshWeather(false, deviceId, WEATHER_PAGE_SIZE, weatherPageOffset);
  if (!data) {
    hideWeatherOverlay();
    return;
  }
  renderWeatherOverlay(data);
}

function findClosestHourly(data, targetMs) {
  const times = data?.hourly?.time || [];
  const temps = data?.hourly?.temperature_2m || [];
  const precip = data?.hourly?.precipitation_probability || [];
  const wind = data?.hourly?.wind_speed_10m || [];
  let bestIdx = -1;
  let bestDiff = Infinity;
  times.forEach((timeStr, idx) => {
    const ts = Date.parse(timeStr);
    if (!Number.isFinite(ts)) return;
    const diff = Math.abs(ts - targetMs);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = idx;
    }
  });
  if (bestIdx === -1) return null;
  return {
    temp: Number.isFinite(temps[bestIdx]) ? temps[bestIdx] : null,
    precipProb: Number.isFinite(precip[bestIdx]) ? precip[bestIdx] : null,
    wind: Number.isFinite(wind[bestIdx]) ? wind[bestIdx] : null,
  };
}

async function fetchWeatherForPoint(planItem) {
  const params = new URLSearchParams({
    latitude: planItem.coord.lat.toFixed(4),
    longitude: planItem.coord.lng.toFixed(4),
    current: "temperature_2m,wind_speed_10m,precipitation",
    hourly: "temperature_2m,precipitation_probability,wind_speed_10m",
    forecast_days: "2",
    timezone: "auto",
  });
  const url = `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error("Weather request failed");
  const data = await res.json();
  const closest = findClosestHourly(data, planItem.timeMs);
  const row = {
    label: formatTimeLabel(planItem.timeMs),
    timeMs: planItem.timeMs,
    temp: closest?.temp != null ? Math.round(closest.temp) : null,
    precip: closest?.precipProb != null ? Math.round(closest.precipProb) : null,
    wind: closest?.wind != null ? Math.round(closest.wind) : null,
    distanceAlong: planItem.distanceAlong ?? null,
    coord: planItem.coord || null,
  };
  const summary = data.current
    ? {
        temp: data.current.temperature_2m,
        wind: data.current.wind_speed_10m,
        precip: data.current.precipitation,
      }
    : null;
  return { row, summary };
}

function getWeatherPlan(deviceId, hours = WEATHER_PAGE_SIZE, offsetHours = 0) {
  const total = getRouteTotal() || 0;
  const progress = deviceId ? getDeviceProgress(deviceId) : null;
  const startMs = getEventStartMs();
  const now = getNowMs();
  const baseTime = startMs && startMs > now ? startMs : now;
  if (progress && !progress.offtrack && progress.proj?.distanceAlong != null) {
    const speedMs = getAverageSpeedForDevice(deviceId) || getExpectedSpeedMs();
    const baseDist = progress.proj.distanceAlong;
    const plan = [];
    for (let i = 0; i < hours; i += 1) {
      const offsetMs = (offsetHours + i + 1) * 60 * 60 * 1000;
      const delta = speedMs > 0 ? (speedMs * offsetMs) / 1000 : 0;
      const targetDist = Math.min(total || baseDist, baseDist + delta);
      const coord = pointAtDistance(targetDist) || progress.proj.point || progress.pos || null;
      if (!coord) break;
      plan.push({ timeMs: baseTime + offsetMs, coord, distanceAlong: targetDist });
    }
    if (plan.length) return plan;
  }
  const speedMs = getExpectedSpeedMs();
  const pts = getRoutePoints();
  const startCoord = pts?.length ? pts[0] : getRouteCenter();
  if (!startCoord) return null;
  return Array.from({ length: hours }, (_, idx) => {
    const offsetMs = (offsetHours + idx + 1) * 60 * 60 * 1000;
    const targetDist = speedMs > 0 ? Math.min(total || 0, (speedMs * offsetMs) / 1000) : 0;
    const coord = targetDist && pointAtDistance(targetDist) ? pointAtDistance(targetDist) : startCoord;
    return {
      timeMs: baseTime + offsetMs,
      coord,
      distanceAlong: targetDist || null,
    };
  });
}

async function fetchWeatherSeries(deviceId, hours = WEATHER_PAGE_SIZE, offsetHours = 0) {
  const plan = getWeatherPlan(deviceId, hours, offsetHours);
  if (!plan || !plan.length) throw new Error("No route to infer location");
  const results = await Promise.all(plan.map((item) => fetchWeatherForPoint(item)));
  const summary = results.find((r) => r.summary)?.summary || null;
  const rows = results.map((r) => r.row);
  return { summary, rows };
}

function getWeatherCacheKey(deviceId, hours = WEATHER_PAGE_SIZE, offsetHours = 0) {
  const idPart = deviceId != null ? String(deviceId) : "route";
  return `${idPart}|${hours}|${offsetHours}`;
}

async function refreshWeather(
  force = false,
  deviceId = selectedDeviceId,
  hours = WEATHER_PAGE_SIZE,
  offsetHours = weatherPageOffset
) {
  if (weatherState.pending) return null;
  const cacheKey = getWeatherCacheKey(deviceId, hours, offsetHours);
  const cached = weatherCache.get(cacheKey);
  if (!force && cached && getNowMs() - cached.lastFetch < WEATHER_STALE_MS) {
    renderWeatherSummary(cached.data);
    if (weatherUpdatedEl) {
      weatherUpdatedEl.textContent = new Date(cached.lastFetch).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
    }
    return cached.data;
  }
  weatherState.pending = true;
  if (weatherErrorEl) {
    weatherErrorEl.classList.add("hidden");
    weatherErrorEl.textContent = "";
  }
  if (weatherForecastEl) weatherForecastEl.textContent = t("weatherFetching");
  try {
    const data = await fetchWeatherSeries(deviceId, hours, offsetHours);
    const entry = { data, lastFetch: getNowMs() };
    weatherCache.set(cacheKey, entry);
    renderWeatherSummary(entry.data);
    renderWeatherForecast(entry.data);
    if (weatherUpdatedEl) {
      weatherUpdatedEl.textContent = getNowDate().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    return entry.data;
  } catch (err) {
    console.error(err);
    if (weatherErrorEl) {
      weatherErrorEl.textContent = t("weatherUnavailable");
      weatherErrorEl.classList.remove("hidden");
    }
    return null;
  } finally {
    weatherState.pending = false;
  }
}

function setupWeatherWidget() {
  weatherToggle = document.getElementById("weather-toggle");
  weatherPanel = document.getElementById("weather-panel");
  weatherForecastEl = document.getElementById("weather-forecast");
  weatherErrorEl = document.getElementById("weather-error");
  weatherSummaryEl = document.getElementById("weather-summary");
  weatherUpdatedEl = document.getElementById("weather-updated");
  const titleEl = document.getElementById("weather-panel-title");
  if (titleEl) titleEl.textContent = t("weatherTitle");
  if (weatherSummaryEl) weatherSummaryEl.textContent = "";
  setWeatherExpanded(false);
  if (weatherPanel) weatherPanel.classList.add("hidden");
  if (weatherToggle) {
    weatherToggle.addEventListener("click", () => {
      showWeatherOverlay().catch((err) => console.error(err));
    });
  }
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
    setElevationProfile(getRouteElevationProfile());
    const mappedWps = mapWaypoints(waypoints || []);
    routeWaypoints = mappedWps;
    progressEvents.clear();
    weatherCache.clear();
    rebuildDistanceTicks();
    setRouteWaypoints(mappedWps);
    renderWaypoints();
    rebuildKmMarkers();
    segments.forEach((seg) => seg.forEach((pt) => extendBounds(pt)));
    fitToData();
    refreshWeather(true).catch((err) => console.error(err));
  } catch (err) {
    console.error(err);
    setStatus(`Track error: ${trackFile}`, true);
  }
}

function selectDevice(deviceId, { focus = false } = {}) {
  selectedDeviceId = deviceId;
  persistPreferences({ selectedDeviceId: deviceId });
  renderLegend();
  renderWaypoints();
  renderToggles();
  const pos = lastPositions.get(deviceId);
  if (pos) updateMarker(pos);
  const prog = getDeviceProgress(deviceId);
  if (prog?.proj?.distanceAlong != null) {
    setElevationProgress(prog.proj.distanceAlong);
  }
  if (focus) {
    // focus handled within visualization renderLegend
  }
  refreshWeather(true, deviceId).catch((err) => console.error(err));
}

async function refreshDevices() {
  let list = [];
  if (!config?.debug && config?.traccarUrl && config?.token) {
    list = await fetchDevices(config);
  }
  if (config?.debug) {
    list = [
      { id: 10001, name: "Debug Rider 1" },
      { id: 10002, name: "Debug Rider 2" },
      { id: 10003, name: "Debug Rider 3" },
      { id: 10004, name: "Debug Rider 4" },
      { id: 10005, name: "Debug Rider 5" },
    ];
  }
  devices.clear();
  list.forEach((d) => devices.set(d.id, d));
  applySavedSelectedDevice(list);
  renderLegend();
  if (!selectedDeviceId && list.length) {
    const preferred = initialSelectedDeviceId && devices.has(initialSelectedDeviceId) ? initialSelectedDeviceId : null;
    const targetId = preferred || list[0].id;
    selectDevice(targetId);
  }
}

async function fetchRecentHistoryForDevice(deviceId) {
  if (!config?.traccarUrl || !config?.token) return;
  if (!filterDevice(deviceId)) return;
  const now = getNowDate();
  const from = new Date(now.getTime() - getHistoryRetentionMs());
  const data = await fetchRecentHistory(config, deviceId, from, now);
  const startMs = getEventStartMs();
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
  const startMs = getEventStartMs();
  if (startMs && timeMs < startMs) return;
  const list = positionsHistory.get(deviceId) || [];
  list.push({ t: timeMs, lat: coords[0], lng: coords[1] });
  const cutoff = getNowMs() - getHistoryRetentionMs();
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

function updateWaypointEvent(entry, wp, prevDist, currDist, prevTime, currTime) {
  const pad = ACTIVE_DISTANCE_THRESHOLD;
  const low = (wp.distanceAlong || 0) - pad;
  const high = (wp.distanceAlong || 0) + pad;
  const prevIn = Number.isFinite(prevDist) && prevDist >= low && prevDist <= high;
  const currIn = Number.isFinite(currDist) && currDist >= low && currDist <= high;
  const crossed =
    Number.isFinite(prevDist) &&
    Number.isFinite(currDist) &&
    prevDist < low &&
    currDist > high;
  if (!entry.enterMs && (currIn || crossed)) {
    entry.enterMs = prevTime ?? currTime ?? getNowMs();
  }
  if (entry.enterMs && !entry.leaveMs && ((prevIn && !currIn && Number.isFinite(currDist) && currDist > high) || crossed)) {
    entry.leaveMs = currTime ?? prevTime ?? entry.enterMs;
  }
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
    const prevDist = lastDist;
    const prevTime = lastTime;
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
        const entry = events.waypoints.get(key) || {
          name: wp.name,
          distanceAlong: wp.distanceAlong,
          enterMs: null,
          leaveMs: null,
        };
        updateWaypointEvent(entry, wp, prevDist, dist, prevTime, sample.t);
        if (entry.enterMs || entry.leaveMs) events.waypoints.set(key, entry);
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
      const pad = ACTIVE_DISTANCE_THRESHOLD;
      const high = (wp.distanceAlong || 0) + pad;
      if (maxDist >= wp.distanceAlong) {
        const t = firstDist != null && wp.distanceAlong <= firstDist ? firstTime : lastTime;
        events.waypoints.set(key, {
          name: wp.name,
          distanceAlong: wp.distanceAlong,
          enterMs: t,
          leaveMs: maxDist > high ? lastTime : null,
        });
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
  const prevTime = prevProj?.t ?? timeMs;
  const events = ensureProgressEvents(deviceId);
  distanceTicks.forEach((tick) => {
    if (events.km.has(tick)) return;
    const crossed = prev == null ? curr >= tick : curr >= tick && prev < tick;
    if (crossed) events.km.set(tick, timeMs);
  });
  routeWaypoints.forEach((wp, idx) => {
    const key = `${idx}:${Math.round(wp.distanceAlong)}`;
    const entry = events.waypoints.get(key) || {
      name: wp.name,
      distanceAlong: wp.distanceAlong,
      enterMs: null,
      leaveMs: null,
    };
    updateWaypointEvent(entry, wp, prev, curr, prevTime, timeMs);
    if (entry.enterMs || entry.leaveMs) events.waypoints.set(key, entry);
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
    const t = timeMs || getNowMs();
    lastProjection.set(position.deviceId, { distanceAlong: position.projHintDistanceAlong, t });
  }
  if (timeMs) updatePositionHistory(position.deviceId, coords, timeMs);
  const prog = getDeviceProgress(position.deviceId);
  markActiveOnRoute(position.deviceId, prog, activeStartTimes, timeMs || getNowMs(), positionsHistory);
  if (timeMs) recordProgressEvents(position.deviceId, prevProj, prog?.proj, timeMs);
  updateMarker(position);
  refreshHistoryOverlay(position.deviceId);
}

async function refreshPositions() {
  let positions = [];
  if (!config?.debug && config?.traccarUrl && config?.token) {
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
    getActiveStartTime: (id) => activeStartTimes.get(id) || null,
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
    persistPanels,
    getPanelPreferences,
    getMapViewPreference,
    persistMapViewPreference,
    devices,
    lastSeen,
    lastPositions,
  });
}

async function bootstrap() {
  setupUiBindings();
  initMap();
  initContextMenu();
  setupCountdownOverlay();
  await loadConfig();
  if (normalizeDebugTimeParamIfNeeded()) return;
  initLangSelector();
  setupWeatherWidget();
  initDownloadButton();
  await loadTranslations();
  setupDebugTimeControls();
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
