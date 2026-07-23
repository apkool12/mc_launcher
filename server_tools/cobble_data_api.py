#!/usr/bin/env python3
"""Read-only HTTP data API for a Cobbleverse Minecraft server.

Reads server world files (pokedex progress, badges, cobbledollars balance)
and serves them as JSON to the launcher panel. Never writes to world data.
"""
import gzip
import hmac
import json
import os
import struct
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse


HOST = os.environ.get("DATA_API_HOST", "0.0.0.0")
PORT = int(os.environ.get("DATA_API_PORT", "8765"))
API_TOKEN = os.environ.get("DATA_API_TOKEN", "")
SERVER_ROOT = Path(os.environ.get("MINECRAFT_SERVER_ROOT", "/home/opc/minecraft"))
LEVEL_NAME = os.environ.get("LEVEL_NAME", "world")
BADGE_ITEM_MATCH = os.environ.get("BADGE_ITEM_MATCH", "cobbleversebadges:")
DOWNLOAD_DIR = Path(
    os.environ.get("LAUNCHER_DOWNLOAD_DIR", str(SERVER_ROOT / "tools" / "downloads"))
)

WORLD = SERVER_ROOT / LEVEL_NAME
USERCACHE_FILE = SERVER_ROOT / "usercache.json"
MAINTENANCE_FLAG = SERVER_ROOT / "MAINTENANCE"

POKEDEX_TOTAL = 1025


TAG_END = 0
TAG_BYTE = 1
TAG_SHORT = 2
TAG_INT = 3
TAG_LONG = 4
TAG_FLOAT = 5
TAG_DOUBLE = 6
TAG_BYTE_ARRAY = 7
TAG_STRING = 8
TAG_LIST = 9
TAG_COMPOUND = 10
TAG_INT_ARRAY = 11
TAG_LONG_ARRAY = 12


class NbtReader:
    def __init__(self, data):
        self.data = data
        self.pos = 0

    def read(self, size):
        value = self.data[self.pos : self.pos + size]
        if len(value) != size:
            raise ValueError("Unexpected end of NBT data")
        self.pos += size
        return value

    def u8(self):
        return self.read(1)[0]

    def i16(self):
        return struct.unpack(">h", self.read(2))[0]

    def i32(self):
        return struct.unpack(">i", self.read(4))[0]

    def i64(self):
        return struct.unpack(">q", self.read(8))[0]

    def string(self):
        size = self.i16()
        return self.read(size).decode("utf-8")

    def named_root(self):
        tag = self.u8()
        if tag != TAG_COMPOUND:
            raise ValueError(f"Expected compound root, got tag {tag}")
        self.string()
        return self.payload(TAG_COMPOUND)

    def payload(self, tag):
        if tag == TAG_END:
            return None
        if tag == TAG_BYTE:
            return struct.unpack(">b", self.read(1))[0]
        if tag == TAG_SHORT:
            return self.i16()
        if tag == TAG_INT:
            return self.i32()
        if tag == TAG_LONG:
            return self.i64()
        if tag == TAG_FLOAT:
            return struct.unpack(">f", self.read(4))[0]
        if tag == TAG_DOUBLE:
            return struct.unpack(">d", self.read(8))[0]
        if tag == TAG_BYTE_ARRAY:
            return self.read(self.i32())
        if tag == TAG_STRING:
            return self.string()
        if tag == TAG_LIST:
            item_tag = self.u8()
            length = self.i32()
            return [self.payload(item_tag) for _ in range(length)]
        if tag == TAG_COMPOUND:
            result = {}
            while True:
                item_tag = self.u8()
                if item_tag == TAG_END:
                    return result
                name = self.string()
                result[name] = self.payload(item_tag)
        if tag == TAG_INT_ARRAY:
            return [self.i32() for _ in range(self.i32())]
        if tag == TAG_LONG_ARRAY:
            return [self.i64() for _ in range(self.i32())]
        raise ValueError(f"Unsupported NBT tag {tag}")


def uuid_from_int_array(values):
    if len(values) != 4:
        return None
    raw = b"".join(struct.pack(">i", value) for value in values)
    return str(uuid.UUID(bytes=raw))


def normalize_uuid(value):
    raw = "".join(ch for ch in value.lower() if ch in "0123456789abcdef")
    if len(raw) != 32:
        return value.lower()
    return str(uuid.UUID(hex=raw))


def _dashed_uuid(raw):
    """Normalize a 32-hex (or already-dashed) uuid string to dashed lowercase form."""
    if not raw:
        return ""
    hex_only = "".join(ch for ch in raw.lower() if ch in "0123456789abcdef")
    if len(hex_only) != 32:
        return raw.lower()
    return str(uuid.UUID(hex=hex_only))


def parse_pokedex(data):
    """Parse a Cobblemon world/pokedex/<bucket>/<uuid>.nbt structure (raw, non-gzip NBT).

    Real shape confirmed against live server data:
      { "speciesRecords": { "cobblemon:<species>": { "formRecords": {
          "<form>": { "knowledge": "CAUGHT" | "ENCOUNTERED", ... } } } }, "uuid": "..." }
    A species counts as "seen" once it has any form record at all; "caught" requires
    at least one form record with knowledge == CAUGHT.
    """
    species_records = (data or {}).get("speciesRecords", {})
    if not isinstance(species_records, dict):
        return {"caught": 0, "seen": 0, "total": POKEDEX_TOTAL}

    caught = 0
    seen = 0
    for record in species_records.values():
        form_records = record.get("formRecords", {}) if isinstance(record, dict) else {}
        if not isinstance(form_records, dict) or not form_records:
            continue
        knowledges = {
            fr.get("knowledge")
            for fr in form_records.values()
            if isinstance(fr, dict) and isinstance(fr.get("knowledge"), str)
        }
        if not knowledges:
            continue
        seen += 1
        if "CAUGHT" in knowledges:
            caught += 1
    return {"caught": caught, "seen": seen, "total": POKEDEX_TOTAL}


def read_pokedex(player_uuid):
    dashed = _dashed_uuid(player_uuid)
    if not dashed:
        return parse_pokedex(None)

    prefix = dashed[:2]
    candidate = WORLD / "pokedex" / prefix / f"{dashed}.nbt"
    try:
        data = NbtReader(candidate.read_bytes()).named_root()
        return parse_pokedex(data)
    except Exception:
        pass

    try:
        for path in (WORLD / "pokedex").glob(f"*/{dashed}.nbt"):
            try:
                data = NbtReader(path.read_bytes()).named_root()
                return parse_pokedex(data)
            except Exception:
                continue
    except Exception:
        pass

    return parse_pokedex(None)


def _iter_item_ids(node):
    """Depth-first walk of an NBT-like structure, yielding each dict's `id` string field."""
    if isinstance(node, dict):
        value = node.get("id")
        if isinstance(value, str):
            yield value
        for child in node.values():
            yield from _iter_item_ids(child)
    elif isinstance(node, list):
        for child in node:
            yield from _iter_item_ids(child)


def parse_badges_from_nbt(player_nbt, match=BADGE_ITEM_MATCH):
    unique_ids = set()
    for item_id in _iter_item_ids(player_nbt):
        lowered = item_id.lower()
        if match not in item_id:
            continue
        if "badge" not in lowered:
            continue
        if "box" in lowered:
            continue
        unique_ids.add(item_id)
    return {"count": len(unique_ids), "list": sorted(unique_ids)}


def read_badges(player_uuid, player_nbt=None):
    if player_nbt is None:
        player_nbt = _read_player_nbt(player_uuid)
    return parse_badges_from_nbt(player_nbt, BADGE_ITEM_MATCH)


def _read_player_nbt(player_uuid):
    dashed = _dashed_uuid(player_uuid)
    if not dashed:
        return {}
    dat_path = WORLD / "playerdata" / f"{dashed}.dat"
    try:
        with gzip.open(dat_path, "rb") as handle:
            return NbtReader(handle.read()).named_root()
    except Exception:
        return {}


def _iter_numeric_fields(node, key_predicate):
    """Depth-first walk yielding numeric values whose dict key matches key_predicate."""
    if isinstance(node, dict):
        for key, value in node.items():
            if key_predicate(key) and isinstance(value, (int, float)) and not isinstance(value, bool):
                yield value
            yield from _iter_numeric_fields(value, key_predicate)
    elif isinstance(node, list):
        for child in node:
            yield from _iter_numeric_fields(child, key_predicate)


def _find_cobbledollars_balance_json(data):
    """Depth-first search a JSON dict/list for a numeric balance/cobbledollars/amount field."""
    for value in _iter_numeric_fields(
        data, lambda k: k.lower() in ("balance", "cobbledollars", "amount")
    ):
        return int(value)
    return None


def read_cobbledollars(player_uuid, player_nbt=None):
    # Confirmed against live server data: world/cobbledollarsplayerdata/<uuid>.json
    # is a flat { "name": ..., "cobbledollars": <int> } file (no bucket subfolder).
    dashed = _dashed_uuid(player_uuid)
    if not dashed:
        return {"balance": 0}

    json_path = WORLD / "cobbledollarsplayerdata" / f"{dashed}.json"
    try:
        data = json.loads(json_path.read_text())
        balance = _find_cobbledollars_balance_json(data)
        if balance is not None:
            return {"balance": balance}
    except Exception:
        pass

    if player_nbt is None:
        player_nbt = _read_player_nbt(player_uuid)
    for value in _iter_numeric_fields(player_nbt, lambda k: "cobbledollar" in k.lower()):
        return {"balance": int(value)}

    return {"balance": 0}


def _resolve_uuid_from_name(name):
    try:
        entries = json.loads(USERCACHE_FILE.read_text())
    except Exception:
        return ""
    lowered = name.lower()
    for entry in entries:
        if isinstance(entry, dict) and (entry.get("name") or "").lower() == lowered:
            return entry.get("uuid") or ""
    return ""


def build_player_payload(player_uuid, name):
    player_uuid = (player_uuid or "").strip()
    name = (name or "").strip()

    if not player_uuid and name:
        player_uuid = _resolve_uuid_from_name(name)

    if not player_uuid:
        return {
            "pokedex": {"caught": 0, "seen": 0, "total": POKEDEX_TOTAL},
            "badges": {"count": 0, "list": []},
            "cobbledollars": {"balance": 0},
        }

    player_nbt = _read_player_nbt(player_uuid)
    return {
        "pokedex": read_pokedex(player_uuid),
        "badges": read_badges(player_uuid, player_nbt=player_nbt),
        "cobbledollars": read_cobbledollars(player_uuid, player_nbt=player_nbt),
    }


def has_token(headers, params):
    expected = API_TOKEN.strip()
    if not expected:
        return False
    supplied = headers.get("Authorization", "")
    if supplied.startswith("Bearer "):
        supplied = supplied[7:]
    else:
        supplied = headers.get("X-API-Token", "") or params.get("token", [""])[0]
    return hmac.compare_digest(supplied, expected)


def download_file_path(raw_name):
    file_name = Path(unquote(raw_name)).name
    if not file_name or file_name in (".", ".."):
        return None

    download_root = DOWNLOAD_DIR.resolve()
    file_path = (download_root / file_name).resolve()
    try:
        file_path.relative_to(download_root)
    except ValueError:
        return None

    if not file_path.is_file():
        return None
    return file_path


def content_type_for(file_path):
    suffix = file_path.suffix.lower()
    if suffix == ".exe":
        return "application/vnd.microsoft.portable-executable"
    if suffix in (".yml", ".yaml"):
        return "application/yaml; charset=utf-8"
    if suffix == ".blockmap":
        return "application/octet-stream"
    return "application/octet-stream"


class Handler(BaseHTTPRequestHandler):
    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_download(self, file_path, head_only=False):
        stat = file_path.stat()
        self.send_response(200)
        self.send_header("Content-Type", content_type_for(file_path))
        self.send_header("Content-Length", str(stat.st_size))
        self.send_header("Cache-Control", "public, max-age=300")
        self.send_header("Content-Disposition", f'attachment; filename="{file_path.name}"')
        self.end_headers()

        if head_only:
            return

        with file_path.open("rb") as file:
            while True:
                chunk = file.read(1024 * 1024)
                if not chunk:
                    break
                self.wfile.write(chunk)

    def handle_download(self, path, head_only=False):
        file_path = download_file_path(path.removeprefix("/downloads/"))
        if not file_path:
            self.send_json(404, {"error": "download_not_found"})
            return
        self.send_download(file_path, head_only=head_only)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, X-API-Token, Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.end_headers()

    def do_HEAD(self):
        parsed = urlparse(self.path)
        if parsed.path.startswith("/downloads/"):
            self.handle_download(parsed.path, head_only=True)
            return
        self.send_response(404)
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)

        if parsed.path.startswith("/downloads/"):
            self.handle_download(parsed.path)
            return

        if parsed.path == "/health":
            self.send_json(200, {"ok": True, "maintenance": MAINTENANCE_FLAG.is_file()})
            return

        if parsed.path != "/player":
            self.send_json(404, {"error": "not_found"})
            return

        if not has_token(self.headers, params):
            self.send_json(401, {"error": "unauthorized"})
            return

        player_uuid = params.get("uuid", [""])[0]
        name = params.get("name", [""])[0]

        try:
            payload = build_player_payload(player_uuid, name)
        except Exception as exc:
            self.send_json(500, {"error": "read_failed", "message": str(exc)})
            return

        self.send_json(200, payload)

    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args), flush=True)


if __name__ == "__main__":
    if not API_TOKEN:
        raise SystemExit("DATA_API_TOKEN is required")
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Data API listening on {HOST}:{PORT}", flush=True)
    server.serve_forever()
