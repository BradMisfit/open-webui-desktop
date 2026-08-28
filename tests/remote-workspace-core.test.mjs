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

test('a failed first enrollment remains retryable and does not mistake a saved device ID for trust', () => {
  const root = temporaryRoot()
  const client = new RemoteWorkspaceClient({ configPath: path.join(root, 'config.json') })
  const id = client.deviceId()
  assert.ok(id.startsWith('desktop-'))
  assert.equal(client.config.enrolled_endpoint, undefined)
  assert.equal(client.config.endpoint, undefined)
})
