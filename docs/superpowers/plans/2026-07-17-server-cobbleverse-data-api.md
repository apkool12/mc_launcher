# Cobbleverse 서버 구축 + 데이터 API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Oracle Cloud 호스트에 최신 Cobbleverse(1.7.41b, Fabric/MC 1.21.1) 서버를 새로 구성하고, 월드의 도감/배지 JSON을 읽어 런처에 제공하는 읽기전용 데이터 API를 배포한다.

**Architecture:** 서버 구축은 SSH로 수행하는 운영 작업이라 단위 테스트가 아닌 로그·핑으로 검증한다. 데이터 API는 Python 표준 라이브러리 서비스로, JSON 파싱 로직은 `unittest` + 픽스처로 검증하고, 실제 스키마는 서버 가동 후 실데이터로 확정한다(디스커버리).

**Tech Stack:** SSH/systemd, Temurin JDK 21, `mrpack-install`(Go 바이너리), Python 3 표준 라이브러리(`http.server`).

## Global Constraints

- 접속: `ssh -i ~/Downloads/ssh-key-2026-07-04.key -p 22 opc@161.33.22.158`
- 서버 폴더: `/home/opc/minecraft`. 월드: `/home/opc/minecraft/world`(server.properties `level-name`으로 확정).
- 팩: COBBLEVERSE `1.7.41b` / MC `1.21.1` / Fabric. Java **21**.
- mrpack URL: `https://cdn.modrinth.com/data/Jkb29YJU/versions/T9GJwPoJ/COBBLEVERSE%201.7.41b.mrpack`
- 데이터 API 포트 **8765** 재사용. `/downloads/`·`/health` 엔드포인트는 기존 `balance_api.py`에서 **보존**(런처 배포 파일 서빙 가능성). 경제(`/balance`)·시즌·NBT 로직만 제거하고 `/player` 추가.
- 파괴적 작업 금지: 기존 서버/월드는 삭제가 아니라 **백업 이동**. 각 파괴 가능 단계 전 사용자에게 상태 보고.
- OCI Security List의 25565·8765는 기존 서버가 이미 사용 중이라 열려 있다고 가정. 닫혀 있으면 SSH로 불가 → 사용자 콘솔 조치 요청.

---

### Task 1: 읽기전용 사전 점검 (Recon)

**Files:** 없음(원격 조회만).

**Interfaces:**
- Produces: arch(`x86_64`/`aarch64`), 총 RAM(GB), 설치 Java 버전, 기존 서버 프로세스·서비스·리스닝 포트, `/home/opc/minecraft` 존재/내용. 이 값들이 Task 3(Java 바이너리)·Task 5(RAM 할당)·Task 2(정지 대상)를 결정.

- [ ] **Step 1: 시스템 정보 수집**

Run:
```bash
ssh -i ~/Downloads/ssh-key-2026-07-04.key -p 22 opc@161.33.22.158 \
  'uname -m; echo "---"; free -h; echo "---"; (java -version 2>&1 || echo no-java); echo "---"; cat /etc/os-release | head -2'
```
Expected: arch/RAM/Java/OS 확인. 결과 기록.

- [ ] **Step 2: 기존 서버·포트·서비스 확인**

Run:
```bash
ssh -i ~/Downloads/ssh-key-2026-07-04.key -p 22 opc@161.33.22.158 \
  'ss -ltnp 2>/dev/null | grep -E ":(25565|8765)" || echo no-listen; echo "---"; systemctl list-units --type=service --all 2>/dev/null | grep -iE "minecraft|balance|cobble" || echo no-service; echo "---"; ls -la /home/opc/minecraft 2>/dev/null | head; echo "---"; (screen -ls 2>/dev/null || true); (tmux ls 2>/dev/null || true)'
```
Expected: 25565/8765 리스너, 관련 systemd 유닛, minecraft 폴더 내용, screen/tmux 세션 파악. 결과 기록.

- [ ] **Step 3: 사용자 보고**

RAM이 6GB 미만이면 사용자에게 보고(Cobbleverse 안정성 저하 가능). 기존 서비스/세션 이름을 Task 2 정지 대상으로 확정.

- [ ] **Step 4: (커밋 없음 — 조회 전용)**

---

### Task 2: 기존 서버 정지 및 백업

**Files:** 없음(원격 상태 변경). **파괴 가능 — 실행 전 Task 1 결과로 확인.**

**Interfaces:**
- Consumes: Task 1의 서비스/세션 이름, minecraft 폴더 존재 여부.
- Produces: 25565 리스너 없음, `/home/opc/minecraft`가 빈(또는 없는) 상태, 백업 디렉터리 `/home/opc/minecraft.bak-2026-07-17`.

- [ ] **Step 1: 기존 서버 정지**

Task 1에서 찾은 방식대로 정지(예: systemd면 `sudo systemctl stop <unit> && sudo systemctl disable <unit>`; screen이면 세션에 `stop` 전송 후 종료). 경제 API 서비스도 있으면 함께 정지(뒤에서 데이터 API로 대체).

Run(예, systemd인 경우):
```bash
ssh -i ~/Downloads/ssh-key-2026-07-04.key -p 22 opc@161.33.22.158 \
  'sudo systemctl stop <minecraft-unit> <balance-unit>; ss -ltnp | grep :25565 || echo stopped'
```
Expected: 25565 리스너 사라짐.

- [ ] **Step 2: 백업 이동**

Run:
```bash
ssh -i ~/Downloads/ssh-key-2026-07-04.key -p 22 opc@161.33.22.158 \
  'test -d /home/opc/minecraft && mv /home/opc/minecraft /home/opc/minecraft.bak-2026-07-17 && mkdir -p /home/opc/minecraft || mkdir -p /home/opc/minecraft; ls -la /home/opc | grep minecraft'
```
Expected: `minecraft.bak-2026-07-17`(있었다면) + 빈 `minecraft`.

- [ ] **Step 3: 사용자 보고**

정지·백업 완료 보고. (커밋 없음 — 원격 작업)

---

### Task 3: Java 21 설치

**Files:** 없음(원격 설치).

**Interfaces:**
- Consumes: Task 1 arch/OS.
- Produces: `java -version`이 21 보고, JAVA 경로 확정.

- [ ] **Step 1: 배포판 패키지 시도**

OS가 Oracle Linux/RHEL 계열이면:
```bash
ssh -i ~/Downloads/ssh-key-2026-07-04.key -p 22 opc@161.33.22.158 \
  'sudo dnf install -y java-21-openjdk-headless 2>&1 | tail -3; java -version 2>&1 | head -1'
```
Expected: Java 21 설치·확인.

- [ ] **Step 2: 폴백(tarball)**

패키지가 없으면 arch 맞는 Temurin 21 tarball을 `/home/opc/jdk-21`에 풀고 절대경로 사용. (arch: `aarch64` → `...aarch64...`, `x86_64` → `...x64...`.) 설치 경로를 기록해 Task 5 start 스크립트에 사용.

- [ ] **Step 3: 사용자 보고 없음, Java 경로 확정. (커밋 없음)**

---

### Task 4: mrpack-install로 Cobbleverse 서버 설치

**Files:** 없음(원격 설치).

**Interfaces:**
- Consumes: Task 2 빈 `/home/opc/minecraft`, Task 3 Java.
- Produces: `/home/opc/minecraft`에 Fabric 서버 런처 + 서버측 모드 + server-overrides. 시작 jar 이름 확정.

- [ ] **Step 1: mrpack-install 바이너리 설치**

arch 맞는 릴리스를 받는다(`aarch64`/`x86_64`):
```bash
ssh -i ~/Downloads/ssh-key-2026-07-04.key -p 22 opc@161.33.22.158 \
  'cd /tmp; ARCH=$(uname -m); case $ARCH in aarch64) A=arm64;; x86_64) A=amd64;; esac; \
   curl -fsSL -o mrpack-install "https://github.com/nothub/mrpack-install/releases/latest/download/mrpack-install-linux-$A"; \
   chmod +x mrpack-install; ./mrpack-install --version'
```
Expected: 버전 출력.

- [ ] **Step 2: Cobbleverse 설치**

```bash
ssh -i ~/Downloads/ssh-key-2026-07-04.key -p 22 opc@161.33.22.158 \
  'cd /home/opc/minecraft; /tmp/mrpack-install "https://cdn.modrinth.com/data/Jkb29YJU/versions/T9GJwPoJ/COBBLEVERSE%201.7.41b.mrpack" --server-dir /home/opc/minecraft 2>&1 | tail -20; ls'
```
Expected: `mods/`, `config/`, fabric server launch jar(`fabric-server-launch.jar` 또는 `fabric-server-launcher.jar`) 생성. jar 이름 기록.

- [ ] **Step 3: 서버측 모드 존재 확인**

```bash
ssh -i ~/Downloads/ssh-key-2026-07-04.key -p 22 opc@161.33.22.158 \
  'ls /home/opc/minecraft/mods | wc -l; ls /home/opc/minecraft | grep -i fabric'
```
Expected: 모드 다수, fabric 런치 jar 확인. (커밋 없음)

---

### Task 5: 서버 구성 + systemd 서비스

**Files:**
- Create(원격): `/home/opc/minecraft/eula.txt`, `/home/opc/minecraft/server.properties`(수정), `/home/opc/minecraft/start.sh`, `/etc/systemd/system/cobbleverse.service`
- Create(로컬 저장소): `server_tools/cobbleverse.service`(레퍼런스 커밋)

**Interfaces:**
- Consumes: Task 3 Java 경로, Task 4 fabric 런치 jar 이름, Task 1 RAM.
- Produces: `systemctl start cobbleverse`로 기동되는 서비스.

- [ ] **Step 1: eula 동의 + server.properties**

```bash
ssh -i ~/Downloads/ssh-key-2026-07-04.key -p 22 opc@161.33.22.158 \
  'cd /home/opc/minecraft; echo "eula=true" > eula.txt; \
   { echo "server-port=25565"; echo "online-mode=true"; echo "motd=Cobbleverse"; echo "difficulty=normal"; echo "max-players=20"; echo "level-name=world"; echo "view-distance=8"; echo "simulation-distance=6"; } > server.properties; cat server.properties'
```
Expected: 파일 생성 확인. (기존 world 백업으로 이동됐으니 새 world 생성)

- [ ] **Step 2: start.sh 작성 (RAM은 Task 1 값에 맞춤)**

RAM 여유가 8GB 이상이면 `-Xmx6G -Xms6G`, 그 미만이면 `-Xmx4G -Xms4G`. `<JAVA>`는 Task 3 경로(패키지면 `java`), `<LAUNCH_JAR>`는 Task 4 jar 이름:

```bash
ssh -i ~/Downloads/ssh-key-2026-07-04.key -p 22 opc@161.33.22.158 \
  'cat > /home/opc/minecraft/start.sh <<'"'"'EOF'"'"'
#!/usr/bin/env bash
cd /home/opc/minecraft
exec <JAVA> -Xmx6G -Xms6G \
  -XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200 \
  -XX:+UnlockExperimentalVMOptions -XX:+DisableExplicitGC \
  -XX:G1HeapRegionSize=8M -XX:G1ReservePercent=20 \
  -jar <LAUNCH_JAR> nogui
EOF
chmod +x /home/opc/minecraft/start.sh; cat /home/opc/minecraft/start.sh'
```
Expected: 실행 가능한 start.sh. `<JAVA>`/`<LAUNCH_JAR>`/RAM은 실제 값으로 치환.

- [ ] **Step 3: systemd 유닛 생성**

```bash
ssh -i ~/Downloads/ssh-key-2026-07-04.key -p 22 opc@161.33.22.158 \
  'sudo tee /etc/systemd/system/cobbleverse.service > /dev/null <<EOF
[Unit]
Description=Cobbleverse Minecraft Server
After=network.target

[Service]
Type=simple
User=opc
WorkingDirectory=/home/opc/minecraft
ExecStart=/home/opc/minecraft/start.sh
Restart=on-failure
RestartSec=10
SuccessExitStatus=0 143

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload; echo done'
```
Expected: 유닛 생성.

- [ ] **Step 4: 로컬에 레퍼런스 커밋**

Create `server_tools/cobbleverse.service` (위 유닛 내용 그대로) 로컬 저장.

```bash
git add server_tools/cobbleverse.service
git commit -m "chore: add cobbleverse systemd unit reference"
```

---

### Task 6: 서버 기동 및 접속 검증

**Files:** 없음(운영 검증).

**Interfaces:**
- Consumes: Task 5 서비스.
- Produces: 25565에서 응답, 로그에 "Done".

- [ ] **Step 1: 서비스 시작**

```bash
ssh -i ~/Downloads/ssh-key-2026-07-04.key -p 22 opc@161.33.22.158 \
  'sudo systemctl enable --now cobbleverse; sleep 5; sudo systemctl status cobbleverse --no-pager | head -8'
```
Expected: active (running).

- [ ] **Step 2: 로그로 기동 확인**

```bash
ssh -i ~/Downloads/ssh-key-2026-07-04.key -p 22 opc@161.33.22.158 \
  'sleep 60; tail -30 /home/opc/minecraft/logs/latest.log'
```
Expected: 모드 로드 완료 후 `Done (Xs)! For help, type "help"`. 크래시면 로그로 원인 파악 후 회귀.

- [ ] **Step 3: 외부 핑 확인**

로컬(macOS)에서:
```bash
nc -z -w 3 161.33.22.158 25565 && echo open || echo closed
```
Expected: `open`. `closed`면 OCI Security List/instance firewall 확인 → 인스턴스 방화벽은 `sudo firewall-cmd --add-port=25565/tcp --permanent && sudo firewall-cmd --reload`, Security List는 사용자 콘솔 조치 요청. (커밋 없음)

---

### Task 7: 데이터 스키마 디스커버리 (실데이터)

**Files:** 없음(조사). **Plan 1 런처로 접속해 테스트 플레이 필요.**

**Interfaces:**
- Produces: `cobblemonplayerdata` JSON 구조(도감 seen/caught 키), `advancements/<uuid>.json`의 Cobbleverse 배지 어드밴스먼트 네임스페이스/키. Task 8 파싱 로직의 근거.

- [ ] **Step 1: 테스트 플레이로 데이터 생성**

Plan 1 런처(또는 임의 1.21.1 Fabric+Cobbleverse 클라)로 서버 접속, 포켓몬 조우/포획·배지 관련 진행을 일부 수행해 월드에 플레이어 데이터 생성.

- [ ] **Step 2: cobblemonplayerdata 구조 확인**

```bash
ssh -i ~/Downloads/ssh-key-2026-07-04.key -p 22 opc@161.33.22.158 \
  'find /home/opc/minecraft/world -maxdepth 3 -iname "*.json" -path "*cobblemon*" | head; echo "==="; \
   F=$(find /home/opc/minecraft/world -path "*cobblemonplayerdata*" -name "*.json" | head -1); echo $F; python3 -m json.tool "$F" | head -60'
```
Expected: 도감 관련 키(예: `advancementData`, `extraData`, `pokedex`, `seen`/`caught` 카운트) 확인. 실제 키 경로 기록.

- [ ] **Step 3: 배지 어드밴스먼트 확인**

```bash
ssh -i ~/Downloads/ssh-key-2026-07-04.key -p 22 opc@161.33.22.158 \
  'F=$(ls -t /home/opc/minecraft/world/advancements/*.json | head -1); echo $F; \
   python3 -c "import json,sys; d=json.load(open(\"$F\")); print([k for k in d if \"badge\" in k.lower() or \"cobble\" in k.lower()][:40])"'
```
Expected: 배지 관련 어드밴스먼트 키 목록. 네임스페이스/패턴 기록(Task 8 필터에 사용).

- [ ] **Step 4: 스키마 확정 기록**

발견한 키 경로·네임스페이스를 Task 8 구현에 반영. (커밋 없음)

---

### Task 8: 데이터 API — `/player` 파싱 로직 (unittest)

기존 `balance_api.py`에서 경제/시즌/NBT 제거, `/downloads`·`/health` 보존, `/player` 추가. 파싱 로직은 픽스처로 테스트.

**Files:**
- Create: `server_tools/cobble_data_api.py`
- Create: `server_tools/test_cobble_data_api.py`
- Create: `server_tools/fixtures/cobblemonplayerdata.json`, `server_tools/fixtures/advancements.json` (Task 7 실데이터 축약본)
- Create: `server_tools/cobble-data-api.env.example`

**Interfaces:**
- Produces:
  - `read_pokedex(player_dir, uuid) → { caught, seen, total }`
  - `read_badges(advancements_dir, uuid, namespaces) → { count, list }`
  - `build_player_payload(server_root, uuid, name) → dict`
  - HTTP: `GET /player?uuid=&name=` (Bearer 토큰), `GET /health`, `GET /downloads/<file>`(기존 유지).

> Task 7에서 확정한 실제 키로 아래 파서의 키 경로를 맞춘다. 아래는 픽스처 기준 계약이며, 실 키가 다르면 픽스처와 파서를 함께 수정한다.

- [ ] **Step 1: 픽스처 작성 (Task 7 실데이터 축약)**

Create `server_tools/fixtures/cobblemonplayerdata.json` (예시 — 실제 구조로 대체):

```json
{ "extraData": { "cobbledex_data": { "registers": { "cobblemon:bulbasaur": { "knowledge": "CAUGHT" }, "cobblemon:charmander": { "knowledge": "SEEN" } } } } }
```

Create `server_tools/fixtures/advancements.json`:

```json
{ "cobbleverse:badges/kanto/boulder": { "done": true }, "cobbleverse:badges/kanto/cascade": { "done": false }, "minecraft:recipes/misc/x": { "done": true } }
```

- [ ] **Step 2: 실패 테스트 작성**

Create `server_tools/test_cobble_data_api.py`:

```python
import json
import unittest
from pathlib import Path

import cobble_data_api as api

FIX = Path(__file__).parent / "fixtures"


class ParsePokedex(unittest.TestCase):
    def test_counts_caught_and_seen(self):
        data = json.loads((FIX / "cobblemonplayerdata.json").read_text())
        result = api.parse_pokedex(data)
        self.assertEqual(result["caught"], 1)
        self.assertEqual(result["seen"], 2)  # caught implies seen


class ParseBadges(unittest.TestCase):
    def test_counts_done_badges_in_namespace(self):
        data = json.loads((FIX / "advancements.json").read_text())
        result = api.parse_badges(data, ["cobbleverse:badges/"])
        self.assertEqual(result["count"], 1)
        self.assertIn("cobbleverse:badges/kanto/boulder", result["list"])
        self.assertNotIn("minecraft:recipes/misc/x", result["list"])


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 3: 실패 확인**

Run: `cd server_tools && python3 -m unittest test_cobble_data_api -v`
Expected: FAIL (module/함수 없음).

- [ ] **Step 4: 파서 구현**

Create `server_tools/cobble_data_api.py` (핵심 파서 — 나머지 HTTP는 balance_api.py의 `/downloads`·`/health`·토큰·서버 골격 재사용):

```python
#!/usr/bin/env python3
import hmac
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

HOST = os.environ.get("DATA_API_HOST", "0.0.0.0")
PORT = int(os.environ.get("DATA_API_PORT", "8765"))
API_TOKEN = os.environ.get("DATA_API_TOKEN", "")
SERVER_ROOT = Path(os.environ.get("MINECRAFT_SERVER_ROOT", "/home/opc/minecraft"))
WORLD = SERVER_ROOT / os.environ.get("LEVEL_NAME", "world")
BADGE_NAMESPACES = [
    ns.strip() for ns in os.environ.get("BADGE_NAMESPACES", "cobbleverse:badges/").split(",") if ns.strip()
]
DOWNLOAD_DIR = Path(os.environ.get("LAUNCHER_DOWNLOAD_DIR", str(SERVER_ROOT / "tools" / "downloads")))


def _iter_knowledge(node):
    # Depth-first search for objects with a "knowledge" field (SEEN/CAUGHT).
    if isinstance(node, dict):
        if "knowledge" in node and isinstance(node["knowledge"], str):
            yield node["knowledge"].upper()
        for value in node.values():
            yield from _iter_knowledge(value)
    elif isinstance(node, list):
        for value in node:
            yield from _iter_knowledge(value)


def parse_pokedex(data):
    caught = 0
    seen = 0
    for knowledge in _iter_knowledge(data):
        if knowledge == "CAUGHT":
            caught += 1
            seen += 1
        elif knowledge == "SEEN":
            seen += 1
    return {"caught": caught, "seen": seen, "total": 1025}


def parse_badges(advancements, namespaces):
    earned = []
    for key, value in advancements.items():
        if any(key.startswith(ns) for ns in namespaces):
            if isinstance(value, dict) and value.get("done") is True:
                earned.append(key)
    return {"count": len(earned), "list": earned}


def _uuid_dashed(raw):
    hexs = "".join(c for c in raw.lower() if c in "0123456789abcdef")
    if len(hexs) != 32:
        return raw
    return f"{hexs[0:8]}-{hexs[8:12]}-{hexs[12:16]}-{hexs[16:20]}-{hexs[20:]}"


def _find_player_data_file(uuid):
    dashed = _uuid_dashed(uuid)
    base = WORLD / "cobblemonplayerdata"
    for candidate in (base.glob(f"*/{dashed}.json") if base.exists() else []):
        return candidate
    return None


def read_pokedex(uuid):
    path = _find_player_data_file(uuid)
    if not path or not path.is_file():
        return {"caught": 0, "seen": 0, "total": 1025}
    return parse_pokedex(json.loads(path.read_text()))


def read_badges(uuid):
    path = WORLD / "advancements" / f"{_uuid_dashed(uuid)}.json"
    if not path.is_file():
        return {"count": 0, "list": []}
    return parse_badges(json.loads(path.read_text()), BADGE_NAMESPACES)


def build_player_payload(uuid, name):
    return {"pokedex": read_pokedex(uuid), "badges": read_badges(uuid)}
```

- [ ] **Step 5: 통과 확인**

Run: `cd server_tools && python3 -m unittest test_cobble_data_api -v`
Expected: 2 passed.

> `parse_pokedex`가 Task 7 실데이터에서 오탐/누락되면 픽스처를 실데이터로 교체하고 파서(`_iter_knowledge` 키 조건)를 조정한 뒤 테스트를 다시 통과시킨다.

- [ ] **Step 6: HTTP 골격 추가**

`cobble_data_api.py`에 balance_api.py의 `Handler`(`/downloads`·`/health`·`send_json`·토큰 검증)를 재사용하되 `/balance` 대신:

```python
    def do_GET(self):
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)
        if parsed.path.startswith("/downloads/"):
            self.handle_download(parsed.path); return
        if parsed.path == "/health":
            self.send_json(200, {"ok": True}); return
        if parsed.path != "/player":
            self.send_json(404, {"error": "not_found"}); return
        if not has_token(self.headers, params):
            self.send_json(401, {"error": "unauthorized"}); return
        uuid = params.get("uuid", [""])[0]
        name = params.get("name", [""])[0]
        try:
            self.send_json(200, build_player_payload(uuid, name))
        except Exception as exc:
            self.send_json(500, {"error": "read_failed", "message": str(exc)})
```

(`has_token`, `download_file_path`, `content_type_for`, `send_json`, `send_download`, `handle_download`, `do_OPTIONS`, `do_HEAD`, `__main__` 부트스트랩은 balance_api.py에서 그대로 가져오되 `API_TOKEN`/env 이름만 `DATA_API_TOKEN`으로.)

- [ ] **Step 7: env 예시 작성**

Create `server_tools/cobble-data-api.env.example`:

```
DATA_API_HOST=0.0.0.0
DATA_API_PORT=8765
DATA_API_TOKEN=change-me-generate-random
MINECRAFT_SERVER_ROOT=/home/opc/minecraft
LEVEL_NAME=world
BADGE_NAMESPACES=cobbleverse:badges/
LAUNCHER_DOWNLOAD_DIR=/home/opc/minecraft/tools/downloads
```

- [ ] **Step 8: Commit**

```bash
git add server_tools/cobble_data_api.py server_tools/test_cobble_data_api.py \
  server_tools/fixtures/ server_tools/cobble-data-api.env.example
git commit -m "feat: add cobblemon read-only data api"
```

---

### Task 9: 데이터 API 배포 + 경제 API 제거

**Files:**
- Delete: `server_tools/balance_api.py`, `server_tools/balance-api.env.example` (경제 폐기; `/downloads` 기능은 `cobble_data_api.py`가 승계)
- Create(원격): `/etc/systemd/system/cobble-data-api.service`, `/home/opc/minecraft/tools/cobble-data-api.env`
- Create(로컬): `server_tools/cobble-data-api.service`

**Interfaces:**
- Consumes: Task 8 스크립트, Task 6 가동 서버.
- Produces: `GET http://161.33.22.158:8765/player?name=<닉>`가 도감/배지 반환. Plan 1 매니페스트 `playerData.token`에 넣을 토큰 확정.

- [ ] **Step 1: 토큰 생성 + env 배치**

```bash
TOKEN=$(openssl rand -hex 24)
ssh -i ~/Downloads/ssh-key-2026-07-04.key -p 22 opc@161.33.22.158 \
  "mkdir -p /home/opc/minecraft/tools; printf 'DATA_API_TOKEN=%s\nMINECRAFT_SERVER_ROOT=/home/opc/minecraft\nLEVEL_NAME=world\nBADGE_NAMESPACES=cobbleverse:badges/\n' '$TOKEN' > /home/opc/minecraft/tools/cobble-data-api.env; echo saved"
echo "TOKEN=$TOKEN  (Plan 1 매니페스트 playerData.token에 사용)"
```
Expected: env 저장, 토큰 출력(기록).

- [ ] **Step 2: 스크립트 업로드**

```bash
scp -i ~/Downloads/ssh-key-2026-07-04.key server_tools/cobble_data_api.py \
  opc@161.33.22.158:/home/opc/minecraft/tools/cobble_data_api.py
```
Expected: 업로드 완료.

- [ ] **Step 3: systemd 유닛**

```bash
ssh -i ~/Downloads/ssh-key-2026-07-04.key -p 22 opc@161.33.22.158 \
  'sudo tee /etc/systemd/system/cobble-data-api.service > /dev/null <<EOF
[Unit]
Description=Cobbleverse Data API
After=network.target

[Service]
Type=simple
User=opc
WorkingDirectory=/home/opc/minecraft/tools
EnvironmentFile=/home/opc/minecraft/tools/cobble-data-api.env
ExecStart=/usr/bin/python3 /home/opc/minecraft/tools/cobble_data_api.py
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload; sudo systemctl enable --now cobble-data-api; sleep 2; sudo systemctl status cobble-data-api --no-pager | head -6'
```
Expected: active (running).

- [ ] **Step 4: 엔드포인트 검증**

```bash
ssh -i ~/Downloads/ssh-key-2026-07-04.key -p 22 opc@161.33.22.158 \
  'source /home/opc/minecraft/tools/cobble-data-api.env; curl -s localhost:8765/health; echo; curl -s -H "Authorization: Bearer $DATA_API_TOKEN" "localhost:8765/player?name=<테스트닉>"'
```
Expected: `/health` → `{"ok": true}`; `/player` → `{"pokedex":{...},"badges":{...}}`. (Task 7 플레이한 닉으로 실수치 확인)

- [ ] **Step 5: 로컬 레퍼런스 + 경제 파일 제거**

```bash
git rm server_tools/balance_api.py server_tools/balance-api.env.example
# cobble-data-api.service 로컬 사본 작성 후:
git add server_tools/cobble-data-api.service
git commit -m "chore: deploy data api, remove economy api"
```

- [ ] **Step 6: 매니페스트 토큰 반영 (Plan 1 연계)**

Plan 1 Task 8의 `resources/modpack-manifest.json` `playerData`에 `"token": "<Step1 TOKEN>"` 추가 후 커밋. (또는 런처 배포 시 `PLAYER_DATA_TOKEN` 환경변수로 주입.)

---

## Self-Review

- **Spec coverage**: A1 recon(Task 1), A2 정지·백업(Task 2), A3 Java 21(Task 3), A4 mrpack-install(Task 4), A5 구성/systemd(Task 5), A6 기동·검증(Task 6), C1 디스커버리(Task 7), C2 서비스/`/player`(Task 8), C3 배포·경제 제거(Task 9) 모두 존재.
- **Placeholder scan**: `<JAVA>`/`<LAUNCH_JAR>`/`<테스트닉>`/`<minecraft-unit>` 등은 Task 1·3·4·7의 조회 결과로 치환하는 **실측 대체값**(placeholder 아님, 근거 태스크 명시). 픽스처 JSON은 Task 7 실데이터로 교체 지시 포함.
- **Type consistency**: `build_player_payload → {pokedex:{caught,seen,total}, badges:{count,list}}`가 Plan 1 Task 10의 `fetchPlayerSummary` 소비 구조와 일치. `/player` 엔드포인트·Bearer 토큰 계약이 Plan 1 `resolvePlayerDataConfig`와 일치.
- **파괴적 작업**: Task 2(정지·백업)만 파괴 가능 — 백업 이동으로 복구 가능, 실행 전 Task 1 확인·사용자 보고 명시.
