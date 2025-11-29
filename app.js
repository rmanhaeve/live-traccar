(() => {
  const statusEl = document.getElementById("status");
  const titleEl = document.getElementById("title");

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

  let colorIdx = 0;
  let map;
  let bounds;
  let boundsDirty = false;
  let autoFit = true;
  let config;
  const trackLayers = [];
  let kmMarkerGroup;
  let legendControl;
  let legendContainer;
  const markers = new Map();
  const lastSeen = new Map();
  let viewerMarker;
  let viewerWatchId;
  let devices = new Map();
  let refreshTimer;
  const trackData = [];
  let contextMenuEl;
  let longPressTimer;
  let longPressPos;

  const defaults = {
    title: "Live Tracker",
    refreshSeconds: 10,
    deviceIds: null,
    kmMarkerInterval: 1,
    showViewerLocation: true,
    staleMinutes: 15,
  };

  function nextColor() {
    const color = colors[colorIdx % colors.length];
    colorIdx += 1;
    return color;
  }

  function setStatus(text, isError = false) {
    statusEl.textContent = text;
    statusEl.classList.toggle("error", Boolean(isError));
  }

  function initMap() {
    map = L.map("map", { worldCopyJump: true }).setView([0, 0], 2);

    // Dedicated panes to control stacking order
    map.createPane("tracksPane");
    map.getPane("tracksPane").style.zIndex = "400";
    map.createPane("kmPane");
    map.getPane("kmPane").style.zIndex = "410";
    map.createPane("kmLabelPane");
    map.getPane("kmLabelPane").style.zIndex = "420";
    map.getPane("kmLabelPane").style.pointerEvents = "none";
    map.createPane("livePane");
    map.getPane("livePane").style.zIndex = "450";
    map.createPane("viewerPane");
    map.getPane("viewerPane").style.zIndex = "460";

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
      maxZoom: 19,
    }).addTo(map);
    kmMarkerGroup = L.layerGroup().addTo(map);
    map.on("zoomend", rebuildKmMarkers);
    map.on("movestart", () => {
      autoFit = false;
    });
    map.on("contextmenu", (e) => {
      e.originalEvent.preventDefault();
      showContextMenu(e.latlng, e.containerPoint);
    });
    bounds = L.latLngBounds();
    boundsDirty = false;
  }

  function extendBounds(point) {
    bounds.extend(point);
    boundsDirty = true;
  }

  function toRad(deg) {
    return (deg * Math.PI) / 180;
  }

  function distanceMeters(a, b) {
    const R = 6371000;
    const dLat = toRad(b[0] - a[0]);
    const dLon = toRad(b[1] - a[1]);
    const lat1 = toRad(a[0]);
    const lat2 = toRad(b[0]);
    const sinDLat = Math.sin(dLat / 2);
    const sinDLon = Math.sin(dLon / 2);
    const h =
      sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function interpolatePoint(a, b, ratio) {
    return [a[0] + (b[0] - a[0]) * ratio, a[1] + (b[1] - a[1]) * ratio];
  }

  function getKmIntervalForZoom(zoom) {
    const base = Number(config?.kmMarkerInterval ?? defaults.kmMarkerInterval);
    if (!base || base <= 0) return 0;
    const z = zoom || 0;
    if (z >= 16) return base * 0.25;
    if (z >= 14) return base * 0.5;
    if (z >= 12) return base;
    if (z >= 10) return base * 5;
    return base * 10;
  }

  async function loadConfig() {
    try {
      const res = await fetch("config.json", { cache: "no-store" });
      if (!res.ok) throw new Error("config.json missing");
      const cfg = await res.json();
      config = {
        ...defaults,
        ...cfg,
      };
      setStatus("Config loaded");
      const pageTitle = config.title || defaults.title;
      titleEl.textContent = pageTitle;
      document.title = pageTitle;
      rebuildKmMarkers();
      renderLegend();
    } catch (err) {
      setStatus("Add config.json (see config.example.json)", true);
    }
  }

  async function loadTrackManifest() {
    try {
      const res = await fetch("tracks/manifest.json", { cache: "no-store" });
      if (!res.ok) throw new Error("No manifest");
      const data = await res.json();
      return Array.isArray(data.tracks) ? data.tracks : [];
    } catch (err) {
      setStatus("No tracks manifest found (run npm run tracks)", false);
      return [];
    }
  }

  function parseGpx(xmlText) {
    const xml = new DOMParser().parseFromString(xmlText, "application/xml");
    const error = xml.querySelector("parsererror");
    if (error) throw new Error("GPX parse error");
    const segments = [];
    const trackNodes = Array.from(xml.getElementsByTagName("trk"));
    trackNodes.forEach((trk) => {
      const segs = Array.from(trk.getElementsByTagName("trkseg"));
      segs.forEach((seg) => {
        const pts = Array.from(seg.getElementsByTagName("trkpt")).map((pt) => [
          Number(pt.getAttribute("lat")),
          Number(pt.getAttribute("lon")),
        ]);
        if (pts.length) segments.push(pts);
      });
    });
    return segments;
  }

  function addKmMarkersForSegments(segments, color, intervalKm) {
    if (!intervalKm || intervalKm <= 0 || !kmMarkerGroup) return;
    const intervalMeters = intervalKm * 1000;
    let total = 0;
    let nextMark = intervalMeters;
    const points = [];
    segments.forEach((seg) => {
      if (seg.length < 2) return;
      for (let i = 1; i < seg.length; i += 1) {
        const prev = seg[i - 1];
        const curr = seg[i];
        const segDist = distanceMeters(prev, curr);
        const startTotal = total;
        total += segDist;
        while (nextMark <= total && segDist > 0) {
          const ratio = (nextMark - startTotal) / segDist;
          const pt = interpolatePoint(prev, curr, ratio);
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
      }).addTo(kmMarkerGroup);
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

  function rebuildKmMarkers() {
    if (!kmMarkerGroup || !map) return;
    kmMarkerGroup.clearLayers();
    const intervalKm = getKmIntervalForZoom(map.getZoom());
    if (!intervalKm || intervalKm <= 0) return;
    trackData.forEach((t) => {
      addKmMarkersForSegments(t.segments, t.color, intervalKm);
    });
  }

  async function loadTrack(track) {
    try {
      const res = await fetch(`tracks/${track.file}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`Track ${track.file} missing`);
      const text = await res.text();
      const segments = parseGpx(text);
      if (!segments.length) throw new Error(`Track ${track.file} has no segments`);
      const color = track.color || nextColor();
      const poly = L.polyline(segments, {
        color,
        weight: 4,
        opacity: 0.8,
        pane: "tracksPane",
      }).addTo(map);
      trackLayers.push(poly);
      trackData.push({ segments, color });
      rebuildKmMarkers();
      segments.forEach((seg) => seg.forEach((pt) => extendBounds(pt)));
      fitToData();
    } catch (err) {
      console.error(err);
      setStatus(`Track error: ${track.file}`, true);
    }
  }

  async function loadTracks() {
    const manifest = await loadTrackManifest();
    if (!manifest.length) return;
    for (const track of manifest) {
      // eslint-disable-next-line no-await-in-loop
      await loadTrack(track);
    }
  }

  async function fetchJson(path) {
    const headers = config?.token
      ? { Authorization: `Bearer ${config.token}` }
      : {};
    const res = await fetch(path, { headers, cache: "no-store" });
    if (!res.ok) throw new Error(`Request failed: ${path}`);
    return res.json();
  }

  function cleanBase(url) {
    return url.replace(/\/+$/, "");
  }

  async function refreshDevices() {
    if (!config?.traccarUrl || !config?.token) return;
    const data = await fetchJson(`${cleanBase(config.traccarUrl)}/api/devices`);
    devices = new Map(data.map((d) => [d.id, d]));
    renderLegend();
  }

  function filterDevice(id) {
    if (!config?.deviceIds || !Array.isArray(config.deviceIds)) return true;
    return config.deviceIds.includes(id);
  }

  function updateMarker(position) {
    const device = devices.get(position.deviceId);
    if (!filterDevice(position.deviceId)) return;
    const name = device?.name || `Device ${position.deviceId}`;
    const time = position.deviceTime || position.fixTime || position.serverTime;
    if (time) lastSeen.set(position.deviceId, time);
    const coords = [position.latitude, position.longitude];
    if (!markers.has(position.deviceId)) {
      const marker = L.circleMarker(coords, {
        radius: 8,
        color: "#0c8bc7",
        fillColor: "#0c8bc7",
        fillOpacity: 0.8,
        pane: "livePane",
      }).addTo(map);
      marker.bindTooltip(name);
      markers.set(position.deviceId, marker);
    }
    const marker = markers.get(position.deviceId);
    marker.setLatLng(coords);
    marker.bringToFront();
    const stale = isStale(position.deviceId);
    marker.setStyle({
      color: stale ? "#6b7280" : "#0c8bc7",
      fillColor: stale ? "#9ca3af" : "#0c8bc7",
    });
    const speed =
      position.speed != null ? ` • ${Math.round(position.speed * 1.852 * 10) / 10} km/h` : "";
    const content = `${name}${speed}<br><span class="muted">${formatDateTimeFull(time) || ""}</span>`;
    const popup = marker.getPopup();
    if (popup) {
      popup.setContent(content);
    } else {
      marker.bindPopup(content);
    }
    extendBounds(coords);
  }

  async function refreshPositions() {
    if (!config?.traccarUrl || !config?.token) return;
    const url = `${cleanBase(config.traccarUrl)}/api/positions`;
    const positions = await fetchJson(url);
    positions.forEach(updateMarker);
    renderLegend();
    fitToData();
    setStatus(`Last update ${new Date().toLocaleTimeString()}`);
  }

  function fitToData() {
    if (!bounds.isValid() || !boundsDirty || !autoFit) return;
    map.fitBounds(bounds, { maxZoom: 16, padding: [30, 30] });
    boundsDirty = false;
  }

  function startViewerLocation() {
    if (!config?.showViewerLocation || !("geolocation" in navigator)) return;
    const opts = { enableHighAccuracy: true, maximumAge: 15000, timeout: 10000 };
    const onPos = (pos) => {
      const { latitude, longitude, accuracy } = pos.coords;
      const latlng = [latitude, longitude];
      if (!viewerMarker) {
        viewerMarker = L.circleMarker(latlng, {
          radius: 9,
          color: "#16a34a",
          fillColor: "#22c55e",
          fillOpacity: 0.85,
          weight: 2,
          pane: "viewerPane",
        }).addTo(map);
        viewerMarker.bindTooltip("You", { direction: "top", offset: [0, -4] });
      } else {
        viewerMarker.setLatLng(latlng);
      }
      viewerMarker.setPopupContent(`You<br><span class="muted">±${Math.round(accuracy)} m</span>`);
      viewerMarker.bringToFront();
      extendBounds(latlng);
      fitToData();
    };
    const onErr = (err) => {
      console.warn("Geolocation error", err);
    };
    viewerWatchId = navigator.geolocation.watchPosition(onPos, onErr, opts);
  }

  function ensureLegend() {
    if (!map) return null;
    if (!legendControl) {
      legendControl = L.control({ position: "bottomright" });
      legendControl.onAdd = () => {
        legendContainer = L.DomUtil.create("div", "legend-control");
        L.DomEvent.disableClickPropagation(legendContainer);
        L.DomEvent.disableScrollPropagation(legendContainer);
        return legendContainer;
      };
      legendControl.addTo(map);
    }
    return legendContainer;
  }

  function hideContextMenu() {
    if (contextMenuEl) {
      contextMenuEl.classList.add("hidden");
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
    if (!contextMenuEl || !map) return;
    const rect = map.getContainer().getBoundingClientRect();
    const x = rect.left + (containerPoint?.x ?? 0);
    const y = rect.top + (containerPoint?.y ?? 0);
    contextMenuEl.innerHTML = "";
    const items = [
      {
        label: "Open in Google Maps",
        action: () =>
          window.open(
            `https://www.google.com/maps/search/?api=1&query=${latlng.lat},${latlng.lng}`,
            "_blank"
          ),
      },
      {
        label: "Open in Waze",
        action: () =>
          window.open(`https://waze.com/ul?ll=${latlng.lat},${latlng.lng}&navigate=yes`, "_blank"),
      },
      {
        label: "Copy coordinates",
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
      contextMenuEl.appendChild(btn);
    });
    contextMenuEl.style.left = `${x}px`;
    contextMenuEl.style.top = `${y}px`;
    contextMenuEl.classList.remove("hidden");
  }

  function initContextMenu() {
    contextMenuEl = document.createElement("div");
    contextMenuEl.className = "context-menu hidden";
    document.body.appendChild(contextMenuEl);
    document.addEventListener("click", hideContextMenu);
    if (!map) return;
    const container = map.getContainer();
    const longPressMs = 600;
    const clearTimer = () => {
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    };
    const startTimer = (touchEvent) => {
      clearTimer();
      const touch = touchEvent.touches?.[0];
      if (!touch) return;
      longPressPos = { clientX: touch.clientX, clientY: touch.clientY };
      longPressTimer = setTimeout(() => {
        const rect = container.getBoundingClientRect();
        const containerPoint = L.point(
          longPressPos.clientX - rect.left,
          longPressPos.clientY - rect.top
        );
        const latlng = map.containerPointToLatLng(containerPoint);
        showContextMenu(latlng, containerPoint);
      }, longPressMs);
    };
    const moveCancel = (e) => {
      if (!longPressPos) return;
      const touch = e.touches?.[0];
      if (!touch) {
        clearTimer();
        return;
      }
      const dx = touch.clientX - longPressPos.clientX;
      const dy = touch.clientY - longPressPos.clientY;
      if (Math.sqrt(dx * dx + dy * dy) > 10) clearTimer();
    };
    container.addEventListener("touchstart", (e) => {
      startTimer(e);
    });
    container.addEventListener("touchend", clearTimer);
    container.addEventListener("touchcancel", clearTimer);
    container.addEventListener("touchmove", moveCancel);
  }

  function focusDevice(deviceId) {
    const marker = markers.get(deviceId);
    if (!marker) return;
    autoFit = false;
    map.setView(marker.getLatLng(), Math.max(map.getZoom(), 15));
    marker.openPopup();
  }

  function focusViewer() {
    if (!viewerMarker) return;
    autoFit = false;
    map.setView(viewerMarker.getLatLng(), Math.max(map.getZoom(), 15));
    viewerMarker.openPopup();
  }

  function isStale(deviceId) {
    const minutes = Number(config?.staleMinutes ?? defaults.staleMinutes);
    if (!minutes || minutes <= 0) return false;
    const ts = lastSeen.get(deviceId);
    if (!ts) return false;
    const ageMs = Date.now() - new Date(ts).getTime();
    return Number.isFinite(ageMs) && ageMs > minutes * 60 * 1000;
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
    const d = new Date(timeStr);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  }

  function renderLegend() {
    const container = ensureLegend();
    if (!container) return;
    container.innerHTML = "";
    const deviceEntries = Array.from(devices.values()).filter((d) => filterDevice(d.id));
    deviceEntries.forEach((device) => {
      const item = document.createElement("div");
      item.className = "legend-item";
      const btn = document.createElement("button");
      btn.className = "legend-btn";
      btn.dataset.deviceId = String(device.id);
      const dot = document.createElement("span");
      dot.className = `legend-dot ${isStale(device.id) ? "stale" : "live"}`;
      const label = document.createElement("span");
      const name = device.name || `Device ${device.id}`;
      const ts = formatTimeLabel(lastSeen.get(device.id));
      label.textContent = ts ? `${name} (${ts})` : name;
      btn.append(dot, label);
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        focusDevice(device.id);
      });
      item.appendChild(btn);
      container.appendChild(item);
    });
    if (config?.showViewerLocation) {
      const item = document.createElement("div");
      item.className = "legend-item";
      const btn = document.createElement("button");
      btn.className = "legend-btn";
      btn.dataset.target = "you";
      const dot = document.createElement("span");
      dot.className = "legend-dot you";
      const label = document.createElement("span");
      label.textContent = "You";
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

  async function startPolling() {
    if (!config?.token || !config?.traccarUrl) return;
    await refreshDevices().catch((err) => {
      console.error(err);
      setStatus("Device fetch failed", true);
    });
    await refreshPositions().catch((err) => {
      console.error(err);
      setStatus("Position fetch failed", true);
    });
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      refreshPositions().catch((err) => {
        console.error(err);
        setStatus("Position fetch failed", true);
      });
    }, (config.refreshSeconds || defaults.refreshSeconds) * 1000);
  }

  async function bootstrap() {
    initMap();
    initContextMenu();
    await loadConfig();
    await loadTracks();
    await startPolling();
    startViewerLocation();
  }

  bootstrap();
})();
