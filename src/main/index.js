import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { setupLauncher } from './launcher'
import net from 'net'

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
}

// ===== Server Status Check Logic =====
function startServerStatusLoop(window) {
  const checkStatus = () => {
    const socket = new net.Socket()
    socket.setTimeout(1000)

    socket.on('connect', () => {
      window.webContents.send('server-status', true)
      socket.destroy()
    })

    socket.on('timeout', () => {
      window.webContents.send('server-status', false)
      socket.destroy()
    })

    socket.on('error', () => {
      window.webContents.send('server-status', false)
      socket.destroy()
    })

    socket.connect(25565, 'localhost')
  }

  // Check every 5 seconds
  checkStatus()
  const interval = setInterval(checkStatus, 5000)

  window.on('closed', () => {
    clearInterval(interval)
  })
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.electron')
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
