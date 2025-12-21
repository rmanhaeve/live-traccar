#!/usr/bin/env python3
import argparse
import json
import math
import os
import sys
import time
from datetime import datetime, timezone
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET


DEFAULT_POLL_SECONDS = 30
DEFAULT_STALE_MINUTES = 15
DEFAULT_OFFTRACK_METERS = 200


def read_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def normalize_name(name):
    return str(name or "").strip().lower()


def apply_template(value, vars_map):
    if not isinstance(value, str):
        return value
    out = value
    for key, val in vars_map.items():
        out = out.replace("{" + key + "}", "" if val is None else str(val))
    return out


def apply_template_object(value, vars_map):
    if value is None:
        return None
    if isinstance(value, str):
        return apply_template(value, vars_map)
    if isinstance(value, list):
        return [apply_template_object(v, vars_map) for v in value]
    if isinstance(value, dict):
        return {k: apply_template_object(v, vars_map) for k, v in value.items()}
    return value


def resolve_path(base_dir, file_path):
    if not file_path:
        return None
    if os.path.isabs(file_path):
        return file_path
    return os.path.abspath(os.path.join(base_dir, file_path))


def to_iso_time(value):
    if not value:
        return ""
    try:
        dt = datetime.fromtimestamp(parse_time_ms(value) / 1000, tz=timezone.utc)
        return dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    except Exception:
        return ""


def parse_time_ms(value):
    if not value:
        return None
    try:
        if isinstance(value, (int, float)):
            return int(value)
        text = str(value)
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        dt = datetime.fromisoformat(text)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return int(dt.timestamp() * 1000)
    except Exception:
        try:
            return int(time.mktime(time.strptime(value, "%Y-%m-%d %H:%M:%S")) * 1000)
        except Exception:
            return None


def fetch_json(url, token):
    headers = {}
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=20) as res:
        return json.loads(res.read().decode("utf-8"))


def fetch_devices(config):
    url = config["traccarUrl"].rstrip("/") + "/api/devices"
    data = fetch_json(url, config.get("token"))
    return data if isinstance(data, list) else []


def fetch_positions(config):
    url = config["traccarUrl"].rstrip("/") + "/api/positions"
    data = fetch_json(url, config.get("token"))
    return data if isinstance(data, list) else []


def send_sms(gateway, to, message):
    base_url = gateway.get("baseUrl")
    if not base_url:
        raise ValueError("smsGateway.baseUrl is required")
    method = str(gateway.get("method", "POST")).upper()
    auth_value = gateway.get("authorization") or gateway.get("token") or gateway.get("apiKey") or ""
    vars_map = {
        "to": to,
        "phone": to,
        "message": message,
        "authorization": auth_value,
        "token": gateway.get("token", ""),
        "apiKey": gateway.get("apiKey", ""),
    }

    path = gateway.get("path", "/")
    url = urllib.parse.urljoin(base_url.rstrip("/") + "/", path.lstrip("/"))
    query = apply_template_object(gateway.get("query", {}), vars_map) or {}
    if query:
        url_parts = list(urllib.parse.urlparse(url))
        qs = urllib.parse.parse_qs(url_parts[4])
        for key, val in query.items():
            if val is None or val == "":
                continue
            qs[key] = [str(val)]
        url_parts[4] = urllib.parse.urlencode(qs, doseq=True)
        url = urllib.parse.urlunparse(url_parts)

    headers = apply_template_object(gateway.get("headers", {}), vars_map) or {}
    if not headers and auth_value:
        headers["Authorization"] = auth_value

    body = None
    if method != "GET":
        body_template = gateway.get("body", {"to": "{to}", "message": "{message}"})
        body_value = apply_template_object(body_template, vars_map)
        body_format = str(gateway.get("bodyFormat", "json")).lower()
        if body_format == "form":
            headers.setdefault("Content-Type", "application/x-www-form-urlencoded")
            body = urllib.parse.urlencode(body_value or {}).encode("utf-8")
        elif body_format == "text":
            headers.setdefault("Content-Type", "text/plain")
            body = (body_value if isinstance(body_value, str) else json.dumps(body_value)).encode("utf-8")
        else:
            headers.setdefault("Content-Type", "application/json")
            body = (body_value if isinstance(body_value, str) else json.dumps(body_value)).encode("utf-8")

    req = urllib.request.Request(url, method=method, headers=headers, data=body)
    with urllib.request.urlopen(req, timeout=20) as res:
        if res.status >= 300:
            raise RuntimeError("SMS gateway failed: %s" % res.status)


def parse_gpx(path):
    tree = ET.parse(path)
    root = tree.getroot()
    ns = {"gpx": root.tag.split("}")[0].strip("{")} if "}" in root.tag else {}
    segments = []
    for trk in root.findall(".//gpx:trk", ns) + root.findall(".//trk"):
        for seg in trk.findall(".//gpx:trkseg", ns) + trk.findall(".//trkseg"):
            points = []
            for pt in seg.findall(".//gpx:trkpt", ns) + seg.findall(".//trkpt"):
                lat = float(pt.attrib.get("lat"))
                lng = float(pt.attrib.get("lon"))
                points.append((lat, lng))
            if points:
                segments.append(points)
    return segments


class RouteProfile:
    def __init__(self, segments, offtrack_meters):
        self.route_points = []
        self.offtrack_meters = offtrack_meters
        for seg in segments:
            for lat, lng in seg:
                self.route_points.append({"lat": lat, "lng": lng})
        if not self.route_points:
            raise ValueError("No route points in GPX")
        self._build()

    def _build(self):
        self.route_distances = [0.0] * len(self.route_points)
        for i in range(1, len(self.route_points)):
            self.route_distances[i] = self.route_distances[i - 1] + distance_meters(
                (self.route_points[i - 1]["lat"], self.route_points[i - 1]["lng"]),
                (self.route_points[i]["lat"], self.route_points[i]["lng"]),
            )
        self.route_total = self.route_distances[-1] if self.route_distances else 0.0
        ref_lat = sum(p["lat"] for p in self.route_points) / len(self.route_points)
        rad = math.pi / 180.0
        r = 6371000.0
        for p in self.route_points:
            p["_x"] = p["lng"] * rad * math.cos(ref_lat * rad) * r
            p["_y"] = p["lat"] * rad * r
        for i in range(len(self.route_points) - 1):
            a = self.route_points[i]
            b = self.route_points[i + 1]
            dx = b["_x"] - a["_x"]
            dy = b["_y"] - a["_y"]
            a["_seg_len2"] = dx * dx + dy * dy

    def project(self, lat, lng):
        if not self.route_points:
            return None
        rad = math.pi / 180.0
        r = 6371000.0
        ref_lat = sum(p["lat"] for p in self.route_points) / len(self.route_points)
        tx = lng * rad * math.cos(ref_lat * rad) * r
        ty = lat * rad * r
        best = None
        for i in range(len(self.route_points) - 1):
            a = self.route_points[i]
            b = self.route_points[i + 1]
            seg_len2 = a.get("_seg_len2", 0.0)
            if seg_len2 == 0:
                continue
            apx = tx - a["_x"]
            apy = ty - a["_y"]
            t = (apx * (b["_x"] - a["_x"]) + apy * (b["_y"] - a["_y"])) / seg_len2
            t = max(0.0, min(1.0, t))
            px = a["_x"] + (b["_x"] - a["_x"]) * t
            py = a["_y"] + (b["_y"] - a["_y"]) * t
            d2 = (px - tx) ** 2 + (py - ty) ** 2
            seg_dist = self.route_distances[i] + math.sqrt(seg_len2) * t
            if best is None or d2 < best["d2"]:
                best = {"d2": d2, "distanceAlong": seg_dist}
        if not best:
            return None
        best["distanceMeters"] = math.sqrt(best["d2"])
        best["offtrack"] = best["distanceMeters"] > self.offtrack_meters
        return best


def distance_meters(a, b):
    lat1, lng1 = a
    lat2, lng2 = b
    rad = math.pi / 180.0
    r = 6371000.0
    dlat = (lat2 - lat1) * rad
    dlng = (lng2 - lng1) * rad
    lat1r = lat1 * rad
    lat2r = lat2 * rad
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1r) * math.cos(lat2r) * math.sin(dlng / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(h)))


def build_participant_map(raw):
    entries = raw if isinstance(raw, list) else raw.get("participants")
    if not isinstance(entries, list):
        return {}
    result = {}
    for entry in entries:
        key = normalize_name(entry.get("name"))
        if not key:
            continue
        result[key] = {"name": entry.get("name"), "phone": entry.get("phone")}
    return result


def get_position_time_ms(position):
    for key in ("deviceTime", "fixTime", "serverTime"):
        t = position.get(key)
        if t:
            time_ms = parse_time_ms(t)
            if time_ms:
                return time_ms
    return None


def parse_args(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default="config.json")
    parser.add_argument("--test-sms")
    parser.add_argument("--test-message")
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args(argv)


def main():
    args = parse_args(sys.argv[1:])
    config_path = os.path.abspath(args.config)
    config_dir = os.path.dirname(config_path)
    config = read_json(config_path)
    if not config.get("traccarUrl") or not config.get("token"):
        raise RuntimeError("traccarUrl and token are required in config.json")

    if args.test_sms:
        message = args.test_message or "Test message from live-traccar off-route monitor."
        if args.dry_run:
            print("Dry run: would send test SMS to %s: %s" % (args.test_sms, message))
        else:
            send_sms(config.get("smsGateway", {}), args.test_sms, message)
            print("Sent test SMS to %s: %s" % (args.test_sms, message))
        return 0

    track_file = resolve_path(config_dir, config.get("trackFile"))
    if not track_file:
        raise RuntimeError("trackFile is required in config.json")
    segments = parse_gpx(track_file)
    offtrack_meters = int(config.get("offrouteThresholdMeters", DEFAULT_OFFTRACK_METERS))
    route = RouteProfile(segments, offtrack_meters)

    participant_file = resolve_path(config_dir, config.get("participantMapFile", "participants.json"))
    if not participant_file:
        raise RuntimeError("participantMapFile is required in config.json")
    participants_raw = read_json(participant_file)
    participants = build_participant_map(participants_raw)
    if not participants:
        raise RuntimeError("participantMapFile has no participants")

    poll_seconds = int(config.get("pollSeconds", DEFAULT_POLL_SECONDS))
    stale_minutes = int(config.get("staleMinutes", DEFAULT_STALE_MINUTES))
    message_template = config.get(
        "offrouteMessage",
        "{name} is off-route at {time}. Last location: {lat},{lng}",
    )

    state = {}

    def poll_once():
        devices = fetch_devices(config)
        positions = fetch_positions(config)
        position_by_id = {p.get("deviceId"): p for p in positions}
        now_ms = int(time.time() * 1000)

        for device in devices:
            participant = participants.get(normalize_name(device.get("name")))
            if not participant:
                continue
            pos = position_by_id.get(device.get("id"))
            if not pos:
                print("Distance from track: %s = unavailable (no position)" % participant.get("name"))
                state[device["id"]] = {"offroute": False, "notified": False}
                continue
            time_ms = get_position_time_ms(pos)
            if not time_ms or now_ms - time_ms > stale_minutes * 60 * 1000:
                print("Distance from track: %s = unavailable (stale position)" % participant.get("name"))
                state[device["id"]] = {"offroute": False, "notified": False}
                continue
            lat = pos.get("latitude")
            lng = pos.get("longitude")
            proj = route.project(lat, lng) if lat is not None and lng is not None else None
            offroute = (proj is None) or proj.get("offtrack")
            distance_m = proj.get("distanceMeters") if proj else None
            if distance_m is not None:
                print(
                    "Distance from track: %s = %.1f m%s"
                    % (
                        participant.get("name"),
                        distance_m,
                        " (off-route)" if offroute else "",
                    )
                )
            else:
                print("Distance from track: %s = unavailable" % participant.get("name"))
            entry = state.get(device["id"], {"offroute": False, "notified": False})
            if offroute and not entry.get("notified"):
                phone = participant.get("phone")
                if not phone:
                    print("No phone number for participant: %s" % participant.get("name"))
                else:
                    vars_map = {
                        "name": participant.get("name"),
                        "lat": pos.get("latitude"),
                        "lng": pos.get("longitude"),
                        "time": to_iso_time(pos.get("deviceTime") or pos.get("fixTime") or pos.get("serverTime")),
                        "deviceId": device.get("id"),
                    }
                    message = apply_template(message_template, vars_map)
                    try:
                        if args.dry_run:
                            print(
                                "Dry run: would send SMS for %s to %s: %s"
                                % (participant.get("name"), phone, message)
                            )
                        else:
                            send_sms(config.get("smsGateway", {}), phone, message)
                            print("Sent SMS for %s to %s: %s" % (participant.get("name"), phone, message))
                    except Exception as exc:
                        print("SMS failed for %s: %s" % (participant.get("name"), exc))
                entry["notified"] = True
            if not offroute:
                entry["notified"] = False
            entry["offroute"] = offroute
            state[device["id"]] = entry

    poll_once()
    while True:
        time.sleep(max(5, poll_seconds))
        try:
            poll_once()
        except Exception as exc:
            print("Poll error: %s" % exc)


if __name__ == "__main__":
    sys.exit(main())
