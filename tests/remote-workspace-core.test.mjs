import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  REMOTE_WORKSPACE_PROTOCOL,
  RemoteWorkspaceClient,
  RemoteWorkspaceError,
  WorkspacePolicy,
  capabilitiesForPreset,
  parseBrowseLaunch
} from '../src/main/remote-workspace-core.mjs'

const temporaryRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'owui-desktop-workspace-'))
const launch = (endpoint = 'wss://work.example.test/v1/remote-workspaces/client/connect') =>
  `work-agent://browse?endpoint=${encodeURIComponent(endpoint)}&pair_id=rwp_${'a'.repeat(32)}&code=${'x'.repeat(24)}&preset=developer`

test('accepts WSS, localhost, and RFC1918 workspace relays but rejects public HTTP', () => {
  assert.equal(parseBrowseLaunch(launch()).endpoint, 'wss://work.example.test/v1/remote-workspaces/client/connect')
  for (const endpoint of ['ws://localhost:3000/connect', 'ws://10.2.3.4/connect', 'ws://172.16.3.4/connect', 'ws://192.168.3.4/connect']) {
    assert.equal(parseBrowseLaunch(launch(endpoint)).endpoint, endpoint)
  }
  assert.throws(() => parseBrowseLaunch(launch('ws://198.51.100.8/connect')), (error) => error.code === 'INVALID_HELPER_URL')
})

test('workspace containment rejects traversal, absolute paths, and symlink escape', () => {
  const root = temporaryRoot()
  const outside = temporaryRoot()
  fs.mkdirSync(path.join(root, 'nested'))
  fs.writeFileSync(path.join(root, 'nested', 'ok.txt'), 'ok')
  fs.symlinkSync(outside, path.join(root, 'escape'))
  const policy = new WorkspacePolicy([{ workspace_id: 'project', local_path: root, enabled: true, capabilities: capabilitiesForPreset('developer') }])
  assert.match(policy.path('project', 'nested/ok.txt'), /ok\.txt$/)
  for (const unsafe of ['../outside.txt', '/etc/passwd', 'C:\\Windows\\system.ini', 'escape/file.txt']) {
    assert.throws(() => policy.path('project', unsafe), (error) => error.code === 'PATH_OUTSIDE_WORKSPACE')
  }
})

test('typed workspace operations are capability-scoped and exact edit remains fail-closed', async () => {
  const root = temporaryRoot()
  fs.writeFileSync(path.join(root, 'notes.txt'), 'alpha\nbeta\nalpha\n')
  const client = new RemoteWorkspaceClient({ configPath: path.join(root, '.desktop-workspace.json') })
  const grant = client.addWorkspace('Project', root, capabilitiesForPreset('developer'))
  const oldText = Buffer.from('beta').toString('base64')
  const newText = Buffer.from('gamma').toString('base64')
  const result = await client.operation(grant.workspace_id, 'edit', { path: 'notes.txt', old_text_b64: oldText, replacement_text_b64: newText }, 10)
  assert.equal(result.replaced, true)
  assert.equal(fs.readFileSync(path.join(root, 'notes.txt'), 'utf8'), 'alpha\ngamma\nalpha\n')
  await assert.rejects(
    client.operation(grant.workspace_id, 'edit', { path: 'notes.txt', old_text_b64: Buffer.from('alpha').toString('base64'), replacement_text_b64: newText }, 10),
    (error) => error.code === 'AMBIGUOUS_REPLACEMENT'
  )
  await assert.rejects(
    client.operation(grant.workspace_id, 'edit', { path: 'notes.txt', old_text_b64: newText, replacement_text_b64: newText }, 10),
    (error) => error.code === 'NO_OP'
  )
})

test('private identity is persistent locally yet status exposes only opaque metadata', () => {
  const root = temporaryRoot()
  const client = new RemoteWorkspaceClient({ configPath: path.join(root, 'config.json') })
  const key = client.ensureKey()
  const signature = crypto.sign(null, Buffer.from('challenge'), key)
  assert.equal(crypto.verify(null, Buffer.from('challenge'), crypto.createPublicKey(key), signature), true)
  const id = client.deviceId()
  const saved = fs.readFileSync(path.join(root, 'config.json'), 'utf8')
  assert.match(saved, /BEGIN PRIVATE KEY/)
  const status = client.publicStatus()
  assert.equal(status.device_id, id)
  assert.equal(JSON.stringify(status).includes('PRIVATE KEY'), false)
  assert.equal(JSON.stringify(status).includes(root), false)
})

test('protocol mismatch fails clearly before any workspace operation', () => {
  const client = new RemoteWorkspaceClient({ configPath: path.join(temporaryRoot(), 'config.json') })
  assert.equal(REMOTE_WORKSPACE_PROTOCOL, 1)
  assert.throws(() => client.assertProtocol(2), (error) => error instanceof RemoteWorkspaceError && error.code === 'DESKTOP_UPDATE_REQUIRED')
})

test('Desktop pair and reconnect frames identify the protocol-bearing client', async () => {
  const configPath = path.join(temporaryRoot(), 'config.json')
  const frames = []
  const socket = {
    onmessage: null,
    send(frame) {
      frames.push(frame)
      const request = JSON.parse(frame)
      if (request.type === 'pair') setTimeout(() => socket.onmessage?.({ data: JSON.stringify({ type: 'paired', device_id: request.device_id }) }), 0)
    },
    close() {}
  }
  const client = new RemoteWorkspaceClient({
    configPath,
    connectSocket: async () => {
      setTimeout(() => socket.onmessage?.({ data: JSON.stringify({ type: 'challenge', nonce: Buffer.alloc(32).toString('base64url'), protocol: REMOTE_WORKSPACE_PROTOCOL }) }), 0)
      return socket
    }
  })
  await client.open('wss://example.test/relay', { pairId: 'rwp_' + 'a'.repeat(32), code: 'x'.repeat(20) })
  const pair = JSON.parse(frames[0])
  assert.equal(pair.client_kind, 'open-webui-desktop')
  assert.equal(pair.protocol, REMOTE_WORKSPACE_PROTOCOL)
})

test('a post-picker relay rejection is returned as its server typed error', async () => {
  const root = temporaryRoot()
  const frames = []
  const socket = {
    onmessage: null,
    onclose: null,
    send(frame) {
      frames.push(JSON.parse(frame))
      setTimeout(() => socket.onmessage?.({ data: JSON.stringify({
        type: 'error', code: 'DESKTOP_UPDATE_REQUIRED', detail: 'Desktop update required to use Remote Workspaces.'
      }) }), 0)
    },
    close() {}
  }
  class PickerClient extends RemoteWorkspaceClient {
    async selectFolder() { return root }
  }
  const client = new PickerClient({
    configPath: path.join(root, 'config.json'),
    connectSocket: async () => {
      setTimeout(() => socket.onmessage?.({ data: JSON.stringify({ type: 'challenge', nonce: Buffer.alloc(32).toString('base64url'), protocol: REMOTE_WORKSPACE_PROTOCOL }) }), 0)
      return socket
    }
  })
  await assert.rejects(
    client.browse({ launch_url: launch() }),
    (error) => error instanceof RemoteWorkspaceError && error.code === 'DESKTOP_UPDATE_REQUIRED'
  )
  assert.equal(frames[0].type, 'pair')
})

test('a saved unpaired device ID retries pair rather than attempting authentication', async () => {
  const root = temporaryRoot()
  const configPath = path.join(root, 'config.json')
  const frames = []
  const socket = {
    onmessage: null,
    send(frame) {
      frames.push(JSON.parse(frame))
      const request = JSON.parse(frame)
      setTimeout(() => socket.onmessage?.({ data: JSON.stringify({ type: 'paired', device_id: request.device_id }) }), 0)
    },
    close() {}
  }
  const client = new RemoteWorkspaceClient({
    configPath,
    connectSocket: async () => {
      setTimeout(() => socket.onmessage?.({ data: JSON.stringify({ type: 'challenge', nonce: Buffer.alloc(32).toString('base64url'), protocol: REMOTE_WORKSPACE_PROTOCOL }) }), 0)
      return socket
    }
  })
  client.deviceId()
  await client.open('wss://example.test/relay', { pairId: 'rwp_' + 'a'.repeat(32), code: 'x'.repeat(20) })
  assert.equal(frames[0].type, 'pair')
})

test('an enrolled Desktop authenticates a fresh Browse launch with its correlation ID', async () => {
  const root = temporaryRoot()
  const configPath = path.join(root, 'config.json')
  const frames = []
  const socket = {
    onmessage: null,
    send(frame) {
      frames.push(JSON.parse(frame))
      const request = JSON.parse(frame)
      if (request.type === 'authenticate') {
        setTimeout(() => socket.onmessage?.({ data: JSON.stringify({ type: 'authenticated', device_id: request.device_id }) }), 0)
      }
    },
    close() {}
  }
  class PickerClient extends RemoteWorkspaceClient {
    async selectFolder() { return root }
  }
  const client = new PickerClient({
    configPath,
    connectSocket: async () => {
      setTimeout(() => socket.onmessage?.({ data: JSON.stringify({ type: 'challenge', nonce: Buffer.alloc(32).toString('base64url'), protocol: REMOTE_WORKSPACE_PROTOCOL }) }), 0)
      return socket
    }
  })
  client.deviceId()
  client.config.enrolled_endpoint = 'wss://work.example.test/v1/remote-workspaces/client/connect'
  client.save()
  await client.browse({ launch_url: launch() })
  assert.equal(frames[0].type, 'authenticate')
  assert.equal(frames[0].helper_launch_id, 'rwp_' + 'a'.repeat(32))
})

test('workspace bridge failures return a bounded typed response to the guest', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src/renderer/src/lib/components/Main/Connections/Content.svelte'), 'utf8')
  const main = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8')
  assert.match(source, /DESKTOP_WORKSPACE_UNAVAILABLE/)
  assert.match(source, /requestData\.type\.startsWith\('workspace:'\)/)
  assert.match(source, /_responseId: requestData\._requestId/)
  assert.match(main, /workspaceBridgeFailure/)
  assert.match(main, /return workspaceBridgeFailure\(error\?\.code\)/)
})

test('a failed first enrollment remains retryable and does not mistake a saved device ID for trust', () => {
  const root = temporaryRoot()
  const client = new RemoteWorkspaceClient({ configPath: path.join(root, 'config.json') })
  const id = client.deviceId()
  assert.ok(id.startsWith('desktop-'))
  assert.equal(client.config.enrolled_endpoint, undefined)
  assert.equal(client.config.endpoint, undefined)
})

// A relay socket that completes the handshake and answers heartbeats until it
// goes silent (simulating a relay that dropped the session with no close frame).
const relaySocket = (state) => {
  const socket = {
    readyState: 1,
    onmessage: null,
    onclose: null,
    closed: false,
    sent: [],
    send(frame) {
      socket.sent.push(frame)
      const request = JSON.parse(frame)
      const reply = (value) => setTimeout(() => socket.onmessage?.({ data: JSON.stringify(value) }), 0)
      if (request.type === 'pair') reply({ type: 'paired', device_id: request.device_id })
      if (request.type === 'authenticate') reply({ type: 'authenticated', device_id: request.device_id })
      if (request.type === 'heartbeat' && !state.silent) reply({ type: 'heartbeat_ack' })
    },
    close() { socket.closed = true; socket.readyState = 3 }
  }
  return socket
}

const connectingClient = (configPath, sockets, state, options = {}) => new RemoteWorkspaceClient({
  configPath,
  heartbeatMs: 20, staleMs: 80, reconnectBaseMs: 10, reconnectMaxMs: 40,
  ...options,
  connectSocket: async () => {
    if (state.unreachable) throw new RemoteWorkspaceError('CLIENT_DISCONNECTED', 'unreachable')
    const socket = relaySocket(state)
    sockets.push(socket)
    setTimeout(() => socket.onmessage?.({ data: JSON.stringify({ type: 'challenge', nonce: Buffer.alloc(32).toString('base64url'), protocol: REMOTE_WORKSPACE_PROTOCOL }) }), 0)
    return socket
  }
})

const waitFor = async (predicate, ms = 2000) => {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not reached')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('a connected client sends heartbeats and stays connected while the relay answers', async () => {
  const sockets = []
  const state = { silent: false }
  const client = connectingClient(path.join(temporaryRoot(), 'config.json'), sockets, state)
  await client.open('wss://example.test/relay', { pairId: 'rwp_' + 'a'.repeat(32), code: 'x'.repeat(20) })
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.ok(sockets[0].sent.some((frame) => JSON.parse(frame).type === 'heartbeat'))
  assert.equal(sockets.length, 1)
  assert.equal(client.connected, true)
  client.stopHeartbeat()
})

test('a silent link (relay dropped the session, no close frame) is detected and reconnected', async () => {
  const sockets = []
  const state = { silent: false }
  const client = connectingClient(path.join(temporaryRoot(), 'config.json'), sockets, state)
  await client.open('wss://example.test/relay', { pairId: 'rwp_' + 'a'.repeat(32), code: 'x'.repeat(20) })
  state.silent = true
  await waitFor(() => sockets.length >= 2 && client.connected)
  assert.equal(sockets[0].closed, true)
  state.silent = false
  client.stopHeartbeat()
})

test('a failed resume at startup keeps retrying instead of staying offline', async () => {
  const sockets = []
  const state = { silent: false, unreachable: true }
  const configPath = path.join(temporaryRoot(), 'config.json')
  const seed = connectingClient(configPath, [], { silent: false })
  await seed.open('wss://example.test/relay', { pairId: 'rwp_' + 'a'.repeat(32), code: 'x'.repeat(20) })
  seed.stopHeartbeat()
  const client = connectingClient(configPath, sockets, state)
  await assert.rejects(client.resume())
  state.unreachable = false
  await waitFor(() => client.connected)
  client.stopHeartbeat()
})
