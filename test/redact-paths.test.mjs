import { createBridgeLogger } from '../lib/log.js';
import { redactMessage, redactText, redactValue, containsSecret } from '../lib/redact.js';
import { pathsEqual, normalizePath, isPathInsideWorkspace } from '../lib/paths.js';
import { hasShellControlOperator, extractCommand } from '../lib/command-safety.js';


import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('redact', () => {
  it('masks bearer tokens', () => {
    const text = redactText('Authorization: Bearer abcdefghijklmnop123 and more');
    assert.ok(!text.includes('abcdefghijklmnop123'));
    assert.ok(text.includes('[REDACTED]'));
  });

  it('masks api keys', () => {
    assert.ok(redactText('sk-abcdefghijklmnopqrst').includes('[REDACTED]'));
    assert.ok(containsSecret('api_key=secretvalue123'));
    assert.ok(!containsSecret('plain text without secrets'));
  });

  it('deep-redacts object values by key', () => {
    const out = redactValue({ token: 'abc123', nested: { password: 'x', ok: 1 }, list: ['sk-abcdefghi'] });
    assert.equal(out.token, '[REDACTED]');
    assert.equal(out.nested.password, '[REDACTED]');
    assert.equal(out.nested.ok, 1);
    assert.ok(out.list[0].includes('[REDACTED]'));
  });

  it('never mutates input', () => {
    const input = { token: 'abc' };
    redactValue(input);
    assert.equal(input.token, 'abc');
  });

  it('redactMessage joins payload', () => {
    const line = redactMessage('token=abc12345', { a: 1 });
    assert.ok(!line.includes('abc12345'));
  });
});

describe('paths', () => {
  it('compares identity', () => {
    assert.ok(pathsEqual('C:\\A\\B', 'c:/a/b/') || !pathsEqual('/a/b', '/a/c'));
    assert.ok(!pathsEqual('/a/b', '/a/c'));
  });

  it('detects workspace escapes', () => {
    assert.ok(isPathInsideWorkspace('/ws/src/a.ts', '/ws'));
    assert.ok(isPathInsideWorkspace('/ws', '/ws'));
    assert.ok(!isPathInsideWorkspace('/ws/../etc/passwd', '/ws'));
    assert.ok(!isPathInsideWorkspace('/etc/passwd', '/ws'));
    assert.ok(!isPathInsideWorkspace('', '/ws'));
  });

  it('rejects empties', () => {
    assert.ok(!isPathInsideWorkspace('/ws/a', ''));
  });
});

describe('command-safety', () => {
  it('detects compound shell payloads', () => {
    assert.ok(hasShellControlOperator('npm test && rm -rf /'));
    assert.ok(hasShellControlOperator('echo a; echo b'));
    assert.ok(hasShellControlOperator('cat f | grep x'));
    assert.ok(!hasShellControlOperator('npm test'));
    assert.ok(!hasShellControlOperator('git status'));
  });

  it('extracts commands from args', () => {
    assert.equal(extractCommand({ command: 'npm test' }), 'npm test');
    assert.equal(extractCommand({ noop: 1 }), undefined);
  });
});

describe('logger', () => {
  it('redacts secrets before emitting', () => {
    const seen = [];
    const log = createBridgeLogger({
      level: 'debug',
      dshHome: '',
      stdioSafe: false,
      cordis: { info: (m) => seen.push(['info', m]), warn: (m) => seen.push(['warn', m]), error: (m) => seen.push(['error', m]) },
    });
    log.info('token=supersecretvalue1');
    log.error('plain error');
    assert.equal(seen.length, 2);
    assert.ok(!seen[0][1].includes('supersecretvalue1'));
    assert.ok(seen[1][1].includes('plain error'));
  });
});
