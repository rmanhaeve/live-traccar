import {
  DEFAULT_CONFIG,
  DEFAULT_TEXTS,
  TRANSLATIONS_MAP,
  LANGUAGE_COOKIE,
} from "./src/constants.js";
import {
  setupVisualization,
  initMap,
  initContextMenu,
  renderRoute,
  renderWaypoints,
  renderLegend,
  renderToggles,
  updateMarker,
  pruneMarkers,
  extendBounds,
  fitToData,
  clearRoute,
  setRouteWaypoints,
  setKmMarkers,
  setElevationProfile,
  setElevationProgress,
  startViewerLocation as vizStartViewerLocation,
  stopViewerLocation as vizStopViewerLocation,
  updateHelpContent,
  refreshHistoryOverlay,
} from "./src/visualization.js";

const statusEl = document.getElementById("status");
const titleEl = document.getElementById("title");
let config = { ...DEFAULT_CONFIG };
let texts = { ...DEFAULT_TEXTS };
let currentLanguage = "en";
let selectedParticipantId = null;
let refreshTimer;
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
let initialSelectedParticipantId = null;
let weatherLastFetch = 0;

const participants = new Map();
const waypointEtas = new Map();
const participantHistories = new Map();

async function fetchJson(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`Request failed: ${path}`);
  return res.json();
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
  const d = timeStr instanceof Date ? timeStr : new Date(timeStr);
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
    applySavedTogglePreferences();
    texts = { ...DEFAULT_TEXTS };
    setStatus("");
    const pageTitle = config.title || DEFAULT_CONFIG.title;
    if (titleEl) titleEl.textContent = pageTitle;
    document.title = pageTitle;
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
    const data = await fetchJson(path);
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
  if (Number.isFinite(temp)) parts.push(`${Math.round(temp)}°C`);
  if (Number.isFinite(wind)) parts.push(`${Math.round(wind)} km/h ${t("weatherWind")}`);
  if (Number.isFinite(precip) && precip > 0) parts.push(`${precip.toFixed(1)} mm ${t("weatherPrecip")}`);
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
    const div = document.createElement("div");
    div.className = "weather-row";
    const left = document.createElement("div");
    left.className = "weather-label";
    const label = row.label || formatTimeLabel(row.timeMs);
    left.textContent = label || "";
    const right = document.createElement("div");
    right.className = "weather-meta";
    const bits = [];
    if (row.temp != null) bits.push(`${row.temp}°C`);
    if (row.precip != null) bits.push(`${row.precip}% rain`);
    if (row.wind != null) bits.push(`${row.wind} km/h`);
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

async function refreshWeather(force = false, participantId = selectedParticipantId) {
  if (!weatherPanel || weatherState.pending) return;
  if (!force && Date.now() - weatherLastFetch < 10 * 60 * 1000) return;
  weatherState.pending = true;
  if (weatherErrorEl) {
    weatherErrorEl.classList.add("hidden");
    weatherErrorEl.textContent = "";
  }
  if (weatherForecastEl) weatherForecastEl.textContent = t("weatherFetching");
  try {
    const path = participantId ? `/api/weather?participantId=${participantId}` : "/api/weather";
    const data = await fetchJson(path);
    renderWeatherSummary(data);
    renderWeatherForecast(data);
    weatherLastFetch = Date.now();
    if (weatherUpdatedEl) {
      weatherUpdatedEl.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
  } catch (err) {
    console.error(err);
    if (weatherErrorEl) {
      weatherErrorEl.textContent = t("weatherUnavailable");
      weatherErrorEl.classList.remove("hidden");
    }
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
  const titleElLocal = document.getElementById("weather-panel-title");
  if (titleElLocal) titleElLocal.textContent = t("weatherTitle");
  if (weatherSummaryEl) weatherSummaryEl.textContent = "";
  setWeatherExpanded(false);
  if (weatherToggle) {
    weatherToggle.addEventListener("click", () => {
      const next = !weatherState.expanded;
      setWeatherExpanded(next);
      if (next) refreshWeather(true);
    });
  }
}

async function loadRoute() {
  try {
    const data = await fetchJson("/api/route");
    clearRoute();
    renderRoute(data.segments, "#0c8bc7");
    setRouteWaypoints(data.waypoints || []);
    setKmMarkers(data.kmMarkers || []);
    setElevationProfile(data.elevationProfile || null, data.elevationProfile?.totals || null);
    renderWaypoints();
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
  list.forEach((participant) => participants.set(participant.id, participant));
}

function getParticipant(id) {
  return participants.get(id) || null;
}

function getParticipantHistory(id) {
  return participantHistories.get(id) || null;
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

async function refreshParticipants() {
  let list = [];
  try {
    const data = await fetchJson("/api/participants");
    list = data.participants || [];
    updateParticipantCaches(list);
  } catch (err) {
    console.error(err);
  }
  pruneMarkers(list.map((participant) => participant.id));
  list.forEach((participant) => updateMarker(participant));
  applySavedSelectedParticipant(list);
  renderLegend();
  renderWaypoints();
  fitToData();
  if (!selectedParticipantId && list.length) {
    const preferred = initialSelectedParticipantId && participants.has(initialSelectedParticipantId) ? initialSelectedParticipantId : null;
    const targetId = preferred || list[0].id;
    selectParticipant(targetId);
  } else if (selectedParticipantId) {
    const selected = participants.get(selectedParticipantId);
    if (selected?.progress?.distanceAlong != null) {
      setElevationProgress(selected.progress.distanceAlong, selected.progress.elevation || null);
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
  renderLegend();
  renderWaypoints();
  renderToggles();
  const selected = participants.get(participantId);
  if (selected?.progress?.distanceAlong != null) {
    setElevationProgress(selected.progress.distanceAlong, selected.progress.elevation || null);
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

function setupUiBindings() {
  initLangSelector();
  initDownloadButton();
  setupWeatherWidget();
}

async function bootstrap() {
  setupVisualization({
    config,
    t,
    formatDateTimeFull,
    formatTimeLabel,
    selectDevice: selectParticipant,
    getSelectedDeviceId: () => selectedParticipantId,
    getParticipant,
    getParticipantHistory,
    getWaypointEta,
    getPointEta,
    isStale,
    persistToggles,
    persistPanels,
    getPanelPreferences,
    participants,
    startViewerLocation: vizStartViewerLocation,
    stopViewerLocation: vizStopViewerLocation,
  });
  initMap();
  initContextMenu();
  setupUiBindings();
  await loadConfig();
  await loadTranslations();
  await loadRoute();
  await startPolling();
}

bootstrap().catch((err) => {
  console.error(err);
  setStatus("Failed to load", true);
});
