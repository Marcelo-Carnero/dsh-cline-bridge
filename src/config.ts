import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { isIP } from 'node:net';
import z from '@deepseek-ai/schemastery';
import type { LogLevel } from './log.js';

/**
 * Plugin configuration (schemastery schema, DSH convention). All defaults are
 * security-first: loopback-only host, bearer-token auth, bounded result sizes.
 */
export const ConfigSchema = z.object({
  /** MCP transport: 'http' (Streamable HTTP) or 'stdio' (local MCP clients). */
  transport: z.union([z.const('http'), z.const('stdio')]).default('http'),
  /** Bind host for the Streamable HTTP server. Loopback only by default. */
  host: z.string().default('127.0.0.1'),
  /** Bind port for the Streamable HTTP server. */
  port: z.number().min(1).max(65535).default(3457),
  /** 'token' requires Authorization: Bearer <token>; 'none' disables auth (loopback only, not recommended). */
  authMode: z.union([z.const('token'), z.const('none')]).default('token'),
  /** Static token; empty falls back to authTokenEnv, then a generated token persisted to tokenFile. */
  authToken: z.string().default(''),
  /** Environment variable read when authToken is empty. */
  authTokenEnv: z.string().default('DSH_CLINE_BRIDGE_TOKEN'),
  /** Where a generated token is persisted; empty means $DSH_HOME/cline-bridge.token. */
  tokenFile: z.string().default(''),
  /** Max characters of assistant text returned by dsh_get_result. */
  resultMaxChars: z.number().default(8000),
  /** Max tool calls returned by dsh_get_result. */
  resultMaxItems: z.number().default(50),
  /** Max message rows returned by dsh_get_session. */
  sessionMaxItems: z.number().default(20),
  /** Max characters per message text returned by dsh_get_session. */
  sessionMaxChars: z.number().default(4000),
  /** Log verbosity: debug | info | warn | error. */
  logLevel: z.union([z.const('debug'), z.const('info'), z.const('warn'), z.const('error')]).default('info'),
});

/** Input shape accepted from the cordis row config (schema input side). */
export interface BridgeConfigInput {
  transport?: 'http' | 'stdio';
  host?: string;
  port?: number;
  authMode?: 'token' | 'none';
  authToken?: string;
  authTokenEnv?: string;
  tokenFile?: string;
  resultMaxChars?: number;
  resultMaxItems?: number;
  sessionMaxItems?: number;
  sessionMaxChars?: number;
  logLevel?: LogLevel;
}

/** Fully resolved configuration after token resolution. */
export interface ResolvedBridgeConfig {
  transport: 'http' | 'stdio';
  host: string;
  port: number;
  authMode: 'token' | 'none';
  authToken: string;
  tokenFile: string;
  resultMaxChars: number;
  resultMaxItems: number;
  sessionMaxItems: number;
  sessionMaxChars: number;
  logLevel: LogLevel;
  dshHome: string;
}

/** True when host is a loopback address (127.0.0.1, ::1, localhost). */
export function isLoopbackHost(host: string): boolean {
  if (host === 'localhost') return true;
  const version = isIP(host);
  if (version === 4) return host.startsWith('127.');
  if (version === 6) return host === '::1' || host === '::ffff:127.0.0.1';
  return false;
}

const TOKEN_STABILIZATION_DELAY_MS = 50;

/**
 * Bounded read of the token file that tolerates a concurrent writer: an empty
 * or partially-written file is retried for a short bounded window, then the
 * last stable value (or undefined when missing is allowed) is returned.
 */
function readStableTokenFile(path: string, allowMissing: boolean): string | undefined {
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  let previous: string | undefined;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    let current: string | undefined;
    try {
      current = readTokenFile(path);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('Bridge auth token file is empty or malformed')) {
        throw error;
      }
    }
    if (current === undefined && allowMissing) return undefined;
    if (current !== undefined && current === previous) return current;
    previous = current;
    Atomics.wait(sleeper, 0, 0, TOKEN_STABILIZATION_DELAY_MS);
  }
  throw new Error('Bridge auth token file is empty or malformed after bounded stabilization');
}

/**
 * Generate a fresh token and persist it (0600 on POSIX; Windows ignores mode).
 *
 * Exclusive create: when two resolvers see the file absent in the same
 * lifecycle, only one wins the write and the loser ADOPTS the persisted
 * token. The file is the single token authority once it exists: every later
 * resolveConfig() reads it back unchanged.
 */
function createTokenFile(path: string): string {
  const token = randomBytes(24).toString('base64url');
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, token + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    // A concurrent resolver won the create: adopt the persisted token so
    // every resolver in the lifecycle converges on the same value.
    if ((error as NodeJS.ErrnoException).code === 'EEXIST' && existsSync(path)) {
      const persisted = readStableTokenFile(path, false);
      if (persisted !== undefined) return persisted;
    }
    // An ephemeral fallback would let independent runtimes keep different
    // tokens. Fail closed without including token material in the error.
    throw new Error('Bridge auth token file could not be created exclusively', { cause: error });
  }
  return token;
}

export function defaultDshHome(env: Record<string, string | undefined>): string {
  return env.DSH_HOME && env.DSH_HOME !== '' ? env.DSH_HOME : join(homeDir(), '.dsh');
}

function homeDir(): string {
  return process.env.USERPROFILE ?? process.env.HOME ?? '.';
}

/** Resolve the effective configuration (defaults + token resolution). */
export function resolveConfig(
  input: BridgeConfigInput,
  env: Record<string, string | undefined>,
): ResolvedBridgeConfig {
  const dshHome = defaultDshHome(env);
  const transport = input.transport === 'stdio' ? 'stdio' : 'http';
  const authMode = input.authMode === 'none' ? 'none' : 'token';
  const host = input.host || '127.0.0.1';
  if (transport === 'http' && authMode === 'none' && !isLoopbackHost(host)) {
    throw new Error(`authMode none is only allowed for loopback HTTP listeners; refusing non-loopback host ${host}`);
  }
  const tokenEnv = input.authTokenEnv || 'DSH_CLINE_BRIDGE_TOKEN';
  const tokenFile = input.tokenFile && input.tokenFile !== '' ? input.tokenFile : join(dshHome, 'cline-bridge.token');
  let authToken = input.authToken ?? '';
  if (authMode === 'token' && authToken === '') {
    authToken = env[tokenEnv] ?? '';
  }
  if (authMode === 'token' && authToken === '') {
    authToken = readStableTokenFile(tokenFile, true) ?? '';
  }
  if (authMode === 'token' && authToken === '') {
    authToken = createTokenFile(tokenFile);
  }
  return {
    transport,
    host,
    port: input.port ?? 3457,
    authMode,
    authToken,
    tokenFile,
    resultMaxChars: input.resultMaxChars ?? 8000,
    resultMaxItems: input.resultMaxItems ?? 50,
    sessionMaxItems: input.sessionMaxItems ?? 20,
    sessionMaxChars: input.sessionMaxChars ?? 4000,
    logLevel: input.logLevel ?? 'info',
    dshHome,
  };
}

/** Canonical MCP Streamable HTTP URL for the bridge endpoint. */
export function bridgeHttpUrl(host: string, port: number): string {
  const literal = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${literal}:${port}/mcp`;
}

function readTokenFile(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, 'utf8').trim();
  if (raw === '') {
    throw new Error('Bridge auth token file is empty or malformed');
  }
  if (!/^[A-Za-z0-9._~+/=-]{16,256}$/.test(raw)) {
    throw new Error('Bridge auth token file is empty or malformed');
  }
  return raw;
}
