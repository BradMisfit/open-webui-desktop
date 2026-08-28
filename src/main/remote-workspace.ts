// @ts-nocheck
import path from 'node:path'
import { app, dialog } from 'electron'
import log from 'electron-log'
import { RemoteWorkspaceClient, RemoteWorkspaceError, REMOTE_WORKSPACE_PROTOCOL } from './remote-workspace-core.mjs'

/**
 * Desktop main-process adapter for the existing Remote Workspace Helper
 * protocol. The content webview only receives opaque grant metadata; all file
 * and process execution stays behind the outbound authenticated relay.
 */
export class DesktopRemoteWorkspaceService extends RemoteWorkspaceClient {
  constructor(onStateChange = () => {}) {
    super({
      configPath: path.join(app.getPath('userData'), 'remote-workspaces.json'),
      onStateChange
    })
  }

  async selectFolder() {
    const result = await dialog.showOpenDialog({
      title: 'Choose a Work Agent workspace folder',
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : (result.filePaths[0] || null)
  }
}

export const createDesktopRemoteWorkspaceService = (onStateChange = () => {}) => {
  const service = new DesktopRemoteWorkspaceService(onStateChange)
  service.resume().catch((error) => {
    // A disconnected laptop must not block the Desktop UI. The authenticated
    // client retries when it has a saved endpoint; no credentials are logged.
    log.warn(`Remote Workspace resume deferred: ${error?.code || error?.name || 'connection error'}`)
  })
  return service
}

export { RemoteWorkspaceError, REMOTE_WORKSPACE_PROTOCOL }
