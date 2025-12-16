# Live Traccar Tracker

Lightweight static viewer that overlays GPX routes and live Traccar device locations on an OSM map. No backend server required beyond Traccar; serve the files with any static host (for local testing, `python -m http.server` works).

## Features
- Live participant tracking from Traccar with off-route/stale detection and legend selection.
- GPX route rendering with waypoints, km markers, elevation profile, and ETAs to waypoints/map clicks.
- Event countdown (full-page overlay and topbar) when `startTime` is in the future.
- Weather summary + hourly forecast modal for the current course segment.
- Download GPX button, language switcher, help tooltip, and persistent map view (center/zoom stored in cookie).
- Progress history overlay (distance and waypoint ticks), viewer-location toggle, and context menu (Google/Waze/coords/ETA).
- Debug tooling: simulated riders, debug time override (including frozen/ticking toggle) via URL or UI, and saved debug state per session.

## Setup
- Copy `config.example.json` to `config.json` and set:
  - `title`: page title (defaults to “Live Tracker”).
  - `trackFile`: path to your single GPX file (default: `tracks/start.gpx`).
  - `translationFile`: translation JSON (default: `translations/en.json`).
  - `traccarUrl`: base URL of your Traccar server.
  - `token`: API token for the account that can view the devices.
  - Optional: `refreshSeconds`, `deviceIds` (array to whitelist specific devices), `showViewerLocation` (show a “You” dot using browser geolocation), `staleMinutes` (after this age, participant dots/legend turn gray), `startTime` (ISO string to ignore history before the event start and, if set in the future, show a countdown), `expectedAvgSpeedKph` (used by debug riders and as an ETA fallback when live data is insufficient), `debugStartTime` (override the start datetime for simulated riders in debug mode), `historyHours` (how many hours of history to fetch/retain for progress history; defaults to 24h; ETA averages still only use the last hour). Km marker spacing follows zoom-based defaults (sparser by default). ETAs use average speed over the last hour; if insufficient data, they fall back to available history/instant speed.
  - `startTime` format: use an ISO 8601 datetime string with timezone for accuracy, e.g. `2024-09-15T08:30:00Z` (UTC) or `2024-09-15T08:30:00+02:00`. If you omit the timezone (e.g. `2024-09-15T08:30:00`), the browser assumes local time.

Debug mode is controlled via URL query params: append `?debug=1` (or `debug=true/on/yes`) to enable fake riders; use `debug=0`/`false` to disable.
- When debug mode is on, no calls are made to the real Traccar API. Fake riders are generated forward from `debugStartTime` at `expectedAvgSpeedKph`, with staggered start times to spread them along the route.
- Leaflet assets are vendored in `vendor/leaflet` (no CDN needed). `config.json` is git-ignored so you don’t accidentally commit secrets.

### Debug time override (for replay/testing)
- URL parameters:
  - `debugTime=ISO_OR_MS`: set “now” to this time on load (e.g. `debugTime=2024-08-01T10:00:00Z`).
  - `debugTimeFreeze=1` (or `true`): keep time frozen; omit or set to `0` to let it tick.
- On the debug page, the topbar exposes a datetime input and a tick/freeze toggle; changes also update the URL for sharing.

## Running locally
1. Place your GPX file (default `tracks/start.gpx`, or whatever `trackFile` points to).
2. Serve the folder (example with Python, but any static host works):
   ```bash
   python -m http.server 8000
   ```
3. Open http://localhost:8000 in your browser. The map will load the GPX route, show waypoints, and poll Traccar for live positions using your config.

## Build
No bundler is required—the site is plain ES modules served as static files. If you want dependencies installed for tests or local tooling, run:
```bash
npm install
```
Then serve the repo (see “Running locally”) or point your static host at the project root.

### Leaflet assets (fixes “ReferenceError: L is not defined”)
Leaflet must be available at `vendor/leaflet/leaflet.js` and `vendor/leaflet/leaflet.css` (what `index.html` loads). `npm install` now copies these files for you via `postinstall`, so you should not see `ReferenceError: L is not defined` when serving locally. If you skip npm install, download the Leaflet release zip (or copy from another install) and drop its `dist` contents into `vendor/leaflet`.

## How it works
- Uses Leaflet with OSM tiles for the base map.
- Reads a single GPX file for the route, draws it, and extracts waypoints for ETA predictions.
- Polls Traccar: `GET /api/devices` for metadata and `GET /api/positions` for latest fixes. Authorization uses the bearer token from `config.json`.
- Select a participant via the legend to see ETAs to waypoints; right-click/long-press the map for a menu (open in Google Maps/Waze, copy coords, see ETA to that point).
- All logic runs in `app.js`; styling lives in `styles.css`.
