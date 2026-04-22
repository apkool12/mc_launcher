import { Client } from 'minecraft-launcher-core'
import { Auth } from 'msmc'
import { ipcMain } from 'electron'
import path from 'path'
import { installFabric, getFabricLoaders } from '@xmcl/installer'
import fs from 'fs'
import { MongoClient } from 'mongodb'
import crypto from 'crypto'
import AdmZip from 'adm-zip'

const launcher = new Client()
let mongoClientPromise = null
const STATE_FILE = '.launcher-state.json'
const MODPACK_READY_FILE = '.modpack-ready.json'

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
    const fabricLoaders = await getFabricLoaders()
    targetLoader = fabricLoaders[0].version
  }

  mainWindow.webContents.send('status-update', `Fabric ${targetLoader} 설치 중...`)
  emitInstallProgress(mainWindow, 10, `Fabric ${targetLoader} 설치 중...`, 'FABRIC')
  const fabricVersionId = await installFabric({
    minecraftVersion: mcVersion,
    version: targetLoader,
    minecraft: root
  })

  writeJsonSafe(statePath, { ...state, fabricVersionId, fabricLoader: targetLoader, minecraftVersion: mcVersion })
  emitInstallProgress(mainWindow, 20, `Fabric 설치 완료: ${targetLoader}`, 'FABRIC')
  return fabricVersionId
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

  const hashCheckDisabled = String(process.env.MODPACK_SKIP_HASH_CHECK || '').toLowerCase() === 'true'
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
  const manifestUrl = process.env.MODPACK_MANIFEST_URL
  if (!manifestUrl) {
    mainWindow.webContents.send('status-update', '모드 매니페스트 미설정: 기존 mods 사용')
    emitInstallProgress(mainWindow, 70, '모드 매니페스트 미설정: 기존 mods 사용', 'MODPACK')
    return
  }

  mainWindow.webContents.send('status-update', '모드 매니페스트 확인 중...')
  emitInstallProgress(mainWindow, 22, '모드 매니페스트 확인 중...', 'MODPACK')
  const response = await fetch(manifestUrl)
  if (!response.ok) {
    throw new Error(`매니페스트 요청 실패: ${response.status} ${response.statusText}`)
  }
  const manifest = await response.json()

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
    return
  }

  if (!Array.isArray(manifest.files)) {
    throw new Error('매니페스트 형식 오류: files 배열이 필요합니다.')
  }

  if (currentVersion === targetVersion) {
    const allPresent = manifest.files.every((file) => existsFile(path.join(root, file.path)))
    if (allPresent) {
      mainWindow.webContents.send('status-update', `모드 최신 상태 유지 (${targetVersion})`)
      emitInstallProgress(mainWindow, 95, `모드 최신 상태 유지 (${targetVersion})`, 'MODPACK')
      return
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
    return
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
}

function parseBadges(value) {
  if (Array.isArray(value)) return value.length
  if (value && typeof value === 'object') {
    return Object.values(value).filter(Boolean).length
  }
  return 0
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
  try {
    const client = await getMongoClient()
    if (!client) {
      return {
        enabled: false,
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
      badgesCount,
      ownedSpeciesCount
    }
  } catch (error) {
    console.error('Mongo summary error:', error)
    return {
      enabled: false,
      badgesCount: 0,
      ownedSpeciesCount: 0,
      error: error.message
    }
  }
}

export function setupLauncher(mainWindow) {
  const authManager = new Auth('select_account')

  // Microsoft Login
  ipcMain.handle('ms-login', async () => {
    try {
      const xboxManager = await authManager.launch('electron')
      const token = await xboxManager.getMinecraft()
      // token.mclc() provides the authorization object needed by MCLC
      return { success: true, profile: token.profile, mclcAuth: token.mclc() }
    } catch (error) {
      console.error('Login error:', error)
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('get-player-summary', async (_, payload) => {
    return fetchPlayerSummary(payload || {})
  })

  // Launch Game
  ipcMain.handle('launch-game', async (event, { mclcAuth, launchRoot }) => {
    try {
      emitInstallProgress(mainWindow, 1, '런처 준비 중...', 'PREPARE')
      const defaultRoot = path.join(
        process.env.APPDATA ||
          (process.platform === 'darwin'
            ? path.join(process.env.HOME, 'Library/Application Support')
            : process.env.HOME),
        'mc-launcher-eunsik'
      )
      const root = launchRoot || defaultRoot

      if (!fs.existsSync(root)) {
        fs.mkdirSync(root, { recursive: true })
      }

      const mcVersion = '1.21.1'

      const fabricVersionID = await resolveFabricVersionId({
        root,
        mcVersion,
        mainWindow
      })
      await ensureModsSynced({ root, mainWindow })

      mainWindow.webContents.send('status-update', 'Starting Minecraft...')
      emitInstallProgress(mainWindow, 100, '설치 준비 완료, 게임 시작', 'LAUNCH')

      const opts = {
        authorization: mclcAuth,
        root: root,
        version: {
          number: mcVersion,
          type: 'release',
          custom: fabricVersionID // The function returns the version ID string
        },
        memory: {
          max: '4G',
          min: '2G'
        },
        customArgs: ['--quickPlayMultiplayer', 'localhost']
      }

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
