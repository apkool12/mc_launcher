import { Client } from 'minecraft-launcher-core'
import { Auth } from 'msmc'
import { app, ipcMain } from 'electron'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import AdmZip from 'adm-zip'
import { spawnSync } from 'child_process'
import { createRequire } from 'module'
import { parseMrpackIndex } from './mrpack.js'
import { sha512Hex, needsDownload, staleModPaths } from './mrpackSync.js'

const launcher = new Client()
const require = createRequire(import.meta.url)
let xmclInstallerPromise = null
const STATE_FILE = '.launcher-state.json'
const MODPACK_READY_FILE = '.modpack-ready.json'
const AUTH_CACHE_FILE = 'minecraft-auth-cache.json'
const DEFAULT_MC_VERSION = '1.20.1'
const DEFAULT_LOADER = 'forge'
const DEFAULT_FORGE_VERSION = '47.4.0'
const DEFAULT_SERVER_HOST = 'localhost'
const DEFAULT_SERVER_PORT = 25565
const DEFAULT_JAVA_MAJOR = 21
const FORGE_JVM_ARGS = ['--add-opens=java.base/java.lang.invoke=ALL-UNNAMED']
let remoteManifestCache = null

function getAdoptiumJavaUrl(major) {
  const arch = process.arch === 'ia32' ? 'x86' : process.arch === 'arm64' ? 'aarch64' : 'x64'
  return `https://api.adoptium.net/v3/binary/latest/${major}/ga/windows/${arch}/jre/hotspot/normal/eclipse?project=jdk`
}

function patchUndiciRequestModule(specifier) {
  try {
    const undici = require(specifier)
    if (!undici || typeof undici.request !== 'function' || undici.request.__bytemcPatched) return

    const originalRequest = undici.request
    const patchedRequest = function patchedRequest(url, options = {}, ...rest) {
      if (options && typeof options === 'object' && 'throwOnError' in options) {
        const { throwOnError, ...safeOptions } = options
        return originalRequest.call(this, url, safeOptions, ...rest)
      }
      return originalRequest.call(this, url, options, ...rest)
    }
    patchedRequest.__bytemcPatched = true
    undici.request = patchedRequest
  } catch {
    // Some package-manager layouts do not expose every nested dependency path.
  }
}

function patchUndiciCompatibility() {
  patchUndiciRequestModule('undici')

  for (const packageName of ['@xmcl/installer', '@xmcl/file-transfer']) {
    try {
      const packageRoot = path.dirname(require.resolve(`${packageName}/package.json`))
      patchUndiciRequestModule(path.join(packageRoot, 'node_modules', 'undici'))
    } catch {
      // Dependency may be hoisted.
    }
  }
}

async function getXmclInstaller() {
  if (!xmclInstallerPromise) {
    patchUndiciCompatibility()
    xmclInstallerPromise = import('@xmcl/installer')
  }
  return xmclInstallerPromise
}

function resolveArgumentValue(value, replacements) {
  if (typeof value !== 'string') return null
  return Object.entries(replacements).reduce(
    (current, [key, replacement]) => current.replaceAll(`\${${key}}`, replacement),
    value
  )
}

function collectArgumentValues(argument, replacements) {
  if (typeof argument === 'string') {
    const resolved = resolveArgumentValue(argument, replacements)
    return resolved ? [resolved] : []
  }

  if (!argument || typeof argument !== 'object') return []
  const value = argument.value
  const values = Array.isArray(value) ? value : [value]
  return values.map((entry) => resolveArgumentValue(entry, replacements)).filter(Boolean)
}

function resolveForgeJvmArgs(root, versionId) {
  const versionJsonPath = path.join(root, 'versions', versionId, `${versionId}.json`)
  const versionJson = readJsonSafe(versionJsonPath, null)
  const replacements = {
    library_directory: path.join(root, 'libraries'),
    classpath_separator: path.delimiter,
    version_name: versionId
  }
  const forgeArgs = (versionJson?.arguments?.jvm || []).flatMap((argument) =>
    collectArgumentValues(argument, replacements)
  )

  return [...forgeArgs, ...FORGE_JVM_ARGS]
}

function getDefaultLaunchDirectory() {
  return path.join(app.getPath('appData'), 'ByteMC Launcher')
}

function getJavaExecutable(javaHome) {
  if (!javaHome) return null
  const executable = process.platform === 'win32' ? 'java.exe' : 'java'
  return path.join(javaHome, 'bin', executable)
}

function isJavaMajor(javaPath, major) {
  if (!javaPath || !existsFile(javaPath)) return false
  try {
    const result = spawnSync(javaPath, ['-version'], { encoding: 'utf-8' })
    const output = `${result.stdout || ''}\n${result.stderr || ''}`
    return (
      new RegExp(`version "${major}\\.`).test(output) ||
      new RegExp(`version "${major}"`).test(output)
    )
  } catch {
    return false
  }
}

function findJavaExecutables(dirPath, depth = 0) {
  if (!dirPath || depth > 8) return []

  try {
    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) return []
    const executable = process.platform === 'win32' ? 'java.exe' : 'java'
    const entries = fs.readdirSync(dirPath, { withFileTypes: true })
    const results = []

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name)
      if (entry.isFile() && entry.name === executable) {
        results.push(fullPath)
      } else if (entry.isDirectory()) {
        results.push(...findJavaExecutables(fullPath, depth + 1))
      }
    }

    return results
  } catch {
    return []
  }
}

function collectWindowsJavaCandidates() {
  if (process.platform !== 'win32') return []

  const candidates = []
  const pathEntries = String(process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)

  for (const entry of pathEntries) {
    candidates.push(path.join(entry, 'java.exe'))
  }

  try {
    const result = spawnSync('where', ['java'], {
      encoding: 'utf-8',
      windowsHide: true
    })
    const output = `${result.stdout || ''}\n${result.stderr || ''}`
    for (const line of output.split(/\r?\n/)) {
      const candidate = line.trim()
      if (candidate.toLowerCase().endsWith('java.exe')) candidates.push(candidate)
    }
  } catch {
    // PATH scanning above still covers the common case.
  }

  const programRoots = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs') : null
  ].filter(Boolean)
  const vendors = ['Eclipse Adoptium', 'AdoptOpenJDK', 'Java', 'Microsoft', 'Zulu', 'BellSoft']

  for (const root of programRoots) {
    for (const vendor of vendors) {
      const vendorRoot = path.join(root, vendor)
      candidates.push(...findJavaExecutables(vendorRoot, 5))
    }
  }

  return [...new Set(candidates)]
}

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

function resolveBundledJavaPath(root, major) {
  const runtimeRoot = path.join(root, 'runtime', 'java-runtime-beta')
  const candidates = [
    getJavaExecutable(runtimeRoot),
    path.join(runtimeRoot, 'jre.bundle', 'Contents', 'Home', 'bin', 'java'),
    path.join(runtimeRoot, 'Contents', 'Home', 'bin', 'java'),
    ...findJavaExecutables(runtimeRoot)
  ]

  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      if (existsFile(candidate) && process.platform !== 'win32') {
        fs.chmodSync(candidate, 0o755)
      }
    } catch {
      // Continue to validation below.
    }
    if (isJavaMajor(candidate, major)) return candidate
  }

  return null
}

async function installWindowsJavaRuntime({ root, mainWindow, major }) {
  const destination = path.join(root, 'runtime', 'java-runtime-beta')
  const tempDestination = `${destination}.tmp-${Date.now()}`
  const zipUrl = getAdoptiumJavaUrl(major)

  try {
    mainWindow.webContents.send('status-update', `Java ${major} 런타임 다운로드 중...`)
    emitInstallProgress(mainWindow, 5, `Java ${major} 런타임 다운로드 시작`, 'JAVA')
    const zipBuffer = await downloadToBuffer(zipUrl, (downloadPercent) => {
      emitInstallProgress(
        mainWindow,
        5 + downloadPercent * 0.03,
        `Java ${major} 다운로드 ${Math.round(downloadPercent)}%`,
        'JAVA'
      )
    })

    mainWindow.webContents.send('status-update', `Java ${major} 런타임 압축 해제 중...`)
    emitInstallProgress(mainWindow, 8, `Java ${major} 런타임 압축 해제 중...`, 'JAVA')

    fs.rmSync(tempDestination, { recursive: true, force: true })
    fs.mkdirSync(tempDestination, { recursive: true })

    const zip = new AdmZip(zipBuffer)
    const entries = zip.getEntries()
    if (entries.length === 0) {
      throw new Error(`Java ${major} zip 파일이 비어 있습니다.`)
    }

    const totalEntries = entries.length
    for (let i = 0; i < entries.length; i += 1) {
      zip.extractEntryTo(entries[i], tempDestination, true, true)
      emitInstallProgress(
        mainWindow,
        8 + ((i + 1) / totalEntries) * 1,
        `Java ${major} 압축 해제 ${Math.round(((i + 1) / totalEntries) * 100)}%`,
        'JAVA'
      )
    }

    const javaCandidate = findJavaExecutables(tempDestination).find((candidate) =>
      isJavaMajor(candidate, major)
    )
    if (!javaCandidate) {
      throw new Error(`다운로드한 Java ${major} 런타임에서 java.exe를 찾지 못했습니다.`)
    }

    fs.rmSync(destination, { recursive: true, force: true })
    fs.renameSync(tempDestination, destination)

    const installedJava = resolveBundledJavaPath(root, major)
    if (!installedJava) {
      throw new Error(`Java ${major} 런타임 설치 후 java.exe를 찾지 못했습니다.`)
    }

    emitInstallProgress(mainWindow, 9, `Java ${major} 런타임 준비 완료`, 'JAVA')
    return installedJava
  } catch (error) {
    fs.rmSync(tempDestination, { recursive: true, force: true })
    const detail = error?.message ? ` (${error.message})` : ''
    throw new Error(`Java ${major} 런타임 설치 실패${detail}`)
  }
}

function resolveRequiredJavaMajor(mcVersion) {
  const [, minor] = String(mcVersion || '').split('.')
  return Number(minor) >= 21 ? DEFAULT_JAVA_MAJOR : 17
}

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

function normalizeAuthUuid(value) {
  return String(value || '').replace(/[^0-9a-f]/gi, '')
}

function sanitizeMclcAuth(auth) {
  if (!auth || typeof auth !== 'object') {
    throw new Error('Microsoft 로그인이 필요합니다.')
  }

  const meta = auth.meta && typeof auth.meta === 'object' ? auth.meta : {}
  const accessToken = String(auth.access_token || '')
  const uuid = normalizeAuthUuid(auth.uuid)
  const name = String(auth.name || '')

  if (!accessToken || !uuid || !name) {
    throw new Error('Minecraft 인증 정보가 올바르지 않습니다. 로그아웃 후 다시 로그인해주세요.')
  }

  return {
    access_token: accessToken,
    client_token: String(auth.client_token || crypto.randomUUID()),
    uuid,
    name,
    user_properties:
      auth.user_properties && typeof auth.user_properties === 'object' ? auth.user_properties : {},
    meta: {
      type: ['mojang', 'msa', 'legacy'].includes(meta.type) ? meta.type : 'msa',
      ...(meta.xuid ? { xuid: String(meta.xuid) } : {}),
      ...(meta.demo ? { demo: Boolean(meta.demo) } : {}),
      ...(meta.clientId ? { clientId: String(meta.clientId) } : {})
    }
  }
}

function existsFile(filePath) {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile()
  } catch {
    return false
  }
}

function isValidZipFile(filePath) {
  try {
    new AdmZip(filePath).getEntries()
    return true
  } catch {
    return false
  }
}

function getMavenArtifactPath(root, descriptor) {
  const [group, artifact, version, classifier] = String(descriptor || '').split(':')
  if (!group || !artifact || !version) return null

  const fileName = `${artifact}-${version}${classifier ? `-${classifier}` : ''}.jar`
  return path.join(root, 'libraries', ...group.split('.'), artifact, version, fileName)
}

function getLibraryDownloadInfo(root, library) {
  const artifact = library?.downloads?.artifact
  const artifactPath =
    artifact?.path ||
    (library?.name
      ? path.relative(path.join(root, 'libraries'), getMavenArtifactPath(root, library.name))
      : null)
  if (!artifactPath) return null

  const baseUrl = String(library?.url || 'https://libraries.minecraft.net/').replace(/\/?$/, '/')
  const url = artifact?.url || `${baseUrl}${artifactPath.replaceAll(path.sep, '/')}`

  return {
    path: path.join(root, 'libraries', artifactPath),
    url,
    sha1: artifact?.sha1 || ''
  }
}

function collectVersionClasspath(root, versionId, seen = new Set()) {
  if (!versionId || seen.has(versionId)) return { jars: [], libraries: [] }
  seen.add(versionId)

  const versionJsonPath = path.join(root, 'versions', versionId, `${versionId}.json`)
  const versionJson = readJsonSafe(versionJsonPath, null)
  if (!versionJson) return { jars: [], libraries: [] }

  const ownLibraries = Array.isArray(versionJson.libraries) ? versionJson.libraries : []
  const parent = versionJson.inheritsFrom
    ? collectVersionClasspath(root, versionJson.inheritsFrom, seen)
    : { jars: [], libraries: [] }

  return {
    jars: [path.join(root, 'versions', versionId, `${versionId}.jar`), ...parent.jars],
    libraries: [...ownLibraries, ...parent.libraries]
  }
}

async function repairVersionClasspath({ root, mcVersion, versionId, mainWindow }) {
  const { jars, libraries } = collectVersionClasspath(root, versionId)
  const libraryDownloads = libraries
    .map((library) => getLibraryDownloadInfo(root, library))
    .filter(Boolean)
  const candidates = [
    ...jars.map((jarPath) => ({ path: jarPath, type: 'version' })),
    ...libraryDownloads.map((library) => ({ ...library, type: 'library' }))
  ]
  const corruptEntries = []
  const seen = new Set()

  for (const candidate of candidates) {
    if (!candidate?.path || seen.has(candidate.path)) continue
    seen.add(candidate.path)
    if (!existsFile(candidate.path)) continue
    if (isValidZipFile(candidate.path)) continue

    corruptEntries.push(candidate)
    fs.rmSync(candidate.path, { force: true })
  }

  if (corruptEntries.length === 0) return

  mainWindow.webContents.send(
    'status-update',
    `손상된 Minecraft 파일 ${corruptEntries.length}개 재설치 중...`
  )
  emitInstallProgress(
    mainWindow,
    20,
    `손상된 Minecraft 파일 ${corruptEntries.length}개 재설치 중...`,
    'MINECRAFT'
  )

  await ensureMinecraftVersionInstalled({ root, mcVersion, mainWindow })

  const corruptLibraries = corruptEntries.filter((entry) => entry.type === 'library' && entry.url)
  for (let index = 0; index < corruptLibraries.length; index += 1) {
    const library = corruptLibraries[index]
    mainWindow.webContents.send(
      'status-update',
      `손상된 라이브러리 복구 중... (${index + 1}/${corruptLibraries.length})`
    )
    const buffer = await downloadToBuffer(library.url, (downloadPercent) => {
      emitInstallProgress(
        mainWindow,
        21 + ((index + downloadPercent / 100) / corruptLibraries.length) * 8,
        `손상된 라이브러리 복구 ${index + 1}/${corruptLibraries.length}`,
        'MINECRAFT'
      )
    })
    if (library.sha1) {
      const actualSha1 = crypto.createHash('sha1').update(buffer).digest('hex')
      if (actualSha1.toLowerCase() !== String(library.sha1).toLowerCase()) {
        throw new Error(`라이브러리 해시 불일치: ${path.basename(library.path)}`)
      }
    }
    fs.mkdirSync(path.dirname(library.path), { recursive: true })
    fs.writeFileSync(library.path, buffer)
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

async function resolveFabricVersionId({ root, mcVersion, mainWindow, pinnedLoader }) {
  const xmclInstaller = await getXmclInstaller()
  const statePath = path.join(root, STATE_FILE)
  const state = readJsonSafe(statePath, {})
  const cachedVersionId = state.fabricVersionId
  const cacheMatchesPin = !pinnedLoader || state.fabricLoader === pinnedLoader

  if (cachedVersionId && cacheMatchesPin) {
    const versionJsonPath = path.join(root, 'versions', cachedVersionId, `${cachedVersionId}.json`)
    if (existsFile(versionJsonPath)) {
      mainWindow.webContents.send('status-update', `Fabric 캐시 사용: ${cachedVersionId}`)
      emitInstallProgress(mainWindow, 20, `Fabric 캐시 사용: ${cachedVersionId}`, 'FABRIC')
      return cachedVersionId
    }
  }

  mainWindow.webContents.send('status-update', 'Fabric 로더 확인 중...')
  emitInstallProgress(mainWindow, 5, 'Fabric 로더 확인 중...', 'FABRIC')
  const fixedLoader = pinnedLoader || process.env.FABRIC_LOADER_VERSION
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
  const xmclInstaller = await getXmclInstaller()
  const versionJsonPath = path.join(root, 'versions', mcVersion, `${mcVersion}.json`)
  const versionJarPath = path.join(root, 'versions', mcVersion, `${mcVersion}.jar`)

  if (existsFile(versionJsonPath) && existsFile(versionJarPath) && isValidZipFile(versionJarPath)) {
    return
  }

  if (existsFile(versionJarPath) && !isValidZipFile(versionJarPath)) {
    fs.rmSync(versionJarPath, { force: true })
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
  const xmclInstaller = await getXmclInstaller()
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
    const versionJarPath = path.join(root, 'versions', cachedVersionId, `${cachedVersionId}.jar`)
    if (
      existsFile(versionJsonPath) &&
      existsFile(versionJarPath) &&
      isValidZipFile(versionJarPath)
    ) {
      mainWindow.webContents.send('status-update', `Forge 캐시 사용: ${cachedVersionId}`)
      emitInstallProgress(mainWindow, 20, `Forge 캐시 사용: ${cachedVersionId}`, 'FORGE')
      return cachedVersionId
    }
  }

  await ensureMinecraftVersionInstalled({ root, mcVersion, mainWindow })

  mainWindow.webContents.send('status-update', `Forge ${targetForge} 설치 중...`)
  emitInstallProgress(mainWindow, 10, `Forge ${targetForge} 설치 중...`, 'FORGE')

  const [forgeMcVersion, ...forgeVersionParts] = targetForge.split('-')
  const java17Path = await ensureJavaPath({ root, mainWindow, requiredMajor: 17 })
  if (java17Path) {
    mainWindow.webContents.send('status-update', `Forge ${targetForge} 설치 중... (Java 17)`)
  }
  const installResult = await xmclInstaller.installForge(
    {
      mcversion: forgeMcVersion || mcVersion,
      version: forgeVersionParts.join('-') || String(forgeVersion || DEFAULT_FORGE_VERSION)
    },
    root,
    java17Path ? { java: java17Path } : undefined
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
    const versionId = await resolveFabricVersionId({
      root,
      mcVersion,
      mainWindow,
      pinnedLoader: gameConfig.fabricLoaderVersion
    })
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
    path.join(__dirname, '../../resources/modpack-manifest.json'),
    path.join(process.cwd(), 'resources', 'modpack-manifest.json'),
    path.join(
      process.resourcesPath || '',
      'app.asar.unpacked',
      'resources',
      'modpack-manifest.json'
    ),
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'modpack-manifest.json'),
    path.join(process.resourcesPath || '', 'resources', 'modpack-manifest.json'),
    path.join(process.resourcesPath || '', 'modpack-manifest.json')
  ].filter(Boolean)

  for (const filePath of candidates) {
    const manifest = readJsonSafe(filePath, null)
    if (manifest) return manifest
  }

  return null
}

function resolveManifestUrl(bundledManifest) {
  return String(
    process.env.MODPACK_MANIFEST_URL ||
      bundledManifest?.manifestUrl ||
      bundledManifest?.updates?.manifestUrl ||
      ''
  ).trim()
}

async function fetchRemoteManifest(manifestUrl) {
  if (remoteManifestCache?.url === manifestUrl) return remoteManifestCache.manifest

  const response = await fetch(manifestUrl)
  if (!response.ok) {
    throw new Error(`매니페스트 요청 실패: ${response.status} ${response.statusText}`)
  }

  const manifest = await response.json()
  remoteManifestCache = { url: manifestUrl, manifest }
  return manifest
}

function mergeManifestDefaults(manifest, defaults) {
  if (!manifest || !defaults) return manifest
  return {
    ...defaults,
    ...manifest,
    game: { ...(defaults.game || {}), ...(manifest.game || {}) },
    server: { ...(manifest.server || {}), ...(defaults.server || {}) },
    memory: { ...(defaults.memory || {}), ...(manifest.memory || {}) },
    economy: { ...(manifest.economy || {}), ...(defaults.economy || {}) }
  }
}

async function loadModpackManifest(mainWindow, options = {}) {
  const bundledManifest = readBundledManifest()
  const manifestUrl = resolveManifestUrl(bundledManifest)
  if (!manifestUrl) {
    if (bundledManifest) {
      if (!options.silent) {
        mainWindow.webContents.send('status-update', '내장 모드 매니페스트 사용')
      }
      return bundledManifest
    }
    return null
  }

  try {
    if (!options.silent) {
      mainWindow.webContents.send('status-update', '모드 매니페스트 확인 중...')
      emitInstallProgress(mainWindow, 22, '모드 매니페스트 확인 중...', 'MODPACK')
    }
    return mergeManifestDefaults(await fetchRemoteManifest(manifestUrl), bundledManifest)
  } catch (error) {
    if (bundledManifest && options.allowFallback !== false) return bundledManifest
    throw error
  }
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
      DEFAULT_FORGE_VERSION,
    fabricLoaderVersion:
      process.env.FABRIC_LOADER_VERSION ||
      manifest?.__fabricLoaderVersion ||
      manifest?.game?.fabricLoaderVersion ||
      undefined
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
  const language = String(settings.minecraftLanguage || 'ko_kr').toLowerCase()
  const minecraftLanguage = ['ko_kr', 'en_us'].includes(language) ? language : 'ko_kr'
  upsertOptionLine(lines, 'soundCategory_master', master.toFixed(2))
  upsertOptionLine(lines, 'soundCategory_music', music.toFixed(2))
  upsertOptionLine(lines, 'lang', minecraftLanguage)

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
    !expectedZipSha &&
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

function readIndexFromMrpack(zipBuffer) {
  const zip = new AdmZip(zipBuffer)
  const entry = zip.getEntry('modrinth.index.json')
  if (!entry) throw new Error('mrpack에 modrinth.index.json이 없습니다.')
  return { zip, index: JSON.parse(zip.readAsText(entry)) }
}

function safeJoin(root, relPath) {
  const target = path.resolve(root, relPath)
  const rel = path.relative(path.resolve(root), target)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`경로가 설치 폴더를 벗어납니다: ${relPath}`)
  }
  return target
}

function extractOverrides(zip, root, folders) {
  for (const folder of folders) {
    const prefix = `${folder}/`
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory || !entry.entryName.startsWith(prefix)) continue
      const rel = entry.entryName.slice(prefix.length)
      const target = safeJoin(root, rel)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, entry.getData())
    }
  }
}

async function installExtraMods({ root, mainWindow, extraMods }) {
  const list = Array.isArray(extraMods) ? extraMods : []
  const paths = []
  for (let i = 0; i < list.length; i += 1) {
    const mod = list[i]
    if (!mod?.path || !mod?.url) continue
    const localPath = safeJoin(root, mod.path)
    let local = null
    if (existsFile(localPath)) local = sha512Hex(fs.readFileSync(localPath))
    if (needsDownload(local, mod)) {
      const buffer = await downloadToBuffer(mod.url)
      if (mod.sha512 && sha512Hex(buffer).toLowerCase() !== String(mod.sha512).toLowerCase()) {
        throw new Error(`추가 모드 해시 불일치: ${mod.path}`)
      }
      fs.mkdirSync(path.dirname(localPath), { recursive: true })
      fs.writeFileSync(localPath, buffer)
    }
    paths.push(mod.path)
    emitInstallProgress(
      mainWindow,
      80 + ((i + 1) / list.length) * 2,
      `추가 모드 설치 ${i + 1}/${list.length}`,
      'DOWNLOAD'
    )
  }
  return paths
}

async function syncMrpackPackage({ root, mainWindow, manifest, statePath, state, targetVersion }) {
  const mrpack = manifest.mrpack
  if (!mrpack?.url) throw new Error('매니페스트 형식 오류: mrpack.url 이 필요합니다.')

  const ready = readModpackReady(root)
  const extraModsList = Array.isArray(manifest.extraMods) ? manifest.extraMods : []
  const alreadyInstalled =
    ready?.mode === 'mrpack' &&
    String(ready.version || '') === targetVersion &&
    Array.isArray(ready.installedPaths) &&
    ready.installedPaths.every((p) => existsFile(path.join(root, p))) &&
    extraModsList.every((m) => m?.path && existsFile(path.join(root, m.path)))

  if (alreadyInstalled && hasJarMods(root)) {
    mainWindow.webContents.send('status-update', `모드팩 캐시 사용 (${targetVersion})`)
    emitInstallProgress(mainWindow, 70, `모드팩 캐시 사용 (${targetVersion})`, 'MODPACK')
    writeJsonSafe(statePath, { ...state, modpackVersion: targetVersion, modpackMode: 'mrpack' })
    return { fabricLoaderVersion: ready.fabricLoaderVersion || null }
  }

  mainWindow.webContents.send('status-update', 'Cobbleverse(.mrpack) 다운로드 중...')
  emitInstallProgress(mainWindow, 25, 'Cobbleverse(.mrpack) 다운로드 시작', 'DOWNLOAD')
  const mrpackBuffer = await downloadToBuffer(mrpack.url, (pct) => {
    emitInstallProgress(
      mainWindow,
      25 + pct * 0.1,
      `모드팩 인덱스 다운로드 ${Math.round(pct)}%`,
      'DOWNLOAD'
    )
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
    const localPath = safeJoin(root, file.path)
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
    emitInstallProgress(
      mainWindow,
      35 + ((i + 1) / total) * 45,
      `모드 설치 ${i + 1}/${total}`,
      'DOWNLOAD'
    )
  }

  extractOverrides(zip, root, ['overrides', 'client-overrides'])

  const extraPaths = await installExtraMods({ root, mainWindow, extraMods: manifest.extraMods })

  const nextPaths = [...parsed.files.map((f) => f.path), ...extraPaths]
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

function resolvePlayerDataConfig(manifest) {
  const cfg = manifest?.playerData || {}
  const url = String(process.env.PLAYER_DATA_URL || cfg.url || '')
    .trim()
    .replace(/\/+$/, '')
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

export function setupLauncher(mainWindow) {
  const authManager = new Auth('select_account')

  async function buildLoginResult(xboxManager) {
    const token = await xboxManager.getMinecraft()
    writeSavedAuthToken(xboxManager.save(), token.profile)
    return { success: true, profile: token.profile, mclcAuth: sanitizeMclcAuth(token.mclc()) }
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
    return fetchPlayerSummary(payload || {}, mainWindow)
  })

  // Launch Game
  ipcMain.handle('launch-game', async (event, { mclcAuth, launchRoot, settings }) => {
    try {
      emitInstallProgress(mainWindow, 1, '런처 준비 중...', 'PREPARE')
      const defaultRoot = getDefaultLaunchDirectory()
      const root = launchRoot || defaultRoot
      const authorization = sanitizeMclcAuth(mclcAuth)

      if (!fs.existsSync(root)) {
        fs.mkdirSync(root, { recursive: true })
      }

      const manifest = await ensureModsSynced({ root, mainWindow })
      const gameConfig = resolveGameConfig(manifest)
      const serverConfig = resolveServerConfig(manifest)
      const memoryConfig = resolveMemoryConfigFromSettings(manifest, settings)
      const requiredMajor = resolveRequiredJavaMajor(gameConfig.minecraftVersion)
      const javaPath = await ensureJavaPath({ root, mainWindow, requiredMajor })
      const { mcVersion, versionId, loader } = await resolveLoaderVersionId({
        root,
        gameConfig,
        mainWindow
      })
      const serverAddress = formatServerAddress(serverConfig)
      applyMinecraftOptions(root, settings)
      await repairVersionClasspath({ root, mcVersion, versionId, mainWindow })

      mainWindow.webContents.send('status-update', `Minecraft 시작 중... (${serverAddress})`)
      emitInstallProgress(mainWindow, 100, '설치 준비 완료, 게임 시작', 'LAUNCH')

      const opts = {
        authorization,
        root: root,
        ...(javaPath ? { javaPath } : {}),
        version: {
          number: mcVersion,
          type: 'release',
          custom: versionId
        },
        memory: memoryConfig,
        customArgs: loader === 'forge' ? resolveForgeJvmArgs(root, versionId) : [],
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

      launcher.removeAllListeners('debug')
      launcher.removeAllListeners('data')
      launcher.removeAllListeners('progress')
      launcher.removeAllListeners('close')
      launcher.on('debug', (e) => console.log(`[DEBUG] ${e}`))
      launcher.on('data', (e) => console.log(`[DATA] ${e}`))
      launcher.on('progress', (e) => {
        mainWindow.webContents.send('download-progress', e)
      })

      launcher.on('close', (code) => {
        mainWindow.webContents.send('game-closed', code)
      })

      await launcher.launch(opts)

      return { success: true }
    } catch (error) {
      console.error('Launch error:', error)
      const errorMessage =
        error?.message ||
        error?.stack ||
        (typeof error === 'string' ? error : '실행 중 알 수 없는 오류가 발생했습니다.')
      return { success: false, error: errorMessage }
    }
  })
}
