# Live Traccar Tracker

Lightweight static viewer that overlays GPX routes and live Traccar device locations on an OSM map. No backend server required beyond Traccar; serve the files with any static host (for local testing, `python -m http.server` works).

## Setup
- Copy `config.example.json` to `config.json` and set:
  - `title`: page title (defaults to “Live Tracker”).
  - `trackFile`: path to your single GPX file (default: `tracks/start.gpx`).
  - `traccarUrl`: base URL of your Traccar server.
  - `token`: API token for the account that can view the devices.
  - Optional: `refreshSeconds`, `deviceIds` (array to whitelist specific devices), `kmMarkerInterval` (base km spacing for track markers; set to 0/false to disable), `showViewerLocation` (show a “You” dot using browser geolocation), `staleMinutes` (after this age, participant dots/legend turn gray), `startTime` (ISO string to ignore history before the event start), `debug` (boolean; when true, injects fake participants—two on-route, one off-route). Spacing adapts automatically with zoom (denser when zoomed in). ETAs use average speed over the last hour; if insufficient data, they fall back to available history/instant speed. Off-route threshold: >200 m from the track counts as off-route (ETAs will show “participant not on track”).
- Leaflet assets are vendored in `vendor/leaflet` (no CDN needed). `config.json` is git-ignored so you don’t accidentally commit secrets.

## Running locally
1. Place your GPX file (default `tracks/start.gpx`, or whatever `trackFile` points to).
2. Serve the folder (example with Python, but any static host works):
   ```bash
   python -m http.server 8000
   ```
3. Open http://localhost:8000 in your browser. The map will load the GPX route, show waypoints, and poll Traccar for live positions using your config.

## How it works
- Uses Leaflet with OSM tiles for the base map.
- Reads a single GPX file for the route, draws it, and extracts waypoints for ETA predictions.
- Polls Traccar: `GET /api/devices` for metadata and `GET /api/positions` for latest fixes. Authorization uses the bearer token from `config.json`.
- Select a participant via the legend to see ETAs to waypoints; right-click/long-press the map for a menu (open in Google Maps/Waze, copy coords, see ETA to that point).
- All logic runs in `app.js`; styling lives in `styles.css`.
