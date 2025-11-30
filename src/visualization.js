import { getRouteDistances, getRoutePoints } from "./route.js";

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
  devices: null,
  lastSeen: null,
  lastPositions: null,
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
  markerToggleControl: null,
  toggleContainer: null,
  viewerMarker: null,
  viewerWatchId: null,
  contextMenuEl: null,
  helpPopupEl: null,
  longPressTimer: null,
  longPressPos: null,
};

function nextColor(idx) {
  return colors[idx % colors.length];
}

export function setupVisualization(deps) {
  state.config = deps.config;
  state.t = deps.t;
  state.computeEta = deps.computeEta;
  state.getDeviceProgress = deps.getDeviceProgress;
  state.getAverageSpeedMs = deps.getAverageSpeedMs;
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
  state.devices = deps.devices;
  state.lastSeen = deps.lastSeen;
  state.lastPositions = deps.lastPositions;
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
    const etaText =
      eta?.status === "eta" && eta.arrival
        ? state.formatDateTimeFull(eta.arrival)
        : eta?.status === "passed"
          ? state.t("passed")
          : eta?.status === "offtrack"
            ? state.t("offtrack")
            : state.t("unknown");
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
      state.legendContainer = L.DomUtil.create("div", "legend-control");
      L.DomEvent.disableClickPropagation(state.legendContainer);
      L.DomEvent.disableScrollPropagation(state.legendContainer);
      return state.legendContainer;
    };
    state.legendControl.addTo(state.map);
  }
  return state.legendContainer;
}

export function renderLegend() {
  const container = ensureLegend();
  if (!container || !state.devices) return;
  container.innerHTML = "";
  const dbgWrap = document.createElement("div");
  dbgWrap.className = "legend-item";
  const dbgBtn = document.createElement("button");
  dbgBtn.className = "legend-btn";
  dbgBtn.textContent = "Debug";
  dbgBtn.addEventListener("click", () => window.open("/debug.html", "_blank"));
  dbgWrap.appendChild(dbgBtn);
  container.appendChild(dbgWrap);
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
    const ts = state.formatTimeLabel(state.lastSeen.get(device.id));
    const prog = state.getDeviceProgress(device.id);
    const offRoute = !prog || prog.offtrack;
    const km = !offRoute && prog ? `${Math.round((prog.proj.distanceAlong / 1000) * 10) / 10} km` : null;
    const suffix = offRoute ? ` • ${state.t("offrouteLabel")}` : km ? ` • ${km}` : "";
    label.textContent = ts ? `${name} (${ts})${suffix}` : `${name}${suffix}`;
    btn.append(dot, label);
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      state.selectDevice(device.id, { focus: true });
      focusDevice(device.id);
    });
    item.appendChild(btn);
    container.appendChild(item);
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
    container.appendChild(item);
  }
}

export function renderToggles() {
  if (!state.map) return;
  if (!state.markerToggleControl) {
    state.markerToggleControl = L.control({ position: "topright" });
    state.markerToggleControl.onAdd = () => {
      state.toggleContainer = L.DomUtil.create("div", "toggle-control");
      L.DomEvent.disableClickPropagation(state.toggleContainer);
      L.DomEvent.disableScrollPropagation(state.toggleContainer);
      return state.toggleContainer;
    };
    state.markerToggleControl.addTo(state.map);
  }
  state.toggleContainer.innerHTML = "";
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
  state.toggleContainer.appendChild(kmRow);

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
  state.toggleContainer.appendChild(wpRow);

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
  state.toggleContainer.appendChild(youRow);
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
  const content = `${name}${speed}<br><span class="muted">${state.formatDateTimeFull(time) || ""}</span>`;
  const popup = marker.getPopup();
  if (popup) {
    popup.setContent(content);
  } else {
    marker.bindPopup(content);
  }
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
      const etaText =
        eta?.status === "eta" && eta.arrival
          ? state.formatDateTimeFull(eta.arrival)
          : eta?.status === "passed"
            ? state.t("passed")
            : eta?.status === "offtrack"
              ? state.t("offtrack")
              : state.t("unknown");
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
