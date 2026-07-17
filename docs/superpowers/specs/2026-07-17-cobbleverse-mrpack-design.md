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

### 범위에서 제외 (YAGNI)

- 런처 내 임의 CurseForge/Modrinth 모드 **검색·개별 설치 UI**. (요청은 "Cobbleverse
  팩을 런처가 받게"로 확정됨)
- 경제/도감 백엔드(`balance_api.py`, MongoDB) 유지. Cobbleverse엔 대응 백엔드가 없다.
  코드는 삭제하지 않고 매니페스트에서 비활성화만 한다.

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
- `economy.enabled: false` (백엔드 없음).
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

## 리스크 / 미해결

- **OCI Security List**: 25565이 이미 열려 있다는 가정. 닫혀 있으면 SSH만으로 해결 불가,
  사용자 콘솔 조치 필요.
- **인스턴스 RAM**: A1 점검 전까지 미확정. 6GB 미만이면 Cobbleverse 안정성 저하 가능 —
  사용자에게 보고.
- **mrpack 내 CurseForge-only 파일**: 공식 Cobbleverse mrpack은 Modrinth 호스팅만
  참조한다고 가정. 만약 `downloads`가 빈 파일(CDN 불가)이 있으면 개별 처리 필요 —
  index.json 파싱 시 확인.
- **Java 21 하위호환**: 런처가 다른(구) 모드팩을 함께 지원할 필요는 없음(전환 대상 단일).
