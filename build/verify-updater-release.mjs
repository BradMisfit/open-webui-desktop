#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const CUSTOM_UPDATE_REPOSITORY = Object.freeze({
  provider: 'github',
  owner: 'BradMisfit',
  repo: 'open-webui-desktop'
})

// Electron-builder requires a SemVer application version.  Custom builds use
// the upstream-compatible numeric base plus an ordered custom prerelease.
export const CUSTOM_VERSION = /^\d+\.\d+\.\d+-bradmisfit\.\d+$/

const fail = (message) => {
  throw new Error(`Invalid Desktop updater release: ${message}`)
}

const scalar = (value) => value.replace(/^['"]|['"]$/g, '').trim()

export function parseLatestYml(source) {
  const document = { files: [] }
  let current = null
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:-\s+)?(version|url|sha512|size|path):\s*(.+)\s*$/)
    if (!match) continue
    const [, key, raw] = match
    const value = scalar(raw)
    if (line.trimStart().startsWith('- ')) {
      current = { [key]: value }
      document.files.push(current)
    } else if (current && ['url', 'sha512', 'size'].includes(key) && line.startsWith('    ')) {
      current[key] = value
    } else {
      document[key] = value
    }
  }
  return document
}

const safeAssetName = (value) => typeof value === 'string'
  && value.length > 0
  && value === path.basename(value)
  && !value.includes('..')

const sha512 = (file) => crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64')

const parseVersion = (value, { requireCustom = false } = {}) => {
  const match = String(value).match(/^(\d+)\.(\d+)\.(\d+)(?:-bradmisfit\.(\d+))?$/)
  if (!match || (requireCustom && !match[4])) fail(`unsupported version ${value}`)
  return match.slice(1).map((item) => Number(item ?? 0))
}

export function customUpdateAvailable(installedVersion, availableVersion) {
  const installed = parseVersion(installedVersion)
  const available = parseVersion(availableVersion, { requireCustom: true })
  for (let index = 0; index < available.length; index += 1) {
    if (available[index] !== installed[index]) return available[index] > installed[index]
  }
  return false
}

export function controlledReleaseAssetUrl(version, assetName) {
  if (!CUSTOM_VERSION.test(version)) fail(`version ${version} is not a custom release`)
  if (!safeAssetName(assetName)) fail(`unsafe artifact name ${assetName}`)
  return `https://github.com/${CUSTOM_UPDATE_REPOSITORY.owner}/${CUSTOM_UPDATE_REPOSITORY.repo}/releases/download/v${version}/${encodeURIComponent(assetName)}`
}

export function verifyWindowsUpdaterRelease({ manifestPath, artifactDirectory, expectedVersion }) {
  const manifest = parseLatestYml(fs.readFileSync(manifestPath, 'utf8'))
  if (!CUSTOM_VERSION.test(manifest.version ?? '')) fail(`version ${manifest.version ?? '<missing>'} is not a custom SemVer release`)
  if (expectedVersion && manifest.version !== expectedVersion) fail(`manifest version ${manifest.version} does not match ${expectedVersion}`)
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) fail('latest.yml has no files')

  const names = new Set()
  for (const entry of manifest.files) {
    if (!safeAssetName(entry.url)) fail(`unsafe artifact name ${entry.url ?? '<missing>'}`)
    if (names.has(entry.url)) fail(`duplicate artifact ${entry.url}`)
    names.add(entry.url)
    const artifact = path.join(artifactDirectory, entry.url)
    if (!fs.existsSync(artifact)) fail(`missing artifact ${entry.url}`)
    if (String(fs.statSync(artifact).size) !== String(entry.size)) fail(`size mismatch for ${entry.url}`)
    if (sha512(artifact) !== entry.sha512) fail(`sha512 mismatch for ${entry.url}`)
  }

  if (!safeAssetName(manifest.path) || !names.has(manifest.path)) fail('latest.yml primary path is not a declared artifact')
  const primary = path.join(artifactDirectory, manifest.path)
  if (sha512(primary) !== manifest.sha512) fail('latest.yml primary sha512 mismatch')
  if (!fs.existsSync(`${primary}.blockmap`)) fail(`missing blockmap for ${manifest.path}`)
  return { version: manifest.version, artifacts: [...names] }
}

const args = process.argv.slice(2)
if (args.length) {
  const argument = (name) => {
    const value = args[args.indexOf(name) + 1]
    if (!value) fail(`missing ${name} argument`)
    return value
  }
  const result = verifyWindowsUpdaterRelease({
    manifestPath: argument('--manifest'),
    artifactDirectory: argument('--artifact-directory'),
    expectedVersion: args.includes('--version') ? argument('--version') : undefined
  })
  process.stdout.write(`Verified Desktop updater release ${result.version}: ${result.artifacts.join(', ')}\n`)
}
