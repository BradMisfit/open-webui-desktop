import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  CUSTOM_VERSION,
  controlledReleaseAssetUrl,
  customUpdateAvailable,
  verifyWindowsUpdaterRelease
} from '../build/verify-updater-release.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const sha512 = (value) => crypto.createHash('sha512').update(value).digest('base64')

test('custom updater feed is application-controlled and never targets vanilla upstream', () => {
  const builder = read('electron-builder.yml')
  const development = read('dev-app-update.yml')
  const updater = read('src/main/updater.ts')
  const about = read('src/renderer/src/lib/components/Main/Settings/About.svelte')
  const packageJson = JSON.parse(read('package.json'))

  for (const source of [builder, development, updater]) {
    assert.match(source, /owner:\s*BradMisfit|owner:\s*'BradMisfit'/)
    assert.match(source, /repo:\s*open-webui-desktop|repo:\s*'open-webui-desktop'/)
    assert.doesNotMatch(source, /owner:\s*open-webui|repo:\s*desktop\s*$/m)
  }
  assert.equal(packageJson.version, '0.0.21-bradmisfit.1')
  assert.match(packageJson.version, CUSTOM_VERSION)
  assert.match(about, /https:\/\/github\.com\/BradMisfit\/open-webui-desktop\/releases/)
  assert.doesNotMatch(about, /https:\/\/github\.com\/open-webui\/desktop/)
})

test('stable application identity and restricted updater bridge are retained', () => {
  const builder = read('electron-builder.yml')
  const preload = read('src/preload/index.ts')
  const main = read('src/main/index.ts')
  const updater = read('src/main/updater.ts')

  assert.match(builder, /^appId:\s*com\.openwebui\.desktop$/m)
  assert.match(builder, /^productName:\s*Open WebUI$/m)
  assert.match(builder, /^\s*executableName:\s*open-webui$/m)
  for (const method of ['checkForUpdates', 'downloadUpdate', 'installUpdate']) {
    assert.match(preload, new RegExp(`${method}: \\(\\) => ipcRenderer\\.invoke\\('updater:`))
  }
  assert.match(main, /ipcMain\.handle\('updater:check', \(\) => checkForUpdates\(\)\)/)
  assert.doesNotMatch(preload, /setFeedURL|updateUrl|updater:configure/)
  assert.doesNotMatch(updater, /setFeedURL\([^C]/)
  for (const event of ['checking-for-update', 'update-available', 'update-downloaded', 'error']) {
    assert.match(updater, new RegExp(`autoUpdater\\.on\\('${event}'`))
  }
  assert.match(updater, /autoUpdater\.downloadUpdate\(\)/)
  assert.match(updater, /autoUpdater\.quitAndInstall\(false, true\)/)
})

test('latest.yml validates the exact artifact, hash, and blockmap', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-updater-'))
  const artifact = 'open-webui-x64-setup.exe'
  const payload = Buffer.from('controlled custom desktop artifact')
  fs.writeFileSync(path.join(directory, artifact), payload)
  fs.writeFileSync(path.join(directory, `${artifact}.blockmap`), 'blockmap')
  const digest = sha512(payload)
  const manifest = [
    'version: 0.0.21-bradmisfit.1',
    'files:',
    `  - url: ${artifact}`,
    `    sha512: ${digest}`,
    `    size: ${payload.length}`,
    `path: ${artifact}`,
    `sha512: ${digest}`
  ].join('\n')
  const manifestPath = path.join(directory, 'latest.yml')
  fs.writeFileSync(manifestPath, manifest)
  assert.deepEqual(verifyWindowsUpdaterRelease({ manifestPath, artifactDirectory: directory }), {
    version: '0.0.21-bradmisfit.1',
    artifacts: [artifact]
  })
  fs.writeFileSync(path.join(directory, artifact), 'tampered')
  assert.throws(() => verifyWindowsUpdaterRelease({ manifestPath, artifactDirectory: directory }), /size mismatch|sha512 mismatch/)
})

test('custom version selection resolves only our controlled public release assets', () => {
  assert.equal(customUpdateAvailable('0.0.20', '0.0.21-bradmisfit.1'), true)
  assert.equal(customUpdateAvailable('0.0.21-bradmisfit.1', '0.0.21-bradmisfit.2'), true)
  assert.equal(customUpdateAvailable('0.0.21-bradmisfit.2', '0.0.21-bradmisfit.1'), false)
  assert.equal(
    controlledReleaseAssetUrl('0.0.21-bradmisfit.1', 'open-webui-x64-setup.exe'),
    'https://github.com/BradMisfit/open-webui-desktop/releases/download/v0.0.21-bradmisfit.1/open-webui-x64-setup.exe'
  )
  assert.throws(() => controlledReleaseAssetUrl('0.0.21', 'open-webui-x64-setup.exe'), /custom release/)
  assert.throws(() => controlledReleaseAssetUrl('0.0.21-bradmisfit.1', '../outside.exe'), /unsafe artifact/)
})

test('release workflow is manual, validates artifacts, and publishes only a draft to the controlled feed', () => {
  const workflow = read('.github/workflows/release.yml')
  assert.match(workflow, /workflow_dispatch:/)
  assert.match(workflow, /create_draft_release:/)
  assert.match(workflow, /repository:\s*BradMisfit\/open-webui-desktop/)
  assert.match(workflow, /GITHUB_TOKEN:\s*\$\{\{ secrets\.RELEASE_FEED_TOKEN \}\}/)
  assert.match(workflow, /verify-updater-release\.mjs/)
  assert.match(workflow, /draft:\s*true/)
  assert.doesNotMatch(workflow, /repository:\s*open-webui\/desktop/)
})

test('Remote Workspace bridge and protocol compatibility remain isolated from updater work', () => {
  const preload = read('src/preload/index.ts')
  const core = read('src/main/remote-workspace-core.mjs')
  assert.match(preload, /workspaceBrowse: \(request: \{ launch_url\?: string \}\)/)
  assert.match(preload, /workspaceStatus: \(\) => ipcRenderer\.invoke\('workspace:status'\)/)
  assert.match(core, /DESKTOP_UPDATE_REQUIRED/)
  assert.doesNotMatch(preload, /workspace[A-Za-z]*:\s*\([^)]*path/)
})
