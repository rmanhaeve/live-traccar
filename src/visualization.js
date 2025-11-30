import { getRouteDistances, getRoutePoints } from "./route.js";
import { computeElevationTotals } from "./stats.js";

const colors = [
  "#ef4444",
  "#8b5cf6",
  "#10b981",
  "#3b82f6",
  "#f59e0b",
  "#ec4899",
  "#14b8a6",
  "#6366f1",
];

const state = {
  config: null,
  t: (k) => k,
  computeEta: null,
  getDeviceProgress: null,
  getAverageSpeedMs: null,
  getProgressHistory: null,
  isStale: null,
  formatDateTimeFull: (x) => String(x),
  formatTimeLabel: (x) => String(x),
  projectOnRoute: null,
  selectDevice: () => {},
  getSelectedDeviceId: () => null,
  filterDevice: () => true,
  startViewerLocation: null,
  stopViewerLocation: null,
  persistToggles: () => {},
  persistPanels: () => {},
  getPanelPreferences: () => ({}),
  devices: null,
  lastSeen: null,
  lastPositions: null,
  historyOverlay: null,
  routeWaypoints: [],
  trackData: [],
  map: null,
  bounds: null,
  boundsDirty: false,
  autoFit: true,
  kmMarkerGroup: null,
  waypointGroup: null,
  trackLayers: [],
  markers: new Map(),
  projectionLines: new Map(),
  legendControl: null,
  legendContainer: null,
  legendBody: null,
  markerToggleControl: null,
  toggleContainer: null,
  toggleBody: null,
  viewerMarker: null,
  viewerWatchId: null,
  contextMenuEl: null,
  helpPopupEl: null,
  longPressTimer: null,
  longPressPos: null,
  elevationProfile: null,
  elevationProgressDistance: null,
  elevationEls: null,
  elevationTotals: null,
};

function nextColor(idx) {
  return colors[idx % colors.length];
}

function ensureElevationBar() {
  if (state.elevationEls) return state.elevationEls;
  const container = document.createElement("div");
  container.className = "elevation-bar collapsed";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "elevation-toggle";
  toggle.textContent = "▲";
  const statsEl = document.createElement("div");
  statsEl.className = "elevation-stats";
  statsEl.textContent = "";
  const content = document.createElement("div");
  content.className = "elevation-content";
  const chart = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  chart.setAttribute("viewBox", "0 0 100 50");
  chart.setAttribute("preserveAspectRatio", "xMidYMid meet");
  chart.classList.add("elevation-chart");
  const gridYGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
  gridYGroup.classList.add("elevation-grid");
  const gridXGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
  gridXGroup.classList.add("elevation-grid");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.classList.add("elevation-path");
  const progressDot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  progressDot.classList.add("elevation-progress-dot");
  progressDot.setAttribute("r", "3.2");
  const progressLabel = document.createElementNS("http://www.w3.org/2000/svg", "text");
  progressLabel.classList.add("elevation-progress-label");
  chart.append(gridYGroup, gridXGroup, path, progressDot, progressLabel);
  const empty = document.createElement("div");
  empty.className = "elevation-empty";
  content.append(chart, empty);
  container.append(toggle, statsEl, content);
  document.body.appendChild(container);
  toggle.addEventListener("click", () => {
    const collapsed = container.classList.toggle("collapsed");
    toggle.textContent = collapsed ? "▲" : "▼";
    updateElevationLayoutPadding();
  });
  state.elevationEls = {
    container,
    toggle,
    statsEl,
    chart,
    path,
    progressDot,
    progressLabel,
    empty,
    gridXGroup,
    gridYGroup,
  };
  window.addEventListener("resize", () => {
    renderElevationChart();
    updateElevationLayoutPadding();
  });
  updateElevationLayoutPadding();
  return state.elevationEls;
}

function updateElevationLayoutPadding() {
  const els = state.elevationEls || ensureElevationBar();
  const layout = document.querySelector(".layout");
  if (!layout) return;
  const expanded = !els.container.classList.contains("collapsed");
  const visibleBar = expanded ? els.container.offsetHeight : (els.toggle?.offsetHeight || 0);
  const pad = Math.max(0, visibleBar) + 8;
  layout.style.paddingBottom = `${pad}px`;
  document.documentElement.style.setProperty("--elevation-offset", `${pad}px`);
  layout.style.height = "";
  if (state.map && state.map.invalidateSize) {
    // defer to allow layout paint
    setTimeout(() => state.map.invalidateSize(), 0);
  }
}

function chooseTickStep(range, targetCount = 4) {
  if (!Number.isFinite(range) || range <= 0) return null;
  const raw = range / targetCount;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const candidates = [1, 2, 5, 10];
  for (let i = 0; i < candidates.length; i += 1) {
    const step = candidates[i] * pow;
    if (raw <= step) return step;
  }
  return candidates[candidates.length - 1] * pow;
}

function getElevationPadding(w, h) {
  const pad = Math.min(w, h) * 0.05;
  return Math.max(28, pad);
}

function createCollapsiblePanel(container, title, prefKey) {
  const prefs = state.getPanelPreferences ? state.getPanelPreferences() : {};
  if (prefKey && prefs[prefKey]) {
    container.classList.add("collapsed");
  }
  const header = document.createElement("button");
  header.type = "button";
  header.className = "panel-toggle";
  const titleSpan = document.createElement("span");
  titleSpan.textContent = title;
  const icon = document.createElement("span");
  icon.className = "panel-toggle-icon";
  icon.textContent = "▼";
  header.append(titleSpan, icon);
  const body = document.createElement("div");
  body.className = "panel-body";
  const setIcon = () => {
    const collapsed = container.classList.contains("collapsed");
    icon.textContent = collapsed ? "▼" : "▲";
  };
  setIcon();
  header.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const collapsed = container.classList.toggle("collapsed");
    setIcon();
    if (prefKey && state.persistPanels) {
      state.persistPanels({ [prefKey]: collapsed });
    }
  });
  container.append(header, body);
  return body;
}

function clearGroup(g) {
  if (!g) return;
  while (g.firstChild) g.removeChild(g.firstChild);
}

function renderElevationChart() {
  const els = ensureElevationBar();
  const profile = state.elevationProfile;
  if (!profile || !profile.distances?.length || !profile.elevations?.length) {
    els.empty.textContent = "No elevation data";
    els.chart.classList.add("hidden");
    if (els.statsEl) els.statsEl.textContent = "";
    updateElevationLayoutPadding();
    return;
  }
  const distances = profile.distances;
  const elevations = profile.elevations;
  const total = distances[distances.length - 1] || 0;
  const finiteElevs = elevations.filter((e) => Number.isFinite(e));
  if (!finiteElevs.length || total <= 0) {
    els.empty.textContent = "No elevation data";
    els.chart.classList.add("hidden");
    if (els.statsEl) els.statsEl.textContent = "";
    updateElevationLayoutPadding();
    return;
  }
  els.empty.textContent = "";
  els.chart.classList.remove("hidden");
  if (els.statsEl && state.elevationTotals) {
    const gain = Math.round(state.elevationTotals.gain);
    const loss = Math.round(state.elevationTotals.loss);
    els.statsEl.textContent = `${state.t("gain")} ${gain} m / ${state.t("descent")} ${loss} m`;
  }
  const minEle = Math.min(...finiteElevs);
  const maxEle = Math.max(...finiteElevs);
  const w = Math.max(els.chart.clientWidth || 0, 300);
  const h = Math.max(els.chart.clientHeight || 0, 120);
  els.chart.setAttribute("viewBox", `0 0 ${w} ${h}`);
  const pad = getElevationPadding(w, h);
  const spanEle = Math.max(1, maxEle - minEle);
  clearGroup(els.gridXGroup);
  clearGroup(els.gridYGroup);
  // vertical ticks for distance
  const totalKm = total / 1000;
  const stepKm = chooseTickStep(totalKm, 8);
  if (stepKm) {
    const decimals = stepKm < 1 ? (stepKm < 0.1 ? 2 : 1) : 0;
    for (let km = 0; km <= totalKm + stepKm * 0.5; km += stepKm) {
      const dist = km * 1000;
      const x = pad + ((dist / total) * (w - pad * 2));
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", String(x));
      line.setAttribute("x2", String(x));
      line.setAttribute("y1", "0");
      line.setAttribute("y2", String(h));
      line.classList.add("elevation-grid-line");
      els.gridXGroup.appendChild(line);
      const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
      label.setAttribute("x", String(x + 0.5));
      label.setAttribute("y", String(h - 1));
      label.setAttribute("text-anchor", "middle");
      label.setAttribute("class", "elevation-grid-label");
      label.textContent = `${km.toFixed(decimals)} km`;
      els.gridXGroup.appendChild(label);
    }
  }
  // horizontal ticks for elevation
  const stepEle = chooseTickStep(spanEle, 4);
  if (stepEle) {
    const start = Math.ceil(minEle / stepEle) * stepEle;
    for (let v = start; v <= maxEle + stepEle * 0.5; v += stepEle) {
      const y = h - pad - (((v - minEle) / spanEle) * (h - pad * 2));
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", "0");
      line.setAttribute("x2", String(w));
      line.setAttribute("y1", String(y));
      line.setAttribute("y2", String(y));
      line.classList.add("elevation-grid-line");
      els.gridYGroup.appendChild(line);
      const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
      label.setAttribute("x", "1");
      label.setAttribute("y", String(y - 1));
      label.setAttribute("class", "elevation-grid-label");
      label.textContent = `${Math.round(v)} m`;
      els.gridYGroup.appendChild(label);
    }
  }
  const points = [];
  for (let i = 0; i < distances.length; i += 1) {
    const d = distances[i];
    const ele = elevations[i];
    if (!Number.isFinite(d) || !Number.isFinite(ele)) continue;
    const x = pad + ((d / total) * (w - pad * 2));
    const y = h - pad - (((ele - minEle) / spanEle) * (h - pad * 2));
    points.push([x, y]);
  }
  if (!points.length) {
    els.empty.textContent = "No elevation data";
    els.chart.classList.add("hidden");
    return;
  }
  let dAttr = `M ${points[0][0]} ${points[0][1]}`;
  for (let i = 1; i < points.length; i += 1) {
    dAttr += ` L ${points[i][0]} ${points[i][1]}`;
  }
  els.path.setAttribute("d", dAttr);
  els.path.setAttribute("fill", "none");
  els.path.setAttribute("stroke", "currentColor");
  els.path.setAttribute("stroke-width", "1.5");
  renderElevationProgress();
  updateElevationLayoutPadding();
}

function renderElevationProgress() {
  const els = ensureElevationBar();
  const profile = state.elevationProfile;
  if (!profile || !profile.distances?.length) {
    els.progressDot.setAttribute("visibility", "hidden");
    if (els.progressLabel) els.progressLabel.setAttribute("visibility", "hidden");
    if (els.statsEl) els.statsEl.textContent = "";
    updateElevationLayoutPadding();
    return;
  }
  const total = profile.distances[profile.distances.length - 1] || 0;
  if (!total || !Number.isFinite(state.elevationProgressDistance)) {
    els.progressDot.setAttribute("visibility", "hidden");
    if (els.progressLabel) els.progressLabel.setAttribute("visibility", "hidden");
    if (els.statsEl) els.statsEl.textContent = "";
    updateElevationLayoutPadding();
    return;
  }
  const vb = els.chart.viewBox.baseVal;
  const w = vb?.width || 100;
  const h = vb?.height || 50;
  const pad = getElevationPadding(w, h);
  const x = pad + ((Math.max(0, Math.min(state.elevationProgressDistance, total)) / total) * (w - pad * 2));
  // find elevation at distance
  const distances = profile.distances;
  const elevations = profile.elevations;
  const target = Math.max(0, Math.min(state.elevationProgressDistance, total));
  let yVal = null;
  for (let i = 1; i < distances.length; i += 1) {
    const d0 = distances[i - 1];
    const d1 = distances[i];
    if (target >= d0 && target <= d1 && Number.isFinite(elevations[i - 1]) && Number.isFinite(elevations[i])) {
      const ratio = d1 === d0 ? 0 : (target - d0) / (d1 - d0);
      yVal = elevations[i - 1] + (elevations[i] - elevations[i - 1]) * ratio;
      break;
    }
  }
  if (!Number.isFinite(yVal)) {
    els.progressDot.setAttribute("visibility", "hidden");
    return;
  }
  const minEle = Math.min(...elevations.filter((e) => Number.isFinite(e)));
  const maxEle = Math.max(...elevations.filter((e) => Number.isFinite(e)));
  const spanEle = Math.max(1, maxEle - minEle);
  const y = h - pad - (((yVal - minEle) / spanEle) * (h - pad * 2));
  els.progressDot.setAttribute("cx", String(x));
  els.progressDot.setAttribute("cy", String(y));
  els.progressDot.setAttribute("visibility", "visible");
  if (els.progressLabel) {
    els.progressLabel.setAttribute("x", String(x + 4));
    els.progressLabel.setAttribute("y", String(Math.max(8, y - 4)));
    els.progressLabel.setAttribute("text-anchor", "start");
    els.progressLabel.textContent = `${Math.round(yVal)} m`;
    els.progressLabel.setAttribute("visibility", "visible");
  }
  if (els.statsEl) {
    const partial = computeElevationTotals(profile, state.elevationProgressDistance);
    const totalGain = Math.round(state.elevationTotals?.gain || 0);
    const totalLoss = Math.round(state.elevationTotals?.loss || 0);
    const curGain = Math.round(partial.gain || 0);
    const curLoss = Math.round(partial.loss || 0);
    els.statsEl.textContent = `${state.t("gain")} ${curGain}/${totalGain} m • ${state.t("descent")} ${curLoss}/${totalLoss} m`;
  }
}

export function setElevationProfile(profile) {
  state.elevationProfile = profile;
  state.elevationTotals = computeElevationTotals(profile, null);
  renderElevationChart();
}

export function setElevationProgress(distanceAlong) {
  state.elevationProgressDistance = distanceAlong;
  renderElevationProgress();
}

export function setupVisualization(deps) {
  state.config = deps.config;
  state.t = deps.t;
  state.computeEta = deps.computeEta;
  state.getDeviceProgress = deps.getDeviceProgress;
  state.getAverageSpeedMs = deps.getAverageSpeedMs;
  state.getProgressHistory = deps.getProgressHistory || (() => null);
  state.isStale = deps.isStale;
  state.projectOnRoute = deps.projectOnRoute;
  state.formatDateTimeFull = deps.formatDateTimeFull;
  state.formatTimeLabel = deps.formatTimeLabel;
  state.selectDevice = deps.selectDevice;
  state.getSelectedDeviceId = deps.getSelectedDeviceId;
  state.filterDevice = deps.filterDevice;
  state.startViewerLocation = deps.startViewerLocation || startViewerLocation;
  state.stopViewerLocation = deps.stopViewerLocation || stopViewerLocation;
  state.persistToggles = deps.persistToggles;
  state.persistPanels = deps.persistPanels || (() => {});
  state.getPanelPreferences = deps.getPanelPreferences || (() => ({}));
  state.devices = deps.devices;
  state.lastSeen = deps.lastSeen;
  state.lastPositions = deps.lastPositions;
}

function formatEtaIntervalText(eta) {
  if (!eta || !eta.arrival || !eta.interval) return "";
  const arrival = eta.arrival instanceof Date ? eta.arrival : new Date(eta.arrival);
  const low = eta.interval.low instanceof Date ? eta.interval.low : new Date(eta.interval.low);
  const high = eta.interval.high instanceof Date ? eta.interval.high : new Date(eta.interval.high);
  if (
    Number.isNaN(arrival.getTime()) ||
    Number.isNaN(low.getTime()) ||
    Number.isNaN(high.getTime())
  ) {
    return "";
  }
  const lowerSpread = Math.max(0, arrival.getTime() - low.getTime());
  const upperSpread = Math.max(0, high.getTime() - arrival.getTime());
  const spreadMs = Math.max(lowerSpread, upperSpread);
  if (!Number.isFinite(spreadMs) || spreadMs <= 0) return "";
  const minutes = Math.round(spreadMs / 60000);
  if (minutes <= 0) return state.t("etaMarginSubMinute");
  return state.t("etaMargin", { minutes });
}

function formatEtaText(eta) {
  if (eta?.status === "eta" && eta.arrival) {
    const base = state.formatDateTimeFull(eta.arrival);
    const intervalText = formatEtaIntervalText(eta);
    return intervalText ? `${base} (${intervalText})` : base;
  }
  if (eta?.status === "passed") return state.t("passed");
  if (eta?.status === "offtrack") return state.t("offtrack");
  return state.t("unknown");
}

function hideHistoryOverlay() {
  if (state.historyOverlay) {
    state.historyOverlay.remove();
    state.historyOverlay = null;
  }
}

function showHistoryOverlay(deviceId) {
  const hist = state.getProgressHistory(deviceId);
  if (!hist) return;
  hideHistoryOverlay();
  const overlay = document.createElement("div");
  overlay.className = "history-overlay";
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) hideHistoryOverlay();
  });
  const panel = document.createElement("div");
  panel.className = "history-modal";
  const header = document.createElement("div");
  header.className = "history-modal-header";
  const title = document.createElement("div");
  title.textContent = state.t("historyTitle");
  const close = document.createElement("button");
  close.className = "history-close";
  close.textContent = "×";
  close.addEventListener("click", hideHistoryOverlay);
  header.append(title, close);
  panel.appendChild(header);
  const sections = document.createElement("div");
  sections.className = "history-sections";
  const addSection = (label, items, formatter) => {
    const block = document.createElement("div");
    block.className = "history-section";
    const headerRow = document.createElement("button");
    headerRow.type = "button";
    headerRow.className = "history-section-header";
    const h = document.createElement("div");
    h.className = "history-label";
    h.textContent = label;
    const toggle = document.createElement("span");
    toggle.className = "history-toggle";
    headerRow.append(h, toggle);
    block.appendChild(headerRow);
    const content = document.createElement("div");
    content.className = "history-content";
    if (!items || !items.length) {
      const empty = document.createElement("div");
      empty.className = "history-empty";
      empty.textContent = state.t("historyNone");
      content.appendChild(empty);
    } else {
      items.forEach((it) => {
        const row = document.createElement("div");
        row.className = "history-row";
        row.textContent = formatter(it);
        content.appendChild(row);
      });
    }
    block.appendChild(content);
    const setCollapsed = (collapsed) => {
      block.classList.toggle("collapsed", collapsed);
      toggle.classList.toggle("collapsed", collapsed);
    };
    headerRow.addEventListener("click", () => {
      setCollapsed(!block.classList.contains("collapsed"));
    });
    const initialCollapsed = Array.isArray(items) && items.length > 10;
    setCollapsed(initialCollapsed);
    sections.appendChild(block);
  };
  addSection(
    state.t("historyKm"),
    hist?.distances || [],
    (item) => `${Math.round((item.distanceAlong / 1000) * 10) / 10} km • ${state.formatDateTimeFull(item.timeMs)}`
  );
  addSection(
    state.t("historyWp"),
    hist?.waypoints || [],
    (item) =>
      `${item.name || state.t("historyWp")} (${Math.round((item.distanceAlong / 1000) * 10) / 10} km) • ${state.formatDateTimeFull(item.timeMs)}`
  );
  panel.appendChild(sections);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  state.historyOverlay = overlay;
}

function attachHistoryButton(marker, deviceId) {
  const popupEl = marker.getPopup()?.getElement();
  if (!popupEl) return;
  const btnEl = popupEl.querySelector(".history-inline-btn");
  if (!btnEl || btnEl.dataset.bound === "1") return;
  btnEl.dataset.bound = "1";
  btnEl.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    showHistoryOverlay(deviceId);
  });
}

export function initMap() {
  state.map = L.map("map", { worldCopyJump: true }).setView([0, 0], 2);
  state.map.createPane("tracksPane");
  state.map.getPane("tracksPane").style.zIndex = "400";
  state.map.createPane("kmPane");
  state.map.getPane("kmPane").style.zIndex = "410";
  state.map.createPane("kmLabelPane");
  state.map.getPane("kmLabelPane").style.zIndex = "420";
  state.map.getPane("kmLabelPane").style.pointerEvents = "none";
  state.map.createPane("waypointPane");
  state.map.getPane("waypointPane").style.zIndex = "430";
  state.map.createPane("livePane");
  state.map.getPane("livePane").style.zIndex = "450";
  state.map.createPane("viewerPane");
  state.map.getPane("viewerPane").style.zIndex = "460";

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
    maxZoom: 19,
  }).addTo(state.map);
  state.kmMarkerGroup = L.layerGroup().addTo(state.map);
  state.waypointGroup = L.layerGroup().addTo(state.map);
  state.map.on("zoomend", rebuildKmMarkers);
  state.map.on("movestart", () => {
    state.autoFit = false;
  });
  state.map.on("contextmenu", (e) => {
    e.originalEvent.preventDefault();
    showContextMenu(e.latlng, e.containerPoint);
  });
  state.bounds = L.latLngBounds();
  state.boundsDirty = false;
}

export function extendBounds(point) {
  state.bounds.extend(point);
  state.boundsDirty = true;
}

export function fitToData() {
  if (!state.bounds?.isValid() || !state.boundsDirty || !state.autoFit) return;
  state.map.fitBounds(state.bounds, { maxZoom: 16, padding: [30, 30] });
  state.boundsDirty = false;
}

export function clearRoute() {
  state.trackLayers.forEach((l) => l.remove());
  state.trackLayers.length = 0;
  state.kmMarkerGroup?.clearLayers();
  state.routeWaypoints = [];
  state.trackData.length = 0;
  state.elevationProfile = null;
  state.elevationProgressDistance = null;
  renderElevationChart();
}

export function renderRoute(segments, color = nextColor(state.trackData.length)) {
  if (!state.map) return;
  const poly = L.polyline(segments, {
    color,
    weight: 4,
    opacity: 0.8,
    pane: "tracksPane",
  }).addTo(state.map);
  state.trackLayers.push(poly);
  state.trackData.push({ segments, color });
  segments.forEach((seg) => seg.forEach((pt) => extendBounds(pt)));
}

function addKmMarkersForSegments(segments, color, intervalKm) {
  if (!intervalKm || intervalKm <= 0 || !state.kmMarkerGroup) return;
  const intervalMeters = intervalKm * 1000;
  let total = 0;
  let nextMark = intervalMeters;
  const points = [];
  segments.forEach((seg) => {
    if (seg.length < 2) return;
    for (let i = 1; i < seg.length; i += 1) {
      const prev = seg[i - 1];
      const curr = seg[i];
      const segDist = L.latLng(prev).distanceTo(curr);
      const startTotal = total;
      total += segDist;
      while (nextMark <= total && segDist > 0) {
        const ratio = (nextMark - startTotal) / segDist;
        const pt = [
          prev[0] + (curr[0] - prev[0]) * ratio,
          prev[1] + (curr[1] - prev[1]) * ratio,
        ];
        points.push({ km: nextMark / 1000, coord: pt });
        nextMark += intervalMeters;
      }
    }
  });

  points.forEach((point) => {
    const marker = L.circleMarker(point.coord, {
      radius: 5,
      color,
      weight: 2,
      fillColor: "#ffffff",
      fillOpacity: 1,
      pane: "kmPane",
    }).addTo(state.kmMarkerGroup);
    marker.bindTooltip(`${point.km} km`, {
      permanent: true,
      direction: "top",
      className: "km-label",
      offset: [0, -2],
      pane: "kmLabelPane",
    });
    extendBounds(point.coord);
  });
}

export function rebuildKmMarkers() {
  if (!state.kmMarkerGroup || !state.map || !state.config?.showKmMarkers) return;
  state.kmMarkerGroup.clearLayers();
  const base = Number(state.config?.kmMarkerInterval ?? 1);
  if (!base || base <= 0) return;
  const z = state.map.getZoom() || 0;
  let intervalKm = base * 10;
  if (z >= 16) intervalKm = base * 0.25;
  else if (z >= 14) intervalKm = base * 0.5;
  else if (z >= 12) intervalKm = base;
  else if (z >= 10) intervalKm = base * 5;
  if (!intervalKm || intervalKm <= 0) return;
  if (getRoutePoints().length) {
    addKmMarkersForSegments(state.trackData[0]?.segments || [], state.trackData[0]?.color || "#0c8bc7", intervalKm);
  }
}

export function setRouteWaypoints(wps) {
  state.routeWaypoints = wps || [];
}

export function renderWaypoints() {
  if (!state.waypointGroup) return;
  state.waypointGroup.clearLayers();
  if (!state.config?.showWaypoints) return;
  const minLabelZoom = 13;
  const markerLayers = [];
  const makeIcon = (name) => {
    const temp = document.createElement("span");
    temp.className = "waypoint-label-inner";
    temp.textContent = name;
    temp.style.position = "absolute";
    temp.style.visibility = "hidden";
    temp.style.left = "-9999px";
    document.body.appendChild(temp);
    const rect = temp.getBoundingClientRect();
    document.body.removeChild(temp);
    const size = [Math.ceil(rect.width), Math.ceil(rect.height)];
    return L.divIcon({
      className: "waypoint-label-icon",
      html: `<span class="waypoint-label-inner">${name}</span>`,
      iconSize: size,
      iconAnchor: [size[0] / 2, size[1] / 2],
    });
  };
  state.routeWaypoints.forEach((wp) => {
    const marker = L.marker([wp.coord.lat, wp.coord.lng], {
      pane: "waypointPane",
      icon: makeIcon(wp.name),
    }).addTo(state.waypointGroup);
    markerLayers.push(marker);
    const eta = state.computeEta && state.getSelectedDeviceId()
      ? state.computeEta(state.getSelectedDeviceId(), wp.distanceAlong)
      : null;
    const etaText = formatEtaText(eta);
    marker.on("click", () => {
      const idx = state.routeWaypoints.indexOf(wp);
      const next = idx >= 0 && idx < state.routeWaypoints.length - 1 ? state.routeWaypoints[idx + 1] : null;
      const nextLabel = next ? next.name : "Finish";
      const popupHtml = `<strong>${wp.name}</strong><br>${state.t("eta")}: ${etaText}<br><span class="muted">${state.t("next")}: ${nextLabel}</span>`;
      marker.bindPopup(popupHtml).openPopup();
    });
  });
  const toggleLabels = () => {
    const show = state.map.getZoom() >= minLabelZoom;
    markerLayers.forEach((m) => {
      const el = m.getElement();
      if (!el) return;
      if (show) el.classList.remove("hidden");
      else el.classList.add("hidden");
    });
  };
  toggleLabels();
  state.map.off("zoomend", toggleLabels);
  state.map.on("zoomend", toggleLabels);
}

function ensureLegend() {
  if (!state.map) return null;
  if (!state.legendControl) {
    state.legendControl = L.control({ position: "bottomright" });
    state.legendControl.onAdd = () => {
      state.legendContainer = L.DomUtil.create("div", "legend-control collapsible-panel");
      L.DomEvent.disableClickPropagation(state.legendContainer);
      L.DomEvent.disableScrollPropagation(state.legendContainer);
      state.legendBody = createCollapsiblePanel(state.legendContainer, state.t("legend"), "legendCollapsed");
      state.legendBody.classList.add("legend-body");
      return state.legendContainer;
    };
    state.legendControl.addTo(state.map);
  }
  return state.legendBody;
}

export function renderLegend() {
  const body = ensureLegend();
  if (!body || !state.devices) return;
  body.innerHTML = "";
  const deviceEntries = Array.from(state.devices.values()).filter((d) => state.filterDevice(d.id));
  deviceEntries.forEach((device) => {
    const item = document.createElement("div");
    item.className = "legend-item";
    const btn = document.createElement("button");
    btn.className = "legend-btn";
    btn.dataset.deviceId = String(device.id);
    if (device.id === state.getSelectedDeviceId()) btn.classList.add("selected");
    const dot = document.createElement("span");
    dot.className = `legend-dot ${state.isStale(device.id) ? "stale" : "live"}`;
    const label = document.createElement("span");
    const name = device.name || `Device ${device.id}`;
    const prog = state.getDeviceProgress(device.id);
    const offRoute = !prog || prog.offtrack;
    const endpoint = prog?.endpoint;
    const km = !offRoute && prog ? `${Math.round((prog.proj.distanceAlong / 1000) * 10) / 10} km` : null;
    const speedMs = state.getAverageSpeedMs ? state.getAverageSpeedMs(device.id) : 0;
    const speedText = speedMs > 0 ? `${Math.round(speedMs * 3.6 * 10) / 10} km/h` : null;
    const statusText = offRoute
      ? state.t("offrouteLabel")
      : endpoint === "start"
        ? state.t("startLabel")
        : endpoint === "finish"
          ? state.t("finishLabel")
          : km;
    const parts = [name];
    if (speedText) parts.push(`• ${speedText}`);
    if (statusText) parts.push(`• ${statusText}`);
    label.textContent = parts.join(" ");
    btn.append(dot, label);
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      state.selectDevice(device.id, { focus: true });
      focusDevice(device.id);
    });
    item.appendChild(btn);
    body.appendChild(item);
  });
  if (state.config?.showViewerLocation) {
    const item = document.createElement("div");
    item.className = "legend-item";
    const btn = document.createElement("button");
    btn.className = "legend-btn";
    btn.dataset.target = "you";
    const dot = document.createElement("span");
    dot.className = "legend-dot you";
    const label = document.createElement("span");
    label.textContent = state.t("you");
    btn.append(dot, label);
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      focusViewer();
    });
    item.appendChild(btn);
    body.appendChild(item);
  }
}

export function renderToggles() {
  if (!state.map) return;
  if (!state.markerToggleControl) {
    state.markerToggleControl = L.control({ position: "topright" });
    state.markerToggleControl.onAdd = () => {
      state.toggleContainer = L.DomUtil.create("div", "toggle-control collapsible-panel");
      L.DomEvent.disableClickPropagation(state.toggleContainer);
      L.DomEvent.disableScrollPropagation(state.toggleContainer);
      state.toggleBody = createCollapsiblePanel(state.toggleContainer, state.t("options"), "optionsCollapsed");
      state.toggleBody.classList.add("toggle-body");
      return state.toggleContainer;
    };
    state.markerToggleControl.addTo(state.map);
  }
  if (!state.toggleBody) return;
  state.toggleBody.innerHTML = "";
  const kmRow = document.createElement("label");
  kmRow.className = "toggle-row";
  const kmCb = document.createElement("input");
  kmCb.type = "checkbox";
  kmCb.checked = Boolean(state.config?.showKmMarkers);
  kmCb.addEventListener("change", () => {
    state.config.showKmMarkers = kmCb.checked;
    rebuildKmMarkers();
    state.persistToggles();
  });
  kmRow.append(kmCb, document.createTextNode(` ${state.t("toggleKm")}`));
  state.toggleBody.appendChild(kmRow);

  const wpRow = document.createElement("label");
  wpRow.className = "toggle-row";
  const wpCb = document.createElement("input");
  wpCb.type = "checkbox";
  wpCb.checked = Boolean(state.config?.showWaypoints);
  wpCb.addEventListener("change", () => {
    state.config.showWaypoints = wpCb.checked;
    renderWaypoints();
    state.persistToggles();
  });
  wpRow.append(wpCb, document.createTextNode(` ${state.t("toggleWp")}`));
  state.toggleBody.appendChild(wpRow);

  const youRow = document.createElement("label");
  youRow.className = "toggle-row";
  const youCb = document.createElement("input");
  youCb.type = "checkbox";
  youCb.checked = Boolean(state.config?.showViewerLocation);
  youCb.addEventListener("change", () => {
    state.config.showViewerLocation = youCb.checked;
    if (youCb.checked) state.startViewerLocation();
    else state.stopViewerLocation();
    renderLegend();
    state.persistToggles();
  });
  youRow.append(youCb, document.createTextNode(` ${state.t("toggleYou")}`));
  state.toggleBody.appendChild(youRow);
}

export function updateMarker(position) {
  if (!state.filterDevice(position.deviceId)) return;
  const device = state.devices.get(position.deviceId);
  const name = device?.name || `Device ${position.deviceId}`;
  const time = position.deviceTime || position.fixTime || position.serverTime;
  if (time) state.lastSeen.set(position.deviceId, time);
  state.lastPositions.set(position.deviceId, position);
  const coords = [position.latitude, position.longitude];
  if (!state.markers.has(position.deviceId)) {
    const marker = L.circleMarker(coords, {
      radius: 8,
      color: "#0c8bc7",
      fillColor: "#0c8bc7",
      fillOpacity: 0.8,
      pane: "livePane",
    }).addTo(state.map);
    marker.bindTooltip(name);
    state.markers.set(position.deviceId, marker);
  }
  const marker = state.markers.get(position.deviceId);
  marker.setLatLng(coords);
  marker.bringToFront();
  const prog = state.getDeviceProgress(position.deviceId);
  const projPoint = prog?.proj?.point;
  if (projPoint) {
    let line = state.projectionLines.get(position.deviceId);
    const latlngs = [coords, [projPoint.lat, projPoint.lng]];
    if (!line) {
      line = L.polyline(latlngs, {
        color: "#6b7280",
        weight: 2,
        dashArray: "4 4",
        pane: "livePane",
      }).addTo(state.map);
      state.projectionLines.set(position.deviceId, line);
    } else {
      line.setLatLngs(latlngs);
    }
  }
  const stale = state.isStale(position.deviceId);
  marker.setStyle({
    color: stale ? "#6b7280" : "#0c8bc7",
    fillColor: stale ? "#9ca3af" : "#0c8bc7",
  });
  const avgMs = state.getAverageSpeedMs(position.deviceId);
  const speed = avgMs ? ` • ${Math.round(avgMs * 3.6 * 10) / 10} km/h` : "";
  const posLabel =
    prog?.endpoint === "start"
      ? ` • ${state.t("startLabel")}`
      : prog?.endpoint === "finish"
        ? ` • ${state.t("finishLabel")}`
        : "";
  const showHistoryBtn =
    state.getSelectedDeviceId && state.getSelectedDeviceId() === position.deviceId
      ? `<br><button class="history-inline-btn" data-history-id="${position.deviceId}">${state.t("historyShow")}</button>`
      : "";
  const content = `${name}${speed}${posLabel}<br><span class="muted">${state.formatDateTimeFull(time) || ""}</span>${showHistoryBtn}`;
  const popup = marker.getPopup();
  if (popup) {
    popup.setContent(content);
  } else {
    marker.bindPopup(content);
  }
  if (state.getSelectedDeviceId && state.getSelectedDeviceId() === position.deviceId && prog?.proj?.distanceAlong != null) {
    setElevationProgress(prog.proj.distanceAlong);
  }
  marker.off("popupopen");
  marker.on("popupopen", () => {
    attachHistoryButton(marker, position.deviceId);
  });
  attachHistoryButton(marker, position.deviceId);
  extendBounds(coords);
}

export function focusDevice(deviceId) {
  const marker = state.markers.get(deviceId);
  if (!marker) return;
  state.autoFit = false;
  state.map.setView(marker.getLatLng(), Math.max(state.map.getZoom(), 15));
  marker.openPopup();
}

export function focusViewer() {
  if (!state.viewerMarker) return;
  state.autoFit = false;
  state.map.setView(state.viewerMarker.getLatLng(), Math.max(state.map.getZoom(), 15));
  state.viewerMarker.openPopup();
}

export function startViewerLocation() {
  if (!state.config?.showViewerLocation || !("geolocation" in navigator)) return;
  if (state.viewerWatchId != null) return;
  const opts = { enableHighAccuracy: true, maximumAge: 15000, timeout: 10000 };
  const onPos = (pos) => {
    const { latitude, longitude, accuracy } = pos.coords;
    const latlng = [latitude, longitude];
    if (!state.viewerMarker) {
      state.viewerMarker = L.circleMarker(latlng, {
        radius: 9,
        color: "#16a34a",
        fillColor: "#22c55e",
        fillOpacity: 0.85,
        weight: 2,
        pane: "viewerPane",
      }).addTo(state.map);
      state.viewerMarker.bindTooltip(state.t("you"), { direction: "top", offset: [0, -4] });
    } else {
      state.viewerMarker.setLatLng(latlng);
    }
    state.viewerMarker.setPopupContent(`${state.t("you")}<br><span class="muted">±${Math.round(accuracy)} m</span>`);
    state.viewerMarker.bringToFront();
    extendBounds(latlng);
    fitToData();
  };
  const onErr = (err) => {
    console.warn("Geolocation error", err);
  };
  state.viewerWatchId = navigator.geolocation.watchPosition(onPos, onErr, opts);
}

export function stopViewerLocation() {
  if (state.viewerWatchId != null && navigator.geolocation?.clearWatch) {
    navigator.geolocation.clearWatch(state.viewerWatchId);
  }
  state.viewerWatchId = null;
  if (state.viewerMarker) {
    state.viewerMarker.remove();
    state.viewerMarker = null;
  }
}

function hideContextMenu() {
  if (state.contextMenuEl) {
    state.contextMenuEl.classList.add("hidden");
  }
}

function copyCoords(latlng) {
  const text = `${latlng.lat.toFixed(6)},${latlng.lng.toFixed(6)}`;
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch((err) => console.warn("Copy failed", err));
  } else {
    window.prompt("Copy coordinates:", text); // eslint-disable-line no-alert
  }
}

function showContextMenu(latlng, containerPoint) {
  if (!state.contextMenuEl || !state.map) return;
  const rect = state.map.getContainer().getBoundingClientRect();
  const x = rect.left + (containerPoint?.x ?? 0);
  const y = rect.top + (containerPoint?.y ?? 0);
  state.contextMenuEl.innerHTML = "";
  if (state.getSelectedDeviceId() && getRoutePoints().length && state.projectOnRoute) {
    const targetProj = state.projectOnRoute(latlng);
    if (targetProj && !targetProj.offtrack) {
      const eta = state.computeEta ? state.computeEta(state.getSelectedDeviceId(), targetProj.distanceAlong) : null;
      const info = document.createElement("div");
      info.className = "context-info";
      const etaText = formatEtaText(eta);
      info.textContent = state.t("etaHere", { eta: etaText });
      state.contextMenuEl.appendChild(info);
    }
  }
  const items = [
    {
      label: state.t("openGoogle"),
      action: () =>
        window.open(`https://www.google.com/maps/search/?api=1&query=${latlng.lat},${latlng.lng}`, "_blank"),
    },
    {
      label: state.t("openWaze"),
      action: () => window.open(`https://waze.com/ul?ll=${latlng.lat},${latlng.lng}&navigate=yes`, "_blank"),
    },
    {
      label: state.t("copyCoords"),
      action: () => copyCoords(latlng),
    },
  ];
  items.forEach((item) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = item.label;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      hideContextMenu();
      item.action();
    });
    state.contextMenuEl.appendChild(btn);
  });
  state.contextMenuEl.style.left = `${x}px`;
  state.contextMenuEl.style.top = `${y}px`;
  state.contextMenuEl.classList.remove("hidden");
}

export function initContextMenu() {
  state.contextMenuEl = document.createElement("div");
  state.contextMenuEl.className = "context-menu hidden";
  document.body.appendChild(state.contextMenuEl);
  document.addEventListener("click", hideContextMenu);
  initHelp();
  if (!state.map) return;
  const container = state.map.getContainer();
  const longPressMs = 600;
  const clearTimer = () => {
    if (state.longPressTimer) {
      clearTimeout(state.longPressTimer);
      state.longPressTimer = null;
    }
  };
  const startTimer = (touchEvent) => {
    clearTimer();
    const touch = touchEvent.touches?.[0];
    if (!touch) return;
    state.longPressPos = { clientX: touch.clientX, clientY: touch.clientY };
    state.longPressTimer = setTimeout(() => {
      const rect = container.getBoundingClientRect();
      const containerPoint = L.point(state.longPressPos.clientX - rect.left, state.longPressPos.clientY - rect.top);
      const latlng = state.map.containerPointToLatLng(containerPoint);
      showContextMenu(latlng, containerPoint);
    }, longPressMs);
  };
  const moveCancel = (e) => {
    if (!state.longPressPos) return;
    const touch = e.touches?.[0];
    if (!touch) {
      clearTimer();
      return;
    }
    const dx = touch.clientX - state.longPressPos.clientX;
    const dy = touch.clientY - state.longPressPos.clientY;
    if (Math.sqrt(dx * dx + dy * dy) > 10) clearTimer();
  };
  container.addEventListener("touchstart", (e) => {
    startTimer(e);
  });
  container.addEventListener("touchend", clearTimer);
  container.addEventListener("touchcancel", clearTimer);
  container.addEventListener("touchmove", moveCancel);
}

function initHelp() {
  const trigger = document.getElementById("help-trigger");
  if (!trigger) return;
  state.helpPopupEl = document.createElement("div");
  state.helpPopupEl.className = "help-popup hidden";
  updateHelpContent();
  document.body.appendChild(state.helpPopupEl);
  const hide = () => state.helpPopupEl.classList.add("hidden");
  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    state.helpPopupEl.classList.toggle("hidden");
  });
  document.addEventListener("click", (e) => {
    if (e.target === trigger || state.helpPopupEl.contains(e.target)) return;
    hide();
  });
}

export function updateHelpContent() {
  if (!state.helpPopupEl) return;
  state.helpPopupEl.innerHTML = `<strong>${state.t("helpTitle")}</strong><br>${state.t("helpTip")}`;
}

export function setSelectedDeviceId(deviceId) {
  if (!state.legendContainer) return;
  state.legendContainer.querySelectorAll(".legend-btn").forEach((btn) => {
    btn.classList.toggle("selected", Number(btn.dataset.deviceId) === deviceId);
  });
}

// Test-only helper to access internal state
export function __getVizTestState() {
  return state;
}
