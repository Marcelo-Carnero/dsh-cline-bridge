/**
 * End-to-end security test of the MCP HTTP layer: auth enforcement (401),
 * loopback behavior, the MCP initialize handshake, the exact tool list, and
 * tools/call error convention — all against a fake Bridge so no DSH host is
 * required. This is the gate a community release must pass.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpServer, BRIDGE_TOOL_NAMES } from '../lib/mcp.js';
import { startHttpServer } from '../lib/http.js';
import { createBridgeLogger } from '../lib/log.js';

const TOKEN = 'test-token-with-enough-entropy-0123456789';
const HOST = '127.0.0.1';

function silentLogger() {
  return createBridgeLogger({ level: 'error', dshHome: '', stdioSafe: false });
}

// A minimal fake Bridge: the MCP layer only exercises its public methods.
function fakeBridge() {
  return {
    async health() {
      return { status: 'ok', bridge: { name: 'dsh-cline-bridge-test', version: '0.0.0-test' } };
    },
    async listWorkspaces() { return []; },
    async createSession() { throw Object.assign(new Error('not wired'), { code: 'SESSION_CREATE_FAILED' }); },
    async listSessions() { return []; },
    async getSession() { throw new Error('nope'); },
    async sendMessage() { return { session_id: 's', accepted: true }; },
    async getTaskStatus() { return { session_id: 's', status: 'idle' }; },
    async getResult() { return { session_id: 's', status: 'completed', turn: 1 }; },
    async cancelTask() { return { session_id: 's', cancelled: true }; },
    async answerQuestion() { return { answered: true }; },
    async approve() { return { approval_id: 'a', session_id: 's', decision: 'reject', outcome: 'rejected' }; },
  };
}

describe('MCP HTTP security + surface', () => {
  let handle;
  let base;

  before(async () => {
    handle = await startHttpServer(
      () => createMcpServer(fakeBridge(), { resultMaxChars: 10, resultMaxItems: 2, sessionMaxItems: 2, sessionMaxChars: 10 }, silentLogger()),
      { host: HOST, port: 0, authMode: 'token', authToken: TOKEN },
      silentLogger(),
    );
    base = handle.url;
  });

  after(async () => {
    await handle?.close();
  });

  it('rejects requests without a token (401)', async () => {
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } }),
    });
    assert.equal(res.status, 401);
  });

  it('rejects requests with a wrong token (401), timing-safe compare', async () => {
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer wrong-token-value-here' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    assert.equal(res.status, 401);
  });

  it('handshakes over MCP with the right token and exposes exactly the bridge tools', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(base), {
      requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
    });
    const client = new Client({ name: 'cline-bridge-security-test', version: '0.1.0' });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      const names = listed.tools.map((t) => t.name).sort();
      assert.deepEqual(names, [...BRIDGE_TOOL_NAMES].sort());
      assert.equal(names.length, 11);

      const health = await client.callTool({ name: 'dsh_health', arguments: {} });
      assert.equal(health.isError, undefined);
      const payload = JSON.parse(health.content[0].text);
      assert.equal(payload.status, 'ok');
    } finally {
      await client.close().catch(() => {});
    }
  });

  it('reports bridge errors as isError results, never throwing JSON-RPC', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(base), {
      requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
    });
    const client = new Client({ name: 'cline-bridge-security-test', version: '0.1.0' });
    try {
      await client.connect(transport);
      const res = await client.callTool({ name: 'dsh_get_session', arguments: { session_id: 'missing' } });
      assert.equal(res.isError, true);
      const payload = JSON.parse(res.content[0].text);
      assert.ok(payload.error && typeof payload.error.code === 'string');
    } finally {
      await client.close().catch(() => {});
    }
  });

  it('refuses authMode none on non-loopback hosts', async () => {
    const { startHttpServer: start } = await import('../lib/http.js');
    await assert.rejects(
      () => start(() => createMcpServer(fakeBridge(), {}, silentLogger()), { host: '0.0.0.0', port: 0, authMode: 'none', authToken: '' }, silentLogger()),
      /loopback/,
    );
  });
});
