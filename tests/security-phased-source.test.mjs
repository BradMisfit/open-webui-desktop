/**
 * Deterministic source guards for Security Workspace Phase D (Fuzzer + passive
 * analysis + findings). The Fuzzer must be hard-bounded and scope-gated so it can
 * never become an unbounded/out-of-scope mass-request primitive; passive analysis
 * must cover the core checks; findings must dedupe and cap.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(__dirname, '..', rel), 'utf-8');

test('Fuzzer is hard-bounded and scope-gated', () => {
	const src = read('src/main/security/fuzzer.ts');
	assert.match(src, /ABS_MAX_REQUESTS\s*=\s*1000/, 'absolute request cap');
	assert.match(src, /MAX_CONCURRENCY\s*=\s*10/, 'concurrency cap');
	assert.match(src, /isInScope\(/, 'fuzz target is scope-gated');
	assert.match(src, /sendRepeaterRequest/, 'sends go through the trusted scope-gated repeater');
	assert.match(src, /job\.cancelled/, 'cancelable');
	assert.match(src, /rateLimitMs/, 'rate limit');
});

test('Passive scan covers the core checks', () => {
	const src = read('src/main/security/captureEngine.ts');
	for (const marker of ['runPassiveScan', 'strict-transport-security', 'content-security-policy', 'access-control-allow-origin', 'set-cookie', 'sourceMappingURL', 'SECRET_PATTERNS']) {
		assert.match(src, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `missing passive check: ${marker}`);
	}
	// permissive-CORS-with-credentials is a high finding
	assert.match(src, /Permissive CORS with credentials/);
});

test('Findings store dedupes and caps', () => {
	const src = read('src/main/security/findings.ts');
	assert.match(src, /MAX_FINDINGS\s*=\s*500/);
	assert.match(src, /keyOf/, 'dedup key');
	assert.match(src, /existing\.has\(k\)/, 'dedup on add');
	assert.match(src, /generateReport/, 'report generation');
});
