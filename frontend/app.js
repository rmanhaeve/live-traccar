import {
  DEFAULT_CONFIG,
  DEFAULT_TEXTS,
  TRANSLATIONS_MAP,
  LANGUAGE_COOKIE,
} from "./src/constants.js";
import { buildRouteProfile, projectOnRoute, getRouteTotal } from "./src/route.js";
import {
  clearNowOverride,
  getNowDate,
  getNowMs,
  getOverrideTicking,
  getTimeOverrideBaseMs,
  hasNowOverride,
  setNowOverride,
  setOverrideTicking,
} from "./src/time.js";
import {
  setupVisualization,
  initMap,
  initContextMenu,
  renderRoute,
  rebuildKmMarkers,
  renderWaypoints,
  renderToggles,
  updateMarker,
  extendBounds,
  fitToData,
  clearRoute,
  setRouteWaypoints,
  setElevationProfile,
  setElevationProgress,
  refreshMarkerStyles,
  focusDevice,
  startViewerLocation as vizStartViewerLocation,
  stopViewerLocation as vizStopViewerLocation,
  updateHelpContent,
  refreshHistoryOverlay,
} from "./src/visualization.js";

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
const debugTimePickerEl = document.getElementById("debug-time-picker");
const debugTimeSliderEl = document.getElementById("debug-time-slider");
const debugTimeValueEl = document.getElementById("debug-time-value");
const debugTimeToggleEl = document.getElementById("debug-time-toggle");
const debugTimeToggleStateEl = document.getElementById("debug-time-toggle-state");
const debugTimeLabelEl = document.getElementById("debug-time-label");
let config = { ...DEFAULT_CONFIG };
let texts = { ...DEFAULT_TEXTS };
let currentLanguage = "en";
let selectedParticipantId = null;
let refreshTimer;
let countdownTimer;
let downloadButton;
let langSelector;
let userPreferences;
let panelPreferencesCache = null;
let weatherToggle;
let weatherPanel;
let weatherForecastEl;
let weatherErrorEl;
let weatherSummaryEl;
let weatherUpdatedEl;
const weatherState = { expanded: false, pending: false };
let weatherOverlay;
let participantsToggleEl;
let participantsOverlayEl;
let participantsListEl;
let participantsCountEl;
let participantsTitleEl;
let participantsCloseEl;
let participantsPanelOpen = false;
const WEATHER_STALE_MS = 10 * 60 * 1000;
const weatherCache = new Map();
let initialSelectedParticipantId = null;
let eventStartMs = null;
let countdownOverlayDismissed = false;
const COUNTDOWN_OVERLAY_PREF = "hideCountdownOverlay";
let initialTimeOverrideMs = null;
let initialTimeOverrideTicking = true;
let routeTotalMeters = 0;
const DEBUG_TIME_STEP_MS = 60 * 1000;

const participants = new Map();
const waypointEtas = new Map();
const participantHistories = new Map();
const devices = new Map();
const lastSeen = new Map();
const lastPositions = new Map();

async function fetchJson(path) {
  const res = await fetch(withDebugTimeParam(path), { cache: "no-store" });
  if (!res.ok) throw new Error(`Request failed: ${path}`);
  return res.json();
}

function withDebugTimeParam(path) {
  if (!config?.debug || !hasNowOverride()) return path;
  if (!path.startsWith("/api/")) return path;
  const nowMs = getNowMs();
  if (!Number.isFinite(nowMs)) return path;
  const url = new URL(path, window.location.origin);
  url.searchParams.set("debugTime", new Date(nowMs).toISOString());
  return `${url.pathname}${url.search}`;
}

async function ensureAdminInitialized() {
  try {
    const res = await fetch("/api/admin/status", { cache: "no-store" });
    if (!res.ok) return true;
    const status = await res.json();
    if (!status.initialized) {
      window.location.replace("/setup.html");
      return false;
    }
  } catch (err) {
    console.warn("Admin status check failed", err);
  }
  return true;
}

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

function getDebugStartMs() {
  const eventStart = getEventStartMs();
  return Number.isFinite(eventStart) ? eventStart : null;
}

function getDebugFinishMs() {
  const startMs = getDebugStartMs();
  if (!Number.isFinite(startMs)) return null;
  if (!Number.isFinite(routeTotalMeters) || routeTotalMeters <= 0) return null;
  const speedKph = Number(config?.debugSpeedKph ?? DEFAULT_CONFIG.debugSpeedKph ?? 60);
  const speedMs = Number.isFinite(speedKph) ? speedKph / 3.6 : 0;
  if (!Number.isFinite(speedMs) || speedMs <= 0) return null;
  return startMs + (routeTotalMeters / speedMs) * 1000;
}

function getDebugTimeRange() {
  const startMs = getDebugStartMs();
  const endMs = getDebugFinishMs();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  return { startMs, endMs };
}

function clampDebugTime(ms, range) {
  if (!range || !Number.isFinite(ms)) return ms;
  return Math.min(range.endMs, Math.max(range.startMs, ms));
}

function updateDebugTimeTexts() {
  if (debugTimeLabelEl) debugTimeLabelEl.textContent = t("debugTimeLabel");
  if (debugTimePickerEl) {
    debugTimePickerEl.textContent = t("debugTimePick");
    debugTimePickerEl.setAttribute("title", t("debugTimePick"));
    debugTimePickerEl.setAttribute("aria-label", t("debugTimePick"));
  }
  if (debugTimeToggleStateEl) {
    const ticking = debugTimeToggleEl ? debugTimeToggleEl.checked : getOverrideTicking();
    debugTimeToggleStateEl.textContent = ticking === false ? t("debugTimeFrozen") : t("debugTimeTicking");
  }
}

function setDebugTimeInputValue(ms) {
  if (!debugTimeInputEl) return;
  debugTimeInputEl.value = formatDatetimeLocalValue(ms);
}

function setDebugTimeSliderValue(ms) {
  if (!debugTimeSliderEl) return;
  const range = getDebugTimeRange();
  const next = Number.isFinite(ms) ? clampDebugTime(ms, range) : null;
  if (!Number.isFinite(next)) return;
  debugTimeSliderEl.value = String(Math.round(next));
}

function setDebugTimeValueText(ms) {
  if (!debugTimeValueEl) return;
  if (!Number.isFinite(ms)) {
    debugTimeValueEl.textContent = t("unknown");
    return;
  }
  debugTimeValueEl.textContent = formatDateTimeFull(new Date(ms));
}

function updateDebugTimeRange() {
  if (!debugTimeSliderEl) return;
  const range = getDebugTimeRange();
  if (!range) {
    debugTimeSliderEl.disabled = true;
    setDebugTimeValueText(null);
    return;
  }
  debugTimeSliderEl.min = String(Math.round(range.startMs));
  debugTimeSliderEl.max = String(Math.round(range.endMs));
  debugTimeSliderEl.step = String(DEBUG_TIME_STEP_MS);
  debugTimeSliderEl.disabled = false;
  const baseMs = getTimeOverrideBaseMs();
  const next = Number.isFinite(baseMs) ? baseMs : range.startMs;
  setDebugTimeSliderValue(next);
  setDebugTimeValueText(next);
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
  const range = getDebugTimeRange();
  const clamped = Number.isFinite(ms) ? clampDebugTime(ms, range) : ms;
  if (!Number.isFinite(ms)) {
    clearNowOverride();
    setDebugTimeInputValue(null);
    if (range) {
      const fallback = clampDebugTime(getNowMs(), range);
      setDebugTimeSliderValue(fallback);
      setDebugTimeValueText(fallback);
    } else {
      setDebugTimeValueText(null);
    }
    const ticking = debugTimeToggleEl ? debugTimeToggleEl.checked : true;
    if (!ticking) {
      setNowOverride(Date.now(), { ticking: false });
    }
  } else {
    const ticking = debugTimeToggleEl ? debugTimeToggleEl.checked : true;
    setNowOverride(clamped, { ticking });
    setDebugTimeInputValue(clamped);
    setDebugTimeSliderValue(clamped);
    setDebugTimeValueText(clamped);
  }
  updateUrlDebugTimeParams({ timeMs: Number.isFinite(clamped) ? clamped : null, ticking: debugTimeToggleEl ? debugTimeToggleEl.checked : null });
  countdownOverlayDismissed = false;
  refreshCountdownTimer();
  refreshWeather(true).catch((err) => console.error(err));
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
    setDebugTimeSliderValue(initialTimeOverrideMs);
    setDebugTimeValueText(initialTimeOverrideMs);
    return true;
  }
  clearNowOverride();
  setDebugTimeInputValue(null);
  setDebugTimeValueText(null);
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

function persistToggles() {
  persistPreferences({
    toggles: {
      showKmMarkers: Boolean(config?.showKmMarkers),
      showWaypoints: Boolean(config?.showWaypoints),
      showViewerLocation: Boolean(config?.showViewerLocation),
    },
  });
}

function applySavedTogglePreferences() {
  const prefs = readPreferences();
  const toggles = prefs?.toggles;
  if (!toggles || typeof toggles !== "object") return;
  if (typeof toggles.showKmMarkers === "boolean") config.showKmMarkers = toggles.showKmMarkers;
  if (typeof toggles.showWaypoints === "boolean") config.showWaypoints = toggles.showWaypoints;
  if (typeof toggles.showViewerLocation === "boolean") config.showViewerLocation = toggles.showViewerLocation;
}

function applySavedSelectedParticipant(list) {
  const prefs = readPreferences();
  const preferredId = prefs?.selectedParticipantId;
  const hasPreferred = preferredId && list?.some((d) => d.id === preferredId);
  initialSelectedParticipantId = hasPreferred ? preferredId : null;
}

async function loadConfig() {
  try {
    const cfg = await fetchJson("/api/config");
    Object.assign(config, DEFAULT_CONFIG, cfg);
    eventStartMs = parseEventStart(config.startTime);
    applyUrlOverrides();
    applySavedTogglePreferences();
    texts = { ...DEFAULT_TEXTS };
    setStatus("");
    const pageTitle = config.title || DEFAULT_CONFIG.title;
    if (titleEl) titleEl.textContent = pageTitle;
    document.title = pageTitle;
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
  } else {
    path = TRANSLATIONS_MAP.en || "translations/en.json";
    currentLanguage = "en";
  }
  persistPreferences({
    lang: currentLanguage,
    toggles: prefs.toggles,
  });
  try {
    const data = await fetchJson(path);
    texts = { ...DEFAULT_TEXTS, ...data };
  } catch (err) {
    texts = { ...DEFAULT_TEXTS };
  }
  updateLangSelector();
  updateHelpContent();
  updateDownloadButtonLabel();
  updateParticipantsTexts();
  renderParticipantsPanel();
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
  updateDebugTimeRange();
  const restored = restoreDebugTimeOverride();
  if (restored) {
    updateUrlDebugTimeParams({
      timeMs: Number.isFinite(initialTimeOverrideMs) ? initialTimeOverrideMs : null,
      ticking: initialTimeOverrideTicking,
    });
    refreshCountdownTimer();
    refreshWeather(true).catch((err) => console.error(err));
  }
  if (debugTimePickerEl && debugTimeInputEl) {
    debugTimePickerEl.addEventListener("click", () => {
      const range = getDebugTimeRange();
      const baseMs = getTimeOverrideBaseMs();
      const fallback = Number.isFinite(baseMs) ? baseMs : getNowMs();
      const next = clampDebugTime(fallback, range);
      debugTimeInputEl.value = formatDatetimeLocalValue(next);
      if (typeof debugTimeInputEl.showPicker === "function") {
        debugTimeInputEl.showPicker();
      } else {
        debugTimeInputEl.focus();
      }
    });
  }
  if (debugTimeToggleEl) {
    debugTimeToggleEl.addEventListener("change", () => {
      const ticking = debugTimeToggleEl.checked;
      if (config?.debug && hasNowOverride()) {
        setOverrideTicking(ticking);
      }
      updateDebugTimeTexts();
      updateUrlDebugTimeParams({ ticking });
      refreshCountdownTimer();
    });
  }
  if (debugTimeSliderEl) {
    debugTimeSliderEl.addEventListener("input", () => {
      const range = getDebugTimeRange();
      let ms = Number(debugTimeSliderEl.value);
      if (!Number.isFinite(ms) && Number.isFinite(debugTimeSliderEl.valueAsNumber)) {
        ms = debugTimeSliderEl.valueAsNumber;
      }
      if (!Number.isFinite(ms) && range) {
        ms = range.endMs;
      }
      if (Number.isFinite(ms)) applyDebugTimeOverride(ms);
    });
  }
  if (debugTimeInputEl) {
    debugTimeInputEl.addEventListener("change", () => {
      const raw = debugTimeInputEl?.value;
      if (!raw) {
        applyDebugTimeOverride(null);
        return;
      }
      const ms = Date.parse(raw);
      if (Number.isFinite(ms)) applyDebugTimeOverride(ms);
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
    const label = row.label || (row.timeMs ? formatTimeLabel(new Date(row.timeMs)) : "");
    left.textContent = label || "";
    const right = document.createElement("div");
    right.className = "weather-meta";
    const bits = [];
    if (row.temp != null) bits.push(`${row.temp}°C`);
    if (row.precip != null) bits.push(`${row.precip}% ${t("weatherPrecip")}`);
    if (row.wind != null) bits.push(`${row.wind} km/h ${t("weatherWind")}`);
    if (row.distanceAlong != null && Number.isFinite(row.distanceAlong)) {
      bits.push(`${Math.round((row.distanceAlong / 1000) * 10) / 10} km`);
    }
    right.textContent = bits.join(" · ");
    div.append(left, right);
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
  title.textContent = t("weatherNextHours");
  const updated = document.createElement("div");
  updated.className = "weather-modal-updated";
  if (weatherUpdatedEl?.textContent) updated.textContent = weatherUpdatedEl.textContent;
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "weather-modal-close";
  closeBtn.textContent = t("closeLabel");
  closeBtn.addEventListener("click", hideWeatherOverlay);
  header.append(title, updated, closeBtn);
  modal.appendChild(header);

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
      const condCol = document.createElement("div");
      condCol.className = "weather-modal-col conditions";
      condCol.textContent = formatWeatherDetails(row);
      item.append(timeCol, condCol);
      list.appendChild(item);
    });
  }

  modal.appendChild(list);
  overlay.appendChild(modal);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) hideWeatherOverlay();
  });
  document.body.appendChild(overlay);
  weatherOverlay = overlay;
}

function getWeatherCacheKey(participantId) {
  return participantId != null ? String(participantId) : "route";
}

async function refreshWeather(force = false, participantId = selectedParticipantId) {
  if (weatherState.pending) return null;
  const cacheKey = getWeatherCacheKey(participantId);
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
    const path = participantId ? `/api/weather?participantId=${participantId}` : "/api/weather";
    const data = await fetchJson(path);
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

async function showWeatherOverlay() {
  const data = await refreshWeather(false, selectedParticipantId);
  renderWeatherOverlay(data);
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

function setParticipantsExpanded(expanded) {
  participantsPanelOpen = expanded;
  if (participantsOverlayEl) {
    participantsOverlayEl.classList.toggle("hidden", !expanded);
  }
  if (participantsToggleEl) {
    participantsToggleEl.setAttribute("aria-expanded", expanded ? "true" : "false");
  }
  if (expanded) renderParticipantsPanel();
}

function updateParticipantsTexts() {
  const baseLabel = t("legend");
  const selectedName = selectedParticipantId ? participants.get(selectedParticipantId)?.name : null;
  if (participantsToggleEl) {
    participantsToggleEl.textContent = selectedName ? `${baseLabel}: ${selectedName}` : baseLabel;
  }
  if (participantsTitleEl) participantsTitleEl.textContent = t("legend");
}

function formatParticipantProgress(prog) {
  if (!prog) return t("unknown");
  if (prog.offtrack) return t("offrouteLabel");
  if (prog.endpoint === "start") return t("startLabel");
  if (prog.endpoint === "finish") return t("finishLabel");
  const dist = prog?.proj?.distanceAlong;
  if (!Number.isFinite(dist)) return t("unknown");
  return `${Math.round((dist / 1000) * 10) / 10} km`;
}

function getParticipantProgressPercent(prog) {
  if (!prog) return 0;
  if (prog.endpoint === "finish") return 1;
  const dist = prog?.proj?.distanceAlong;
  if (!Number.isFinite(dist) || !Number.isFinite(routeTotalMeters) || routeTotalMeters <= 0) return 0;
  return Math.min(1, Math.max(0, dist / routeTotalMeters));
}

function renderParticipantsPanel() {
  if (!participantsListEl) return;
  participantsListEl.innerHTML = "";
  const list = Array.from(participants.values()).filter((p) => filterDevice(p.id));
  if (participantsCountEl) participantsCountEl.textContent = list.length ? `${list.length}` : "";
  if (!list.length) return;
  const sorted = list.slice().sort((a, b) => {
    const progA = getDeviceProgress(a.id);
    const progB = getDeviceProgress(b.id);
    const distA = progA?.offtrack ? -1 : progA?.proj?.distanceAlong ?? -1;
    const distB = progB?.offtrack ? -1 : progB?.proj?.distanceAlong ?? -1;
    return distB - distA;
  });
  sorted.forEach((participant) => {
    const prog = getDeviceProgress(participant.id);
    const item = document.createElement("div");
    item.className = "participants-item";
    const row = document.createElement("button");
    row.type = "button";
    row.className = "participants-row";
    if (participant.id === selectedParticipantId) row.classList.add("selected");
    const name = document.createElement("span");
    name.className = "participants-name";
    name.textContent = participant.name || `Device ${participant.id}`;
    const progress = document.createElement("span");
    progress.className = "participants-progress";
    progress.textContent = formatParticipantProgress(prog);
    row.append(name, progress);
    const bar = document.createElement("div");
    bar.className = "participants-bar";
    const fill = document.createElement("div");
    fill.className = "participants-bar-fill";
    if (prog?.offtrack) fill.classList.add("offroute");
    const percent = getParticipantProgressPercent(prog);
    fill.style.width = `${Math.round(percent * 1000) / 10}%`;
    bar.appendChild(fill);
    row.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      selectParticipant(participant.id, { focus: true });
      focusDevice(participant.id);
      setParticipantsExpanded(false);
    });
    item.append(row, bar);
    participantsListEl.appendChild(item);
  });
}

function setupParticipantsPanel() {
  participantsToggleEl = document.getElementById("participants-toggle");
  participantsOverlayEl = document.getElementById("participants-overlay");
  participantsListEl = document.getElementById("participants-list");
  participantsCountEl = document.getElementById("participants-count");
  participantsTitleEl = document.getElementById("participants-title");
  participantsCloseEl = document.getElementById("participants-close");
  updateParticipantsTexts();
  setParticipantsExpanded(false);
  if (participantsToggleEl) {
    participantsToggleEl.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      setParticipantsExpanded(!participantsPanelOpen);
    });
  }
  if (participantsCloseEl) {
    participantsCloseEl.addEventListener("click", () => setParticipantsExpanded(false));
  }
  if (participantsOverlayEl) {
    participantsOverlayEl.addEventListener("click", (e) => {
      if (e.target === participantsOverlayEl) setParticipantsExpanded(false);
    });
  }
  document.addEventListener("keydown", (e) => {
    if (!participantsPanelOpen) return;
    if (e.key === "Escape") setParticipantsExpanded(false);
  });
}

async function loadRoute() {
  try {
    const data = await fetchJson("/api/route");
    clearRoute();
    buildRouteProfile(data.segments || []);
    routeTotalMeters = getRouteTotal();
    renderRoute(data.segments, "#0c8bc7");
    setRouteWaypoints(data.waypoints || []);
    setElevationProfile(data.elevationProfile || null);
    renderWaypoints();
    rebuildKmMarkers();
    renderParticipantsPanel();
    updateDebugTimeRange();
    (data.segments || []).forEach((seg) => seg.forEach((pt) => extendBounds(pt)));
    fitToData();
    refreshWeather(true).catch((err) => console.error(err));
  } catch (err) {
    console.error(err);
    setStatus("Track error", true);
  }
}

function updateParticipantCaches(list) {
  participants.clear();
  devices.clear();
  lastSeen.clear();
  lastPositions.clear();
  list.forEach((participant) => {
    participants.set(participant.id, participant);
    devices.set(participant.id, { id: participant.id, name: participant.name });
    if (participant.position) {
      lastPositions.set(participant.id, participant.position);
      const time =
        participant.lastSeen ||
        participant.position.deviceTime ||
        participant.position.fixTime ||
        participant.position.serverTime;
      if (time) lastSeen.set(participant.id, time);
    }
  });
}

function getParticipant(id) {
  return participants.get(id) || null;
}

function getParticipantHistory(id) {
  return participantHistories.get(id) || null;
}

function findEtaForDistance(list, distanceAlong) {
  if (!Array.isArray(list) || distanceAlong == null) return null;
  let best = null;
  let bestDiff = null;
  list.forEach((item) => {
    const dist = item?.distanceAlong;
    if (!Number.isFinite(dist)) return;
    const diff = Math.abs(dist - distanceAlong);
    if (bestDiff == null || diff < bestDiff) {
      best = item;
      bestDiff = diff;
    }
  });
  if (bestDiff != null && bestDiff <= 5) return best;
  return null;
}

function computeEta(participantId, distanceAlong) {
  const waypointMap = waypointEtas.get(participantId);
  if (waypointMap) {
    const entry = findEtaForDistance(Array.from(waypointMap.values()), distanceAlong);
    if (entry?.eta) return entry.eta;
  }
  const history = participantHistories.get(participantId);
  if (history?.upcoming) {
    const entry = findEtaForDistance(history.upcoming, distanceAlong);
    if (entry?.eta) return entry.eta;
  }
  return null;
}

function getWaypointEta(participantId, waypointId) {
  const map = waypointEtas.get(participantId);
  if (!map) return null;
  return map.get(waypointId) || null;
}

async function getPointEta(participantId, latlng) {
  return fetchJson(`/api/participants/${participantId}/eta?lat=${latlng.lat}&lng=${latlng.lng}`);
}

function isStale(participantId) {
  return Boolean(participants.get(participantId)?.isStale);
}

function getDeviceProgress(participantId) {
  const participant = participants.get(participantId);
  const prog = participant?.progress;
  if (!prog) return null;
  return {
    proj: {
      distanceAlong: prog.distanceAlong,
      point: prog.point,
    },
    offtrack: prog.offtrack,
    endpoint: prog.endpoint,
  };
}

function getAverageSpeedMs(participantId) {
  const speedKph = participants.get(participantId)?.speedKph || 0;
  if (!Number.isFinite(speedKph) || speedKph <= 0) return 0;
  return speedKph / 3.6;
}

function getProgressHistory(deviceId) {
  const history = participantHistories.get(deviceId);
  if (!history) return { distances: [], waypoints: [] };
  return {
    distances: history.kmEvents || [],
    waypoints: history.waypointEvents || [],
  };
}

function filterDevice(id) {
  if (config?.debug) return true;
  if (!config?.deviceIds || !Array.isArray(config.deviceIds)) return true;
  return config.deviceIds.includes(id);
}

async function refreshParticipants() {
  let list = [];
  try {
    const data = await fetchJson("/api/participants");
    list = data.participants || [];
    updateParticipantCaches(list);
  } catch (err) {
    console.error(err);
  }
  list.forEach((participant) => {
    if (participant.position) updateMarker(participant.position);
  });
  applySavedSelectedParticipant(list);
  updateParticipantsTexts();
  renderParticipantsPanel();
  renderWaypoints();
  fitToData();
  if (!selectedParticipantId && list.length) {
    const preferred = initialSelectedParticipantId && participants.has(initialSelectedParticipantId) ? initialSelectedParticipantId : null;
    const targetId = preferred || list[0].id;
    selectParticipant(targetId);
  } else if (selectedParticipantId) {
    const prog = getDeviceProgress(selectedParticipantId);
    if (prog?.proj?.distanceAlong != null) {
      setElevationProgress(prog.proj.distanceAlong);
    }
  }
}

async function loadParticipantDetails(participantId) {
  if (!participantId) return;
  try {
    const data = await fetchJson(`/api/participants/${participantId}/waypoints`);
    const map = new Map();
    (data.waypoints || []).forEach((wp) => map.set(wp.id, wp));
    waypointEtas.set(participantId, map);
    renderWaypoints();
  } catch (err) {
    console.error(err);
  }
  try {
    const data = await fetchJson(`/api/participants/${participantId}/history`);
    participantHistories.set(participantId, data);
    refreshHistoryOverlay(participantId);
  } catch (err) {
    console.error(err);
  }
}

function selectParticipant(participantId, { focus = false } = {}) {
  selectedParticipantId = participantId;
  persistPreferences({ selectedParticipantId: participantId });
  updateParticipantsTexts();
  renderParticipantsPanel();
  renderWaypoints();
  renderToggles();
  refreshMarkerStyles();
  const prog = getDeviceProgress(participantId);
  if (prog?.proj?.distanceAlong != null) {
    setElevationProgress(prog.proj.distanceAlong);
  }
  if (focus) {
    // focus handled within visualization
  }
  loadParticipantDetails(participantId).catch((err) => console.error(err));
  refreshWeather(true, participantId).catch((err) => console.error(err));
}

async function startPolling() {
  if (refreshTimer) clearInterval(refreshTimer);
  await refreshParticipants();
  const interval = Math.max(2, Number(config.refreshSeconds || 8));
  refreshTimer = setInterval(async () => {
    await refreshParticipants();
    if (selectedParticipantId) {
      await loadParticipantDetails(selectedParticipantId);
    }
  }, interval * 1000);
}

async function bootstrap() {
  if (!(await ensureAdminInitialized())) return;
  setupVisualization({
    config,
    t,
    computeEta,
    getPointEta,
    getDeviceProgress,
    getAverageSpeedMs,
    getProgressHistory,
    formatDateTimeFull,
    formatTimeLabel,
    selectDevice: selectParticipant,
    getSelectedDeviceId: () => selectedParticipantId,
    isStale,
    projectOnRoute,
    filterDevice,
    persistToggles,
    persistPanels,
    getPanelPreferences,
    devices,
    lastSeen,
    lastPositions,
    startViewerLocation: () => vizStartViewerLocation(),
    stopViewerLocation: () => vizStopViewerLocation(),
  });
  initMap();
  initContextMenu();
  setupCountdownOverlay();
  await loadConfig();
  if (normalizeDebugTimeParamIfNeeded()) return;
  initLangSelector();
  setupWeatherWidget();
  initDownloadButton();
  await loadTranslations();
  setupParticipantsPanel();
  setupDebugTimeControls();
  await loadRoute();
  await startPolling();
}

bootstrap().catch((err) => {
  console.error(err);
  setStatus("Failed to load", true);
});
