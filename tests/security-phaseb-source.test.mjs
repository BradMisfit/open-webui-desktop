/**
 * Deterministic source guards for Security Workspace Phase B (Intercept +
 * Repeater). No Electron/GPU: asserts the security-critical invariants are
 * present in the shell source — the Repeater is scope-gated and reuses protected
 * auth without leaking it, and Intercept fails safe (a held request auto-forwards
 * and detach releases the queue) so a stuck UI never wedges the browser.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(__dirname, '..', rel), 'utf-8');

test('Repeater is scope-gated and reuses protected auth without leaking it', () => {
	const src = read('src/main/security/repeater.ts');
	assert.match(src, /isInScope\(url\)/, 'repeater must refuse out-of-scope targets');
	assert.match(src, /outOfScope: true/, 'out-of-scope refusal is explicit');
	// protected-auth: a "[REDACTED]" header is filled from the raw captured request
	assert.match(src, /REDACTED/, 'protected-auth substitution keys off the redaction sentinel');
	assert.match(src, /getRawRequest/, 'raw headers come from the main-process capture store');
	assert.match(src, /drop the header rather than send the literal/i, 'never send the literal [REDACTED]');
});

test('captureEngine keeps raw headers out of any IPC/model projection', () => {
	const src = read('src/main/security/captureEngine.ts');
	// getRawRequest is documented main-process-only and used only by the repeater
	assert.match(src, /getRawRequest/);
	assert.match(src, /NEVER exposed over IPC/i);
});

test('Intercept fails safe: auto-forward timer + detach releases the queue', () => {
	const src = read('src/main/security/captureEngine.ts');
	assert.match(src, /INTERCEPT_FAILSAFE_MS/, 'a fail-safe timeout exists');
	assert.match(src, /setTimeout\([\s\S]*?continueRequest/, 'held requests auto-continue on timeout');
	assert.match(src, /Fetch\.continueRequest/, 'forward uses Fetch.continueRequest');
	assert.match(src, /Fetch\.failRequest/, 'drop uses Fetch.failRequest');
	// on detach, queued requests for that tab are released
    assert.match(src, /for \(const p of \[\.\.\.paused\.values\(\)\]\)/);
});

test('Intercept off releases anything still held', () => {
	const src = read('src/main/security/captureEngine.ts');
	const seg = src.split('export function setIntercept')[1].slice(0, 900);
	assert.match(seg, /if \(!interceptEnabled\)/);
	assert.match(seg, /continueRequest\(p, null\)/, 'disabling intercept forwards held requests');
});
