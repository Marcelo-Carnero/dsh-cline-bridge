# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - Unreleased

### Added

- DSH (Cordis) plugin row that mounts an MCP endpoint. Disabling the row removes
  the endpoint while DSH keeps running.
- Streamable HTTP transport on `127.0.0.1:3457/mcp` (default) and a stdio
  transport for clients that spawn the host directly.
- 11 MCP tools: `dsh_health`, `dsh_list_workspaces`, `dsh_create_session`,
  `dsh_list_sessions`, `dsh_get_session`, `dsh_send_message`,
  `dsh_get_task_status`, `dsh_get_result`, `dsh_cancel_task`,
  `dsh_answer_question`, `dsh_approve`.
- Bearer-token auth with constant-time comparison, generated token persisted to
  `$DSH_HOME/cline-bridge.token` with mode `0600`.
- Workspace boundary: sessions are only created in workspaces DSH already
  registered; the bridge never auto-registers or opens an arbitrary path.
- Risk-tiered approval policy (`L0`–`L3`) that never auto-approves unrecognized
  operations or compound shell commands.
- Bounded outputs and redaction of secret material and sensitive paths in both
  payloads and logs.
- Unit suite plus an end-to-end MCP HTTP security suite (auth 401, handshake,
  exact tool surface, `isError` convention, loopback guard).
- `npm run test:release` release gate: builds, tests, packs, unpacks the real
  tarball and asserts the published surface is prebuilt, loadable, loopback-only
  and free of sources, tests, tokens and logs.

### Security notes

- `authMode: none` is refused for any non-loopback host at config resolution and
  at server start.
- Every approval grant is `allowed-once`, scoped to a single tool call.

### Dependencies

- Bumped `@modelcontextprotocol/sdk` to `1.32.1` to clear the advisory flagged
  by `npm audit` in CI; typecheck and the full 44-test suite pass against it.

### Fixed

- `npm test` now compiles first via a `pretest` hook. CI installs with
  `npm ci --ignore-scripts` (so `prepare` never builds `lib/`) and the test
  suite imports the compiled `lib/*.js`; without the hook the Test step failed
  with `ERR_MODULE_NOT_FOUND` on a clean checkout. The hook makes `npm test`
  self-sufficient locally and in CI alike.

[0.1.0]: https://github.com/Marcelo-Carnero/dsh-cline-bridge/releases/tag/v0.1.0
