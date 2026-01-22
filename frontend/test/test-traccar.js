import assert from "node:assert/strict";
import { fetchDevices, fetchPositions, fetchRecentHistory } from "../src/traccar.js";

const originalFetch = global.fetch;

function stubFetch(payload) {
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: true,
      async json() {
        return payload;
      },
    };
  };
  return calls;
}

try {
  // Missing config should short-circuit
  await fetchDevices({});
  await fetchPositions(null);
  await fetchRecentHistory(null, 1, new Date(), new Date());

  const config = { traccarUrl: "https://example.com/base///", token: "abc" };

  // fetchDevices should hit the devices endpoint and return array payloads
  let calls = stubFetch([{ id: 1 }]);
  const devices = await fetchDevices(config);
  assert.deepEqual(devices, [{ id: 1 }]);
  assert.equal(calls[0].url, "https://example.com/base/api/devices");
  assert.equal(calls[0].opts.cache, "no-store");
  assert.equal(calls[0].opts.headers.Authorization, "Bearer abc");

  // fetchPositions should hit the positions endpoint
  calls = stubFetch([{ deviceId: 1 }]);
  const positions = await fetchPositions(config);
  assert.deepEqual(positions, [{ deviceId: 1 }]);
  assert.equal(calls[0].url, "https://example.com/base/api/positions");

  // fetchRecentHistory should include query parameters and return arrays
  const from = new Date("2023-01-01T00:00:00Z");
  const to = new Date("2023-01-01T01:00:00Z");
  calls = stubFetch([{ x: 1 }]);
  const history = await fetchRecentHistory(config, 7, from, to);
  assert.deepEqual(history, [{ x: 1 }]);
  assert.ok(calls[0].url.startsWith("https://example.com/base/api/reports/route?"));
  assert.ok(calls[0].url.includes("deviceId=7"));
  assert.ok(calls[0].url.includes("from=2023-01-01T00%3A00%3A00.000Z"));
  assert.ok(calls[0].url.includes("to=2023-01-01T01%3A00%3A00.000Z"));

  console.log("traccar tests passed");
} finally {
  global.fetch = originalFetch;
}
