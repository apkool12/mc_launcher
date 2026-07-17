# 런처 Cobbleverse `.mrpack` 전환 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 런처가 기존 `modpack.zip` 대신 Modrinth `.mrpack`(Cobbleverse 1.7.41b, Fabric/MC 1.21.1)을 받아 설치하고, Java 21을 확보하며, 정보 패널을 경제 대신 서버상태·도감·배지로 재구성한다.

**Architecture:** mrpack index 파싱·서버 핑 패킷·설치 파일 diff 같은 순수 로직은 `src/main/`의 작은 전용 모듈로 분리해 vitest로 단위 테스트한다. Electron/네트워크 결합부(`launcher.js`, `index.js`, 렌더러)는 이 모듈들을 배선하고 `npm run dev`로 수동 검증한다.

**Tech Stack:** Electron + electron-vite, `@xmcl/installer`(Fabric 설치·Java 런타임), `adm-zip`(mrpack 압축 해제), Node `net`(서버 핑), vitest(신규 devDependency, 순수 로직 테스트).

## Global Constraints

- 대상 팩: COBBLEVERSE `1.7.41b` / Minecraft `1.21.1` / **Fabric** / `.mrpack`.
- mrpack URL: `https://cdn.modrinth.com/data/Jkb29YJU/versions/T9GJwPoJ/COBBLEVERSE%201.7.41b.mrpack`
- mrpack sha512: `d9669e1d99db2645c6540bcab60ac0454e97a1f7c466454651a386dc0fdbf6c7aa796e8cc747707377745adaf6e085da0d57af35a350220515544aa2ffb87f81`
- Java 요구 major: **21** (MC 1.21+). fabric-loader 버전은 매니페스트에 핀하지 않고 `modrinth.index.json`의 `dependencies["fabric-loader"]`에서 읽는다.
- 서버: `161.33.22.158:25565` 유지. 데이터 API: `http://161.33.22.158:8765` (`/player` 엔드포인트, Plan 2에서 구축).
- 코드 스타일: 기존 파일 컨벤션(2-space, 세미콜론 없음, single quote) 유지. 주석 최소.
- 수술적 변경: 경제(잔액) 제거로 고아가 되는 코드만 제거. 사전 존재하던 무관한 코드는 건드리지 않는다.

---

### Task 1: vitest 테스트 하네스 추가

**Files:**
- Modify: `package.json` (scripts, devDependencies)
- Create: `vitest.config.mjs`
- Create: `test/smoke.test.js`

**Interfaces:**
- Produces: `npm test` 실행 가능, `test/**/*.test.js`를 node 환경에서 구동.

- [ ] **Step 1: vitest 설치**

Run: `npm install -D vitest`
Expected: `package.json` devDependencies에 `vitest` 추가.

- [ ] **Step 2: vitest config 작성**

Create `vitest.config.mjs`:

```js
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.js']
  }
})
```

- [ ] **Step 3: test 스크립트 추가**

`package.json`의 `scripts`에 추가:

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 4: 스모크 테스트 작성**

Create `test/smoke.test.js`:

```js
import { describe, it, expect } from 'vitest'

describe('harness', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2)
  })
})
```

- [ ] **Step 5: 테스트 실행**

Run: `npm test`
Expected: 1 passed.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json vitest.config.mjs test/smoke.test.js
git commit -m "test: add vitest harness"
```

---

### Task 2: mrpack index 파서 (`src/main/mrpack.js`)

`modrinth.index.json`을 받아 설치할 파일 목록·로더 정보를 뽑는 순수 함수. 사이드(`client`/`server`)로 필터링.

**Files:**
- Create: `src/main/mrpack.js`
- Test: `test/mrpack.test.js`

**Interfaces:**
- Produces:
  - `parseMrpackIndex(index, side = 'client')` →
    `{ minecraft: string, loader: 'fabric'|'forge'|'neoforge'|'quilt'|null, loaderVersion: string|null, files: Array<{ path, downloads: string[], sha512: string|null, sha1: string|null, size: number }> }`
  - side가 `'client'`이면 `file.env.client === 'unsupported'` 제외, `'server'`이면 `file.env.server === 'unsupported'` 제외. `env` 없으면 포함.

- [ ] **Step 1: 실패 테스트 작성**

Create `test/mrpack.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { parseMrpackIndex } from '../src/main/mrpack.js'

const sample = {
  formatVersion: 1,
  dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.16.9' },
  files: [
    {
      path: 'mods/cobblemon.jar',
      hashes: { sha512: 'aaa', sha1: 'bbb' },
      downloads: ['https://cdn.modrinth.com/x.jar'],
      fileSize: 10,
      env: { client: 'required', server: 'required' }
    },
    {
      path: 'mods/iris.jar',
      hashes: { sha512: 'ccc', sha1: 'ddd' },
      downloads: ['https://cdn.modrinth.com/iris.jar'],
      fileSize: 20,
      env: { client: 'required', server: 'unsupported' }
    }
  ]
}

describe('parseMrpackIndex', () => {
  it('reads loader and minecraft version', () => {
    const r = parseMrpackIndex(sample, 'client')
    expect(r.minecraft).toBe('1.21.1')
    expect(r.loader).toBe('fabric')
    expect(r.loaderVersion).toBe('0.16.9')
  })

  it('includes client files', () => {
    const r = parseMrpackIndex(sample, 'client')
    expect(r.files.map((f) => f.path)).toEqual(['mods/cobblemon.jar', 'mods/iris.jar'])
    expect(r.files[0].sha512).toBe('aaa')
    expect(r.files[0].downloads[0]).toBe('https://cdn.modrinth.com/x.jar')
  })

  it('excludes server-unsupported files on server side', () => {
    const r = parseMrpackIndex(sample, 'server')
    expect(r.files.map((f) => f.path)).toEqual(['mods/cobblemon.jar'])
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -- mrpack`
Expected: FAIL ("Cannot find module '../src/main/mrpack.js'").

- [ ] **Step 3: 구현**

Create `src/main/mrpack.js`:

```js
const LOADER_KEYS = {
  'fabric-loader': 'fabric',
  'quilt-loader': 'quilt',
  forge: 'forge',
  neoforge: 'neoforge'
}

export function parseMrpackIndex(index, side = 'client') {
  const deps = index?.dependencies || {}
  let loader = null
  let loaderVersion = null
  for (const [key, name] of Object.entries(LOADER_KEYS)) {
    if (deps[key]) {
      loader = name
      loaderVersion = String(deps[key])
      break
    }
  }

  const files = (Array.isArray(index?.files) ? index.files : [])
    .filter((file) => file?.path && Array.isArray(file.downloads) && file.downloads.length > 0)
    .filter((file) => (file.env?.[side] || 'required') !== 'unsupported')
    .map((file) => ({
      path: String(file.path),
      downloads: file.downloads.map(String),
      sha512: file.hashes?.sha512 ? String(file.hashes.sha512) : null,
      sha1: file.hashes?.sha1 ? String(file.hashes.sha1) : null,
      size: Number(file.fileSize || 0)
    }))

  return {
    minecraft: String(deps.minecraft || ''),
    loader,
    loaderVersion,
    files
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -- mrpack`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add src/main/mrpack.js test/mrpack.test.js
git commit -m "feat: add mrpack index parser"
```

---

### Task 3: 서버 핑 패킷 인코딩/파싱 (`src/main/serverPing.js`)

Minecraft Server List Ping의 VarInt·핸드셰이크/스테이터스 패킷 빌더(순수)와, 이를 쓰는 `pingServer`(소켓) 분리.

**Files:**
- Create: `src/main/serverPing.js`
- Test: `test/serverPing.test.js`

**Interfaces:**
- Produces:
  - `encodeVarInt(value: number) → Buffer`
  - `decodeVarInt(buf: Buffer, offset = 0) → { value: number, size: number }`
  - `buildHandshakePacket(host, port, protocol = 767) → Buffer` (packet id 0x00, next-state 1)
  - `buildStatusRequestPacket() → Buffer` (packet id 0x00)
  - `parseStatusResponse(json) → { online: true, players: { online, max }, motd: string }`
  - `pingServer(host, port, timeoutMs = 2000) → Promise<{ online, players?, motd? }>` (소켓, 실패 시 `{ online: false }`)

- [ ] **Step 1: 실패 테스트 작성**

Create `test/serverPing.test.js`:

```js
import { describe, it, expect } from 'vitest'
import {
  encodeVarInt,
  decodeVarInt,
  buildHandshakePacket,
  parseStatusResponse
} from '../src/main/serverPing.js'

describe('varint', () => {
  it('roundtrips small and multibyte values', () => {
    for (const n of [0, 1, 127, 128, 255, 25565, 2097151]) {
      const buf = encodeVarInt(n)
      expect(decodeVarInt(buf, 0)).toEqual({ value: n, size: buf.length })
    }
  })
})

describe('handshake packet', () => {
  it('is length-prefixed and contains host', () => {
    const pkt = buildHandshakePacket('example.com', 25565, 767)
    const { value: len, size } = decodeVarInt(pkt, 0)
    expect(len).toBe(pkt.length - size)
    expect(pkt.includes(Buffer.from('example.com'))).toBe(true)
  })
})

describe('parseStatusResponse', () => {
  it('extracts players and motd', () => {
    const r = parseStatusResponse({
      players: { online: 3, max: 20 },
      description: { text: 'Hello' }
    })
    expect(r).toEqual({ online: true, players: { online: 3, max: 20 }, motd: 'Hello' })
  })

  it('flattens description string form', () => {
    const r = parseStatusResponse({ players: { online: 0, max: 10 }, description: 'Plain' })
    expect(r.motd).toBe('Plain')
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -- serverPing`
Expected: FAIL (module not found).

- [ ] **Step 3: 구현**

Create `src/main/serverPing.js`:

```js
import net from 'net'

export function encodeVarInt(value) {
  const bytes = []
  let v = value >>> 0
  do {
    let temp = v & 0x7f
    v >>>= 7
    if (v !== 0) temp |= 0x80
    bytes.push(temp)
  } while (v !== 0)
  return Buffer.from(bytes)
}

export function decodeVarInt(buf, offset = 0) {
  let value = 0
  let size = 0
  let byte
  do {
    byte = buf[offset + size]
    value |= (byte & 0x7f) << (7 * size)
    size += 1
    if (size > 5) throw new Error('VarInt too long')
  } while ((byte & 0x80) !== 0)
  return { value: value >>> 0, size }
}

function withLength(payload) {
  return Buffer.concat([encodeVarInt(payload.length), payload])
}

function encodeString(str) {
  const buf = Buffer.from(str, 'utf-8')
  return Buffer.concat([encodeVarInt(buf.length), buf])
}

export function buildHandshakePacket(host, port, protocol = 767) {
  const payload = Buffer.concat([
    encodeVarInt(0x00),
    encodeVarInt(protocol),
    encodeString(host),
    Buffer.from([(port >> 8) & 0xff, port & 0xff]),
    encodeVarInt(1)
  ])
  return withLength(payload)
}

export function buildStatusRequestPacket() {
  return withLength(encodeVarInt(0x00))
}

function flattenDescription(description) {
  if (typeof description === 'string') return description
  if (!description || typeof description !== 'object') return ''
  let text = String(description.text || '')
  if (Array.isArray(description.extra)) {
    text += description.extra.map(flattenDescription).join('')
  }
  return text
}

export function parseStatusResponse(json) {
  return {
    online: true,
    players: {
      online: Number(json?.players?.online || 0),
      max: Number(json?.players?.max || 0)
    },
    motd: flattenDescription(json?.description).trim()
  }
}

export function pingServer(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let buffer = Buffer.alloc(0)
    const done = (result) => {
      socket.destroy()
      resolve(result)
    }

    socket.setTimeout(timeoutMs)
    socket.on('timeout', () => done({ online: false }))
    socket.on('error', () => done({ online: false }))

    socket.connect(port, host, () => {
      socket.write(buildHandshakePacket(host, port))
      socket.write(buildStatusRequestPacket())
    })

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      try {
        const { value: pktLen, size: lenSize } = decodeVarInt(buffer, 0)
        if (buffer.length < lenSize + pktLen) return
        let cursor = lenSize
        const idRead = decodeVarInt(buffer, cursor)
        cursor += idRead.size
        const strLen = decodeVarInt(buffer, cursor)
        cursor += strLen.size
        if (buffer.length < cursor + strLen.value) return
        const jsonStr = buffer.slice(cursor, cursor + strLen.value).toString('utf-8')
        done(parseStatusResponse(JSON.parse(jsonStr)))
      } catch {
        // Wait for more data; if the stream is malformed, timeout/error path resolves.
      }
    })
  })
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -- serverPing`
Expected: all passed.

- [ ] **Step 5: Commit**

```bash
git add src/main/serverPing.js test/serverPing.test.js
git commit -m "feat: add minecraft server list ping"
```

---

### Task 4: 설치 파일 diff 유틸 (`src/main/mrpackSync.js`)

이미 올바른 해시로 존재하는 파일은 스킵하고, 이전 설치 목록 대비 사라진 mod jar을 정리하는 순수 로직.

**Files:**
- Create: `src/main/mrpackSync.js`
- Test: `test/mrpackSync.test.js`

**Interfaces:**
- Consumes: Task 2 `files` 배열 형태.
- Produces:
  - `sha512Hex(buffer) → string`
  - `needsDownload(localHashHex, file) → boolean` (파일에 sha512 있으면 비교, 없으면 sha1 무시하고 존재만으로 판단은 호출측 담당 → 여기선 해시 불일치 여부만)
  - `staleModPaths(previousPaths: string[], nextPaths: string[]) → string[]` (`mods/`로 시작하고 next에 없는 previous 경로)

- [ ] **Step 1: 실패 테스트 작성**

Create `test/mrpackSync.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { sha512Hex, needsDownload, staleModPaths } from '../src/main/mrpackSync.js'

describe('sha512Hex', () => {
  it('hashes buffer', () => {
    expect(sha512Hex(Buffer.from('abc'))).toMatch(/^ddaf35a1/)
  })
})

describe('needsDownload', () => {
  it('true when sha512 mismatches', () => {
    expect(needsDownload('deadbeef', { sha512: 'cafef00d' })).toBe(true)
  })
  it('false when sha512 matches (case-insensitive)', () => {
    expect(needsDownload('CAFEF00D', { sha512: 'cafef00d' })).toBe(false)
  })
  it('true when no local hash', () => {
    expect(needsDownload(null, { sha512: 'cafef00d' })).toBe(true)
  })
})

describe('staleModPaths', () => {
  it('returns removed mod jars only', () => {
    const prev = ['mods/a.jar', 'mods/b.jar', 'config/x.toml']
    const next = ['mods/a.jar']
    expect(staleModPaths(prev, next)).toEqual(['mods/b.jar'])
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -- mrpackSync`
Expected: FAIL (module not found).

- [ ] **Step 3: 구현**

Create `src/main/mrpackSync.js`:

```js
import crypto from 'crypto'

export function sha512Hex(buffer) {
  return crypto.createHash('sha512').update(buffer).digest('hex')
}

export function needsDownload(localHashHex, file) {
  if (!file?.sha512) return !localHashHex
  if (!localHashHex) return true
  return localHashHex.toLowerCase() !== String(file.sha512).toLowerCase()
}

export function staleModPaths(previousPaths, nextPaths) {
  const next = new Set(nextPaths)
  return previousPaths.filter(
    (p) => p.startsWith('mods/') && p.toLowerCase().endsWith('.jar') && !next.has(p)
  )
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -- mrpackSync`
Expected: all passed.

- [ ] **Step 5: Commit**

```bash
git add src/main/mrpackSync.js test/mrpackSync.test.js
git commit -m "feat: add mrpack sync diff utils"
```

---

### Task 5: Java 요구 major 파라미터화 (Java 21 지원)

`launcher.js`의 Java 17 하드코딩을 `requiredMajor` 파라미터로 일반화.

**Files:**
- Modify: `src/main/launcher.js` (Java 관련 함수군)

**Interfaces:**
- Consumes: 없음.
- Produces: `ensureJavaPath({ root, mainWindow, requiredMajor })`; 내부 헬퍼 `getAdoptiumJavaUrl(major)`, `isJavaMajor(javaPath, major)`, `resolveSystemJavaPath(major)`, `resolveBundledJavaPath(root, major)`, `installWindowsJavaRuntime({ root, mainWindow, major })`.

- [ ] **Step 1: Adoptium URL 파라미터화**

`launcher.js`에서 `getAdoptiumJava17Url`을 다음으로 교체:

```js
function getAdoptiumJavaUrl(major) {
  const arch =
    process.arch === 'ia32' ? 'x86' : process.arch === 'arm64' ? 'aarch64' : 'x64'
  return `https://api.adoptium.net/v3/binary/latest/${major}/ga/windows/${arch}/jre/hotspot/normal/eclipse?project=jdk`
}
```

- [ ] **Step 2: 버전 검증 파라미터화**

`isJava17`을 교체:

```js
function isJavaMajor(javaPath, major) {
  if (!javaPath || !existsFile(javaPath)) return false
  try {
    const result = spawnSync(javaPath, ['-version'], { encoding: 'utf-8' })
    const output = `${result.stdout || ''}\n${result.stderr || ''}`
    return new RegExp(`version "${major}\\.`).test(output) ||
      new RegExp(`version "${major}"`).test(output)
  } catch {
    return false
  }
}
```

- [ ] **Step 3: 시스템/번들 탐색 파라미터화**

`resolveJava17Path` → `resolveSystemJavaPath(major)`, `resolveBundledJava17Path` → `resolveBundledJavaPath(root, major)`로 이름과 시그니처 변경. 내부의 `isJava17(x)` 호출을 `isJavaMajor(x, major)`로, macOS `java_home -v 17`을 `-v ${major}`로, 환경변수는 `JAVA_${major}_HOME`/`JDK_${major}_HOME`도 함께 조회하도록 수정:

```js
function resolveSystemJavaPath(major) {
  const candidates = [
    getJavaExecutable(process.env[`JAVA_${major}_HOME`]),
    getJavaExecutable(process.env[`JDK_${major}_HOME`]),
    getJavaExecutable(process.env.JAVA_HOME),
    ...collectWindowsJavaCandidates()
  ].filter(Boolean)

  if (process.platform === 'darwin') {
    try {
      const javaHome = spawnSync('/usr/libexec/java_home', ['-v', String(major)], {
        encoding: 'utf-8'
      }).stdout.trim()
      candidates.unshift(getJavaExecutable(javaHome))
    } catch {
      // Continue with generic candidates.
    }
  }

  return candidates.find((candidate) => isJavaMajor(candidate, major)) || null
}
```

`resolveBundledJavaPath(root, major)`는 기존 본문에서 `isJava17(candidate)` → `isJavaMajor(candidate, major)`로만 교체(경로는 동일 `runtime/java-runtime-beta`).

- [ ] **Step 4: Windows 런타임 설치 파라미터화**

`installWindowsJava17Runtime` → `installWindowsJavaRuntime({ root, mainWindow, major })`: `getAdoptiumJava17Url()` → `getAdoptiumJavaUrl(major)`, 내부 `resolveBundledJava17Path(root)` → `resolveBundledJavaPath(root, major)`, `findJavaExecutables(...).find((c) => isJava17(c))` → `isJavaMajor(c, major)`, 사용자 메시지 "Java 17" → `Java ${major}`.

- [ ] **Step 5: ensure 함수 파라미터화**

`ensureJava17Path({ root, mainWindow })` → `ensureJavaPath({ root, mainWindow, requiredMajor })`. 본문의 `resolveJava17Path()` → `resolveSystemJavaPath(requiredMajor)`, `resolveBundledJava17Path(root)` → `resolveBundledJavaPath(root, requiredMajor)`, Windows 분기 `installWindowsJava17Runtime({ root, mainWindow })` → `installWindowsJavaRuntime({ root, mainWindow, major: requiredMajor })`, 비-Windows xmcl 분기의 `installJavaRuntimeTask` target을 major에 맞춰: MC 1.21은 `JavaRuntimeTargetType.Delta`가 아닌 최신을 요구하므로 `fetchJavaRuntimeManifest({ target: 'java-runtime-delta' })` 대신 major 기반 선택은 xmcl이 제공하지 않음 → **비-Windows/비-macOS에서 시스템 Java 21이 없으면 명확한 에러**로 안내:

```js
async function ensureJavaPath({ root, mainWindow, requiredMajor }) {
  const systemJava = resolveSystemJavaPath(requiredMajor)
  if (systemJava) {
    mainWindow.webContents.send('status-update', `설치된 Java ${requiredMajor} 사용`)
    emitInstallProgress(mainWindow, 9, `설치된 Java ${requiredMajor} 사용`, 'JAVA')
    return systemJava
  }

  const bundledJava = resolveBundledJavaPath(root, requiredMajor)
  if (bundledJava) {
    mainWindow.webContents.send('status-update', `런처 Java ${requiredMajor} 캐시 사용`)
    emitInstallProgress(mainWindow, 9, `런처 Java ${requiredMajor} 캐시 사용`, 'JAVA')
    return bundledJava
  }

  if (process.platform === 'win32') {
    return installWindowsJavaRuntime({ root, mainWindow, major: requiredMajor })
  }

  throw new Error(
    `Java ${requiredMajor}이(가) 필요합니다. Java ${requiredMajor}을 설치한 뒤 다시 실행해주세요.`
  )
}
```

- [ ] **Step 6: 호출부 갱신**

`launch-game` 핸들러의 `ensureJava17Path({ root, mainWindow })` 두 곳(Forge 설치용 `resolveForgeVersionId` 내부 포함) 확인. Forge 경로는 이번 전환에서 미사용이지만 코드 유지 → `resolveForgeVersionId` 내부의 `ensureJava17Path`는 `ensureJavaPath({ root, mainWindow, requiredMajor: 17 })`로 교체(포지 하위호환). `launch-game`의 Java 확보는 Task 8에서 `requiredMajor`를 게임 설정에서 도출해 전달.

- [ ] **Step 7: 빌드 확인**

Run: `npm run build`
Expected: 빌드 성공(타입/문법 에러 없음).

- [ ] **Step 8: Commit**

```bash
git add src/main/launcher.js
git commit -m "refactor: parameterize java runtime resolution by major version"
```

---

### Task 6: `syncMrpackPackage` 배선 (launcher.js)

Task 2·4 모듈을 써서 mrpack을 실제로 다운로드·설치.

**Files:**
- Modify: `src/main/launcher.js` (`ensureModsSynced`에 mrpack 분기 추가, `syncMrpackPackage` 신설, import 추가)

**Interfaces:**
- Consumes: `parseMrpackIndex` (Task 2), `sha512Hex`/`needsDownload`/`staleModPaths` (Task 4).
- Produces: `syncMrpackPackage({ root, mainWindow, manifest, statePath, state, targetVersion }) → { fabricLoaderVersion: string|null }`; `.modpack-ready.json`에 `{ mode: 'mrpack', version, installedPaths, fabricLoaderVersion }` 기록.

- [ ] **Step 1: import 추가**

`launcher.js` 상단 import 구역에:

```js
import { parseMrpackIndex } from './mrpack.js'
import { sha512Hex, needsDownload, staleModPaths } from './mrpackSync.js'
```

- [ ] **Step 2: `syncMrpackPackage` 구현**

`ensureModsSynced` 위에 추가:

```js
function readIndexFromMrpack(zipBuffer) {
  const zip = new AdmZip(zipBuffer)
  const entry = zip.getEntry('modrinth.index.json')
  if (!entry) throw new Error('mrpack에 modrinth.index.json이 없습니다.')
  return { zip, index: JSON.parse(zip.readAsText(entry)) }
}

function extractOverrides(zip, root, folders) {
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue
    for (const folder of folders) {
      const prefix = `${folder}/`
      if (entry.entryName.startsWith(prefix)) {
        const rel = entry.entryName.slice(prefix.length)
        const target = path.join(root, rel)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, entry.getData())
      }
    }
  }
}

async function syncMrpackPackage({ root, mainWindow, manifest, statePath, state, targetVersion }) {
  const mrpack = manifest.mrpack
  if (!mrpack?.url) throw new Error('매니페스트 형식 오류: mrpack.url 이 필요합니다.')

  const ready = readModpackReady(root)
  const alreadyInstalled =
    ready?.mode === 'mrpack' &&
    String(ready.version || '') === targetVersion &&
    Array.isArray(ready.installedPaths) &&
    ready.installedPaths.every((p) => existsFile(path.join(root, p)))

  if (alreadyInstalled && hasJarMods(root)) {
    mainWindow.webContents.send('status-update', `모드팩 캐시 사용 (${targetVersion})`)
    emitInstallProgress(mainWindow, 70, `모드팩 캐시 사용 (${targetVersion})`, 'MODPACK')
    writeJsonSafe(statePath, { ...state, modpackVersion: targetVersion, modpackMode: 'mrpack' })
    return { fabricLoaderVersion: ready.fabricLoaderVersion || null }
  }

  mainWindow.webContents.send('status-update', 'Cobbleverse(.mrpack) 다운로드 중...')
  emitInstallProgress(mainWindow, 25, 'Cobbleverse(.mrpack) 다운로드 시작', 'DOWNLOAD')
  const mrpackBuffer = await downloadToBuffer(mrpack.url, (pct) => {
    emitInstallProgress(mainWindow, 25 + pct * 0.1, `모드팩 인덱스 다운로드 ${Math.round(pct)}%`, 'DOWNLOAD')
  })
  if (mrpack.sha512) {
    const actual = sha512Hex(mrpackBuffer)
    if (actual.toLowerCase() !== String(mrpack.sha512).toLowerCase()) {
      throw new Error(`mrpack sha512 불일치 (expected=${mrpack.sha512}, actual=${actual})`)
    }
  }

  const { zip, index } = readIndexFromMrpack(mrpackBuffer)
  const parsed = parseMrpackIndex(index, 'client')

  const total = parsed.files.length || 1
  for (let i = 0; i < parsed.files.length; i += 1) {
    const file = parsed.files[i]
    const localPath = path.join(root, file.path)
    let local = null
    if (existsFile(localPath)) local = sha512Hex(fs.readFileSync(localPath))
    if (needsDownload(local, file)) {
      const buffer = await downloadToBuffer(file.downloads[0])
      if (file.sha512 && sha512Hex(buffer).toLowerCase() !== file.sha512.toLowerCase()) {
        throw new Error(`모드 해시 불일치: ${file.path}`)
      }
      fs.mkdirSync(path.dirname(localPath), { recursive: true })
      fs.writeFileSync(localPath, buffer)
    }
    emitInstallProgress(mainWindow, 35 + ((i + 1) / total) * 45, `모드 설치 ${i + 1}/${total}`, 'DOWNLOAD')
  }

  extractOverrides(zip, root, ['overrides', 'client-overrides'])

  const nextPaths = parsed.files.map((f) => f.path)
  const removed = staleModPaths(ready?.installedPaths || [], nextPaths)
  for (const rel of removed) fs.rmSync(path.join(root, rel), { force: true })

  writeJsonSafe(statePath, { ...state, modpackVersion: targetVersion, modpackMode: 'mrpack' })
  writeModpackReady(root, {
    mode: 'mrpack',
    version: targetVersion,
    url: String(mrpack.url),
    installedPaths: nextPaths,
    fabricLoaderVersion: parsed.loaderVersion,
    updatedAt: new Date().toISOString()
  })
  emitInstallProgress(mainWindow, 82, '모드팩(.mrpack) 설치 완료', 'MODPACK')
  return { fabricLoaderVersion: parsed.loaderVersion }
}
```

- [ ] **Step 3: `ensureModsSynced`에 분기 추가**

`ensureModsSynced` 내 `if (manifest.package) { ... }` **앞**에 추가:

```js
if (manifest.mrpack) {
  const { fabricLoaderVersion } = await syncMrpackPackage({
    root,
    mainWindow,
    manifest,
    statePath,
    state,
    targetVersion
  })
  return { ...manifest, __fabricLoaderVersion: fabricLoaderVersion }
}
```

- [ ] **Step 4: 빌드 확인**

Run: `npm run build`
Expected: 성공.

- [ ] **Step 5: Commit**

```bash
git add src/main/launcher.js
git commit -m "feat: install cobbleverse from mrpack"
```

---

### Task 7: Fabric 로더 핀 + 로더 라우팅

mrpack이 준 fabric-loader 버전으로 Fabric 설치.

**Files:**
- Modify: `src/main/launcher.js` (`resolveFabricVersionId`, `resolveLoaderVersionId`)

**Interfaces:**
- Consumes: `manifest.__fabricLoaderVersion` (Task 6).
- Produces: `resolveLoaderVersionId`가 `gameConfig.fabricLoaderVersion`을 우선 사용.

- [ ] **Step 1: `resolveFabricVersionId`에 핀 인자 추가**

시그니처를 `resolveFabricVersionId({ root, mcVersion, mainWindow, pinnedLoader })`로 바꾸고, 로더 선택부를:

```js
const fixedLoader = pinnedLoader || process.env.FABRIC_LOADER_VERSION
let targetLoader = fixedLoader
if (!targetLoader) {
  const fabricLoaders = await xmclInstaller.getFabricLoaders()
  targetLoader = fabricLoaders[0].version
}
```

- [ ] **Step 2: `resolveLoaderVersionId`에서 핀 전달**

fabric 분기를:

```js
if (loader === 'fabric') {
  const versionId = await resolveFabricVersionId({
    root,
    mcVersion,
    mainWindow,
    pinnedLoader: gameConfig.fabricLoaderVersion
  })
  return { mcVersion, versionId, loader }
}
```

`resolveGameConfig`에 `fabricLoaderVersion` 추가:

```js
fabricLoaderVersion:
  process.env.FABRIC_LOADER_VERSION ||
  manifest?.__fabricLoaderVersion ||
  manifest?.game?.fabricLoaderVersion ||
  undefined,
```

- [ ] **Step 3: 빌드 확인**

Run: `npm run build`
Expected: 성공.

- [ ] **Step 4: Commit**

```bash
git add src/main/launcher.js
git commit -m "feat: pin fabric loader from mrpack index"
```

---

### Task 8: 매니페스트 전환 + Java major 배선

**Files:**
- Modify: `resources/modpack-manifest.json`
- Modify: `src/main/launcher.js` (`launch-game`에서 requiredMajor 도출, DEFAULT 상수)

**Interfaces:**
- Consumes: `ensureJavaPath` (Task 5), mrpack 동기화 (Task 6).

- [ ] **Step 1: 매니페스트 교체**

`resources/modpack-manifest.json`을 다음으로:

```json
{
  "version": "cobbleverse-1.7.41b",
  "generatedAt": "2026-07-17T00:00:00.000Z",
  "game": {
    "minecraftVersion": "1.21.1",
    "loader": "fabric"
  },
  "server": {
    "host": "161.33.22.158",
    "port": 25565,
    "quickConnect": true
  },
  "memory": {
    "min": "4G",
    "max": "6G"
  },
  "mrpack": {
    "url": "https://cdn.modrinth.com/data/Jkb29YJU/versions/T9GJwPoJ/COBBLEVERSE%201.7.41b.mrpack",
    "version": "1.7.41b",
    "sha512": "d9669e1d99db2645c6540bcab60ac0454e97a1f7c466454651a386dc0fdbf6c7aa796e8cc747707377745adaf6e085da0d57af35a350220515544aa2ffb87f81"
  },
  "playerData": {
    "url": "http://161.33.22.158:8765"
  }
}
```

> `manifestUrl`은 제거(원격 GitHub 매니페스트 대신 내장 사용). `economy`/`package` 섹션 제거. `playerData.token`은 Plan 2에서 서버 토큰 확정 후 추가.

- [ ] **Step 2: requiredMajor 도출 상수/헬퍼 추가**

`launcher.js`에 상수/함수 추가:

```js
const DEFAULT_JAVA_MAJOR = 21

function resolveRequiredJavaMajor(mcVersion) {
  const [, minor] = String(mcVersion || '').split('.')
  return Number(minor) >= 21 ? 21 : 17
}
```

- [ ] **Step 3: `launch-game`에서 major 전달**

`launch-game` 핸들러에서 Java 확보 호출을 `mcVersion` 확정 이후로 옮기고:

```js
const requiredMajor = resolveRequiredJavaMajor(gameConfig.minecraftVersion)
const javaPath = await ensureJavaPath({ root, mainWindow, requiredMajor })
```

(기존 `const java17Path = await ensureJava17Path(...)` 라인을 대체. 이후 `java17Path` 사용처를 `javaPath`로 rename.)

- [ ] **Step 4: 빌드 확인**

Run: `npm run build`
Expected: 성공.

- [ ] **Step 5: Commit**

```bash
git add resources/modpack-manifest.json src/main/launcher.js
git commit -m "feat: switch manifest to cobbleverse mrpack and java 21"
```

---

### Task 9: 서버 상태 패널(핑) 배선

**Files:**
- Modify: `src/main/index.js` (`startServerStatusLoop`가 `pingServer` 사용)
- Modify: `src/renderer/src/renderer.js` (서버 상태 표시에 접속자 수·MOTD)

**Interfaces:**
- Consumes: `pingServer` (Task 3).
- Produces: IPC `server-status` 페이로드가 `{ online, players, motd }` 객체.

- [ ] **Step 1: index.js import + 루프 교체**

`src/main/index.js`에 `import { pingServer } from './serverPing.js'` 추가하고, `startServerStatusLoop`의 `checkStatus`를:

```js
const checkStatus = async () => {
  const serverConfig = getServerConfig()
  const result = await pingServer(serverConfig.host, serverConfig.port, 1500)
  window.webContents.send('server-status', result)
}
```

(기존 `net.Socket` 직접 사용 블록 제거. 파일 상단 `import net from 'net'`가 다른 곳에서 안 쓰이면 제거 — Task의 orphan 정리.)

- [ ] **Step 2: 렌더러 표시 갱신**

`src/renderer/src/renderer.js`에서 `server-status` 수신 핸들러가 boolean을 기대하던 부분을 객체로: `payload.online`으로 온라인 판정, 온라인이면 `payload.players.online/payload.players.max`와 `payload.motd`를 상태 영역에 표시. (기존 DOM 요소 재사용; 새 요소가 필요하면 상태 텍스트에 `접속자 N/M` 추가.)

- [ ] **Step 3: 수동 검증**

Run: `npm run dev`
Expected: 앱 실행 후 서버 상태 영역에 온/오프라인과 접속자 수 표시(서버가 떠 있으면 실제 인원). Plan 2 서버 가동 전이면 오프라인 표시.

- [ ] **Step 4: Commit**

```bash
git add src/main/index.js src/renderer/src/renderer.js
git commit -m "feat: show player count and motd via server ping"
```

---

### Task 10: 경제 제거 + 도감/배지 API 연동

**Files:**
- Modify: `src/main/launcher.js` (`get-player-summary` 재작성, 경제/Mongo 제거)
- Modify: `src/renderer/src/renderer.js` (패널 라벨: 잔액 → 도감/배지)
- Modify: `package.json` (mongodb 의존성 제거)

**Interfaces:**
- Consumes: 데이터 API `GET /player?uuid=&name=` → `{ pokedex: { caught, seen, total }, badges: { count, list } }` (Plan 2에서 제공).
- Produces: IPC `get-player-summary` → `{ enabled, pokedex, badges }`.

- [ ] **Step 1: 경제/Mongo 코드 제거**

`launcher.js`에서 다음 삭제: `import { MongoClient } from 'mongodb'`, `mongoClientPromise`, `getMongoClient`, `fetchNumismaticsBalance`, `resolveEconomyConfig`, `parseBadges`, `normalizePlayerUuid`(아래서 재사용 안 하면), `DEFAULT_BALANCE_API_URL`. `fetchPlayerSummary`를 재작성:

```js
function resolvePlayerDataConfig(manifest) {
  const cfg = manifest?.playerData || {}
  const url = String(process.env.PLAYER_DATA_URL || cfg.url || '').trim().replace(/\/+$/, '')
  const token = String(process.env.PLAYER_DATA_TOKEN || cfg.token || '').trim()
  return { enabled: Boolean(url), url, token }
}

async function fetchPlayerSummary({ uuid, nickname }, mainWindow) {
  const manifest = await loadModpackManifest(mainWindow, { silent: true }).catch(() =>
    readBundledManifest()
  )
  const cfg = resolvePlayerDataConfig(manifest)
  if (!cfg.enabled) return { enabled: false, pokedex: null, badges: null }

  const params = new URLSearchParams()
  if (uuid) params.set('uuid', uuid)
  if (nickname) params.set('name', nickname)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 2500)
  try {
    const response = await fetch(`${cfg.url}/player?${params.toString()}`, {
      signal: controller.signal,
      headers: cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}
    })
    if (!response.ok) return { enabled: true, pokedex: null, badges: null }
    const payload = await response.json()
    return {
      enabled: true,
      pokedex: payload.pokedex || null,
      badges: payload.badges || null
    }
  } catch (error) {
    console.error('Player data API error:', error)
    return { enabled: false, pokedex: null, badges: null }
  } finally {
    clearTimeout(timeout)
  }
}
```

`get-player-summary` IPC 핸들러는 그대로 `fetchPlayerSummary(payload, mainWindow)` 반환.

- [ ] **Step 2: 렌더러 패널 라벨 교체**

`renderer.js`에서 잔액/시즌 표시를 제거하고 `pokedex.caught/total`, `badges.count`를 표시. (`get-player-summary` 응답 구조 변경에 맞춤.)

- [ ] **Step 3: mongodb 의존성 제거**

Run: `npm uninstall mongodb`
Expected: `package.json`에서 mongodb 제거.

- [ ] **Step 4: 빌드 + 수동 검증**

Run: `npm run build`
Expected: 성공(잔여 mongodb import 없음).
Run: `npm run dev` → 로그인 후 패널이 도감/배지 영역을 보여줌(데이터 API 없으면 비활성/빈 값).

- [ ] **Step 5: Commit**

```bash
git add src/main/launcher.js src/renderer/src/renderer.js package.json package-lock.json
git commit -m "feat: replace economy panel with pokedex and badges"
```

---

### Task 11: 통합 수동 검증 (clean install)

**Files:** 없음(검증 전용). Plan 2 서버가 먼저 가동돼 있어야 전체 흐름 확인 가능.

- [ ] **Step 1: 클린 디렉터리 지정**

임시 설치 폴더를 새로 만들고 런처 설정에서 설치 위치로 지정(또는 `MC_*` 환경변수).

- [ ] **Step 2: 실행**

Run: `npm run dev` → 로그인 → 실행.
Expected(순서): Java 21 확보 → Fabric(1.21.1, 핀 로더) 설치 → mrpack 다운로드·검증 → 클라 모드/overrides 설치 → 게임 진입 → `161.33.22.158:25565` 자동 접속.

- [ ] **Step 3: 재실행 캐시 확인**

다시 실행 → 모드 재다운로드 없이 "모드팩 캐시 사용" 로그, 빠른 진입.

- [ ] **Step 4: 검증 노트 기록**

`docs/superpowers/plans/`에 결과를 남기지 말고, 이슈 발견 시 해당 Task로 회귀.

---

## Self-Review

- **Spec coverage**: B1 매니페스트(Task 8), B2 mrpack 동기화(Task 2·4·6), B3 Java 21(Task 5·8), B4 Fabric 핀(Task 7), B5 실행(Task 8·11), B6 패널(Task 9·10) 모두 태스크 존재.
- **Placeholder scan**: `playerData.token`은 Plan 2 산출물(서버 토큰)로 의도된 후속 값 — 계획상 명시됨. 그 외 TODO 없음.
- **Type consistency**: `parseMrpackIndex`의 `files[].sha512`를 `needsDownload`/`syncMrpackPackage`가 동일 키로 사용. `pingServer` 반환 `{ online, players, motd }`를 index.js·renderer가 동일하게 소비. `ensureJavaPath({ requiredMajor })` 시그니처 Task 5 정의 = Task 8 호출 일치.
