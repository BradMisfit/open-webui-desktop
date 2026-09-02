/**
 * Deterministic source guards for Security Workspace Phase C (WebSocket repeater).
 * The controlled WS send must be scope-gated and bounded (wait / frame count /
 * frame size) so it can never become an unbounded or out-of-scope primitive.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(__dirname, '..', rel), 'utf-8');

test('WS repeater is scope-gated', () => {
	const src = read('src/main/security/wsRepeater.ts');
	assert.match(src, /isInScope\(httpish\)/, 'ws(s) target maps to host scope authorization');
	assert.match(src, /outOfScope: true/);
	assert.match(src, /only ws\(s\):\/\/ URLs/i, 'only ws/wss schemes accepted');
});

test('WS repeater is bounded (wait / frames / size)', () => {
	const src = read('src/main/security/wsRepeater.ts');
	assert.match(src, /MAX_WAIT_MS/);
	assert.match(src, /MAX_FRAMES/);
	assert.match(src, /MAX_FRAME_BYTES/);
	// hard cap on the wait window and the frame count
	assert.match(src, /Math\.min\(Math\.max\(Number\(req\.waitMs\)/);
	assert.match(src, /frames!\.length >= MAX_FRAMES/);
});
