#!/usr/bin/env python3
import gzip
import json
import os
import struct
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


HOST = os.environ.get("BALANCE_API_HOST", "0.0.0.0")
PORT = int(os.environ.get("BALANCE_API_PORT", "8765"))
API_TOKEN = os.environ.get("BALANCE_API_TOKEN", "")
SERVER_ROOT = Path(os.environ.get("MINECRAFT_SERVER_ROOT", "/home/opc/minecraft"))
BANK_FILE = SERVER_ROOT / "world" / "data" / "numismatics_bank.dat"
SEASONS_FILE = SERVER_ROOT / "world" / "data" / "seasons.dat"
SEASONS_CONFIG = SERVER_ROOT / "config" / "sereneseasons" / "seasons.toml"
USERNAME_CACHE = SERVER_ROOT / "usernamecache.json"


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


def load_usernames():
    try:
        data = json.loads(USERNAME_CACHE.read_text())
        return {key.lower(): value for key, value in data.items()}
    except Exception:
        return {}


def load_balances():
    with gzip.open(BANK_FILE, "rb") as handle:
        root = NbtReader(handle.read()).named_root()

    usernames = load_usernames()
    accounts = root.get("data", {}).get("Accounts", [])
    balances = []
    for account in accounts:
        player_uuid = uuid_from_int_array(account.get("id", []))
        if not player_uuid:
            continue
        balances.append(
            {
                "uuid": player_uuid,
                "name": usernames.get(player_uuid.lower()),
                "balance": int(account.get("balance", 0)),
                "accountType": account.get("AccountType"),
            }
        )
    return balances


def read_sub_season_duration():
    try:
        for line in SEASONS_CONFIG.read_text().splitlines():
            line = line.strip()
            if line.startswith("sub_season_duration"):
                return max(1, int(line.split("=", 1)[1].strip()))
    except Exception:
        pass
    return 10


def load_season():
    names = [
        ("EARLY_SPRING", "초봄", "봄"),
        ("MID_SPRING", "중봄", "봄"),
        ("LATE_SPRING", "늦봄", "봄"),
        ("EARLY_SUMMER", "초여름", "여름"),
        ("MID_SUMMER", "한여름", "여름"),
        ("LATE_SUMMER", "늦여름", "여름"),
        ("EARLY_AUTUMN", "초가을", "가을"),
        ("MID_AUTUMN", "한가을", "가을"),
        ("LATE_AUTUMN", "늦가을", "가을"),
        ("EARLY_WINTER", "초겨울", "겨울"),
        ("MID_WINTER", "한겨울", "겨울"),
        ("LATE_WINTER", "늦겨울", "겨울"),
    ]

    with gzip.open(SEASONS_FILE, "rb") as handle:
        root = NbtReader(handle.read()).named_root()

    ticks = int(root.get("data", {}).get("SeasonCycleTicks", 0))
    sub_days = read_sub_season_duration()
    day_ticks = 24000
    sub_ticks = sub_days * day_ticks
    cycle_ticks = sub_ticks * len(names)
    cycle_tick = ticks % cycle_ticks
    index = min(len(names) - 1, cycle_tick // sub_ticks)
    day = min(sub_days, cycle_tick % sub_ticks // day_ticks + 1)
    key, label, season = names[index]

    return {
        "key": key,
        "label": label,
        "season": season,
        "day": int(day),
        "subSeasonDuration": sub_days,
        "cycleTicks": ticks,
    }


def has_token(headers, params):
    expected = API_TOKEN.strip()
    if not expected:
        return False
    supplied = headers.get("Authorization", "")
    if supplied.startswith("Bearer "):
        supplied = supplied[7:]
    else:
        supplied = params.get("token", [""])[0]
    return supplied == expected


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

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)

        if parsed.path == "/health":
            self.send_json(200, {"ok": True})
            return

        if parsed.path not in ("/balance", "/balances"):
            self.send_json(404, {"error": "not_found"})
            return

        if not has_token(self.headers, params):
            self.send_json(401, {"error": "unauthorized"})
            return

        try:
            balances = load_balances()
            season = load_season()
        except Exception as exc:
            self.send_json(500, {"error": "read_failed", "message": str(exc)})
            return

        if parsed.path == "/balances":
            self.send_json(200, {"balances": balances, "season": season})
            return

        name = params.get("name", [""])[0].lower()
        player_uuid = normalize_uuid(params.get("uuid", [""])[0])
        for item in balances:
            if name and (item.get("name") or "").lower() == name:
                self.send_json(200, {**item, "season": season})
                return
            if player_uuid and item["uuid"].lower() == player_uuid:
                self.send_json(200, {**item, "season": season})
                return

        self.send_json(404, {"error": "player_not_found", "season": season})

    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args), flush=True)


if __name__ == "__main__":
    if not API_TOKEN:
        raise SystemExit("BALANCE_API_TOKEN is required")
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Balance API listening on {HOST}:{PORT}", flush=True)
    server.serve_forever()
