#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const tracksDir = path.resolve(__dirname, "..", "tracks");
const manifestPath = path.join(tracksDir, "manifest.json");

if (!fs.existsSync(tracksDir)) {
  fs.mkdirSync(tracksDir, { recursive: true });
}

const files = fs
  .readdirSync(tracksDir)
  .filter((file) => file.toLowerCase().endsWith(".gpx"))
  .sort();

const manifest = {
  generatedAt: new Date().toISOString(),
  tracks: files.map((file) => ({ file })),
};

fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log(`Found ${files.length} GPX file(s). Wrote ${path.relative(process.cwd(), manifestPath)}.`);
