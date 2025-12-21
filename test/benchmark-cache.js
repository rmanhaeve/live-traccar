import { DOMParser } from "xmldom";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  buildRouteProfile,
  parseGpx,
  matchPositionToRoute,
} from "../src/route.js";

global.DOMParser = DOMParser;

function runBenchmark() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const gpxPath = path.join(here, "..", "tracks", "start.gpx");
  
  // Load and build route
  const gpxContent = fs.readFileSync(gpxPath, "utf8");
  const { segments } = parseGpx(gpxContent);
  buildRouteProfile(segments);
  
  // Generate test points along the route
  const testPoints = [];
  for (let lat = 51.0; lat < 51.5; lat += 0.001) {
    for (let lng = 4.0; lng < 4.5; lng += 0.001) {
      testPoints.push({ lat, lng });
      if (testPoints.length >= 1000) break;
    }
    if (testPoints.length >= 1000) break;
  }
  
  console.log(`Benchmarking with ${testPoints.length} test points`);
  
  // Warm-up (populate cache)
  testPoints.forEach(point => matchPositionToRoute(point));
  
  // First run - cache should be populated
  const start1 = performance.now();
  for (let i = 0; i < 10; i++) {
    testPoints.forEach(point => matchPositionToRoute(point));
  }
  const end1 = performance.now();
  const time1 = end1 - start1;
  
  // Clear cache by rebuilding route
  buildRouteProfile(segments);
  
  // Second run - cache empty at start
  const start2 = performance.now();
  testPoints.forEach(point => matchPositionToRoute(point));
  const end2 = performance.now();
  const time2 = end2 - start2;
  
  // Third run - cache populated from second run
  const start3 = performance.now();
  for (let i = 0; i < 10; i++) {
    testPoints.forEach(point => matchPositionToRoute(point));
  }
  const end3 = performance.now();
  const time3 = end3 - start3;
  
  console.log("\nResults:");
  console.log(`- Cold cache (1 iteration):  ${time2.toFixed(2)}ms`);
  console.log(`- Warm cache (10 iterations): ${time1.toFixed(2)}ms`);
  console.log(`- Average per iteration (warm): ${(time1 / 10).toFixed(2)}ms`);
  console.log(`- Average per iteration (cold): ${time2.toFixed(2)}ms`);
  console.log(`- Speedup: ${(time2 / (time1 / 10)).toFixed(2)}x faster with cache`);
  
  // Test with hints (common pattern in actual usage)
  console.log("\nBenchmark with hints (simulates sequential tracking):");
  buildRouteProfile(segments);
  
  const start4 = performance.now();
  let hint = null;
  for (let i = 0; i < 5; i++) {
    testPoints.forEach(point => {
      const result = matchPositionToRoute(point, { hintDistanceAlong: hint });
      hint = result?.distanceAlong || null;
    });
  }
  const end4 = performance.now();
  const time4 = end4 - start4;
  console.log(`- With hints (5 iterations): ${time4.toFixed(2)}ms`);
  console.log(`- Average per iteration: ${(time4 / 5).toFixed(2)}ms`);
}

runBenchmark();
