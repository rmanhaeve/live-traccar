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
  const debugState = new Map();
  const projectionLines = new Map();
  const lastSeen = new Map();
  const lastPositions = new Map();
  const positionsHistory = new Map();
  let viewerMarker;
  let viewerWatchId;
  let devices = new Map();
  let refreshTimer;
  const trackData = [];
  let contextMenuEl;
  let longPressTimer;
  let longPressPos;
  let selectedDeviceId = null;
  let routePoints = [];
  let routeDistances = [];
  let routeWaypoints = [];
  let routeAvgLat = 0;
  let waypointGroup;
  let markerToggleControl;
  let toggleContainer;
  let helpPopupEl;
  let routeTotal = 0;
  let texts;

  const defaults = {
    title: "Live Tracker",
    refreshSeconds: 10,
    deviceIds: null,
    kmMarkerInterval: 1,
    showViewerLocation: true,
    staleMinutes: 15,
    startTime: null,
    showKmMarkers: true,
    showWaypoints: true,
    debug: false,
  };

  const defaultTexts = {
    eta: "ETA",
    etaHere: "ETA here: {eta}",
    passed: "passed",
    offtrack: "participant not on track",
    unknown: "unknown",
    next: "Next",
    offrouteLabel: "off-route",
    helpTip:
      "Select a participant to see live ETAs to waypoints. Right-click or long-press the map for Google Maps/Waze/coords and ETA to that point.",
    helpTitle: "Live Tracker Tips",
  };

  function t(key, vars = {}) {
    const str = (texts && texts[key]) || defaultTexts[key] || key;
    return Object.keys(vars).reduce((acc, k) => acc.replace(`{${k}}`, vars[k]), str);
  }

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
    map.createPane("waypointPane");
    map.getPane("waypointPane").style.zIndex = "430";
    map.createPane("livePane");
    map.getPane("livePane").style.zIndex = "450";
    map.createPane("viewerPane");
    map.getPane("viewerPane").style.zIndex = "460";

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
      maxZoom: 19,
    }).addTo(map);
    kmMarkerGroup = L.layerGroup().addTo(map);
    waypointGroup = L.layerGroup().addTo(map);
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
      texts = { ...defaultTexts };
      setStatus("Config loaded");
      const pageTitle = config.title || defaults.title;
      titleEl.textContent = pageTitle;
      document.title = pageTitle;
      rebuildKmMarkers();
      renderWaypoints();
      renderToggles();
      renderLegend();
    } catch (err) {
      setStatus("Add config.json (see config.example.json)", true);
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
    const waypoints = Array.from(xml.getElementsByTagName("wpt")).map((wpt) => ({
      lat: Number(wpt.getAttribute("lat")),
      lng: Number(wpt.getAttribute("lon")),
      name: wpt.querySelector("name")?.textContent?.trim(),
      desc: wpt.querySelector("desc")?.textContent?.trim(),
    }));
    return { segments, waypoints };
  }

  async function loadTranslations() {
    const path = config?.translationFile || "translations/en.json";
    try {
      const res = await fetch(path, { cache: "no-store" });
      if (!res.ok) throw new Error("no translation file");
      const data = await res.json();
      texts = { ...defaultTexts, ...data };
    } catch (err) {
      texts = { ...defaultTexts };
    }
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
    if (!config?.showKmMarkers) return;
    const intervalKm = getKmIntervalForZoom(map.getZoom());
    if (!intervalKm || intervalKm <= 0) return;
    if (routePoints.length) {
      addKmMarkersForSegments(trackData[0]?.segments || [], trackData[0]?.color || "#0c8bc7", intervalKm);
    }
  }

  function buildRouteProfile(segments) {
    routePoints = [];
    routeDistances = [];
    routeAvgLat = 0;
    segments.forEach((seg) => {
      seg.forEach((pt) => routePoints.push({ lat: pt[0], lng: pt[1] }));
    });
    if (!routePoints.length) return;
    routeAvgLat = routePoints.reduce((sum, p) => sum + p.lat, 0) / routePoints.length;
    routeDistances = new Array(routePoints.length).fill(0);
    for (let i = 1; i < routePoints.length; i += 1) {
      routeDistances[i] =
        routeDistances[i - 1] + distanceMeters([routePoints[i - 1].lat, routePoints[i - 1].lng], [routePoints[i].lat, routePoints[i].lng]);
    }
    routeTotal = routeDistances[routeDistances.length - 1] || 0;
  }

  function projectOnRoute(latlng) {
    if (!routePoints.length) return null;
    const refLat = routeAvgLat || latlng.lat;
    const toXY = (p) => {
      const rad = Math.PI / 180;
      const R = 6371000;
      return {
        x: p.lng * rad * Math.cos(refLat * rad) * R,
        y: p.lat * rad * R,
      };
    };
    const target = toXY(latlng);
    let best = { dist2: Infinity, distanceAlong: 0, point: latlng };
    for (let i = 1; i < routePoints.length; i += 1) {
      const a = routePoints[i - 1];
      const b = routePoints[i];
      const ax = toXY(a);
      const bx = toXY(b);
      const seg = { x: bx.x - ax.x, y: bx.y - ax.y };
      const segLen2 = seg.x * seg.x + seg.y * seg.y;
      if (segLen2 === 0) continue;
      const ap = { x: target.x - ax.x, y: target.y - ax.y };
      let t = (ap.x * seg.x + ap.y * seg.y) / segLen2;
      t = Math.max(0, Math.min(1, t));
      const proj = { x: ax.x + seg.x * t, y: ax.y + seg.y * t };
      const d2 = (proj.x - target.x) * (proj.x - target.x) + (proj.y - target.y) * (proj.y - target.y);
      if (d2 < best.dist2) {
        const segDist = distanceMeters([a.lat, a.lng], [b.lat, b.lng]);
        best = {
          dist2: d2,
          distanceAlong: routeDistances[i - 1] + segDist * t,
          point: {
            lat: a.lat + (b.lat - a.lat) * t,
            lng: a.lng + (b.lng - a.lng) * t,
          },
        };
      }
    }
    if (!Number.isFinite(best.dist2)) return null;
    const offtrack = Math.sqrt(best.dist2) > 200;
    return { ...best, offtrack };
  }

  function mapWaypoints(rawWaypoints) {
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

  function pointAtDistance(distanceAlong) {
    if (!routePoints.length || !routeDistances.length) return null;
    const target = Math.min(Math.max(distanceAlong, 0), routeDistances[routeDistances.length - 1]);
    let idx = routeDistances.findIndex((d) => d >= target);
    if (idx <= 0) return routePoints[routePoints.length - 1];
    if (routeDistances[idx] === target) return routePoints[idx];
    const prevIdx = idx - 1;
    const segmentLen = routeDistances[idx] - routeDistances[prevIdx];
    const t = segmentLen > 0 ? (target - routeDistances[prevIdx]) / segmentLen : 0;
    const a = routePoints[prevIdx];
    const b = routePoints[idx];
    return {
      lat: a.lat + (b.lat - a.lat) * t,
      lng: a.lng + (b.lng - a.lng) * t,
    };
  }

  function renderWaypoints() {
    if (!waypointGroup) return;
    waypointGroup.clearLayers();
    if (!config?.showWaypoints) return;
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
    routeWaypoints.forEach((wp) => {
      const marker = L.marker([wp.coord.lat, wp.coord.lng], {
        pane: "waypointPane",
        icon: makeIcon(wp.name),
      }).addTo(waypointGroup);
      markerLayers.push(marker);
      const eta = selectedDeviceId ? computeEta(selectedDeviceId, wp.distanceAlong) : null;
      const etaText =
        eta?.status === "eta" && eta.arrival
          ? formatDateTimeFull(eta.arrival)
          : eta?.status === "passed"
            ? t("passed")
            : eta?.status === "offtrack"
              ? t("offtrack")
              : t("unknown");
      marker.on("click", () => {
        const idx = routeWaypoints.indexOf(wp);
        const next = idx >= 0 && idx < routeWaypoints.length - 1 ? routeWaypoints[idx + 1] : null;
        const nextLabel = next ? next.name : "Finish";
        const popupHtml = `<strong>${wp.name}</strong><br>${t("eta")}: ${etaText}<br><span class="muted">${t("next")}: ${nextLabel}</span>`;
        marker.bindPopup(popupHtml).openPopup();
      });
    });
    const toggleLabels = () => {
      const show = map.getZoom() >= minLabelZoom;
      markerLayers.forEach((m) => {
        const el = m.getElement();
        if (!el) return;
        if (show) el.classList.remove("hidden");
        else el.classList.add("hidden");
      });
    };
    toggleLabels();
    map.off("zoomend", toggleLabels);
    map.on("zoomend", toggleLabels);
  }

  async function loadRoute() {
    const trackFile = config?.trackFile || "tracks/track.gpx";
    try {
      const res = await fetch(trackFile, { cache: "no-store" });
      if (!res.ok) throw new Error(`Track ${trackFile} missing`);
      const text = await res.text();
      const { segments, waypoints } = parseGpx(text);
      if (!segments.length) throw new Error(`Track ${trackFile} has no segments`);
      const color = "#0c8bc7";
      trackLayers.forEach((l) => l.remove());
      trackLayers.length = 0;
      kmMarkerGroup.clearLayers();
      trackData.length = 0;
      const poly = L.polyline(segments, {
        color,
        weight: 4,
        opacity: 0.8,
        pane: "tracksPane",
      }).addTo(map);
      trackLayers.push(poly);
      trackData.push({ segments, color });
      buildRouteProfile(segments);
      routeWaypoints = mapWaypoints(waypoints || []);
      renderWaypoints();
      rebuildKmMarkers();
      segments.forEach((seg) => seg.forEach((pt) => extendBounds(pt)));
      fitToData();
    } catch (err) {
      console.error(err);
      setStatus(`Track error: ${trackFile}`, true);
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
    let list = [];
    if (config?.traccarUrl && config?.token) {
      const data = await fetchJson(`${cleanBase(config.traccarUrl)}/api/devices`);
      list = [...data];
    }
    if (config?.debug) {
      list.push(
        { id: 10001, name: "Debug Rider 1" },
        { id: 10002, name: "Debug Rider 2" },
        { id: 10003, name: "Debug Offroute" }
      );
    }
    devices = new Map(list.map((d) => [d.id, d]));
    renderLegend();
    if (!selectedDeviceId && list.length) {
      selectDevice(list[0].id);
    }
  }

  function filterDevice(id) {
    if (config?.debug) return true;
    if (!config?.deviceIds || !Array.isArray(config.deviceIds)) return true;
    return config.deviceIds.includes(id);
  }

  function updateMarker(position) {
    const device = devices.get(position.deviceId);
    if (!filterDevice(position.deviceId)) return;
    const name = device?.name || `Device ${position.deviceId}`;
    const time = position.deviceTime || position.fixTime || position.serverTime;
    const timeMs = time ? Date.parse(time) : null;
    if (time) lastSeen.set(position.deviceId, time);
    lastPositions.set(position.deviceId, position);
    const coords = [position.latitude, position.longitude];
    if (timeMs) {
      const startMs = config?.startTime ? Date.parse(config.startTime) : null;
      if (!startMs || timeMs >= startMs) {
        const list = positionsHistory.get(position.deviceId) || [];
        list.push({ t: timeMs, lat: coords[0], lng: coords[1] });
        const cutoff = Date.now() - 60 * 60 * 1000;
        while (list.length && list[0].t < cutoff) list.shift();
        positionsHistory.set(position.deviceId, list);
      }
    }
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
    const prog = getDeviceProgress(position.deviceId);
    const projPoint = prog?.proj?.point;
    if (projPoint) {
      let line = projectionLines.get(position.deviceId);
      const latlngs = [coords, [projPoint.lat, projPoint.lng]];
      if (!line) {
        line = L.polyline(latlngs, {
          color: "#6b7280",
          weight: 2,
          dashArray: "4 4",
          pane: "livePane",
        }).addTo(map);
        projectionLines.set(position.deviceId, line);
      } else {
        line.setLatLngs(latlngs);
      }
    }
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
    let positions = [];
    if (config?.traccarUrl && config?.token) {
      const url = `${cleanBase(config.traccarUrl)}/api/positions`;
      positions = await fetchJson(url);
    }
    if (config?.debug) {
      const debugPos = buildDebugPositions();
      positions.push(...debugPos);
    }
    positions.forEach(updateMarker);
    renderLegend();
    renderWaypoints();
    fitToData();
    setStatus(`Last update ${new Date().toLocaleTimeString()}`);
  }

  function buildDebugPositions() {
    const now = new Date().toISOString();
    if (!routeTotal || !routePoints.length) {
      return [
        { deviceId: 10001, latitude: 0, longitude: 0, speed: 0, deviceTime: now },
        { deviceId: 10002, latitude: 0.01, longitude: 0.01, speed: 0, deviceTime: now },
        { deviceId: 10003, latitude: 0.02, longitude: 0.02, speed: 0, deviceTime: now },
      ];
    }
    const stepSeconds = config?.refreshSeconds || defaults.refreshSeconds;
    const debugSpeedMs = 6; // ~22 km/h
    const deltaFraction = routeTotal > 0 ? (debugSpeedMs * stepSeconds) / routeTotal : 0;
    const onTrack = (deviceId, initialFraction) => {
      const state = debugState.get(deviceId) || { fraction: initialFraction };
      state.fraction = Math.min(1, state.fraction + deltaFraction);
      debugState.set(deviceId, state);
      const dist = routeTotal * state.fraction;
      const pt = pointAtDistance(dist) || routePoints[0];
      return {
        deviceId,
        latitude: pt.lat,
        longitude: pt.lng,
        speed: debugSpeedMs / 0.514444, // convert m/s to knots
        deviceTime: now,
      };
    };
    const offTrack = () => {
      const mid = pointAtDistance(routeTotal * 0.5) || { lat: 0, lng: 0 };
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

  function initHelp() {
    const trigger = document.getElementById("help-trigger");
    if (!trigger) return;
    helpPopupEl = document.createElement("div");
    helpPopupEl.className = "help-popup hidden";
    helpPopupEl.innerHTML = `<strong>${t("helpTitle") || "Live Tracker Tips"}</strong><br>${t("helpTip")}`;
    document.body.appendChild(helpPopupEl);
    const hide = () => helpPopupEl.classList.add("hidden");
    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      helpPopupEl.classList.toggle("hidden");
    });
    document.addEventListener("click", (e) => {
      if (e.target === trigger || helpPopupEl.contains(e.target)) return;
      hide();
    });
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
    if (selectedDeviceId && routePoints.length) {
      const targetProj = projectOnRoute(latlng);
      if (targetProj && !targetProj.offtrack) {
        const eta = computeEta(selectedDeviceId, targetProj.distanceAlong);
        const info = document.createElement("div");
        info.className = "context-info";
        const etaText =
          eta.status === "eta" && eta.arrival
            ? formatDateTimeFull(eta.arrival)
            : eta.status === "passed"
              ? t("passed")
              : eta.status === "offtrack"
                ? t("offtrack")
                : t("unknown");
        info.textContent = t("etaHere", { eta: etaText });
        contextMenuEl.appendChild(info);
      }
    }
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
    initHelp();
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

  function ensureEtaControl() {
    if (!map) return null;
    if (!etaControl) {
      etaControl = L.control({ position: "topright" });
      etaControl.onAdd = () => {
        etaContainer = L.DomUtil.create("div", "eta-control");
        L.DomEvent.disableClickPropagation(etaContainer);
        L.DomEvent.disableScrollPropagation(etaContainer);
        return etaContainer;
      };
      etaControl.addTo(map);
    }
    return etaContainer;
  }

  function getDeviceProgress(deviceId) {
    const pos = lastPositions.get(deviceId);
    if (!pos) return null;
    const proj = projectOnRoute({ lat: pos.latitude, lng: pos.longitude });
    if (!proj) return null;
    const offtrack = Boolean(proj.offtrack);
    const speedMs = getAverageSpeedMs(deviceId);
    return { proj, speedMs, pos, offtrack };
  }

  function computeEta(deviceId, targetDistance) {
    const progress = getDeviceProgress(deviceId);
    if (!progress || progress.offtrack) return { status: "offtrack" };
    const delta = targetDistance - progress.proj.distanceAlong;
    if (delta <= 0) return { status: "passed" };
    if (!progress.speedMs || progress.speedMs <= 0) return { status: "unknown" };
    const arrival = new Date(Date.now() + (delta / progress.speedMs) * 1000);
    return { status: "eta", arrival };
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
    const d = timeStr instanceof Date ? timeStr : new Date(timeStr);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  }

  function getAverageSpeedMs(deviceId) {
    const hist = positionsHistory.get(deviceId);
    if (!hist || hist.length < 2) {
      const pos = lastPositions.get(deviceId);
      return pos?.speed != null ? pos.speed * 0.514444 : 0;
    }
    const cutoff = Date.now() - 60 * 60 * 1000;
    const recent = hist.filter((p) => p.t >= cutoff);
    const samples = recent.length >= 2 ? recent : hist;
    let dist = 0;
    let startT = samples[0].t;
    let endT = samples[samples.length - 1].t;
    for (let i = 1; i < samples.length; i += 1) {
      dist += distanceMeters([samples[i - 1].lat, samples[i - 1].lng], [samples[i].lat, samples[i].lng]);
    }
    const span = (endT || 0) - (startT || 0);
    if (span <= 0) {
      const pos = lastPositions.get(deviceId);
      return pos?.speed != null ? pos.speed * 0.514444 : 0;
    }
    return dist / (span / 1000);
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
      if (device.id === selectedDeviceId) btn.classList.add("selected");
      const dot = document.createElement("span");
      dot.className = `legend-dot ${isStale(device.id) ? "stale" : "live"}`;
      const label = document.createElement("span");
      const name = device.name || `Device ${device.id}`;
      const ts = formatTimeLabel(lastSeen.get(device.id));
      const prog = getDeviceProgress(device.id);
      const offRoute = !prog || prog.offtrack;
      const km = !offRoute && prog
        ? `${Math.round((prog.proj.distanceAlong / 1000) * 10) / 10} km`
        : null;
      const suffix = offRoute ? " • off-route" : km ? ` • ${km}` : "";
      label.textContent = ts ? `${name} (${ts})${suffix}` : `${name}${suffix}`;
      btn.append(dot, label);
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        selectDevice(device.id, { focus: true });
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

  function renderToggles() {
    if (!map) return;
    if (!markerToggleControl) {
      markerToggleControl = L.control({ position: "topright" });
      markerToggleControl.onAdd = () => {
        toggleContainer = L.DomUtil.create("div", "toggle-control");
        L.DomEvent.disableClickPropagation(toggleContainer);
        L.DomEvent.disableScrollPropagation(toggleContainer);
        return toggleContainer;
      };
      markerToggleControl.addTo(map);
    }
    toggleContainer.innerHTML = "";
    const kmRow = document.createElement("label");
    kmRow.className = "toggle-row";
    const kmCb = document.createElement("input");
    kmCb.type = "checkbox";
    kmCb.checked = Boolean(config?.showKmMarkers);
    kmCb.addEventListener("change", () => {
      config.showKmMarkers = kmCb.checked;
      rebuildKmMarkers();
    });
    kmRow.append(kmCb, document.createTextNode(" Show km markers"));
    toggleContainer.appendChild(kmRow);

    const wpRow = document.createElement("label");
    wpRow.className = "toggle-row";
    const wpCb = document.createElement("input");
    wpCb.type = "checkbox";
    wpCb.checked = Boolean(config?.showWaypoints);
    wpCb.addEventListener("change", () => {
      config.showWaypoints = wpCb.checked;
      renderWaypoints();
    });
    wpRow.append(wpCb, document.createTextNode(" Show waypoints"));
    toggleContainer.appendChild(wpRow);
  }

  function selectDevice(deviceId, { focus = false } = {}) {
    selectedDeviceId = deviceId;
    renderLegend();
    renderWaypoints();
    renderToggles();
    if (focus) focusDevice(deviceId);
  }

  async function startPolling() {
    if ((!config?.token || !config?.traccarUrl) && !config?.debug) return;
    await refreshDevices().catch((err) => {
      console.error(err);
      setStatus("Device fetch failed", true);
    });
    await refreshPositions().catch((err) => {
      console.error(err);
      setStatus("Position fetch failed", true);
    });
    renderToggles();
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
    await loadTranslations();
    await loadRoute();
    await startPolling();
    startViewerLocation();
  }

  bootstrap();
})();
