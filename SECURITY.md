# Security Policy

## Supported versions

Only the latest published minor receives security fixes.

## Scope

`dsh-cline-bridge` is an MCP bridge that runs **inside a DSH profile** and
exposes a local MCP endpoint. It holds one real capability: it can act on DSH
sessions on behalf of whoever holds the bridge token. Everything it can do, DSH
can also do for a human — the bridge widens *reach*, it does not add new
privilege.

Out of scope: DSH itself, Cline itself, and any agent/tool behavior the DSH
host authorizes independently of this plugin.

## Trust boundary

Anything that can read `$DSH_HOME/cline-bridge.token` (or the env var) can drive
DSH sessions as the human who registered the workspaces. Treat the token as
equivalent to an interactive session on the machine.

## Enforced invariants

These are unit-tested; `npm run test:release` fails the release if the published
build drops one.

1. **Loopback by default.** `host` defaults to `127.0.0.1`.
2. **Bearer token by default**, compared in constant time. Missing/wrong token
   → `401`. `authMode: 'none'` is rejected for any non-loopback host, at both
   config resolution and server start.
3. **No auto-registration.** `dsh_create_session` resolves workspaces against
   the registry DSH already has (`registry.list()`). An unregistered path fails
   with `WORKSPACE_NOT_FOUND`. The bridge never calls `registry.create`,
   `initializeDefault`, or opens an arbitrary directory.
4. **No approve-all.** Every grant is `allowed-once` and bound to the exact
   tool-call id, so a grant can never be reused by a different call.
5. **Unrecognized operations are never auto-approved.** The risk-tiered policy
   (`L0`/`L1`/`L2`/`L3`) falls back to `require_human` for anything it cannot
   classify.
6. **Compound shell commands are never auto-approved.** Any command containing a
   shell control operator (`;`, `&&`, `||`, `|`, `>>`, `<<`, `$(`, backtick)
   requires an explicit human decision.
7. **Destructive remote operations require a human** by default: `git push`
   (including `--force`), `npm publish`, `gh release`.
8. **Bounded output.** All text/tool-call/message payloads are truncated to
   configured budgets, so a runaway turn cannot flood or exhaust the client.
9. **No secret material in output or logs.** Tokens, API keys, cookies,
   `Authorization` values and `.env`-style assignments are redacted; home and
   workspace paths are abbreviated. Errors never include token values.
10. **Token file is created exclusively** (`O_EXCL`, mode `0600`). A concurrent
    creator is detected and the persisted token is adopted, so independent
    runtimes converge on one value. If the file cannot be created exclusively,
    startup fails closed rather than falling back to an ephemeral token.
11. **Request limits.** JSON bodies are capped at 4 MB, MCP sessions are capped
    and swept when idle, so the endpoint cannot be used as a memory sink.
12. **Clean teardown.** Unloading the plugin row closes the HTTP listener and
    every MCP transport before the row finishes unloading.

## Deliberately not in scope

- The bridge does **not** sandbox commands. DSH's own sandbox/approval layer is
  the enforcement point; this policy decides what to *ask the human* about.
- The bridge does **not** authenticate the MCP *client's identity*. The bearer
  token is a shared secret: any local process holding it is trusted.
- HTTP CORS is permissive because the endpoint is loopback-only. Do not set a
  non-loopback `host`.

## Reporting a vulnerability

Please report privately, not as a public issue:

1. Open a **GitHub private security advisory** on this repository
   (`Security → Report a vulnerability`), or
2. Email the maintainer listed in the repository metadata.

Include: the affected version, the impacted invariant above, a reproduction, and
your impact assessment. Please do not include real token values or private paths.

Expected timeline: acknowledgement within 72 hours, an assessment and a fix or
mitigation plan within 14 days, and coordinated disclosure after a release is
available.

## Release verification

Every published version must pass `npm run test:release`, which asserts the
tarball is prebuilt (so installing it runs no arbitrary build script), loads as
a real module, keeps the loopback/token defaults, and ships no `src/`, `test/`,
`ref-*`, `*.token`, `*.log`, `.env` or `*.tsbuildinfo`.
