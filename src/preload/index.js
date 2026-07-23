import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Custom APIs for renderer
const api = {
  restoreLogin: () => ipcRenderer.invoke('restore-login'),
  msLogin: () => ipcRenderer.invoke('ms-login'),
  offlineLogin: (username) => ipcRenderer.invoke('offline-login', username),
  restoreOfflineLogin: () => ipcRenderer.invoke('restore-offline-login'),
  logout: () => ipcRenderer.invoke('logout'),
  getPlayerSummary: (args) => ipcRenderer.invoke('get-player-summary', args),
  getLauncherSettings: () => ipcRenderer.invoke('get-launcher-settings'),
  saveLauncherSettings: (settings) => ipcRenderer.invoke('save-launcher-settings', settings),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getLaunchDirectory: () => ipcRenderer.invoke('get-launch-directory'),
  chooseLaunchDirectory: () => ipcRenderer.invoke('choose-launch-directory'),
  launchGame: (args) => ipcRenderer.invoke('launch-game', args),
  onStatusUpdate: (callback) => {
    ipcRenderer.removeAllListeners('status-update')
    ipcRenderer.on('status-update', (_, status) => callback(status))
  },
  onProgress: (callback) => {
    ipcRenderer.removeAllListeners('download-progress')
    ipcRenderer.on('download-progress', (_, progress) => callback(progress))
  },
  onInstallProgress: (callback) => {
    ipcRenderer.removeAllListeners('install-progress')
    ipcRenderer.on('install-progress', (_, payload) => callback(payload))
  },
  onGameClosed: (callback) => {
    ipcRenderer.removeAllListeners('game-closed')
    ipcRenderer.on('game-closed', (_, code) => callback(code))
  },
  onServerStatus: (callback) => {
    ipcRenderer.removeAllListeners('server-status')
    ipcRenderer.on('server-status', (_, online) => callback(online))
  },
  restartAndInstall: () => ipcRenderer.invoke('restart-and-install'),
  onUpdateReady: (callback) => {
    ipcRenderer.removeAllListeners('update-ready')
    ipcRenderer.on('update-ready', () => callback())
  },
  onUpdateStatus: (callback) => {
    ipcRenderer.removeAllListeners('update-status')
    ipcRenderer.on('update-status', (_, status) => callback(status))
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
