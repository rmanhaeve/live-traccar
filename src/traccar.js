function cleanBase(url) {
  return url.replace(/\/+$/, "");
}

async function fetchJson(config, path) {
  const headers = config?.token ? { Authorization: `Bearer ${config.token}` } : {};
  const res = await fetch(path, { headers, cache: "no-store" });
  if (!res.ok) throw new Error(`Request failed: ${path}`);
  return res.json();
}

export async function fetchDevices(config) {
  if (!config?.traccarUrl || !config?.token) return [];
  const url = `${cleanBase(config.traccarUrl)}/api/devices`;
  const data = await fetchJson(config, url);
  return Array.isArray(data) ? data : [];
}

export async function fetchPositions(config) {
  if (!config?.traccarUrl || !config?.token) return [];
  const url = `${cleanBase(config.traccarUrl)}/api/positions`;
  const data = await fetchJson(config, url);
  return Array.isArray(data) ? data : [];
}

export async function fetchRecentHistory(config, deviceId, from, to) {
  if (!config?.traccarUrl || !config?.token) return [];
  const params = new URLSearchParams({
    deviceId: String(deviceId),
    from: from.toISOString(),
    to: to.toISOString(),
  });
  const url = `${cleanBase(config.traccarUrl)}/api/reports/route?${params.toString()}`;
  const data = await fetchJson(config, url);
  return Array.isArray(data) ? data : [];
}
