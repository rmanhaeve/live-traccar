# Live Traccar Tracker

FastAPI-backed tracker that renders a GPX route with live participant locations from a Traccar server. The backend performs all computation (route parsing, projections, progress/ETA/history, weather). The frontend is a thin renderer that only consumes `/api/*` responses.

## Repository structure
- `backend/`: FastAPI app, services, tests.
- `frontend/`: Static UI (Leaflet, HTML/CSS/JS) served by the backend in development.

## Architecture overview
1. **Traccar** is the source of truth for devices and positions.
2. **Backend** polls Traccar, computes route progress, ETAs, history events, and weather, then exposes the data via REST endpoints.
3. **Frontend** polls the backend and renders the map and UI. No computation is done in the browser.

## Requirements
- Python 3.11+
- Traccar server with API token

## Configuration
Create `backend/.env` from the example:
```bash
cp backend/.env.example backend/.env
```

### Environment variables
All settings are prefixed with `APP_`:
- `APP_TRACCAR_URL`: Traccar base URL (required)
- `APP_TRACCAR_TOKEN`: Traccar API token (required)
- `APP_TITLE`: Page title
- `APP_REFRESH_SECONDS`: Poll interval (default: 8)
- `APP_STALE_MINUTES`: Stale threshold for participant marker (default: 15)
- `APP_HISTORY_HOURS`: History retention (default: 24)
- `APP_SHOW_VIEWER_LOCATION`: Enable "You" marker (default: true)
- `APP_SHOW_KM_MARKERS`: Enable km marker toggle (default: true)
- `APP_SHOW_WAYPOINTS`: Enable waypoint toggle (default: true)
- `APP_TRACK_FILE`: GPX path (default: `frontend/tracks/stapvoorstap.gpx`)
- `APP_TRANSLATION_FILE`: Translation JSON path (default: `frontend/translations/en.json`)
- `APP_WEATHER_ENABLED`: Weather panel toggle (default: true)
- `APP_WEATHER_HOURS`: Forecast rows (default: 4)

## Running locally
```bash
python -m pip install -r backend/requirements.txt
uvicorn backend.main:app --reload
```
Open http://localhost:8000

## API endpoints
All responses are JSON.

### Config
`GET /api/config`
- Returns UI config values for the frontend.

### Route
`GET /api/route`
- Returns route segments, waypoints, elevation profile, and km markers.

### Participants
`GET /api/participants`
- Returns current participants, positions, progress, and computed status.

`GET /api/participants/{id}/waypoints`
- Returns waypoint ETAs and distance-to for a participant.

`GET /api/participants/{id}/history`
- Returns distance tick events, waypoint enter/leave events, and upcoming waypoints.

`GET /api/participants/{id}/eta?lat=...&lng=...`
- Returns ETA to an arbitrary point on the route (snapped to route).

### Weather
`GET /api/weather?participantId=...`
- Returns forecast for a participant location or route center.

## Data flow details
- Route is parsed once on demand and cached in memory.
- Traccar devices/positions are polled on each backend refresh cycle.
- History uses Traccar route reports and in-memory aggregation.
- Weather data is cached for 10 minutes per location.

## Testing
Backend unit tests and API tests:
```bash
python -m pytest backend/tests -q
```

Frontend unit tests (optional):
```bash
node frontend/test/run-all.js
```

## Troubleshooting
- **Empty map**: Ensure `APP_TRACK_FILE` points to a valid GPX file.
- **No participants**: Verify Traccar API token and that devices have recent positions.
- **Weather missing**: Check outbound network access; disable with `APP_WEATHER_ENABLED=false`.
- **Stale markers**: Increase `APP_STALE_MINUTES` if positions update less frequently.

## Security notes
- Traccar API token is stored server-side only.
- The frontend never talks directly to Traccar.
- Consider adding auth middleware if serving publicly.
