# Live Traccar Tracker

Lightweight static viewer that overlays GPX routes and live Traccar device locations on an OSM map. No backend server required beyond Traccar; serve the files with any static host (for local testing, `python -m http.server` works).

## Setup
- Copy `config.example.json` to `config.json` and set:
  - `title`: page title (defaults to “Live Tracker”).
  - `traccarUrl`: base URL of your Traccar server.
  - `token`: API token for the account that can view the devices.
  - Optional: `refreshSeconds`, `deviceIds` (array to whitelist specific devices), `kmMarkerInterval` (base km spacing for track markers; set to 0/false to disable), `showViewerLocation` (show a “You” dot using browser geolocation), `staleMinutes` (after this age, participant dots/legend turn gray). Spacing adapts automatically with zoom (denser when zoomed in).
- Drop GPX files into `tracks/` and run `npm run tracks` (or `node scripts/generate-manifest.js`) to refresh `tracks/manifest.json`.
- Leaflet assets are vendored in `vendor/leaflet` (no CDN needed). `config.json` is git-ignored so you don’t accidentally commit secrets.

## Running locally
1. Generate the manifest after adding GPX files:
   ```bash
   npm run tracks
   ```
2. Serve the folder (example with Python, but any static host works):
   ```bash
   python -m http.server 8000
   ```
3. Open http://localhost:8000 in your browser. The map will load GPX overlays and poll Traccar for live positions using your config.

## How it works
- Uses Leaflet with OSM tiles for the base map.
- Reads `tracks/manifest.json` to load GPX polylines and fit bounds.
- Polls Traccar: `GET /api/devices` for metadata and `GET /api/positions` for latest fixes. Authorization uses the bearer token from `config.json`.
- All logic runs in `app.js`; styling lives in `styles.css`.
