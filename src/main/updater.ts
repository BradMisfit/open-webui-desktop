import { autoUpdater, type UpdateInfo } from 'electron-updater'
import log from 'electron-log'
import { app, BrowserWindow } from 'electron'

let mainWin: BrowserWindow | null = null

// This is deliberately compiled into the Desktop main process.  No renderer,
// loaded Open WebUI page, or model input can supply an update location.
export const CUSTOM_UPDATE_FEED = Object.freeze({
  provider: 'github' as const,
  owner: 'BradMisfit',
  repo: 'open-webui-desktop'
})

const send = (type: string, data?: any): void => {
  mainWin?.webContents.send('main:data', { type, data })
}

export function initUpdater(window: BrowserWindow): void {
  mainWin = window

  autoUpdater.logger = log
  // Real auto-update: download in the background as soon as an update is found,
  // and apply it when the app next quits. The user is also shown progress + a
  // "Restart to update" affordance in the status bar.
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  // Our custom versions carry a `-bradmisfit.N` SemVer prerelease tag. Without
  // these two lines electron-updater derives an update CHANNEL from that tag
  // (e.g. "bradmisfit") and looks for `bradmisfit.yml`, which we never publish —
  // so it silently finds no update. Pin the channel to the `latest.yml` we DO
  // publish, and allow prerelease-tagged versions to update to one another. This
  // is the root cause the earlier build failed to auto-update.
  autoUpdater.channel = 'latest'
  autoUpdater.allowPrerelease = true
  autoUpdater.setFeedURL(CUSTOM_UPDATE_FEED)

  autoUpdater.on('checking-for-update', () => {
    send('update:checking')
  })

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    send('update:available', {
      version: info.version,
      releaseDate: info.releaseDate
    })
  })

  autoUpdater.on('update-not-available', (_info: UpdateInfo) => {
    send('update:not-available')
  })

  autoUpdater.on('download-progress', (progress) => {
    send('update:download-progress', {
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total
    })
  })

  autoUpdater.on('update-downloaded', (_info: UpdateInfo) => {
    send('update:downloaded')
  })

  autoUpdater.on('error', (error: Error) => {
    send('update:error', { message: error?.message ?? 'Update error' })
  })

  // Auto-check on launch, then periodically so a long-running app still updates
  // without a relaunch (only when packaged).
  if (app.isPackaged) {
    autoUpdater.checkForUpdates().catch((err) => {
      log.warn('Auto update check failed:', err)
    })
    setInterval(
      () => {
        autoUpdater.checkForUpdates().catch((err) => log.warn('Periodic update check failed:', err))
      },
      2 * 60 * 60 * 1000
    )
  }
}

export async function checkForUpdates(): Promise<void> {
  if (!app.isPackaged) {
    log.info('Skipping update check — app is not packaged')
    send('update:not-available')
    return
  }
  await autoUpdater.checkForUpdates()
}

export async function downloadUpdate(): Promise<void> {
  await autoUpdater.downloadUpdate()
}

export function installUpdate(): void {
  autoUpdater.quitAndInstall(false, true)
}
