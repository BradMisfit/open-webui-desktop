/**
 * Remote Workspace protocol core.
 *
 * This is a direct TypeScript/Node port of the policy-bearing portions of
 * shellraiser's remote-workspace-client/remote_workspace_client.py.  It is
 * deliberately independent of Electron so its containment and wire-format
 * rules can be tested without granting a test process Desktop capabilities.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

// Protocol 2 is the first Desktop protocol that implements the complete
// remote_project_v1 snapshot and transactional sync surface it advertises.
export const REMOTE_WORKSPACE_PROTOCOL = 2
export const REMOTE_WORKSPACE_DESKTOP_CLIENT_KIND = 'open-webui-desktop'

export class RemoteWorkspaceError extends Error {
  constructor(code, detail) {
    super(detail)
    this.name = 'RemoteWorkspaceError'
    this.code = code
    this.detail = detail
  }
}

const isInside = (root, candidate) => {
  const normal = (value) => {
    const resolved = path.normalize(value)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  const rootValue = normal(root)
  const candidateValue = normal(candidate)
  const relative = path.relative(rootValue, candidateValue)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

const isFilesystemRoot = (value) => path.parse(value).root === value

export const capabilitiesForPreset = (preset) => {
  if (preset === 'read-only') return { read: true, remote_project_v1: true }
  if (preset === 'edit') return { read: true, write: true, create: true, move: true, delete: true, remote_project_v1: true }
  if (preset === 'developer') {
    return { read: true, write: true, create: true, move: true, delete: true, execute: true, cancel: true, git: true, remote_project_v1: true, coding_environment_v1: true }
  }
  throw new RemoteWorkspaceError('PERMISSION_DENIED', 'workspace capability preset is invalid')
}

export const parseBrowseLaunch = (value) => {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new RemoteWorkspaceError('INVALID_HELPER_URL', 'the Work Agent workspace launch URL is invalid')
  }
  if (parsed.protocol !== 'work-agent:' || parsed.hostname !== 'browse' || (parsed.pathname !== '' && parsed.pathname !== '/')) {
    throw new RemoteWorkspaceError('INVALID_HELPER_URL', 'the Work Agent workspace launch URL is invalid')
  }
  const allowed = new Set(['endpoint', 'pair_id', 'code', 'preset'])
  for (const key of parsed.searchParams.keys()) {
    if (!allowed.has(key) || parsed.searchParams.getAll(key).length !== 1) {
      throw new RemoteWorkspaceError('INVALID_HELPER_URL', 'the Work Agent workspace launch URL is invalid')
    }
  }
  const endpoint = parsed.searchParams.get('endpoint') || ''
  const pairId = parsed.searchParams.get('pair_id') || ''
  const code = parsed.searchParams.get('code') || ''
  const preset = parsed.searchParams.get('preset') || 'developer'
  let relay
  try {
    relay = new URL(endpoint)
  } catch {
    throw new RemoteWorkspaceError('INVALID_HELPER_URL', 'the Work Agent relay endpoint is invalid')
  }
  if (!['ws:', 'wss:'].includes(relay.protocol) || !relay.hostname || relay.username || relay.password || relay.search || relay.hash) {
    throw new RemoteWorkspaceError('INVALID_HELPER_URL', 'the Work Agent relay endpoint is invalid')
  }
  if (relay.protocol === 'ws:' && !isPrivateOrLoopbackLiteral(relay.hostname)) {
    throw new RemoteWorkspaceError('INVALID_HELPER_URL', 'unencrypted workspace relay endpoints must be loopback or private-LAN literal addresses')
  }
  if (!/^rwp_[a-f0-9]{32}$/.test(pairId) || code.length < 20 || !['read-only', 'edit', 'developer'].includes(preset)) {
    throw new RemoteWorkspaceError('INVALID_HELPER_URL', 'the Work Agent workspace launch URL is invalid')
  }
  return { endpoint, pairId, code, preset }
}

const isPrivateOrLoopbackLiteral = (host) => {
  const normalized = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (normalized === 'localhost' || normalized === '::1' || normalized === '127.0.0.1') return true
  const octets = normalized.split('.')
  if (octets.length !== 4 || octets.some((part) => !/^\d+$/.test(part))) return false
  const values = octets.map(Number)
  if (values.some((part) => part < 0 || part > 255)) return false
  return values[0] === 10 || (values[0] === 172 && values[1] >= 16 && values[1] <= 31) || (values[0] === 192 && values[1] === 168)
}

export class WorkspacePolicy {
  constructor(grants = []) {
    this.grants = new Map(grants.map((grant) => [grant.workspace_id, grant]))
  }

  grant(workspaceId) {
    const grant = this.grants.get(workspaceId)
    if (!grant || !grant.enabled) throw new RemoteWorkspaceError('WORKSPACE_UNAVAILABLE', 'workspace is not granted locally')
    return grant
  }

  require(workspaceId, capability) {
    const grant = this.grant(workspaceId)
    if (!grant.capabilities?.[capability]) throw new RemoteWorkspaceError('PERMISSION_DENIED', `workspace does not grant ${capability}`)
    return grant
  }

  path(workspaceId, relative, { write = false } = {}) {
    const grant = write ? this.require(workspaceId, 'write') : this.grant(workspaceId)
    if (typeof relative !== 'string' || relative.includes('\0')) {
      throw new RemoteWorkspaceError('PATH_OUTSIDE_WORKSPACE', 'path is invalid')
    }
    if (path.isAbsolute(relative) || path.win32.isAbsolute(relative) || /^[A-Za-z]:/.test(relative) || relative.startsWith('\\\\')) {
      throw new RemoteWorkspaceError('PATH_OUTSIDE_WORKSPACE', 'path escapes granted workspace')
    }
    const parts = relative.split(/[\\/]+/).filter((part) => part && part !== '.')
    if (parts.includes('..')) throw new RemoteWorkspaceError('PATH_OUTSIDE_WORKSPACE', 'path escapes granted workspace')
    const root = fs.realpathSync.native(grant.local_path)
    const candidate = path.resolve(root, ...parts)
    let existingParent = fs.existsSync(candidate) ? candidate : path.dirname(candidate)
    while (!fs.existsSync(existingParent) && existingParent !== path.dirname(existingParent)) existingParent = path.dirname(existingParent)
    const resolvedParent = fs.realpathSync.native(existingParent)
    if (!isInside(root, resolvedParent) || !isInside(root, candidate)) {
      throw new RemoteWorkspaceError('PATH_OUTSIDE_WORKSPACE', 'link or junction escapes workspace')
    }
    return candidate
  }
}

const bounded = (value, limit = 262144) => String(value || '').slice(-limit)

const base64url = (buffer) => buffer.toString('base64url')

const rawEd25519PublicKey = (privateKey) => {
  const der = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' })
  // SubjectPublicKeyInfo for Ed25519 ends in its fixed-width 32-byte public key.
  return Buffer.from(der).subarray(-32)
}

export class RemoteWorkspaceClient {
  constructor({
    configPath, platform = process.platform, hostname = os.hostname(), connectSocket = null, onStateChange = () => {},
    heartbeatMs = 15000, staleMs = 45000, reconnectBaseMs = 1000, reconnectMaxMs = 15000
  }) {
    this.configPath = configPath
    this.platform = platform
    this.hostname = hostname
    // Liveness: the relay answers every heartbeat, so a link that has delivered
    // nothing for staleMs is dead even if the socket still looks open (the relay
    // may have dropped the session without a close frame reaching us).
    this.heartbeatMs = heartbeatMs
    this.staleMs = staleMs
    this.reconnectBaseMs = reconnectBaseMs
    this.reconnectMaxMs = reconnectMaxMs
    this.reconnectDelay = reconnectBaseMs
    this.heartbeatTimer = null
    this.lastMessageAt = 0
    this.connectSocket = connectSocket || defaultSocket
    this.onStateChange = onStateChange
    this.config = this.load()
    this.policy = new WorkspacePolicy(this.config.workspaces || [])
    this.processes = new Map()
    this.snapshots = new Map()
    this.socket = null
    this.connected = false
    this.connecting = null
    this.reconnectTimer = null
    this.recoverSyncTransactions()
  }

  load() {
    try {
      return JSON.parse(fs.readFileSync(this.configPath, 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT') return { workspaces: [], recent_workspace_ids: [] }
      throw new RemoteWorkspaceError('WORKSPACE_CONFIGURATION_INVALID', 'the local workspace configuration is invalid')
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true, mode: 0o700 })
    const temporary = `${this.configPath}.${process.pid}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(this.config, null, 2), { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(temporary, this.configPath)
    try { fs.chmodSync(this.configPath, 0o600) } catch {}
  }

  ensureKey() {
    if (this.config.private_key_pem) return crypto.createPrivateKey(this.config.private_key_pem)
    const { privateKey } = crypto.generateKeyPairSync('ed25519')
    this.config.private_key_pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
    this.save()
    return crypto.createPrivateKey(this.config.private_key_pem)
  }

  publicKey() { return base64url(rawEd25519PublicKey(this.ensureKey())) }

  deviceId() {
    if (!this.config.device_id) {
      this.config.device_id = `desktop-${crypto.randomUUID().replace(/-/g, '').slice(0, 48)}`
      this.save()
    }
    return this.config.device_id
  }

  publicStatus() {
    return {
      protocol: REMOTE_WORKSPACE_PROTOCOL,
      device_id: this.config.device_id || null,
      connected: this.connected,
      workspaces: (this.config.recent_workspace_ids || []).map((id) => this.policy.grants.get(id)).filter(Boolean).map(publicGrant)
    }
  }

  localWorkspaceLocation(workspaceId) {
    const grant = this.policy.grant(String(workspaceId || ''))
    return { workspace_id: grant.workspace_id, local_path: grant.local_path }
  }

  addWorkspace(displayName, localPath, capabilities) {
    const root = fs.realpathSync.native(localPath)
    if (isFilesystemRoot(root)) throw new RemoteWorkspaceError('PERMISSION_DENIED', 'granting a filesystem root is not allowed')
    const normalized = normalizePath(root)
    let item = (this.config.workspaces || []).find((candidate) => normalizePath(candidate.local_path) === normalized)
    if (item) {
      item.display_name = (displayName || path.basename(root)).slice(0, 200)
      item.local_path = root
      item.capabilities = capabilities
      item.enabled = true
    } else {
      const used = new Set((this.config.workspaces || []).map((candidate) => candidate.workspace_id))
      const base = slug(displayName || path.basename(root)) || 'workspace'
      let workspaceId = base
      while (used.has(workspaceId)) workspaceId = `${base}-${crypto.randomUUID().slice(0, 8)}`
      item = { workspace_id: workspaceId, display_name: (displayName || path.basename(root)).slice(0, 200), local_path: root, capabilities, enabled: true }
      this.config.workspaces = [...(this.config.workspaces || []), item]
    }
    this.config.recent_workspace_ids = [item.workspace_id, ...(this.config.recent_workspace_ids || []).filter((id) => id !== item.workspace_id)].slice(0, 12)
    this.save()
    this.policy = new WorkspacePolicy(this.config.workspaces)
    return item
  }

  async browse({ launch_url }) {
    const request = parseBrowseLaunch(launch_url)
    if (this.config.enrolled_endpoint && this.config.enrolled_endpoint !== request.endpoint) {
      throw new RemoteWorkspaceError('ENDPOINT_MISMATCH', 'this Desktop client is already enrolled against a different Work Agent server')
    }
    const selected = await this.selectFolder()
    if (!selected) return { cancelled: true, ...this.publicStatus() }
    const grant = this.addWorkspace(path.basename(selected) || 'Workspace', selected, capabilitiesForPreset(request.preset))
    this.config.endpoint = request.endpoint
    this.save()
    // Every Browse launch needs a server-side correlation result, even when
    // this Desktop is already enrolled and therefore authenticates instead of
    // consuming the fresh one-time pairing code.  The pair ID is opaque to the
    // guest and is used only by the relay to acknowledge this registration.
    const pairing = this.config.enrolled_endpoint === request.endpoint
      ? { helperLaunchId: request.pairId }
      : { pairId: request.pairId, code: request.code, helperLaunchId: request.pairId }
    // The native picker is intentionally outside any transport deadline: a
    // person may take as long as needed to choose a folder.  Once selection is
    // complete, however, the relay handshake is bounded and failures are
    // returned as typed RemoteWorkspaceError values to the guest bridge.
    await this.connect(request.endpoint, pairing)
    return { cancelled: false, workspace: publicGrant(grant), ...this.publicStatus() }
  }

  // Electron injects this narrow capability. The protocol core never opens a UI itself.
  async selectFolder() { throw new RemoteWorkspaceError('FOLDER_PICKER_UNAVAILABLE', 'the native folder picker is unavailable') }

  async resume() {
    const endpoint = this.config.enrolled_endpoint
    if (!endpoint || !this.config.device_id) return
    try {
      await this.connect(endpoint)
    } catch (error) {
      // The relay may be briefly unreachable when the app starts (e.g. while the
      // Work Agent runtime is being updated). Keep retrying in the background
      // instead of staying offline until the user reconnects by hand.
      this.scheduleReconnect(endpoint)
      throw error
    }
  }

  async connect(endpoint, pairing = {}) {
    if (this.connecting) return this.connecting
    this.connecting = this.open(endpoint, pairing).finally(() => { this.connecting = null })
    return this.connecting
  }

  async open(endpoint, { pairId, code, helperLaunchId } = {}) {
    const socket = await this.connectSocket(endpoint)
    this.socket = socket
    try {
      const challenge = await receiveJson(socket)
      if (challenge?.type !== 'challenge' || typeof challenge.nonce !== 'string') {
        throw new RemoteWorkspaceError('CLIENT_DISCONNECTED', 'the Work Agent relay did not provide a valid challenge')
      }
      this.assertProtocol(challenge.protocol)
      // Identity generation happens before the first pair frame.  A failed
      // first attempt can therefore leave a device ID on disk; enrollment is
      // still incomplete until the server has accepted the pair frame.
      const firstUse = Boolean(pairId && code && !this.config.enrolled_endpoint)
      if (firstUse) {
        sendJson(socket, {
          type: 'pair', pair_id: pairId, code, device_id: this.deviceId(),
          display_name: this.config.display_name || this.deviceId(),
          os_name: this.platform === 'win32' ? 'windows' : 'linux', public_key: this.publicKey(),
          helper_launch_id: helperLaunchId || pairId, protocol: REMOTE_WORKSPACE_PROTOCOL,
          client_kind: REMOTE_WORKSPACE_DESKTOP_CLIENT_KIND
        })
      } else {
        const nonce = Buffer.from(challenge.nonce, 'base64url')
        sendJson(socket, {
          type: 'authenticate', device_id: this.deviceId(),
          signature: base64url(crypto.sign(null, nonce, this.ensureKey())),
          helper_launch_id: helperLaunchId, protocol: REMOTE_WORKSPACE_PROTOCOL,
          client_kind: REMOTE_WORKSPACE_DESKTOP_CLIENT_KIND
        })
      }
      const authenticated = await receiveJson(socket)
      if (authenticated?.type === 'error') {
        throw new RemoteWorkspaceError(
          typeof authenticated.code === 'string' ? authenticated.code : 'CLIENT_DISCONNECTED',
          typeof authenticated.detail === 'string' ? authenticated.detail : 'the Work Agent relay rejected this Desktop client'
        )
      }
      if (!['paired', 'authenticated'].includes(authenticated?.type) || authenticated.device_id !== this.deviceId()) {
        throw new RemoteWorkspaceError('PERMISSION_DENIED', authenticated?.detail || 'the Work Agent relay rejected this Desktop client')
      }
      if (firstUse) {
        // A device ID is not itself enrollment proof: a failed first pairing
        // must be safely retryable with a new one-time bootstrap.
        this.config.enrolled_endpoint = endpoint
        this.config.endpoint = endpoint
        this.save()
      }
      this.connected = true
      this.reconnectDelay = this.reconnectBaseMs
      this.onStateChange(this.publicStatus())
      for (const grant of this.policy.grants.values()) {
        const capabilities = {
          ...grant.capabilities,
          remote_project_v1: Boolean(grant.capabilities?.read),
          coding_environment_v1: Boolean(grant.capabilities?.write && grant.capabilities?.execute)
        }
        sendJson(socket, { type: 'workspace_register', ...grant, capabilities })
      }
      this.listen(socket, endpoint)
      this.startHeartbeat(socket, endpoint)
    } catch (error) {
      this.connected = false
      this.onStateChange(this.publicStatus())
      try { socket.close() } catch {}
      throw error
    }
  }

  assertProtocol(serverProtocol) {
    if (serverProtocol !== REMOTE_WORKSPACE_PROTOCOL) {
      throw new RemoteWorkspaceError('DESKTOP_UPDATE_REQUIRED', `Desktop update required: server requires Remote Workspace protocol ${serverProtocol}`)
    }
  }

  listen(socket, endpoint) {
    socket.onmessage = async (event) => {
      if (this.socket === socket) this.lastMessageAt = Date.now()
      let message
      try { message = JSON.parse(await messageText(event.data)) } catch { return }
      if (message?.type !== 'operation') return
      let result
      try {
        result = await this.operation(String(message.workspace_id || ''), String(message.operation || ''), message.arguments || {}, Number(message.timeout || 600), String(message.request_id || ''))
      } catch (error) {
        result = error instanceof RemoteWorkspaceError
          ? { ok: false, code: error.code, detail: error.detail }
          : { ok: false, code: 'CLIENT_DISCONNECTED', detail: 'local workspace operation failed' }
      }
      sendJson(socket, { type: 'result', request_id: message.request_id, result })
    }
    socket.onclose = () => {
      if (this.socket === socket) this.stopHeartbeat()
      this.scheduleReconnect(endpoint)
    }
    socket.onerror = () => undefined
  }

  startHeartbeat(socket, endpoint) {
    this.stopHeartbeat()
    this.lastMessageAt = Date.now()
    this.heartbeatTimer = setInterval(() => {
      if (this.socket !== socket) { this.stopHeartbeat(); return }
      if (Date.now() - this.lastMessageAt > this.staleMs) { this.dropDeadLink(socket, endpoint); return }
      try { sendJson(socket, { type: 'heartbeat' }) } catch { this.dropDeadLink(socket, endpoint) }
    }, this.heartbeatMs)
    this.heartbeatTimer.unref?.()
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
  }

  // A silent link is treated as lost: close it and reconnect, even though the
  // socket never reported a close.
  dropDeadLink(socket, endpoint) {
    this.stopHeartbeat()
    if (this.socket === socket) this.socket = null
    socket.onclose = null
    try { socket.close() } catch {}
    this.scheduleReconnect(endpoint)
  }

  scheduleReconnect(endpoint) {
    if (this.socket && this.socket.readyState === 1) return
    this.connected = false
    this.onStateChange(this.publicStatus())
    if (this.reconnectTimer) return
    const delay = this.reconnectDelay
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.reconnectMaxMs)
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null
      try { await this.connect(endpoint) } catch { this.scheduleReconnect(endpoint) }
    }, delay)
    this.reconnectTimer.unref?.()
  }

  async operation(workspaceId, operation, operationArgs, timeout, requestId = '') {
    if (['list', 'stat', 'read', 'snapshot_manifest', 'search'].includes(operation)) this.policy.require(workspaceId, 'read')
    else if (['write', 'edit', 'mkdir', 'move', 'delete', 'sync_begin', 'sync_write', 'sync_commit', 'sync_abort'].includes(operation)) this.policy.require(workspaceId, 'write')
    else if (operation === 'command') this.policy.require(workspaceId, 'execute')
    else if (operation === 'prepare_python_environment') {
      this.policy.require(workspaceId, 'execute')
      this.policy.require(workspaceId, 'write')
    }
    else if (operation === 'command_cancel') this.policy.require(workspaceId, 'cancel')
    else if (operation === 'git') this.policy.require(workspaceId, 'git')
    else throw new RemoteWorkspaceError('PERMISSION_DENIED', 'operation is not supported')
    if (operation === 'list') return this.list(workspaceId, operationArgs)
    if (operation === 'stat') return this.stat(workspaceId, operationArgs)
    if (operation === 'read') return this.read(workspaceId, operationArgs)
    if (operation === 'snapshot_manifest') return this.snapshotManifest(workspaceId, operationArgs)
    if (operation === 'sync_begin') return this.syncBegin(workspaceId, operationArgs)
    if (operation === 'sync_write') return this.syncWrite(workspaceId, operationArgs)
    if (operation === 'sync_commit') return this.syncCommit(workspaceId, operationArgs)
    if (operation === 'sync_abort') return this.syncAbort(workspaceId, operationArgs)
    if (operation === 'write') return this.write(workspaceId, operationArgs)
    if (operation === 'edit') return this.edit(workspaceId, operationArgs)
    if (operation === 'mkdir') return this.mkdir(workspaceId, operationArgs)
    if (operation === 'move') return this.move(workspaceId, operationArgs)
    if (operation === 'delete') return this.delete(workspaceId, operationArgs)
    if (operation === 'search') return this.search(workspaceId, operationArgs)
    if (operation === 'prepare_python_environment') return this.preparePythonEnvironment(workspaceId, operationArgs, timeout)
    if (operation === 'command') return this.command(workspaceId, operationArgs, timeout, requestId)
    if (operation === 'command_cancel') return this.cancel(operationArgs.request_id)
    return this.git(workspaceId, operationArgs, timeout)
  }

  list(workspaceId, args) {
    const target = this.policy.path(workspaceId, String(args.path || '.'))
    const root = fs.realpathSync.native(this.policy.grant(workspaceId).local_path)
    const max = clamp(args.max_entries, 1, 500, 200)
    const entries = fs.readdirSync(target, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).slice(0, max).flatMap((entry) => {
      const full = path.join(target, entry.name)
      try {
        if (!isInside(root, fs.realpathSync.native(full))) return []
        const relative = path.relative(root, full).split(path.sep).join('/')
        return [{ name: entry.name, path: relative, kind: entry.isDirectory() ? 'directory' : 'file', size: entry.isFile() ? fs.statSync(full).size : null }]
      } catch { return [] }
    })
    return { ok: true, entries, truncated: entries.length >= max }
  }

  stat(workspaceId, args) {
    const target = this.policy.path(workspaceId, String(args.path || '.'))
    const info = fs.statSync(target)
    return { ok: true, path: String(args.path || '.'), kind: info.isDirectory() ? 'directory' : 'file', size: info.size, mtime_ns: Math.round(info.mtimeMs * 1e6) }
  }

  read(workspaceId, args) {
    const target = this.policy.path(workspaceId, String(args.path || ''))
    if (!fs.statSync(target).isFile()) throw new RemoteWorkspaceError('WORKSPACE_UNAVAILABLE', 'file does not exist')
    const offset = Math.max(0, Number(args.offset || 0))
    const limit = clamp(args.limit, 1, 65536, 16000)
    const descriptor = fs.openSync(target, 'r')
    const data = Buffer.alloc(limit)
    const bytes = fs.readSync(descriptor, data, 0, limit, offset)
    fs.closeSync(descriptor)
    const content = data.subarray(0, bytes)
    return { ok: true, path: String(args.path), content: content.toString('utf8'), content_b64: content.toString('base64'), offset, next_offset: offset + bytes, total_bytes: fs.statSync(target).size, bytes, content_sha256: sha256(content) }
  }

  snapshotExcluded(relative, directory) {
    const parts = new Set(String(relative).split('/').map((item) => item.toLocaleLowerCase()))
    const generated = new Set(['.git', '.venv', 'venv', 'node_modules', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.svelte-kit', 'dist', 'build', 'target'])
    if ([...parts].some((item) => generated.has(item))) return 'generated'
    if (directory) return null
    const name = path.posix.basename(relative).toLocaleLowerCase()
    if (name === '.env' || (name.startsWith('.env.') && !['.env.example', '.env.sample'].includes(name))) return 'secret'
    if (['id_rsa', 'id_ed25519', 'credentials', 'credentials.json'].includes(name)) return 'secret'
    if (['.pem', '.key', '.p12', '.pfx'].includes(path.posix.extname(name))) return 'secret'
    return null
  }

  snapshotManifest(workspaceId, args) {
    const now = Date.now()
    for (const [id, item] of this.snapshots.entries()) {
      if (now - item.createdAt > 10 * 60 * 1000) this.snapshots.delete(id)
    }
    const snapshotId = String(args.snapshot_id || '')
    const offset = Math.max(0, Number(args.offset || 0))
    const pageSize = clamp(args.page_size, 1, 250, 250)
    if (snapshotId) {
      const cached = this.snapshots.get(snapshotId)
      if (!cached) throw new RemoteWorkspaceError('SNAPSHOT_EXPIRED', 'project snapshot expired; restart staging')
      if (cached.workspaceId !== workspaceId) throw new RemoteWorkspaceError('PERMISSION_DENIED', 'snapshot belongs to another workspace')
      const page = cached.manifest.entries.slice(offset, offset + pageSize)
      const nextOffset = offset + page.length
      const { entries: _entries, ...metadata } = cached.manifest
      const result = { ...metadata, entries: page, offset, next_offset: nextOffset, complete: nextOffset >= cached.manifest.entries.length }
      if (result.complete) this.snapshots.delete(snapshotId)
      return result
    }

    const root = this.policy.path(workspaceId, '.')
    const maxFiles = clamp(args.max_files, 1, 5000, 5000)
    const maxTotal = clamp(args.max_total_bytes, 1, 256 * 1024 * 1024, 256 * 1024 * 1024)
    const maxFile = clamp(args.max_file_bytes, 1, 16 * 1024 * 1024, 16 * 1024 * 1024)
    const entries = []
    const excluded = []
    let total = 0
    const visit = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const candidate = path.join(directory, entry.name)
        const relative = path.relative(root, candidate).split(path.sep).join('/')
        const info = fs.lstatSync(candidate)
        const reason = info.isSymbolicLink() ? 'link' : this.snapshotExcluded(relative, info.isDirectory())
        if (reason) {
          if (excluded.length < 200) excluded.push({ path: relative, reason })
          continue
        }
        if (info.isDirectory()) {
          visit(candidate)
          continue
        }
        if (!info.isFile()) continue
        if (info.size > maxFile) {
          if (excluded.length < 200) excluded.push({ path: relative, reason: 'file_too_large' })
          continue
        }
        if (entries.length >= maxFiles || total + info.size > maxTotal) {
          throw new RemoteWorkspaceError('PROJECT_TOO_LARGE', 'selected project exceeds the bounded snapshot limits')
        }
        entries.push({ path: relative, size: info.size, mtime_ns: Math.round(info.mtimeMs * 1e6), sha256: sha256(fs.readFileSync(candidate)) })
        total += info.size
      }
    }
    visit(root)

    let repository = { is_git: false, branch: '', head: '' }
    if (fs.existsSync(path.join(root, '.git'))) {
      const git = (...argv) => {
        const result = spawnSync('git', argv, { cwd: root, shell: false, windowsHide: true, encoding: 'utf8', timeout: 15000 })
        return result.status === 0 ? String(result.stdout || '').trim() : ''
      }
      const top = git('rev-parse', '--show-toplevel')
      try {
        if (top && normalizePath(fs.realpathSync.native(top)) === normalizePath(fs.realpathSync.native(root))) {
          repository = { is_git: true, branch: git('branch', '--show-current').slice(0, 240), head: git('rev-parse', 'HEAD').slice(0, 64) }
        }
      } catch {}
    }
    const id = crypto.randomUUID().replace(/-/g, '')
    const manifest = { ok: true, schema: 'remote_project_manifest_v1', snapshot_id: id, entries, excluded, excluded_truncated: excluded.length >= 200, file_count: entries.length, total_bytes: total, repository }
    this.snapshots.set(id, { createdAt: now, workspaceId, manifest })
    const page = entries.slice(0, pageSize)
    const { entries: _entries, ...metadata } = manifest
    const result = { ...metadata, entries: page, offset: 0, next_offset: page.length, complete: page.length >= entries.length }
    if (result.complete) this.snapshots.delete(id)
    return result
  }

  syncRoot() {
    const root = path.join(path.dirname(this.configPath), 'sync-transactions')
    fs.mkdirSync(root, { recursive: true, mode: 0o700 })
    return root
  }

  syncDirectory(transactionId) {
    if (!/^[a-f0-9]{32}$/.test(transactionId)) throw new RemoteWorkspaceError('COMMAND_FORMAT_INVALID', 'sync transaction id is invalid')
    return path.join(this.syncRoot(), transactionId)
  }

  syncFileName(value) { return sha256(Buffer.from(value, 'utf8')) }

  fileSha256(target) {
    if (!fs.existsSync(target)) return null
    const info = fs.lstatSync(target)
    if (info.isSymbolicLink() || !info.isFile()) throw new RemoteWorkspaceError('SYNC_CONFLICT', 'project path is no longer a regular file')
    return sha256(fs.readFileSync(target))
  }

  writeSyncJournal(directory, manifest) {
    const temporary = path.join(directory, 'manifest.tmp')
    const target = path.join(directory, 'manifest.json')
    fs.writeFileSync(temporary, JSON.stringify(manifest), { encoding: 'utf8', mode: 0o600 })
    const descriptor = fs.openSync(temporary, 'r')
    try { fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
    fs.renameSync(temporary, target)
  }

  loadSync(workspaceId, transactionId) {
    const directory = this.syncDirectory(transactionId)
    const journal = path.join(directory, 'manifest.json')
    if (!fs.existsSync(journal)) throw new RemoteWorkspaceError('WORKSPACE_UNAVAILABLE', 'sync transaction is unavailable')
    let manifest
    try { manifest = JSON.parse(fs.readFileSync(journal, 'utf8')) } catch { throw new RemoteWorkspaceError('WORKSPACE_UNAVAILABLE', 'sync transaction is corrupt') }
    if (manifest.workspace_id !== workspaceId) throw new RemoteWorkspaceError('PERMISSION_DENIED', 'sync transaction belongs to another workspace')
    return { directory, manifest }
  }

  syncBegin(workspaceId, args) {
    const transactionId = String(args.transaction_id || '')
    const changes = args.changes
    if (!Array.isArray(changes) || !changes.length || changes.length > 500) throw new RemoteWorkspaceError('COMMAND_FORMAT_INVALID', 'sync change set is invalid')
    const seen = new Set()
    const normalized = []
    let total = 0
    for (const raw of changes) {
      if (!raw || typeof raw !== 'object') throw new RemoteWorkspaceError('COMMAND_FORMAT_INVALID', 'sync change is invalid')
      const relative = String(raw.path || '')
      const action = String(raw.action || '')
      const base = String(raw.base_sha256 || '')
      const final = String(raw.final_sha256 || '')
      const size = Number(raw.size || 0)
      const target = this.policy.path(workspaceId, relative, { write: true })
      if (seen.has(relative) || !['write', 'delete'].includes(action) || !Number.isInteger(size) || size < 0 || size > 16 * 1024 * 1024) throw new RemoteWorkspaceError('COMMAND_FORMAT_INVALID', 'sync change is invalid')
      if (base && !/^[0-9a-f]{64}$/.test(base)) throw new RemoteWorkspaceError('COMMAND_FORMAT_INVALID', 'sync base hash is invalid')
      if (action === 'write' && !/^[0-9a-f]{64}$/.test(final)) throw new RemoteWorkspaceError('COMMAND_FORMAT_INVALID', 'sync final hash is invalid')
      if (action === 'delete' && (final || size)) throw new RemoteWorkspaceError('COMMAND_FORMAT_INVALID', 'delete sync change is invalid')
      if (this.fileSha256(target) !== (base || null)) throw new RemoteWorkspaceError('SYNC_CONFLICT', `${relative} changed after the task snapshot`)
      seen.add(relative); total += size
      normalized.push({ path: relative, action, base_sha256: base, final_sha256: final, size })
    }
    if (total > 256 * 1024 * 1024) throw new RemoteWorkspaceError('PROJECT_TOO_LARGE', 'sync change set exceeds the bounded limit')
    const paths = [...seen].sort()
    if (paths.some((value) => paths.some((other) => other !== value && other.startsWith(`${value}/`)))) throw new RemoteWorkspaceError('SYNC_CONFLICT', 'sync change set contains a file/directory topology change')
    const directory = this.syncDirectory(transactionId)
    if (fs.existsSync(directory)) throw new RemoteWorkspaceError('DESTINATION_EXISTS', 'sync transaction already exists')
    fs.mkdirSync(path.join(directory, 'staged'), { recursive: true, mode: 0o700 })
    fs.mkdirSync(path.join(directory, 'backup'), { mode: 0o700 })
    const manifest = { schema: 'remote_project_sync_v1', transaction_id: transactionId, workspace_id: workspaceId, state: 'PREPARED', changes: normalized, applied: [], created_at: Date.now() / 1000 }
    this.writeSyncJournal(directory, manifest)
    for (const change of normalized) {
      if (change.action === 'write' && change.size === 0) fs.closeSync(fs.openSync(path.join(directory, 'staged', this.syncFileName(change.path)), 'w', 0o600))
    }
    return { ok: true, transaction_id: transactionId, state: 'PREPARED', change_count: normalized.length }
  }

  syncWrite(workspaceId, args) {
    const transactionId = String(args.transaction_id || '')
    const relative = String(args.path || '')
    const offset = Math.max(0, Number(args.offset || 0))
    const encoded = String(args.content_b64 || '')
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new RemoteWorkspaceError('COMMAND_FORMAT_INVALID', 'sync chunk is invalid')
    const data = Buffer.from(encoded, 'base64')
    if (!data.length || data.length > 65536 || sha256(data) !== String(args.content_sha256 || '')) throw new RemoteWorkspaceError('COMMAND_FORMAT_INVALID', 'sync chunk failed integrity validation')
    const { directory, manifest } = this.loadSync(workspaceId, transactionId)
    const change = manifest.changes.find((item) => item.path === relative && item.action === 'write')
    if (!change || manifest.state !== 'PREPARED') throw new RemoteWorkspaceError('PERMISSION_DENIED', 'sync file is not prepared')
    const staged = path.join(directory, 'staged', this.syncFileName(relative))
    const current = fs.existsSync(staged) ? fs.statSync(staged).size : 0
    if (!Number.isInteger(offset) || current !== offset || current + data.length > change.size) throw new RemoteWorkspaceError('SYNC_CONFLICT', 'sync chunk offset is invalid')
    const descriptor = fs.openSync(staged, 'a', 0o600)
    try { fs.writeSync(descriptor, data); fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
    return { ok: true, path: relative, next_offset: offset + data.length }
  }

  rollbackSync(workspaceId, directory, manifest) {
    for (const change of [...(manifest.changes || [])].reverse()) {
      const target = this.policy.path(workspaceId, change.path, { write: true })
      const backup = path.join(directory, 'backup', this.syncFileName(change.path))
      if (fs.existsSync(backup)) {
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.copyFileSync(backup, target)
      } else if (change.action === 'write' && this.fileSha256(target) === change.final_sha256) {
        fs.rmSync(target)
      }
    }
    manifest.state = 'ROLLED_BACK'
    this.writeSyncJournal(directory, manifest)
  }

  syncCommit(workspaceId, args) {
    const transactionId = String(args.transaction_id || '')
    const { directory, manifest } = this.loadSync(workspaceId, transactionId)
    if (manifest.state === 'COMMITTED') return { ok: true, transaction_id: transactionId, state: 'COMMITTED', change_count: manifest.changes.length }
    if (manifest.state !== 'PREPARED') throw new RemoteWorkspaceError('SYNC_CONFLICT', 'sync transaction is not prepared')
    for (const change of manifest.changes) {
      if (change.action === 'write') {
        const staged = path.join(directory, 'staged', this.syncFileName(change.path))
        if (!fs.existsSync(staged) || fs.statSync(staged).size !== change.size || this.fileSha256(staged) !== change.final_sha256) throw new RemoteWorkspaceError('SYNC_CONFLICT', `${change.path} was not transferred completely`)
      }
      const target = this.policy.path(workspaceId, change.path, { write: true })
      if (this.fileSha256(target) !== (change.base_sha256 || null)) throw new RemoteWorkspaceError('SYNC_CONFLICT', `${change.path} changed after the task snapshot`)
    }
    manifest.state = 'APPLYING'; this.writeSyncJournal(directory, manifest)
    try {
      for (const change of manifest.changes) {
        const target = this.policy.path(workspaceId, change.path, { write: true })
        const backup = path.join(directory, 'backup', this.syncFileName(change.path))
        if (fs.existsSync(target)) fs.copyFileSync(target, backup)
        if (change.action === 'delete') fs.rmSync(target)
        else {
          fs.mkdirSync(path.dirname(target), { recursive: true })
          const temporary = path.join(path.dirname(target), `.${path.basename(target)}.work-agent-${transactionId}.tmp`)
          fs.copyFileSync(path.join(directory, 'staged', this.syncFileName(change.path)), temporary)
          const descriptor = fs.openSync(temporary, 'r')
          try { fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
          fs.renameSync(temporary, target)
        }
        manifest.applied.push(change.path); this.writeSyncJournal(directory, manifest)
      }
    } catch (error) {
      this.rollbackSync(workspaceId, directory, manifest)
      throw new RemoteWorkspaceError('SYNC_APPLY_FAILED', 'project sync failed and was rolled back')
    }
    manifest.state = 'COMMITTED'; this.writeSyncJournal(directory, manifest)
    return { ok: true, transaction_id: transactionId, state: 'COMMITTED', change_count: manifest.changes.length }
  }

  syncAbort(workspaceId, args) {
    const transactionId = String(args.transaction_id || '')
    const { directory, manifest } = this.loadSync(workspaceId, transactionId)
    if (manifest.state === 'APPLYING') throw new RemoteWorkspaceError('SYNC_CONFLICT', 'applying sync cannot be aborted')
    if (manifest.state === 'COMMITTED') return { ok: true, transaction_id: transactionId, state: 'COMMITTED' }
    fs.rmSync(directory, { recursive: true })
    return { ok: true, transaction_id: transactionId, state: 'ABORTED' }
  }

  recoverSyncTransactions() {
    let root
    try { root = this.syncRoot() } catch { return }
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const directory = path.join(root, entry.name)
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'))
        if (manifest.state === 'APPLYING') this.rollbackSync(String(manifest.workspace_id), directory, manifest)
        else if (manifest.state === 'COMMITTED' && Date.now() / 1000 - Number(manifest.created_at || 0) > 86400) fs.rmSync(directory, { recursive: true })
      } catch {
        // Retain unreadable journals for inspection; never guess at project changes.
      }
    }
  }

  write(workspaceId, args) {
    const target = this.policy.path(workspaceId, String(args.path || ''), { write: true })
    const data = Buffer.from(String(args.content_b64 || ''), 'base64')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, data)
    return { ok: true, bytes: data.length, content_sha256: sha256(data) }
  }

  edit(workspaceId, args) {
    const target = this.policy.path(workspaceId, String(args.path || ''), { write: true })
    const raw = fs.readFileSync(target)
    const oldValue = Buffer.from(String(args.old_text_b64 || ''), 'base64')
    const replacement = Buffer.from(String(args.replacement_text_b64 || ''), 'base64')
    const count = occurrences(raw, oldValue)
    if (count !== 1) throw new RemoteWorkspaceError(count > 1 ? 'AMBIGUOUS_REPLACEMENT' : 'TEXT_NOT_FOUND', `exact old text matched ${count} times`)
    if (oldValue.equals(replacement)) throw new RemoteWorkspaceError('NO_OP', 'exact replacement is a no-op')
    const index = raw.indexOf(oldValue)
    const updated = Buffer.concat([raw.subarray(0, index), replacement, raw.subarray(index + oldValue.length)])
    fs.writeFileSync(target, updated)
    return { ok: true, replaced: true, bytes: updated.length, content_sha256: sha256(updated), old_text_sha256: sha256(oldValue), replacement_text_sha256: sha256(replacement) }
  }

  mkdir(workspaceId, args) {
    const target = this.policy.path(workspaceId, String(args.path || ''), { write: true })
    fs.mkdirSync(target, { recursive: Boolean(args.parents) })
    return { ok: true, path: String(args.path) }
  }

  move(workspaceId, args) {
    const source = this.policy.path(workspaceId, String(args.source || ''), { write: true })
    const destination = this.policy.path(workspaceId, String(args.destination || ''), { write: true })
    if (!fs.existsSync(source)) throw new RemoteWorkspaceError('WORKSPACE_UNAVAILABLE', 'source path does not exist')
    if (fs.existsSync(destination) && !args.overwrite) throw new RemoteWorkspaceError('DESTINATION_EXISTS', 'destination already exists')
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.renameSync(source, destination)
    return { ok: true, source: String(args.source), destination: String(args.destination) }
  }

  delete(workspaceId, args) {
    const target = this.policy.path(workspaceId, String(args.path || ''), { write: true })
    if (!fs.existsSync(target)) throw new RemoteWorkspaceError('WORKSPACE_UNAVAILABLE', 'path does not exist')
    const info = fs.lstatSync(target)
    if (info.isDirectory() && !args.recursive) throw new RemoteWorkspaceError('DIRECTORY_NOT_EMPTY', 'recursive deletion was not explicitly granted')
    fs.rmSync(target, { recursive: Boolean(args.recursive), force: false })
    return { ok: true, path: String(args.path), deleted: true }
  }

  search(workspaceId, args) {
    const root = this.policy.path(workspaceId, String(args.path || '.'))
    const grantRoot = fs.realpathSync.native(this.policy.grant(workspaceId).local_path)
    const query = String(args.query || '').toLocaleLowerCase()
    const max = clamp(args.max_results, 1, 100, 50)
    const results = []
    const visit = (directory) => {
      if (results.length >= max) return
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (results.length >= max) return
        const candidate = path.join(directory, entry.name)
        try {
          if (!isInside(grantRoot, fs.realpathSync.native(candidate))) continue
          if (entry.isDirectory()) { visit(candidate); continue }
          if (!entry.isFile() || fs.statSync(candidate).size > 1024 * 1024) continue
          const lines = fs.readFileSync(candidate, 'utf8').split(/\r?\n/)
          const index = lines.findIndex((line) => line.toLocaleLowerCase().includes(query))
          if (index >= 0) results.push({ path: path.relative(grantRoot, candidate).split(path.sep).join('/'), line: index + 1, text: lines[index].slice(0, 500) })
        } catch {}
      }
    }
    visit(root)
    return { ok: true, results, truncated: results.length >= max }
  }

  async command(workspaceId, args, timeout, requestId) {
    const command = String(args.command || '')
    if (!command || /[\n`]|\$\(|[;&|<>]/.test(command)) throw new RemoteWorkspaceError('COMMAND_FORMAT_INVALID', 'commands must be one simple argument-safe invocation')
    const argv = splitCommand(command)
    this.validateCommandPaths(workspaceId, argv)
    return this.runArgv(workspaceId, argv, String(args.cwd || '.'), timeout, requestId)
  }

  async preparePythonEnvironment(workspaceId, args, timeout) {
    const root = this.policy.path(workspaceId, String(args.path || '.'), { write: true })
    const metadataNames = ['pyproject.toml', 'requirements.txt', 'requirements-dev.txt', 'requirements-test.txt']
    const metadata = metadataNames.flatMap((name) => {
      const candidate = path.join(root, name)
      try { return fs.statSync(candidate).size <= 1024 * 1024 ? [fs.readFileSync(candidate, 'utf8')] : [] } catch { return [] }
    })
    const testFiles = [
      ...safeMatchingFiles(root, /^test_.*\.py$/),
      ...safeMatchingFiles(path.join(root, 'tests'), /^test_.*\.py$/)
    ]
    if (!metadata.length && !testFiles.length) {
      return { ok: true, status: 'NOT_APPLICABLE', detail: 'no Python project or test surface detected' }
    }
    const pythonPath = this.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python'
    const absolutePython = path.join(root, ...pythonPath.split('/'))
    let created = false
    if (!fs.existsSync(absolutePython)) {
      const candidates = this.platform === 'win32'
        ? [['python', '-m', 'venv', '.venv'], ['py', '-3', '-m', 'venv', '.venv']]
        : [['python3', '-m', 'venv', '.venv'], ['python', '-m', 'venv', '.venv']]
      let result = null
      for (const argv of candidates) {
        try {
          result = await this.runArgv(workspaceId, argv, String(args.path || '.'), timeout)
          if (result.exit_code === 0) break
        } catch {}
      }
      if (!result || result.exit_code !== 0 || !fs.existsSync(absolutePython)) {
        return { ok: true, status: 'FAILED', stage: 'venv', detail: bounded(result?.stderr || result?.stdout || 'Python could not create a project-local virtual environment', 2000) }
      }
      created = true
    }
    const needsPytest = Boolean(args.install_test_runner) && (
      testFiles.length > 0 || metadata.some((value) => value.toLocaleLowerCase().includes('pytest'))
    )
    let pytestInstalled = false
    if (needsPytest) {
      const probe = await this.runArgv(workspaceId, [pythonPath, '-c', 'import pytest'], String(args.path || '.'), timeout)
      if (probe.exit_code !== 0) {
        const install = await this.runArgv(workspaceId, [pythonPath, '-m', 'pip', 'install', 'pytest'], String(args.path || '.'), timeout)
        if (install.exit_code !== 0) {
          return { ok: true, status: 'FAILED', stage: 'pytest', detail: bounded(install.stderr || install.stdout, 2000) }
        }
        pytestInstalled = true
      }
    }
    return { ok: true, status: 'READY', python: pythonPath, created, pytest_installed: pytestInstalled }
  }

  validateCommandPaths(workspaceId, argv) {
    for (const value of argv.slice(1)) {
      const candidate = value.startsWith('--') && value.includes('=') ? value.split('=', 2)[1] : value
      if (/^(\/|\\\\|[A-Za-z]:|\.\.)/.test(candidate)) this.policy.path(workspaceId, candidate)
    }
  }

  async git(workspaceId, args, timeout) {
    const action = String(args.action || 'status')
    const commands = {
      status: ['git', 'status', '--short', '--branch'], diff: ['git', 'diff', '--no-ext-diff'],
      log: ['git', 'log', '-1', '--format=%H'], branch: ['git', 'branch', '--show-current']
    }
    if (action === 'add') {
      this.policy.require(workspaceId, 'write')
      const target = String(args.path || '')
      this.policy.path(workspaceId, target, { write: true })
      commands.add = ['git', 'add', '--', target]
    } else if (action === 'commit') {
      this.policy.require(workspaceId, 'write')
      const message = String(args.message || '')
      if (!message || message.length > 300 || message.includes('\0')) throw new RemoteWorkspaceError('COMMAND_FORMAT_INVALID', 'commit message is invalid')
      commands.commit = ['git', 'commit', '-m', message]
    }
    if (!commands[action]) throw new RemoteWorkspaceError('PERMISSION_DENIED', 'git action is not supported')
    return this.runArgv(workspaceId, commands[action], String(args.cwd || '.'), timeout)
  }

  async runArgv(workspaceId, argv, cwdValue, timeout, requestId = '') {
    const cwd = this.policy.path(workspaceId, cwdValue)
    const started = Date.now()
    return new Promise((resolve, reject) => {
      let stdout = ''
      let stderr = ''
      let timedOut = false
      let processHandle
      try {
        processHandle = spawn(argv[0], argv.slice(1), { cwd, shell: false, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (error) { reject(error); return }
      if (requestId) this.processes.set(requestId, processHandle)
      const timer = setTimeout(() => {
        timedOut = true
        terminateProcess(processHandle)
      }, clamp(timeout, 1, 3600, 600) * 1000)
      processHandle.stdout.on('data', (chunk) => { stdout = bounded(stdout + chunk) })
      processHandle.stderr.on('data', (chunk) => { stderr = bounded(stderr + chunk) })
      processHandle.on('error', (error) => { clearTimeout(timer); if (requestId) this.processes.delete(requestId); reject(error) })
      processHandle.on('close', async (code) => {
        clearTimeout(timer)
        if (requestId) this.processes.delete(requestId)
        const result = { ok: true, exit_code: timedOut ? 124 : (code ?? 1), stdout, stderr, duration_seconds: (Date.now() - started) / 1000, timed_out: timedOut, cancelled: false }
        if (!timedOut && code === 0) {
          try {
            const tree = await quickGitTree(cwd)
            if (/^[0-9a-f]{40,64}$/.test(tree)) result.tree_sha = tree
          } catch {}
        }
        resolve(result)
      })
    })
  }

  cancel(requestId) {
    const processHandle = this.processes.get(String(requestId || ''))
    if (!processHandle) return { ok: true, cancelled: false, detail: 'command is no longer running' }
    terminateProcess(processHandle)
    return { ok: true, cancelled: true }
  }
}

const safeMatchingFiles = (directory, pattern) => {
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && pattern.test(entry.name))
      .map((entry) => path.join(directory, entry.name))
  } catch { return [] }
}

export const publicGrant = (grant) => ({
  workspace_id: grant.workspace_id,
  display_name: grant.display_name,
  capabilities: {
    ...grant.capabilities,
    remote_project_v1: Boolean(grant.capabilities?.read),
    coding_environment_v1: Boolean(grant.capabilities?.write && grant.capabilities?.execute)
  },
  enabled: Boolean(grant.enabled)
})
const normalizePath = (value) => process.platform === 'win32' ? path.normalize(value).toLowerCase() : path.normalize(value)
const slug = (value) => String(value).toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '')
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex')
const clamp = (value, minimum, maximum, fallback) => Math.min(maximum, Math.max(minimum, Number.isFinite(Number(value)) ? Number(value) : fallback))
const occurrences = (haystack, needle) => { if (needle.length === 0) return 0; let count = 0; let offset = 0; while ((offset = haystack.indexOf(needle, offset)) >= 0) { count += 1; offset += needle.length } return count }
const splitCommand = (command) => {
  // The helper intentionally permits only a single, shell-free command. This small parser is
  // enough for quoted argv values and rejects malformed quotation instead of invoking a shell.
  const argv = []; let current = ''; let quote = null; let escaped = false
  for (const char of command.trim()) {
    if (escaped) { current += char; escaped = false; continue }
    if (char === '\\' && quote !== "'") { escaped = true; continue }
    if ((char === "'" || char === '"')) { if (!quote) quote = char; else if (quote === char) quote = null; else current += char; continue }
    if (/\s/.test(char) && !quote) { if (current) { argv.push(current); current = '' }; continue }
    current += char
  }
  if (escaped || quote) throw new RemoteWorkspaceError('COMMAND_FORMAT_INVALID', 'command quoting is invalid')
  if (current) argv.push(current)
  if (!argv.length) throw new RemoteWorkspaceError('COMMAND_FORMAT_INVALID', 'command is empty')
  return argv
}
const terminateProcess = (child) => { if (!child || child.exitCode !== null) return; try { if (process.platform === 'win32') child.kill(); else process.kill(-child.pid, 'SIGTERM') } catch { try { child.kill('SIGKILL') } catch {} } }
const quickGitTree = (cwd) => new Promise((resolve) => { const child = spawn('git', ['rev-parse', 'HEAD^{tree}'], { cwd, shell: false, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }); let text = ''; child.stdout.on('data', (chunk) => { text += chunk }); child.on('close', () => resolve(text.trim())); child.on('error', () => resolve('')) })
const defaultSocket = (endpoint) => new Promise((resolve, reject) => {
  const socket = new WebSocket(endpoint)
  const timeout = setTimeout(() => {
    try { socket.close() } catch {}
    reject(new RemoteWorkspaceError('CLIENT_DISCONNECTED', 'the Work Agent relay connection timed out'))
  }, 15000)
  socket.onopen = () => { clearTimeout(timeout); resolve(socket) }
  socket.onerror = () => { clearTimeout(timeout); reject(new RemoteWorkspaceError('CLIENT_DISCONNECTED', 'the Work Agent relay could not be reached')) }
})
const receiveJson = (socket) => new Promise((resolve, reject) => {
  const clear = () => clearTimeout(timeout)
  const timeout = setTimeout(() => {
    socket.onmessage = previous
    reject(new RemoteWorkspaceError('CLIENT_DISCONNECTED', 'the Work Agent relay timed out'))
  }, 15000)
  const previous = socket.onmessage
  const previousClose = socket.onclose
  socket.onmessage = async (event) => {
    clear()
    socket.onmessage = previous
    socket.onclose = previousClose
    try { resolve(JSON.parse(await messageText(event.data))) } catch { reject(new RemoteWorkspaceError('CLIENT_DISCONNECTED', 'the Work Agent relay sent invalid JSON')) }
  }
  socket.onclose = () => {
    clear()
    socket.onmessage = previous
    socket.onclose = previousClose
    reject(new RemoteWorkspaceError('CLIENT_DISCONNECTED', 'the Work Agent relay disconnected during authentication'))
  }
})
const sendJson = (socket, value) => socket.send(JSON.stringify(value))
const messageText = async (data) => typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : data?.text ? data.text() : String(data)
