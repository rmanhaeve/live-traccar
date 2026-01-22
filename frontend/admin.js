const loginSection = document.getElementById("admin-login");
const configSection = document.getElementById("admin-config");
const loginForm = document.getElementById("login-form");
const loginPassword = document.getElementById("login-password");
const loginMessage = document.getElementById("login-message");
const logoutBtn = document.getElementById("logout-btn");
const configForm = document.getElementById("config-form");
const configMessage = document.getElementById("config-message");

const fields = {
  traccarUrl: document.getElementById("config-traccar-url"),
  token: document.getElementById("config-token"),
  title: document.getElementById("config-title"),
  refreshSeconds: document.getElementById("config-refresh-seconds"),
  staleMinutes: document.getElementById("config-stale-minutes"),
  historyHours: document.getElementById("config-history-hours"),
  startTime: document.getElementById("config-start-time"),
  deviceIds: document.getElementById("config-device-ids"),
  trackFile: document.getElementById("config-track-file"),
  showViewerLocation: document.getElementById("config-show-viewer"),
  showKmMarkers: document.getElementById("config-show-km"),
  showWaypoints: document.getElementById("config-show-waypoints"),
  weatherEnabled: document.getElementById("config-weather-enabled"),
  weatherHours: document.getElementById("config-weather-hours"),
  debug: document.getElementById("config-debug"),
  debugSpeedKph: document.getElementById("config-debug-speed"),
  debugStartTime: document.getElementById("config-debug-start-time"),
  debugDeviceIds: document.getElementById("config-debug-device-ids"),
};

function setMessage(el, text, isError = false) {
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("error", Boolean(isError));
}

function showLogin() {
  if (loginSection) loginSection.classList.remove("hidden");
  if (configSection) configSection.classList.add("hidden");
}

function showConfig() {
  if (loginSection) loginSection.classList.add("hidden");
  if (configSection) configSection.classList.remove("hidden");
}

function parseCsv(value) {
  if (!value) return null;
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length);
  if (!items.length) return null;
  const numbers = items
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item));
  return numbers.length ? numbers : null;
}

function formatCsv(list) {
  if (!Array.isArray(list) || !list.length) return "";
  return list.join(", ");
}

function formatDateTimeLocal(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  const pad = (num) => String(num).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(
    date.getMinutes()
  )}`;
}

function parseNumberInput(input) {
  if (!input || input.value === "") return null;
  const value = Number(input.value);
  return Number.isFinite(value) ? value : null;
}

function fillForm(config) {
  if (fields.traccarUrl) fields.traccarUrl.value = config.traccarUrl || "";
  if (fields.token) fields.token.value = config.token || "";
  if (fields.title) fields.title.value = config.title || "";
  if (fields.refreshSeconds) fields.refreshSeconds.value = config.refreshSeconds ?? "";
  if (fields.staleMinutes) fields.staleMinutes.value = config.staleMinutes ?? "";
  if (fields.historyHours) fields.historyHours.value = config.historyHours ?? "";
  if (fields.startTime) fields.startTime.value = formatDateTimeLocal(config.startTime);
  if (fields.deviceIds) fields.deviceIds.value = formatCsv(config.deviceIds);
  if (fields.trackFile) fields.trackFile.value = config.trackFile || "";
  if (fields.showViewerLocation) fields.showViewerLocation.checked = Boolean(config.showViewerLocation);
  if (fields.showKmMarkers) fields.showKmMarkers.checked = Boolean(config.showKmMarkers);
  if (fields.showWaypoints) fields.showWaypoints.checked = Boolean(config.showWaypoints);
  if (fields.weatherEnabled) fields.weatherEnabled.checked = Boolean(config.weatherEnabled);
  if (fields.weatherHours) fields.weatherHours.value = config.weatherHours ?? "";
  if (fields.debug) fields.debug.checked = Boolean(config.debug);
  if (fields.debugSpeedKph) fields.debugSpeedKph.value = config.debugSpeedKph ?? "";
  if (fields.debugStartTime) fields.debugStartTime.value = config.debugStartTime || "";
  if (fields.debugDeviceIds) fields.debugDeviceIds.value = formatCsv(config.debugDeviceIds);
}

function serializeForm() {
  return {
    traccarUrl: fields.traccarUrl?.value.trim() || null,
    token: fields.token?.value.trim() || null,
    title: fields.title?.value.trim() || null,
    refreshSeconds: parseNumberInput(fields.refreshSeconds),
    staleMinutes: parseNumberInput(fields.staleMinutes),
    historyHours: parseNumberInput(fields.historyHours),
    startTime: fields.startTime?.value || null,
    deviceIds: parseCsv(fields.deviceIds?.value || ""),
    trackFile: fields.trackFile?.value.trim() || null,
    showViewerLocation: Boolean(fields.showViewerLocation?.checked),
    showKmMarkers: Boolean(fields.showKmMarkers?.checked),
    showWaypoints: Boolean(fields.showWaypoints?.checked),
    weatherEnabled: Boolean(fields.weatherEnabled?.checked),
    weatherHours: parseNumberInput(fields.weatherHours),
    debug: Boolean(fields.debug?.checked),
    debugSpeedKph: parseNumberInput(fields.debugSpeedKph),
    debugStartTime: fields.debugStartTime?.value.trim() || null,
    debugDeviceIds: parseCsv(fields.debugDeviceIds?.value || ""),
  };
}

async function loadConfig() {
  try {
    const res = await fetch("/api/admin/config", { cache: "no-store" });
    if (res.status === 401) {
      showLogin();
      return;
    }
    if (!res.ok) {
      throw new Error("Failed to load config");
    }
    const config = await res.json();
    fillForm(config);
    showConfig();
  } catch (err) {
    console.error(err);
    setMessage(configMessage, "Failed to load configuration.", true);
  }
}

async function checkStatus() {
  try {
    const res = await fetch("/api/admin/status", { cache: "no-store" });
    if (!res.ok) return true;
    const status = await res.json();
    if (!status.initialized) {
      window.location.replace("/setup.html");
      return false;
    }
  } catch (err) {
    console.error(err);
  }
  return true;
}

async function handleLogin(event) {
  event.preventDefault();
  const password = loginPassword?.value || "";
  setMessage(loginMessage, "Signing in…");
  try {
    const res = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const detail = body?.detail || "Login failed.";
      setMessage(loginMessage, detail, true);
      return;
    }
    if (loginPassword) loginPassword.value = "";
    setMessage(loginMessage, "");
    await loadConfig();
  } catch (err) {
    console.error(err);
    setMessage(loginMessage, "Login failed.", true);
  }
}

async function handleSave(event) {
  event.preventDefault();
  const payload = serializeForm();
  setMessage(configMessage, "Saving…");
  try {
    const res = await fetch("/api/admin/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const detail = body?.detail || "Save failed.";
      setMessage(configMessage, detail, true);
      return;
    }
    const config = await res.json();
    fillForm(config);
    setMessage(configMessage, "Saved.");
  } catch (err) {
    console.error(err);
    setMessage(configMessage, "Save failed.", true);
  }
}

async function handleLogout() {
  try {
    await fetch("/api/admin/logout", { method: "POST" });
  } catch (err) {
    console.error(err);
  }
  showLogin();
}

if (loginForm) loginForm.addEventListener("submit", handleLogin);
if (configForm) configForm.addEventListener("submit", handleSave);
if (logoutBtn) logoutBtn.addEventListener("click", handleLogout);

checkStatus().then((ok) => {
  if (!ok) return;
  loadConfig();
});
