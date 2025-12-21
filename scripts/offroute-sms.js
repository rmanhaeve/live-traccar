import fs from "fs/promises";
import path from "path";
import { DOMParser } from "xmldom";
import { parseGpx, buildRouteProfile, projectOnRoute } from "../src/route.js";

global.DOMParser = DOMParser;

const DEFAULT_POLL_SECONDS = 30;
const DEFAULT_STALE_MINUTES = 15;

function parseArgs(argv) {
  const args = argv.slice(2);
  let configPath = "config.json";
  let testSms = null;
  let testMessage = null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--config" && args[i + 1]) {
      configPath = args[i + 1];
      i += 1;
    } else if (args[i] === "--test-sms" && args[i + 1]) {
      testSms = args[i + 1];
      i += 1;
    } else if (args[i] === "--test-message" && args[i + 1]) {
      testMessage = args[i + 1];
      i += 1;
    }
  }
  return { configPath, testSms, testMessage };
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

function normalizeName(name) {
  return String(name || "").trim().toLowerCase();
}

function applyTemplate(str, vars) {
  if (typeof str !== "string") return str;
  return str.replace(/{(\w+)}/g, (_match, key) => (vars[key] == null ? "" : String(vars[key])));
}

function applyTemplateObject(value, vars) {
  if (value == null) return value;
  if (typeof value === "string") return applyTemplate(value, vars);
  if (Array.isArray(value)) return value.map((entry) => applyTemplateObject(entry, vars));
  if (typeof value === "object") {
    return Object.entries(value).reduce((acc, [key, val]) => {
      acc[key] = applyTemplateObject(val, vars);
      return acc;
    }, {});
  }
  return value;
}

function resolvePath(baseDir, filePath) {
  if (!filePath) return null;
  return path.isAbsolute(filePath) ? filePath : path.resolve(baseDir, filePath);
}

function buildParticipantMap(raw) {
  const list = Array.isArray(raw) ? raw : raw?.participants;
  if (!Array.isArray(list)) return new Map();
  const map = new Map();
  list.forEach((entry) => {
    const key = normalizeName(entry?.name);
    if (!key) return;
    map.set(key, { name: entry.name, phone: entry.phone });
  });
  return map;
}

function toIsoTime(value) {
  if (!value) return "";
  const timeMs = Date.parse(value);
  if (!Number.isFinite(timeMs)) return "";
  return new Date(timeMs).toISOString();
}

function getPositionTimeMs(position) {
  const time = position.deviceTime || position.fixTime || position.serverTime;
  const timeMs = time ? Date.parse(time) : NaN;
  return Number.isFinite(timeMs) ? timeMs : null;
}

async function fetchJson(url, token) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Request failed (${res.status}): ${url} ${text}`.trim());
  }
  return res.json();
}

async function fetchDevices(config) {
  const url = `${config.traccarUrl.replace(/\/+$/, "")}/api/devices`;
  const data = await fetchJson(url, config.token);
  return Array.isArray(data) ? data : [];
}

async function fetchPositions(config) {
  const url = `${config.traccarUrl.replace(/\/+$/, "")}/api/positions`;
  const data = await fetchJson(url, config.token);
  return Array.isArray(data) ? data : [];
}

async function sendSms(gateway, to, message) {
  const baseUrl = gateway?.baseUrl;
  if (!baseUrl) throw new Error("smsGateway.baseUrl is required");
  const method = String(gateway?.method || "POST").toUpperCase();
  const vars = { to, message, token: gateway?.token || "" };
  const url = new URL(gateway?.path || "/", baseUrl);
  const query = applyTemplateObject(gateway?.query || {}, vars);
  Object.entries(query).forEach(([key, val]) => {
    if (val != null && val !== "") url.searchParams.set(key, String(val));
  });
  const headers = applyTemplateObject(gateway?.headers || {}, vars);
  if (!Object.keys(headers).length && gateway?.token) {
    headers.Authorization = `Bearer ${gateway.token}`;
  }

  let body;
  if (method !== "GET") {
    const bodyTemplate = gateway?.body ?? { to: "{to}", message: "{message}" };
    const bodyValue = applyTemplateObject(bodyTemplate, vars);
    const format = String(gateway?.bodyFormat || "json").toLowerCase();
    if (format === "form") {
      if (!headers["Content-Type"]) headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(bodyValue).toString();
    } else if (format === "text") {
      if (!headers["Content-Type"]) headers["Content-Type"] = "text/plain";
      body = typeof bodyValue === "string" ? bodyValue : JSON.stringify(bodyValue);
    } else {
      if (!headers["Content-Type"]) headers["Content-Type"] = "application/json";
      body = typeof bodyValue === "string" ? bodyValue : JSON.stringify(bodyValue);
    }
  }

  const res = await fetch(url.toString(), { method, headers, body });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`SMS gateway failed (${res.status}): ${text}`.trim());
  }
}

async function loadRoute(trackFile) {
  const gpx = await fs.readFile(trackFile, "utf8");
  const { segments } = parseGpx(gpx);
  buildRouteProfile(segments || []);
  if (!segments?.length) throw new Error("No route segments found in GPX");
}

async function main() {
  const { configPath, testSms, testMessage } = parseArgs(process.argv);
  const configAbs = path.resolve(process.cwd(), configPath);
  const configDir = path.dirname(configAbs);
  const config = await readJson(configAbs);
  if (!config?.traccarUrl || !config?.token) {
    throw new Error("traccarUrl and token are required in config.json");
  }

  if (testSms) {
    const message = testMessage || "Test message from live-traccar off-route monitor.";
    await sendSms(config.smsGateway || {}, testSms, message);
    console.log(`Sent test SMS to ${testSms}`);
    return;
  }

  const trackFile = resolvePath(configDir, config.trackFile);
  if (!trackFile) throw new Error("trackFile is required in config.json");
  await loadRoute(trackFile);

  const participantFile = resolvePath(configDir, config.participantMapFile || "participants.json");
  if (!participantFile) throw new Error("participantMapFile is required in config.json");
  const participantsRaw = await readJson(participantFile);
  const participantMap = buildParticipantMap(participantsRaw);
  if (!participantMap.size) {
    throw new Error("participantMapFile has no participants");
  }

  const pollSeconds = Number(config.pollSeconds || DEFAULT_POLL_SECONDS);
  const staleMinutes = Number(config.staleMinutes || DEFAULT_STALE_MINUTES);
  const messageTemplate =
    config.offrouteMessage ||
    "{name} is off-route at {time}. Last location: {lat},{lng}";

  const state = new Map();

  async function pollOnce() {
    const devices = await fetchDevices(config);
    const positions = await fetchPositions(config);
    const positionById = new Map(positions.map((p) => [p.deviceId, p]));
    const now = Date.now();

    devices.forEach((device) => {
      const participant = participantMap.get(normalizeName(device.name));
      if (!participant) return;
      const position = positionById.get(device.id);
      if (!position) {
        state.set(device.id, { offroute: false, notified: false });
        return;
      }

      const timeMs = getPositionTimeMs(position);
      if (!timeMs || now - timeMs > staleMinutes * 60 * 1000) {
        state.set(device.id, { offroute: false, notified: false });
        return;
      }

      const proj = projectOnRoute({ lat: position.latitude, lng: position.longitude });
      const offroute = !proj || proj.offtrack;
      const entry = state.get(device.id) || { offroute: false, notified: false };
      if (offroute && !entry.notified) {
        if (!participant.phone) {
          console.warn(`No phone number for participant: ${participant.name}`);
        } else {
          const vars = {
            name: participant.name,
            lat: position.latitude,
            lng: position.longitude,
            time: toIsoTime(position.deviceTime || position.fixTime || position.serverTime),
            deviceId: device.id,
          };
          const message = applyTemplate(messageTemplate, vars);
          sendSms(config.smsGateway || {}, participant.phone, message)
            .then(() => console.log(`Sent SMS for ${participant.name}`))
            .catch((err) => console.error(`SMS failed for ${participant.name}`, err));
        }
        entry.notified = true;
      }
      if (!offroute) entry.notified = false;
      entry.offroute = offroute;
      state.set(device.id, entry);
    });
  }

  await pollOnce();
  setInterval(() => {
    pollOnce().catch((err) => console.error("Poll error", err));
  }, Math.max(5, pollSeconds) * 1000);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
