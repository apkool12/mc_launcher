# Cobbleverse `.mrpack` 전환 설계

작성일: 2026-07-17

## 목표

기존 커스텀 Cobblemon 모드팩(경제/도감/시즌/KubeJS 생태계)을 폐기하고, **공식 최신
Cobbleverse 모드팩**으로 서버와 런처를 전환한다. 클라이언트와 서버는 항상 **동일한
Cobbleverse 버전**을 사용한다.

- 서버: Oracle Cloud 인스턴스(`161.33.22.158`, user `opc`, `/home/opc/minecraft`)에
  최신 Cobbleverse Fabric 서버를 새로 구성.
- 런처: 현재의 단일 `modpack.zip` 다운로드 방식을 폐기하고, Modrinth `.mrpack`을
  받아 클라이언트에 설치하도록 변경.

## 확정 사실 (2026-07-17 조사)

| 항목 | 값 |
| --- | --- |
| 모드팩 | COBBLEVERSE - Pokemon Adventure (Modrinth project `cobbleverse`, id `Jkb29YJU`) |
| 최신 버전 | `1.7.41b` |
| Minecraft | `1.21.1` |
| 로더 | **Fabric** (NeoForge/Forge 아님) |
| 배포 형식 | `.mrpack` (Modrinth CDN 직접 다운로드) |
| mrpack URL | `https://cdn.modrinth.com/data/Jkb29YJU/versions/T9GJwPoJ/COBBLEVERSE%201.7.41b.mrpack` |
| Java | **21** (MC 1.21 이상 요구) |

> 버전을 올릴 때는 Modrinth의 새 버전 URL/해시/버전 문자열과 fabric-loader 버전만
> 매니페스트에서 교체하면 서버·클라가 함께 갱신된다. (서버는 `mrpack-install` 재실행)

## 결정된 접근

- **런처**: `.mrpack` 직접 설치. 런처가 `.mrpack`(zip)을 받아 `modrinth.index.json`을
  파싱, 각 모드를 Modrinth CDN에서 직접 다운로드하고 overrides를 적용한다. 재호스팅
  불필요. Cobbleverse는 Modrinth에 완전히 존재하므로 CurseForge API 키가 필요 없다.
- **서버**: `mrpack-install` 툴. `.mrpack` 하나로 Fabric 서버 + 서버측 모드 +
  server-overrides를 한 번에 설치한다.

### 데이터 연동 결정 (2026-07-17 추가)

경제/도감 **UI는 제거**하되, 그 자리에 아래 데이터를 표시한다:

- **서버 상태** — 마인크래프트 Server List Ping으로 접속자 수·최대 인원·MOTD.
  런처가 서버를 직접 핑하므로 **서버측 추가 코드 불필요**.
- **도감 진행률** — Cobblemon이 월드 폴더에 남기는 `cobblemonplayerdata` JSON.
- **배지 현황** — COBBLEVERSE: Badges & Trophies 모드가 어드밴스먼트
  (`<world>/advancements/<uuid>.json`)로 기록.

도감·배지는 월드 파일에만 있고 내장 HTTP API가 없으므로, 서버에 **읽기전용 데이터
API 사이드카**를 새로 둔다(Part C). 이는 기존 경제 백엔드(`balance_api.py` +
MongoDB)를 대체하며, Cobbleverse 자체는 건드리지 않고 월드 파일만 관찰한다.

**제거 대상**: 경제(잔액/돈) 기능 전체 — 런처 UI + 관련 IPC(`get-player-summary`의
balance 부분)·`fetchNumismaticsBalance`·`resolveEconomyConfig`·MongoDB 연동
코드, 그리고 기존 `server_tools/balance_api.py`. 도감/배지는 삭제가 아니라 새 API로
소스만 교체한다.

### 범위에서 제외 (YAGNI)

- 런처 내 임의 CurseForge/Modrinth 모드 **검색·개별 설치 UI**. (요청은 "Cobbleverse
  팩을 런처가 받게"로 확정됨)
- 다중 서버 간 데이터 동기화(CobbledSync 등, Redis+MongoDB 필요). 단일 서버만 대상.

## `.mrpack` 포맷 요약

`.mrpack`은 zip이며 내부에:

- `modrinth.index.json` — `formatVersion`, `name`, `versionId`, `dependencies`
  (`minecraft`, `fabric-loader`), `files[]` 배열.
  - 각 `file`: `path`(설치 상대 경로), `hashes.sha512`/`sha1`, `env.client`·`env.server`
    (`required`/`optional`/`unsupported`), `downloads[]`(CDN URL 목록), `fileSize`.
- `overrides/` — 모든 환경에 복사할 config/kubejs/datapack 등.
- `client-overrides/` — 클라이언트 전용 overrides.
- `server-overrides/` — 서버 전용 overrides.

클라이언트는 `env.client != "unsupported"`인 파일 + `overrides/` + `client-overrides/`를
설치한다. 서버는 `env.server != "unsupported"`인 파일 + `overrides/` + `server-overrides/`.

## Part A — 서버 (Oracle Cloud)

접속: `ssh -i ~/Downloads/ssh-key-2026-07-04.key -p 22 opc@161.33.22.158`

### A1. 읽기 전용 사전 점검

- OS 배포판/버전, CPU arch(`uname -m` — ARM `aarch64` 추정), 총 RAM(`free -h`).
- 설치된 Java 버전(`java -version`).
- 기존 Minecraft 프로세스/서비스(`systemctl`, `screen`/`tmux`, `ps`), `/home/opc/minecraft`
  내용, 리스닝 포트(`ss -ltnp`).
- 이 단계 결과로 RAM 할당량과 arch별 Java/mrpack-install 바이너리를 확정한다.

### A2. 기존 서버 정지 및 백업

- 기존 서버 프로세스/서비스 정지.
- `/home/opc/minecraft` → `/home/opc/minecraft.bak-2026-07-17`로 **이동**(삭제 아님).
  테스트 데이터라 폐기 가능하지만 되돌릴 여지를 남긴다.

### A3. Java 21 설치

- arch에 맞는 Temurin(Adoptium) JDK 21 설치. 배포판 패키지 또는 tarball.

### A4. Cobbleverse 서버 설치

- `mrpack-install`(arch 맞는 바이너리)로 Cobbleverse `1.7.41b`를 `/home/opc/minecraft`에
  설치. Fabric 서버 + `env.server` 지원 모드 + `server-overrides` 적용.

### A5. 서버 구성

- `eula.txt` → `eula=true`.
- `server.properties`: `server-port=25565`, `online-mode=true`, `motd`, `difficulty`,
  `max-players` 등.
- 시작 스크립트: 인스턴스 RAM에 맞춘 `-Xmx/-Xms`(Cobbleverse 권장 6GB+; A1 결과로 결정)
  + Aikar's flags.
- systemd 서비스로 등록(자동 재시작). 기존 서비스가 있으면 재사용/교체.

### A6. 기동 및 검증

- 서비스 시작, 로그로 정상 기동 확인(모드 로드 완료, "Done").
- 외부에서 25565 핑 확인(런처 상태 루프 또는 mcstatus). Security List는 기존 서버가
  이미 사용 중이라 열려 있음 — 만약 닫혀 있으면 사용자에게 콘솔 조치 요청.

## Part B — 런처

### B1. 매니페스트 (`resources/modpack-manifest.json`)

- `game`: `minecraftVersion: "1.21.1"`, `loader: "fabric"`. fabric-loader 버전은
  매니페스트에 핀하지 않는다 — `.mrpack`의 `modrinth.index.json` `dependencies`가
  단일 진실 원천이므로 **설치 시 거기서 읽는다**(아래 B4).
- `package`(zip) 섹션 제거, `mrpack` 섹션 신설:
  ```json
  "mrpack": {
    "url": "https://cdn.modrinth.com/data/Jkb29YJU/versions/T9GJwPoJ/COBBLEVERSE%201.7.41b.mrpack",
    "version": "1.7.41b",
    "sha512": "d9669e1d99db2645c6540bcab60ac0454e97a1f7c466454651a386dc0fdbf6c7aa796e8cc747707377745adaf6e085da0d57af35a350220515544aa2ffb87f81"
  }
  ```
- `economy` 섹션 제거. 대신 `playerData` 섹션 신설: 새 데이터 API의 `url`·`token`.
  ```json
  "playerData": {
    "url": "http://161.33.22.158:8765",
    "token": "<서버 API 토큰>"
  }
  ```
- `server.host`는 `161.33.22.158`, `port` 25565 유지.

### B2. `.mrpack` 동기화 (`src/main/launcher.js`)

- 신규 `syncMrpackPackage({ root, mainWindow, manifest, statePath, state, targetVersion })`:
  1. `.mrpack` 다운로드(진행률 표시) → `sha512` 검증.
  2. zip에서 `modrinth.index.json` 파싱.
  3. `files[]` 중 `env.client != "unsupported"`만 대상. 각 파일:
     - 로컬에 존재하고 해시 일치하면 스킵(델타 업데이트).
     - 아니면 `downloads[0]`에서 다운로드 → `path`에 저장 → `sha512`/`sha1` 검증.
  4. zip의 `overrides/`, `client-overrides/`를 `root`에 추출(client-overrides가 우선).
  5. 버전 변경 시: 이번 설치 파일 목록을 `.modpack-ready.json`류에 기록하고, 이전 설치
     목록과 비교해 **사라진 모드 jar를 제거**(mrpack 업데이트로 빠진 모드 정리).
- `ensureModsSynced`에서 `manifest.mrpack`이 있으면 이 경로를 사용. 기존
  `syncZipPackage`/`files[]` 경로는 유지(하위호환)하되 매니페스트가 mrpack을 우선.

### B3. Java 21 지원

- `getAdoptiumJava17Url`, `isJava17`, `resolveJava17Path`, `resolveBundledJava17Path`,
  `installWindowsJava17Runtime`, `ensureJava17Path`를 **required major(예: 21)**를 받는
  형태로 일반화.
  - Adoptium URL의 `/17/`을 파라미터화.
  - 버전 검증 정규식 `version "17\.` → `version "<major>\.`.
  - macOS `/usr/libexec/java_home -v <major>`.
- 매니페스트/게임 설정에서 요구 Java major를 도출(1.21.1 → 21). 기본값 상수 추가.

### B4. Fabric 로더

- `resolveLoaderVersionId`가 `fabric` 경로를 타도록 매니페스트 로더를 `fabric`으로.
- `.mrpack`의 `modrinth.index.json` `dependencies["fabric-loader"]`를 읽어
  `resolveFabricVersionId`에 전달, 그 버전으로 **핀 고정**한다. index.json에 값이
  없으면 최신 fabric-loader로 폴백(현재 동작). (현재는 env 또는 최신 자동 선택)

### B5. 실행

- `launch-game`에서 loader가 fabric이면 forge JVM 인자 미적용(기존 분기 그대로),
  Java 21 경로 사용, `version.custom = fabricVersionId`.

### B6. 정보 패널 재구성 (경제 제거 → 상태/도감/배지)

- **제거**: 경제(잔액) UI 요소, `fetchNumismaticsBalance`, `resolveEconomyConfig`,
  MongoDB 연동(`getMongoClient`, mongo 조회) 코드. 이들은 UI 제거로 고아가 되는 코드.
- **서버 상태(A)**: `src/main/index.js`의 `startServerStatusLoop`가 지금은 raw TCP
  연결만 확인 → **Server List Ping(핸드셰이크+Status)** 으로 확장해 접속자 수·최대
  인원·MOTD 파싱. 렌더러에 `server-status` 페이로드로 전달.
- **도감/배지(B)**: `get-player-summary` IPC를 새 데이터 API 호출로 교체.
  `{ pokedex: { caught, seen, total }, badges: { count, list } }` 반환. 렌더러 패널을
  잔액 대신 도감 진행률·배지 수 표시로 변경.

## Part C — 서버측 Cobblemon 데이터 API (읽기전용 사이드카)

기존 `server_tools/balance_api.py`를 대체하는 새 서비스. Cobbleverse 서버와 같은
호스트에서 동작하며 월드 파일만 읽는다(쓰기 없음).

### C1. 데이터 소스 (서버 가동 후 실제 스키마 확인 필요)

- 도감: `<world>/cobblemonplayerdata/<uuid[0:2]>/<uuid>.json` — seen/caught 종 목록.
- 배지: `<world>/advancements/<uuid>.json` — Cobbleverse 배지 어드밴스먼트
  (네임스페이스/키는 서버 가동 후 실데이터로 확인).
- **디스커버리 단계**: 서버 구성 후 테스트 플레이로 데이터를 만들고, 위 파일들의 실제
  JSON 구조를 확인해 파싱 로직을 확정한다. (팩 버전에 따라 키가 다를 수 있음)

### C2. 서비스

- Python(표준 라이브러리 위주, 기존 balance_api 패턴 재사용), systemd 서비스로 상주.
- 엔드포인트: `GET /player?uuid=&name=` → 위 도감/배지 JSON.
  - `Authorization: Bearer <token>` 검증(런처 매니페스트 토큰과 동일).
  - UUID↔닉네임 매핑: `usercache.json` 또는 요청의 uuid 사용.
- 포트: 기존 8765 재사용(방화벽 이미 열림 가정) 또는 신규.
- 월드 경로는 `/home/opc/minecraft/world`(server.properties `level-name` 기준).

### C3. 배포

- `server_tools/`에 새 스크립트 + `*.env.example` 추가, systemd 유닛 구성.
- 기존 `balance_api.py`/관련 유닛은 정지·제거.

## 버전 일치 보장

서버(`mrpack-install ... 1.7.41b`)와 런처(매니페스트 `mrpack.version 1.7.41b` +
동일 URL)가 같은 버전 문자열을 참조한다. 업그레이드 절차:

1. Modrinth에서 새 버전의 mrpack URL·sha512·fabric-loader 버전 확인.
2. `modpack-manifest.json`의 `mrpack.url`/`sha512`/`version`, `game.fabricLoaderVersion`
   갱신.
3. 서버에서 `mrpack-install`로 새 버전 재설치 후 재시작.

## 검증 기준

- 서버: systemd로 기동, 로그에 모드 로드 완료/"Done", 외부에서 25565 접속 가능.
- 런처: 클린 설치 디렉터리에서 실행 → Java 21 확보 → Fabric 1.21.1 설치 → Cobbleverse
  1.7.41b 모드/overrides 설치 → 게임 진입 → 서버 자동 접속 성공.
- 재실행: 변경 없으면 캐시로 스킵(재다운로드 없음). 버전 변경 시 사라진 모드 제거 확인.
- 데이터 API: 테스트 플레이로 도감/배지 데이터 생성 후 `GET /player`가 실제 수치를
  반환하고, 런처 패널에 도감 진행률·배지 수·접속자 수가 표시되는지 확인.

## 리스크 / 미해결

- **OCI Security List**: 25565이 이미 열려 있다는 가정. 닫혀 있으면 SSH만으로 해결 불가,
  사용자 콘솔 조치 필요.
- **인스턴스 RAM**: A1 점검 전까지 미확정. 6GB 미만이면 Cobbleverse 안정성 저하 가능 —
  사용자에게 보고.
- **mrpack 내 CurseForge-only 파일**: 공식 Cobbleverse mrpack은 Modrinth 호스팅만
  참조한다고 가정. 만약 `downloads`가 빈 파일(CDN 불가)이 있으면 개별 처리 필요 —
  index.json 파싱 시 확인.
- **Java 21 하위호환**: 런처가 다른(구) 모드팩을 함께 지원할 필요는 없음(전환 대상 단일).
- **배지/도감 스키마**: Cobbleverse 배지 어드밴스먼트 네임스페이스와 cobblemonplayerdata
  구조는 팩 버전에 의존. 서버 가동·테스트 플레이 전에는 확정 불가 → C1 디스커버리
  단계에서 실데이터로 파싱 로직 확정. 이 때문에 Part C는 서버(Part A) 이후에 구현.
