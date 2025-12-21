const tests = [
  "./test-geo.js",
  "./test-route.js",
  "./test-cache.js",
  "./test-stats.js",
  "./test-traccar.js",
  "./test-matcher.js",
  "./test-debug-history.js",
  "./test-visualization-history.js",
];

for (const test of tests) {
  const resolved = new URL(test, import.meta.url);
  // eslint-disable-next-line no-await-in-loop
  await import(resolved);
}

console.log("all tests passed");
