/**
 * Deterministic unit tests for the Security Workspace authorized-scope engine
 * (src/main/security/scope.ts). No Electron / GPU required: the module is pure
 * logic, transpiled on the fly with esbuild and exercised directly. Scope is the
 * safety backbone — every active tool gates on isInScope — so these guard host,
 * wildcard, IP, CIDR, port, and the enabled/empty fail-closed behavior.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import esbuild from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function loadScope() {
	const srcPath = join(__dirname, '..', 'src', 'main', 'security', 'scope.ts');
	const ts = readFileSync(srcPath, 'utf-8');
	const { code } = await esbuild.transform(ts, { loader: 'ts', format: 'esm' });
	const dir = await mkdtemp(join(tmpdir(), 'scope-'));
	const out = join(dir, 'scope.mjs');
	await writeFile(out, code, 'utf-8');
	return import(out);
}

test('empty scope fails closed', async () => {
	const s = await loadScope();
	s.setScope({ enabled: true, targets: [] });
	assert.equal(s.isInScope('https://example.com'), false);
});

test('host + path match, other hosts refused', async () => {
	const s = await loadScope();
	s.setScope({ enabled: true, targets: ['example.com'] });
	assert.equal(s.isInScope('https://example.com/login?x=1'), true);
	assert.equal(s.isInScope('https://evil.com/'), false);
	assert.equal(s.isInScope('sub.example.com'), false); // exact host, not subdomain
});

test('wildcard matches base + subdomains only', async () => {
	const s = await loadScope();
	s.setScope({ enabled: true, targets: ['*.lab.local'] });
	assert.equal(s.isInScope('https://api.lab.local/'), true);
	assert.equal(s.isInScope('https://lab.local/'), true);
	assert.equal(s.isInScope('https://lab.local.evil.com/'), false);
});

test('CIDR range membership', async () => {
	const s = await loadScope();
	s.setScope({ enabled: true, targets: ['10.0.0.0/24'] });
	assert.equal(s.isInScope('http://10.0.0.5'), true);
	assert.equal(s.isInScope('http://10.0.0.255'), true);
	assert.equal(s.isInScope('http://10.0.1.5'), false);
});

test('port constraint is enforced when present', async () => {
	const s = await loadScope();
	s.setScope({ enabled: true, targets: ['127.0.0.1:8080'] });
	assert.equal(s.isInScope('http://127.0.0.1:8080/api'), true);
	assert.equal(s.isInScope('http://127.0.0.1:9090/api'), false);
});

test('disabling scope refuses everything (fail closed)', async () => {
	const s = await loadScope();
	s.setScope({ enabled: false, targets: ['example.com'] });
	assert.equal(s.isInScope('https://example.com'), false);
});

test('getScope round-trips declared targets', async () => {
	const s = await loadScope();
	s.setScope({ enabled: true, targets: ['example.com', '10.0.0.0/24', '*.x.io'] });
	const st = s.getScope();
	assert.equal(st.enabled, true);
	assert.equal(st.rules.length, 3);
	assert.deepEqual(st.rules.map((r) => r.kind).sort(), ['cidr', 'host', 'wildcard']);
});
