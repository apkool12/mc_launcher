import { Client } from 'minecraft-launcher-core'
import { Auth } from 'msmc'
import { ipcMain } from 'electron'
import path from 'path'
import { installFabric, getFabricLoaders } from '@xmcl/installer'
import fs from 'fs'

const launcher = new Client()

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

  // Launch Game
  ipcMain.handle('launch-game', async (event, { mclcAuth }) => {
    try {
      const root = path.join(
        process.env.APPDATA ||
          (process.platform === 'darwin'
            ? path.join(process.env.HOME, 'Library/Application Support')
            : process.env.HOME),
        'mc-launcher-eunsik'
      )

      if (!fs.existsSync(root)) {
        fs.mkdirSync(root, { recursive: true })
      }

      const mcVersion = '1.21.1'
      
      // Install Fabric if needed
      mainWindow.webContents.send('status-update', 'Checking Fabric loader...')
      const fabricLoaders = await getFabricLoaders()
      const latestFabric = fabricLoaders[0].version // Get latest loader version
      
      mainWindow.webContents.send('status-update', `Installing Fabric ${latestFabric}...`)
      // Correcting the options based on @xmcl/installer source code
      const fabricVersionID = await installFabric({
        minecraftVersion: mcVersion,
        version: latestFabric,
        minecraft: root
      })

      mainWindow.webContents.send('status-update', 'Starting Minecraft...')

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
