import { Client } from 'minecraft-launcher-core'
import { Auth } from 'msmc'
import { app, ipcMain } from 'electron'
import path from 'path'
import * as xmclInstaller from '@xmcl/installer'
import fs from 'fs'
import { MongoClient } from 'mongodb'
import crypto from 'crypto'
import AdmZip from 'adm-zip'

const launcher = new Client()
let mongoClientPromise = null
const STATE_FILE = '.launcher-state.json'
const MODPACK_READY_FILE = '.modpack-ready.json'
const AUTH_CACHE_FILE = 'minecraft-auth-cache.json'
const DEFAULT_MC_VERSION = '1.20.1'
const DEFAULT_LOADER = 'forge'
const DEFAULT_FORGE_VERSION = '47.4.0'
const DEFAULT_SERVER_HOST = 'localhost'
const DEFAULT_SERVER_PORT = 25565
const DEFAULT_BALANCE_API_URL = 'http://161.33.22.158:8765'

function getDefaultLaunchDirectory() {
  return path.join(app.getPath('appData'), 'ByteMC Launcher')
}

function emitInstallProgress(mainWindow, percent, message, stage = 'PREPARE') {
  const safePercent = Math.max(0, Math.min(100, Math.round(percent)))
  mainWindow.webContents.send('install-progress', {
    percent: safePercent,
    message,
    stage
  })
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  } catch {
    return fallback
  }
}

function writeJsonSafe(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')
}

function getAuthCachePath() {
  return path.join(app.getPath('userData'), AUTH_CACHE_FILE)
}

function readSavedAuthToken() {
  try {
    const cachePath = getAuthCachePath()
    if (!fs.existsSync(cachePath)) return null
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8'))
    return typeof cache.refreshToken === 'string' ? cache.refreshToken : null
  } catch {
    return null
  }
}

function writeSavedAuthToken(refreshToken, profile) {
  const cachePath = getAuthCachePath()
  fs.writeFileSync(
    cachePath,
    JSON.stringify(
      {
        refreshToken,
        profile,
        savedAt: new Date().toISOString()
      },
      null,
      2
    ),
    { encoding: 'utf-8', mode: 0o600 }
  )
}

function clearSavedAuthToken() {
  try {
    fs.rmSync(getAuthCachePath(), { force: true })
  } catch {
    // Ignore logout cleanup errors.
  }
}

function existsFile(filePath) {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile()
  } catch {
    return false
  }
}

function getModpackReadyPath(root) {
  return path.join(root, MODPACK_READY_FILE)
}

function readModpackReady(root) {
  return readJsonSafe(getModpackReadyPath(root), null)
}

function writeModpackReady(root, data) {
  writeJsonSafe(getModpackReadyPath(root), data)
}

function hasJarMods(root) {
  const modsDir = path.join(root, 'mods')
  try {
    if (!fs.existsSync(modsDir) || !fs.statSync(modsDir).isDirectory()) return false
    return fs.readdirSync(modsDir).some((name) => name.toLowerCase().endsWith('.jar'))
  } catch {
    return false
  }
}

function isDriveRootWindows(dirPath) {
  if (process.platform !== 'win32') return false
  const normalized = path.normalize(dirPath)
  return /^[A-Za-z]:\\?$/.test(normalized)
}

function resolveModpackExtractRoot(root, extractToRaw) {
  const rootResolved = path.resolve(root)

  if (!extractToRaw) {
    return rootResolved
  }

  const extractTo = String(extractToRaw).trim()
  if (!extractTo || extractTo === '.' || extractTo === '/' || extractTo === '\\') {
    return rootResolved
  }

  if (path.isAbsolute(extractTo)) {
    throw new Error('extractTo는 절대경로를 사용할 수 없습니다. 상대경로만 허용됩니다.')
  }

  const joined = path.resolve(path.join(rootResolved, extractTo))
  const relative = path.relative(rootResolved, joined)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('extractTo가 설치 폴더 밖으로 나가려고 합니다.')
  }

  if (isDriveRootWindows(joined)) {
    return rootResolved
  }

  return joined
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

async function resolveFabricVersionId({ root, mcVersion, mainWindow }) {
  const statePath = path.join(root, STATE_FILE)
  const state = readJsonSafe(statePath, {})
  const cachedVersionId = state.fabricVersionId

  if (cachedVersionId) {
    const versionJsonPath = path.join(root, 'versions', cachedVersionId, `${cachedVersionId}.json`)
    if (existsFile(versionJsonPath)) {
      mainWindow.webContents.send('status-update', `Fabric 캐시 사용: ${cachedVersionId}`)
      emitInstallProgress(mainWindow, 20, `Fabric 캐시 사용: ${cachedVersionId}`, 'FABRIC')
      return cachedVersionId
    }
  }

  mainWindow.webContents.send('status-update', 'Fabric 로더 확인 중...')
  emitInstallProgress(mainWindow, 5, 'Fabric 로더 확인 중...', 'FABRIC')
  const fixedLoader = process.env.FABRIC_LOADER_VERSION
  let targetLoader = fixedLoader

  if (!targetLoader) {
    const fabricLoaders = await xmclInstaller.getFabricLoaders()
    targetLoader = fabricLoaders[0].version
  }

  mainWindow.webContents.send('status-update', `Fabric ${targetLoader} 설치 중...`)
  emitInstallProgress(mainWindow, 10, `Fabric ${targetLoader} 설치 중...`, 'FABRIC')
  const fabricVersionId = await xmclInstaller.installFabric({
    minecraftVersion: mcVersion,
    version: targetLoader,
    minecraft: root
  })

  writeJsonSafe(statePath, {
    ...state,
    fabricVersionId,
    fabricLoader: targetLoader,
    minecraftVersion: mcVersion
  })
  emitInstallProgress(mainWindow, 20, `Fabric 설치 완료: ${targetLoader}`, 'FABRIC')
  return fabricVersionId
}

function normalizeForgeVersion(mcVersion, forgeVersion) {
  const rawVersion = String(forgeVersion || DEFAULT_FORGE_VERSION).trim()
  if (rawVersion.includes('-')) return rawVersion
  return `${mcVersion}-${rawVersion}`
}

async function ensureMinecraftVersionInstalled({ root, mcVersion, mainWindow }) {
  const versionJsonPath = path.join(root, 'versions', mcVersion, `${mcVersion}.json`)
  const versionJarPath = path.join(root, 'versions', mcVersion, `${mcVersion}.jar`)

  if (existsFile(versionJsonPath) && existsFile(versionJarPath)) {
    return
  }

  if (typeof xmclInstaller.getVersionList !== 'function') {
    throw new Error(
      '@xmcl/installer에서 Minecraft 버전 목록 API를 찾을 수 없습니다. 패키지를 최신 상태로 설치해주세요.'
    )
  }

  mainWindow.webContents.send('status-update', `Minecraft ${mcVersion} 파일 확인 중...`)
  emitInstallProgress(mainWindow, 8, `Minecraft ${mcVersion} 파일 확인 중...`, 'MINECRAFT')

  const versionList = await xmclInstaller.getVersionList()
  const versionMeta = versionList?.versions?.find((version) => version.id === mcVersion)
  if (!versionMeta?.url) {
    throw new Error(`Minecraft ${mcVersion} 버전 정보를 찾을 수 없습니다.`)
  }

  let versionJson = readJsonSafe(versionJsonPath, null)
  if (!versionJson) {
    mainWindow.webContents.send('status-update', `Minecraft ${mcVersion} JSON 다운로드 중...`)
    emitInstallProgress(mainWindow, 9, `Minecraft ${mcVersion} JSON 다운로드 중...`, 'MINECRAFT')
    const response = await fetch(versionMeta.url)
    if (!response.ok) {
      throw new Error(`Minecraft ${mcVersion} JSON 다운로드 실패: ${response.status}`)
    }
    versionJson = await response.json()
    fs.mkdirSync(path.dirname(versionJsonPath), { recursive: true })
    fs.writeFileSync(versionJsonPath, JSON.stringify(versionJson, null, 2), 'utf-8')
  }

  if (!existsFile(versionJarPath)) {
    const client = versionJson?.downloads?.client
    if (!client?.url) {
      throw new Error(`Minecraft ${mcVersion} client jar 다운로드 URL을 찾을 수 없습니다.`)
    }

    mainWindow.webContents.send('status-update', `Minecraft ${mcVersion} jar 다운로드 중...`)
    const jarBuffer = await downloadToBuffer(client.url, (downloadPercent) => {
      emitInstallProgress(
        mainWindow,
        9 + downloadPercent * 0.03,
        `Minecraft jar 다운로드 ${Math.round(downloadPercent)}%`,
        'MINECRAFT'
      )
    })
    const actualSha1 = crypto.createHash('sha1').update(jarBuffer).digest('hex')
    if (client.sha1 && actualSha1.toLowerCase() !== String(client.sha1).toLowerCase()) {
      throw new Error(
        `Minecraft ${mcVersion} jar 해시 불일치 (expected=${client.sha1}, actual=${actualSha1})`
      )
    }
    fs.mkdirSync(path.dirname(versionJarPath), { recursive: true })
    fs.writeFileSync(versionJarPath, jarBuffer)
  }

  emitInstallProgress(mainWindow, 12, `Minecraft ${mcVersion} 설치 완료`, 'MINECRAFT')
}

async function resolveForgeVersionId({ root, mcVersion, forgeVersion, mainWindow }) {
  if (typeof xmclInstaller.installForge !== 'function') {
    throw new Error(
      '@xmcl/installer에서 installForge를 찾을 수 없습니다. 패키지를 최신 상태로 설치해주세요.'
    )
  }

  const statePath = path.join(root, STATE_FILE)
  const state = readJsonSafe(statePath, {})
  const targetForge = normalizeForgeVersion(mcVersion, forgeVersion)
  const cachedVersionId = state.forgeVersionId

  if (cachedVersionId && state.forgeVersion === targetForge) {
    const versionJsonPath = path.join(root, 'versions', cachedVersionId, `${cachedVersionId}.json`)
    if (existsFile(versionJsonPath)) {
      mainWindow.webContents.send('status-update', `Forge 캐시 사용: ${cachedVersionId}`)
      emitInstallProgress(mainWindow, 20, `Forge 캐시 사용: ${cachedVersionId}`, 'FORGE')
      return cachedVersionId
    }
  }

  await ensureMinecraftVersionInstalled({ root, mcVersion, mainWindow })

  mainWindow.webContents.send('status-update', `Forge ${targetForge} 설치 중...`)
  emitInstallProgress(mainWindow, 10, `Forge ${targetForge} 설치 중...`, 'FORGE')

  const [forgeMcVersion, ...forgeVersionParts] = targetForge.split('-')
  const installResult = await xmclInstaller.installForge(
    {
      mcversion: forgeMcVersion || mcVersion,
      version: forgeVersionParts.join('-') || String(forgeVersion || DEFAULT_FORGE_VERSION)
    },
    root
  )
  const forgeVersionId =
    typeof installResult === 'string'
      ? installResult
      : installResult?.id ||
        installResult?.version ||
        `${mcVersion}-forge-${targetForge.split('-').at(-1)}`

  writeJsonSafe(statePath, {
    ...state,
    forgeVersionId,
    forgeVersion: targetForge,
    minecraftVersion: mcVersion,
    loader: 'forge'
  })
  emitInstallProgress(mainWindow, 20, `Forge 설치 완료: ${targetForge}`, 'FORGE')
  return forgeVersionId
}

async function resolveLoaderVersionId({ root, gameConfig, mainWindow }) {
  const mcVersion = String(gameConfig.minecraftVersion || DEFAULT_MC_VERSION)
  const loader = String(gameConfig.loader || DEFAULT_LOADER).toLowerCase()

  if (loader === 'vanilla' || loader === 'none') {
    return { mcVersion, versionId: mcVersion, loader }
  }

  if (loader === 'fabric') {
    const versionId = await resolveFabricVersionId({ root, mcVersion, mainWindow })
    return { mcVersion, versionId, loader }
  }

  if (loader === 'forge') {
    const versionId = await resolveForgeVersionId({
      root,
      mcVersion,
      forgeVersion: gameConfig.forgeVersion || gameConfig.loaderVersion,
      mainWindow
    })
    return { mcVersion, versionId, loader }
  }

  throw new Error(`지원하지 않는 로더입니다: ${loader}`)
}

function readBundledManifest() {
  const candidates = [
    process.env.MODPACK_MANIFEST_FILE,
    path.join(process.cwd(), 'resources', 'modpack-manifest.json'),
    path.join(process.resourcesPath || '', 'resources', 'modpack-manifest.json'),
    path.join(process.resourcesPath || '', 'modpack-manifest.json')
  ].filter(Boolean)

  for (const filePath of candidates) {
    const manifest = readJsonSafe(filePath, null)
    if (manifest) return manifest
  }

  return null
}

async function loadModpackManifest(mainWindow) {
  const manifestUrl = process.env.MODPACK_MANIFEST_URL
  if (!manifestUrl) {
    const bundledManifest = readBundledManifest()
    if (bundledManifest) {
      mainWindow.webContents.send('status-update', '내장 모드 매니페스트 사용')
      return bundledManifest
    }
    return null
  }

  mainWindow.webContents.send('status-update', '모드 매니페스트 확인 중...')
  emitInstallProgress(mainWindow, 22, '모드 매니페스트 확인 중...', 'MODPACK')
  const response = await fetch(manifestUrl)
  if (!response.ok) {
    throw new Error(`매니페스트 요청 실패: ${response.status} ${response.statusText}`)
  }
  return response.json()
}

function resolveGameConfig(manifest) {
  return {
    minecraftVersion:
      process.env.MINECRAFT_VERSION ||
      manifest?.game?.minecraftVersion ||
      manifest?.minecraftVersion ||
      DEFAULT_MC_VERSION,
    loader: process.env.MC_LOADER || manifest?.game?.loader || manifest?.loader || DEFAULT_LOADER,
    loaderVersion:
      process.env.MC_LOADER_VERSION ||
      manifest?.game?.loaderVersion ||
      manifest?.loaderVersion ||
      undefined,
    forgeVersion:
      process.env.FORGE_VERSION ||
      manifest?.game?.forgeVersion ||
      manifest?.forgeVersion ||
      DEFAULT_FORGE_VERSION
  }
}

function resolveServerConfig(manifest) {
  const server = manifest?.server || {}
  const host = String(
    process.env.SERVER_HOST || server.host || server.address || DEFAULT_SERVER_HOST
  ).trim()
  const port = Number(process.env.SERVER_PORT || server.port || DEFAULT_SERVER_PORT)
  const quickConnect = server.quickConnect !== false

  return {
    host,
    port: Number.isFinite(port) ? port : DEFAULT_SERVER_PORT,
    quickConnect
  }
}

function resolveMemoryConfig(manifest) {
  return {
    max: String(process.env.MC_MEMORY_MAX || manifest?.memory?.max || '4G'),
    min: String(process.env.MC_MEMORY_MIN || manifest?.memory?.min || '2G')
  }
}

function resolveMemoryConfigFromSettings(manifest, settings) {
  if (!settings) return resolveMemoryConfig(manifest)

  const minGb = Math.max(1, Math.min(12, Number(settings.memoryMinGb) || 2))
  const maxGb = Math.max(minGb, Math.min(16, Number(settings.memoryMaxGb) || 4))

  return {
    min: `${minGb}G`,
    max: `${maxGb}G`
  }
}

function formatServerAddress(server) {
  if (!server?.host) return DEFAULT_SERVER_HOST
  if (!server.port || Number(server.port) === DEFAULT_SERVER_PORT) return server.host
  return `${server.host}:${server.port}`
}

function clampPercent(value, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(0, Math.min(100, number))
}

function upsertOptionLine(lines, key, value) {
  const nextLine = `${key}:${value}`
  const index = lines.findIndex((line) => line.startsWith(`${key}:`))
  if (index >= 0) {
    lines[index] = nextLine
    return
  }
  lines.push(nextLine)
}

function applyMinecraftOptions(root, settings) {
  if (!settings) return

  const optionsPath = path.join(root, 'options.txt')
  const lines = existsFile(optionsPath)
    ? fs.readFileSync(optionsPath, 'utf-8').split(/\r?\n/).filter(Boolean)
    : []

  const master = clampPercent(settings.masterVolume, 100) / 100
  const music = clampPercent(settings.musicVolume, 30) / 100
  upsertOptionLine(lines, 'soundCategory_master', master.toFixed(2))
  upsertOptionLine(lines, 'soundCategory_music', music.toFixed(2))

  fs.writeFileSync(optionsPath, `${lines.join('\n')}\n`, 'utf-8')
}

async function downloadFile(url, targetPath) {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`다운로드 실패: ${response.status} ${response.statusText} (${url})`)
  }
  const arrayBuffer = await response.arrayBuffer()
  fs.mkdirSync(path.dirname(targetPath), { recursive: true })
  fs.writeFileSync(targetPath, Buffer.from(arrayBuffer))
}

async function downloadToBuffer(url, onProgress) {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`다운로드 실패: ${response.status} ${response.statusText} (${url})`)
  }
  const total = Number(response.headers.get('content-length') || 0)

  if (!response.body) {
    const arrayBuffer = await response.arrayBuffer()
    onProgress?.(100)
    return Buffer.from(arrayBuffer)
  }

  const reader = response.body.getReader()
  const chunks = []
  let received = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(Buffer.from(value))
    received += value.length
    if (total > 0) {
      onProgress?.((received / total) * 100)
    }
  }

  onProgress?.(100)
  return Buffer.concat(chunks)
}

async function syncZipPackage({ root, mainWindow, manifest, statePath, state, targetVersion }) {
  const pack = manifest.package
  if (!pack?.url) {
    throw new Error('매니페스트 형식 오류: package.url 이 필요합니다.')
  }

  const hashCheckDisabled =
    String(process.env.MODPACK_SKIP_HASH_CHECK || '').toLowerCase() === 'true'
  const ready = readModpackReady(root)
  const expectedZipSha = pack.sha256 ? String(pack.sha256).toLowerCase() : ''
  const readyShaOk =
    !!ready?.sha256 &&
    !!expectedZipSha &&
    String(ready.sha256).toLowerCase() === expectedZipSha &&
    String(ready.version || '') === targetVersion &&
    String(ready.url || '') === String(pack.url)

  const legacyZipCached =
    state.modpackVersion === targetVersion &&
    (state.modpackMode === 'zip' || !state.modpackMode) &&
    hasJarMods(root)

  if (readyShaOk && hasJarMods(root)) {
    mainWindow.webContents.send('status-update', `모드팩 캐시 사용 (${targetVersion})`)
    emitInstallProgress(mainWindow, 70, `모드팩 캐시 사용 (${targetVersion})`, 'MODPACK')
    writeJsonSafe(statePath, { ...state, modpackVersion: targetVersion, modpackMode: 'zip' })
    return
  }

  if (legacyZipCached) {
    mainWindow.webContents.send('status-update', `모드팩 최신 상태 유지 (${targetVersion})`)
    emitInstallProgress(mainWindow, 70, `모드팩 최신 상태 유지 (${targetVersion})`, 'MODPACK')
    writeJsonSafe(statePath, { ...state, modpackVersion: targetVersion, modpackMode: 'zip' })
    if (!readyShaOk && expectedZipSha) {
      writeModpackReady(root, {
        version: targetVersion,
        url: String(pack.url),
        sha256: expectedZipSha,
        size: Number(pack.size || 0),
        updatedAt: new Date().toISOString()
      })
    }
    return
  }

  mainWindow.webContents.send('status-update', '모드팩(zip) 다운로드 중...')
  emitInstallProgress(mainWindow, 25, '모드팩(zip) 다운로드 시작', 'DOWNLOAD')
  const zipBuffer = await downloadToBuffer(pack.url, (downloadPercent) => {
    emitInstallProgress(
      mainWindow,
      25 + downloadPercent * 0.45,
      `모드팩 다운로드 ${Math.round(downloadPercent)}%`,
      'DOWNLOAD'
    )
  })

  const actualZipSha = crypto.createHash('sha256').update(zipBuffer).digest('hex')

  if (pack.sha256) {
    const expectedHash = String(pack.sha256).toLowerCase()
    if (!hashCheckDisabled && actualZipSha.toLowerCase() !== expectedHash) {
      throw new Error(
        `모드팩 zip 해시 불일치 (expected=${expectedHash}, actual=${actualZipSha}). ` +
          'modpack-manifest.json을 zip 재업로드 후 다시 생성하세요.'
      )
    }
  }

  const extractRoot = resolveModpackExtractRoot(root, pack.extractTo)
  if (extractRoot !== path.resolve(root)) {
    fs.mkdirSync(extractRoot, { recursive: true })
  }

  mainWindow.webContents.send('status-update', '모드팩(zip) 압축 해제 중...')
  const zip = new AdmZip(zipBuffer)
  const entries = zip.getEntries()
  const totalEntries = entries.length || 1
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]
    zip.extractEntryTo(entry, extractRoot, true, true)
    const extractPercent = ((i + 1) / totalEntries) * 100
    emitInstallProgress(
      mainWindow,
      70 + extractPercent * 0.25,
      `모드팩 압축 해제 ${Math.round(extractPercent)}%`,
      'EXTRACT'
    )
  }

  writeJsonSafe(statePath, {
    ...state,
    modpackVersion: targetVersion,
    modpackMode: 'zip'
  })
  writeModpackReady(root, {
    version: targetVersion,
    url: String(pack.url),
    sha256: String(pack.sha256 || actualZipSha).toLowerCase(),
    size: Number(pack.size || zipBuffer.length || 0),
    updatedAt: new Date().toISOString()
  })
  mainWindow.webContents.send('status-update', '모드팩(zip) 업데이트 완료')
  emitInstallProgress(mainWindow, 95, '모드팩(zip) 업데이트 완료', 'MODPACK')
}

async function ensureModsSynced({ root, mainWindow }) {
  const manifest = await loadModpackManifest(mainWindow)
  if (!manifest) {
    mainWindow.webContents.send('status-update', '모드 매니페스트 미설정: 기존 mods 사용')
    emitInstallProgress(mainWindow, 70, '모드 매니페스트 미설정: 기존 mods 사용', 'MODPACK')
    return null
  }

  const statePath = path.join(root, STATE_FILE)
  const state = readJsonSafe(statePath, {})
  const currentVersion = state.modpackVersion
  const targetVersion = String(manifest.version || '0')

  if (manifest.package) {
    await syncZipPackage({
      root,
      mainWindow,
      manifest,
      statePath,
      state,
      targetVersion
    })
    return manifest
  }

  if (!Array.isArray(manifest.files)) {
    throw new Error('매니페스트 형식 오류: files 배열이 필요합니다.')
  }

  if (currentVersion === targetVersion) {
    const allPresent = manifest.files.every((file) => existsFile(path.join(root, file.path)))
    if (allPresent) {
      mainWindow.webContents.send('status-update', `모드 최신 상태 유지 (${targetVersion})`)
      emitInstallProgress(mainWindow, 95, `모드 최신 상태 유지 (${targetVersion})`, 'MODPACK')
      return manifest
    }
  }

  const updates = []
  for (const file of manifest.files) {
    const localPath = path.join(root, file.path)
    let shouldDownload = !existsFile(localPath)

    if (!shouldDownload && file.sha256) {
      const localHash = await sha256File(localPath)
      shouldDownload = localHash.toLowerCase() !== String(file.sha256).toLowerCase()
    }

    if (shouldDownload) updates.push(file)
  }

  if (updates.length === 0) {
    mainWindow.webContents.send('status-update', '모드 파일 검증 완료 (변경 없음)')
    writeJsonSafe(statePath, { ...state, modpackVersion: targetVersion })
    return manifest
  }

  for (let i = 0; i < updates.length; i += 1) {
    const file = updates[i]
    const updatePercent = ((i + 1) / updates.length) * 100
    mainWindow.webContents.send(
      'status-update',
      `모드 업데이트 ${i + 1}/${updates.length}: ${file.path}`
    )
    emitInstallProgress(
      mainWindow,
      25 + updatePercent * 0.7,
      `모드 업데이트 ${i + 1}/${updates.length}`,
      'DOWNLOAD'
    )
    await downloadFile(file.url, path.join(root, file.path))
  }

  writeJsonSafe(statePath, { ...state, modpackVersion: targetVersion })
  mainWindow.webContents.send('status-update', `모드 업데이트 완료 (${updates.length}개)`)
  emitInstallProgress(mainWindow, 95, `모드 업데이트 완료 (${updates.length}개)`, 'MODPACK')
  return manifest
}

function parseBadges(value) {
  if (Array.isArray(value)) return value.length
  if (value && typeof value === 'object') {
    return Object.values(value).filter(Boolean).length
  }
  return 0
}

function resolveEconomyConfig() {
  const manifest = readBundledManifest()
  const economy = manifest?.economy || {}
  const balanceApiUrl = String(
    process.env.BALANCE_API_URL || economy.balanceApiUrl || economy.url || DEFAULT_BALANCE_API_URL
  ).trim()
  const token = String(process.env.BALANCE_API_TOKEN || economy.token || '').trim()

  return {
    enabled: economy.enabled !== false && Boolean(balanceApiUrl),
    balanceApiUrl: balanceApiUrl.replace(/\/+$/, ''),
    token
  }
}

function normalizePlayerUuid(value) {
  const raw = String(value || '')
    .toLowerCase()
    .replace(/[^0-9a-f]/g, '')
  if (raw.length !== 32) return value
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(
    16,
    20
  )}-${raw.slice(20)}`
}

async function fetchNumismaticsBalance({ uuid, nickname }) {
  const economy = resolveEconomyConfig()
  if (!economy.enabled) return { enabled: false, balance: null }

  const params = new URLSearchParams()
  if (uuid) params.set('uuid', normalizePlayerUuid(uuid))
  if (nickname) params.set('name', nickname)
  if (!uuid && !nickname) return { enabled: false, balance: null }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 2500)

  try {
    const response = await fetch(`${economy.balanceApiUrl}/balance?${params.toString()}`, {
      signal: controller.signal,
      headers: economy.token ? { Authorization: `Bearer ${economy.token}` } : {}
    })

    if (response.status === 404) {
      const payload = await response.json().catch(() => ({}))
      return { enabled: true, balance: 0, season: payload.season || null }
    }
    if (!response.ok) return { enabled: false, balance: null }
    const payload = await response.json()
    const balance = Number(payload.balance)
    return {
      enabled: true,
      balance: Number.isFinite(balance) ? balance : 0,
      season: payload.season || null
    }
  } catch (error) {
    console.error('Balance API error:', error)
    return { enabled: false, balance: null, season: null }
  } finally {
    clearTimeout(timeout)
  }
}

async function getMongoClient() {
  const mongoUri = process.env.MONGO_URI
  if (!mongoUri) return null

  if (!mongoClientPromise) {
    const client = new MongoClient(mongoUri)
    mongoClientPromise = client.connect()
  }

  return mongoClientPromise
}

async function fetchPlayerSummary({ uuid, nickname }) {
  const balanceResult = await fetchNumismaticsBalance({ uuid, nickname })
  const balance = balanceResult.balance
  const season = balanceResult.season

  try {
    const client = await getMongoClient()
    if (!client) {
      return {
        enabled: balanceResult.enabled,
        balance,
        season,
        badgesCount: 0,
        ownedSpeciesCount: 0
      }
    }

    const dbName = process.env.MONGO_DB || 'cobblemon'
    const db = client.db(dbName)

    const keys = []
    if (uuid) keys.push({ uuid })
    if (nickname) keys.push({ nickname })
    if (nickname) keys.push({ playerName: nickname })

    const query = keys.length > 0 ? { $or: keys } : {}

    const progressDoc = await db.collection('player_progress').findOne(query)
    const pokedexDoc = await db.collection('player_pokedex').findOne(query)

    const badgesCount = parseBadges(progressDoc?.badges)
    const ownedSpeciesRaw =
      pokedexDoc?.ownedSpecies ??
      pokedexDoc?.ownedPokemon ??
      progressDoc?.ownedSpecies ??
      progressDoc?.ownedPokemon
    const ownedSpeciesCount = Array.isArray(ownedSpeciesRaw) ? ownedSpeciesRaw.length : 0

    return {
      enabled: true,
      balance,
      season,
      badgesCount,
      ownedSpeciesCount
    }
  } catch (error) {
    console.error('Mongo summary error:', error)
    return {
      enabled: balanceResult.enabled,
      balance,
      season,
      badgesCount: 0,
      ownedSpeciesCount: 0,
      error: error.message
    }
  }
}

export function setupLauncher(mainWindow) {
  const authManager = new Auth('select_account')

  async function buildLoginResult(xboxManager) {
    const token = await xboxManager.getMinecraft()
    writeSavedAuthToken(xboxManager.save(), token.profile)
    return { success: true, profile: token.profile, mclcAuth: token.mclc() }
  }

  ipcMain.handle('restore-login', async () => {
    try {
      const savedToken = readSavedAuthToken()
      if (!savedToken) return { success: false, needsLogin: true }

      const xboxManager = await authManager.refresh(savedToken)
      return buildLoginResult(xboxManager)
    } catch (error) {
      console.error('Restore login error:', error)
      clearSavedAuthToken()
      return { success: false, needsLogin: true, error: error.message }
    }
  })

  // Microsoft Login
  ipcMain.handle('ms-login', async () => {
    try {
      const xboxManager = await authManager.launch('electron')
      return buildLoginResult(xboxManager)
    } catch (error) {
      console.error('Login error:', error)
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('logout', async () => {
    clearSavedAuthToken()
    return { success: true }
  })

  ipcMain.handle('get-player-summary', async (_, payload) => {
    return fetchPlayerSummary(payload || {})
  })

  // Launch Game
  ipcMain.handle('launch-game', async (event, { mclcAuth, launchRoot, settings }) => {
    try {
      emitInstallProgress(mainWindow, 1, '런처 준비 중...', 'PREPARE')
      const defaultRoot = getDefaultLaunchDirectory()
      const root = launchRoot || defaultRoot

      if (!fs.existsSync(root)) {
        fs.mkdirSync(root, { recursive: true })
      }

      const manifest = await ensureModsSynced({ root, mainWindow })
      const gameConfig = resolveGameConfig(manifest)
      const serverConfig = resolveServerConfig(manifest)
      const memoryConfig = resolveMemoryConfigFromSettings(manifest, settings)
      const { mcVersion, versionId, loader } = await resolveLoaderVersionId({
        root,
        gameConfig,
        mainWindow
      })
      const serverAddress = formatServerAddress(serverConfig)
      applyMinecraftOptions(root, settings)

      mainWindow.webContents.send('status-update', `Minecraft 시작 중... (${serverAddress})`)
      emitInstallProgress(mainWindow, 100, '설치 준비 완료, 게임 시작', 'LAUNCH')

      const opts = {
        authorization: mclcAuth,
        root: root,
        version: {
          number: mcVersion,
          type: 'release',
          custom: versionId
        },
        memory: memoryConfig,
        quickPlay:
          serverConfig.quickConnect && settings?.autoConnect !== false
            ? {
                type: 'multiplayer',
                identifier: serverAddress
              }
            : undefined
      }

      mainWindow.webContents.send(
        'status-update',
        `${mcVersion} / ${loader} 실행, 서버 접속: ${serverAddress}`
      )

      launcher.launch(opts)

      launcher.on('debug', (e) => console.log(`[DEBUG] ${e}`))
      launcher.on('data', (e) => console.log(`[DATA] ${e}`))
      launcher.on('progress', (e) => {
        mainWindow.webContents.send('download-progress', e)
      })

      launcher.on('close', (code) => {
        mainWindow.webContents.send('game-closed', code)
      })

      return { success: true }
    } catch (error) {
      console.error('Launch error:', error)
      return { success: false, error: error.message }
    }
  })
}
