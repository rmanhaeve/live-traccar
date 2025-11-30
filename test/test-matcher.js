import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { DOMParser } from "xmldom";
import * as app from "../app-matcher.js";

function parseGpx(file) {
  const xml = new DOMParser().parseFromString(fs.readFileSync(file, "utf8"));
  const pts = [];
  const trkpts = xml.getElementsByTagName("trkpt");
  for (let i = 0; i < trkpts.length; i += 1) {
    const el = trkpts[i];
    const lat = parseFloat(el.getAttribute("lat"));
    const lon = parseFloat(el.getAttribute("lon"));
    pts.push([lat, lon]);
  }
  return pts;
}

function approxEqual(a, b, tol) {
  return Math.abs(a - b) <= tol;
}

async function run() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const gpxPath = path.join(here, "..", "tracks", "10k.gpx");
  const pts = parseGpx(gpxPath);
  app.buildRouteProfile([pts]);
  const total = app.getRouteTotal();
  if (!total) throw new Error("routeTotal zero");
  const step = 50; // meters
  for (let d = 0; d <= total; d += step) {
    const p = app.pointAtDistance(d);
    const match = app.matchPositionToRoute({ lat: p.lat, lng: p.lng }, {});
    if (!match) throw new Error(`no match at d=${d}`);
    const latDiff = Math.abs(match.point.lat - p.lat);
    const lngDiff = Math.abs(match.point.lng - p.lng);
    if (!approxEqual(latDiff, 0, 1e-5) || !approxEqual(lngDiff, 0, 1e-5)) {
      console.error("Coordinate mismatch at", d, "got", match.point, "expected", p);
      process.exit(2);
    }
  }
  console.log("matcher test passed");
}

run();
