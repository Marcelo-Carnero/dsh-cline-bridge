import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig, isLoopbackHost, bridgeHttpUrl, defaultDshHome } from '../lib/config.js';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'cline-bridge-cfg-'));
}

describe('resolveConfig', () => {
  it('uses security-first defaults', () => {
    const dir = tempDir();
    try {
      const cfg = resolveConfig({ tokenFile: join(dir, 't.token') }, {});
      assert.equal(cfg.transport, 'http');
      assert.equal(cfg.host, '127.0.0.1');
      assert.equal(cfg.port, 3457);
      assert.equal(cfg.authMode, 'token');
      assert.ok(cfg.authToken.length >= 16);
      assert.ok(existsSync(cfg.tokenFile));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prefers explicit token, then env, then file', () => {
    const dir = tempDir();
    try {
      const file = join(dir, 't.token');
      const fromArg = resolveConfig({ authToken: 'explicit-token-value-here', tokenFile: file }, {});
      assert.equal(fromArg.authToken, 'explicit-token-value-here');

      const fromEnv = resolveConfig({ tokenFile: file }, { DSH_CLINE_BRIDGE_TOKEN: 'env-token-value-here' });
      assert.equal(fromEnv.authToken, 'env-token-value-here');
      // env token must NOT create a file
      assert.ok(!existsSync(file));

      const generated = resolveConfig({ tokenFile: file }, {});
      assert.equal(readFileSync(file, 'utf8').trim(), generated.authToken);
      const second = resolveConfig({ tokenFile: file }, {});
      assert.equal(second.authToken, generated.authToken);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses authMode none on non-loopback hosts', () => {
    assert.throws(() => resolveConfig({ authMode: 'none', host: '0.0.0.0', authToken: '' }, {}), /loopback/);
    assert.throws(() => resolveConfig({ authMode: 'none', host: '192.168.1.5', authToken: '' }, {}), /loopback/);
  });

  it('allows authMode none on loopback', () => {
    const cfg = resolveConfig({ authMode: 'none', host: '127.0.0.1', authToken: '' }, {});
    assert.equal(cfg.authMode, 'none');
  });
});

describe('isLoopbackHost', () => {
  it('accepts loopback forms only', () => {
    assert.ok(isLoopbackHost('127.0.0.1'));
    assert.ok(isLoopbackHost('127.0.0.53'));
    assert.ok(isLoopbackHost('localhost'));
    assert.ok(isLoopbackHost('::1'));
    assert.ok(!isLoopbackHost('0.0.0.0'));
    assert.ok(!isLoopbackHost('10.0.0.1'));
    assert.ok(!isLoopbackHost('example.com'));
  });
});

describe('bridgeHttpUrl / defaultDshHome', () => {
  it('builds the /mcp url', () => {
    assert.equal(bridgeHttpUrl('127.0.0.1', 3457), 'http://127.0.0.1:3457/mcp');
    assert.equal(bridgeHttpUrl('::1', 3457), 'http://[::1]:3457/mcp');
  });

  it('respects DSH_HOME', () => {
    assert.equal(defaultDshHome({ DSH_HOME: '/x' }), '/x');
    assert.ok(defaultDshHome({}).endsWith('.dsh'));
  });
});
