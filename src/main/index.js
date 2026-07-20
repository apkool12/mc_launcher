import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join, normalize } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { autoUpdater } from 'electron-updater'
import icon from '../../resources/icon.png?asset'
import { setupLauncher } from './launcher'
import { pingServer } from './serverPing'
import fs from 'fs'

const LAUNCHER_CONFIG_FILE = 'launcher-config.json'
const DEFAULT_SERVER_HOST = 'localhost'
const DEFAULT_SERVER_PORT = 25565
const DEFAULT_LAUNCHER_SETTINGS = {
  memoryMinGb: 2,
  memoryMaxGb: 4,
  autoConnect: true,
  masterVolume: 100,
  musicVolume: 30,
  minecraftLanguage: 'ko_kr'
}
let launchPathIpcRegistered = false

function getDefaultLaunchDirectory() {
  return join(app.getPath('appData'), 'ByteMC Launcher')
}

function getConfigPath() {
  return join(app.getPath('userData'), LAUNCHER_CONFIG_FILE)
}

function readLauncherConfig() {
  try {
    const configPath = getConfigPath()
    if (!fs.existsSync(configPath)) return {}
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'))
  } catch {
    return {}
  }
}

function writeLauncherConfig(nextConfig) {
  const configPath = getConfigPath()
  fs.writeFileSync(configPath, JSON.stringify(nextConfig, null, 2), 'utf-8')
}

function normalizeLauncherSettings(config) {
  const rawMemoryMin = Number(config.memoryMinGb)
  const rawMemoryMax = Number(config.memoryMaxGb)
  const rawMasterVolume = Number(config.masterVolume)
  const rawMusicVolume = Number(config.musicVolume)
  const rawMinecraftLanguage = String(config.minecraftLanguage || '').toLowerCase()
  const memoryMinGb = Math.max(1, Math.min(12, Number.isFinite(rawMemoryMin) ? rawMemoryMin : 2))
  const memoryMaxGb = Math.max(
    memoryMinGb,
    Math.min(16, Number.isFinite(rawMemoryMax) ? rawMemoryMax : 4)
  )
  const masterVolume = Math.max(
    0,
    Math.min(100, Number.isFinite(rawMasterVolume) ? rawMasterVolume : 100)
  )
  const musicVolume = Math.max(
    0,
    Math.min(100, Number.isFinite(rawMusicVolume) ? rawMusicVolume : 30)
  )
  const minecraftLanguage = ['ko_kr', 'en_us'].includes(rawMinecraftLanguage)
    ? rawMinecraftLanguage
    : 'ko_kr'

  return {
    ...DEFAULT_LAUNCHER_SETTINGS,
    ...config,
    launchDirectory:
      config.launchDirectory && !isWindowsDriveRoot(config.launchDirectory)
        ? config.launchDirectory
        : getDefaultLaunchDirectory(),
    memoryMinGb,
    memoryMaxGb,
    autoConnect: config.autoConnect !== false,
    masterVolume,
    musicVolume,
    minecraftLanguage
  }
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return fallback
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  } catch {
    return fallback
  }
}

function readBundledManifest() {
  const candidates = [
    process.env.MODPACK_MANIFEST_FILE,
    join(__dirname, '../../resources/modpack-manifest.json'),
    join(process.cwd(), 'resources', 'modpack-manifest.json'),
    join(process.resourcesPath || '', 'app.asar.unpacked', 'resources', 'modpack-manifest.json'),
    join(process.resourcesPath || '', 'app.asar.unpacked', 'modpack-manifest.json'),
    join(process.resourcesPath || '', 'resources', 'modpack-manifest.json'),
    join(process.resourcesPath || '', 'modpack-manifest.json')
  ].filter(Boolean)

  for (const filePath of candidates) {
    const manifest = readJsonSafe(filePath, null)
    if (manifest) return manifest
  }

  return null
}

function getServerConfig() {
  const manifest = readBundledManifest()
  const server = manifest?.server || {}
  const host = String(
    process.env.SERVER_HOST || server.host || server.address || DEFAULT_SERVER_HOST
  ).trim()
  const port = Number(process.env.SERVER_PORT || server.port || DEFAULT_SERVER_PORT)

  return {
    host,
    port: Number.isFinite(port) ? port : DEFAULT_SERVER_PORT
  }
}

function isWindowsDriveRoot(dirPath) {
  if (process.platform !== 'win32') return false
  const normalized = normalize(dirPath)
  return /^[A-Za-z]:\\?$/.test(normalized)
}

function registerLaunchPathIpc(mainWindow) {
  if (launchPathIpcRegistered) return
  launchPathIpcRegistered = true

  ipcMain.handle('get-launch-directory', async () => {
    const config = readLauncherConfig()
    const launchDirectory = config.launchDirectory || getDefaultLaunchDirectory()
    if (isWindowsDriveRoot(launchDirectory)) {
      return getDefaultLaunchDirectory()
    }
    return launchDirectory
  })

  ipcMain.handle('get-launcher-settings', async () => {
    const config = readLauncherConfig()
    return {
      success: true,
      settings: normalizeLauncherSettings(config),
      server: getServerConfig()
    }
  })

  ipcMain.handle('save-launcher-settings', async (_, settings) => {
    const config = readLauncherConfig()
    const nextConfig = normalizeLauncherSettings({ ...config, ...(settings || {}) })
    writeLauncherConfig(nextConfig)
    return {
      success: true,
      settings: nextConfig,
      server: getServerConfig()
    }
  })

  ipcMain.handle('choose-launch-directory', async () => {
    const config = readLauncherConfig()
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '마인크래프트 설치 위치 선택',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: config.launchDirectory || getDefaultLaunchDirectory()
    })

    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, canceled: true }
    }

    const launchDirectory = result.filePaths[0]
    if (isWindowsDriveRoot(launchDirectory)) {
      return {
        success: false,
        error:
          '드라이브 루트(E:\\ 같은 폴더)는 설치 위치로 선택할 수 없습니다. 하위 폴더를 선택해주세요.'
      }
    }
    writeLauncherConfig({ ...config, launchDirectory })
    return { success: true, launchDirectory }
  })
}

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
    // Start server status check after window is ready
    startServerStatusLoop(mainWindow)
    setupAutoUpdater(mainWindow)
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  setupLauncher(mainWindow)
  registerLaunchPathIpc(mainWindow)
}

// ===== Auto Update (Windows only — see README on macOS constraints) =====
function setupAutoUpdater(window) {
  if (process.platform !== 'win32' || !app.isPackaged) return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-downloaded', () => {
    if (window.isDestroyed()) return
    window.webContents.send('update-ready')
  })

  autoUpdater.on('error', (error) => {
    console.error('Auto update error:', error)
  })

  autoUpdater.checkForUpdates().catch((error) => {
    console.error('Auto update check failed:', error)
  })
}

// ===== Server Status Check Logic =====
function startServerStatusLoop(window) {
  const checkStatus = async () => {
    const serverConfig = getServerConfig()
    const result = await pingServer(serverConfig.host, serverConfig.port, 1500)
    if (window.isDestroyed()) return
    window.webContents.send('server-status', result)
  }

  // Check every 5 seconds
  checkStatus()
  const interval = setInterval(checkStatus, 5000)

  window.on('closed', () => {
    clearInterval(interval)
  })
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.bytemc.launcher')
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  ipcMain.on('ping', () => console.log('pong'))

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
