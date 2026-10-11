# dsh-cline-bridge

Lets **Cline** (or any local MCP client) create, continue, supervise and stop
**DeepSeek Harness (DSH)** agent sessions over the standard MCP protocol.

This is a DSH plugin. It only *connects*: DSH keeps its own session, agent,
tool, approval and workspace security model. The bridge adds no shell, no
filesystem access and no credentials of its own.

Unofficial community project by Marcelo F. Carnero. Not affiliated with
or endorsed by DeepSeek or the Cline project.

## Architecture

Cline is a local MCP client, so there is no relay, no tunnel and no remote
management API: the MCP endpoint is simply where DSH runs.

```
Cline (MCP client) ──stdio──▶  dsh-cline-bridge  ──▶  DSH capability seams
                                   or
Cline (MCP client) ──http://127.0.0.1:3457/mcp──▶
```

The bridge owns no shell, no filesystem access and no credential store. It
translates MCP calls onto DSH's own seams and lets DSH decide.

## Install

Preferred (prebuilt, no install-time code execution):

```sh
dsh plugin add dsh-cline-bridge
```

From git (runs your package manager's build gate first; pin a commit so a later
push cannot change what runs):

```sh
dsh plugin add github:Marcelo-Carnero/dsh-cline-bridge#<sha>
```

### Point Cline at the bridge

`transport: stdio` — DSH speaks MCP on its own stdin/stdout is not what Cline
wants; instead run the bridge in stdio mode inside a DSH profile and let Cline
spawn DSH. The default and recommended setup is `transport: http`:

```jsonc
// cline_mcp_settings.json
{
  "mcpServers": {
    "dsh": {
      "type": "streamableHttp",
      "url": "http://127.0.0.1:3457/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

The token is generated on first start and persisted to
`$DSH_HOME/cline-bridge.token` (mode `0600`). Set it explicitly with
`authToken`, or point `authTokenEnv` at your own variable.

## Tools

| Tool | Purpose |
| --- | --- |
| `dsh_health` | bridge + DSH versions, session counts, capability flags |
| `dsh_list_workspaces` | the workspaces DSH already registered |
| `dsh_create_session` | create a real DSH session in a registered workspace |
| `dsh_list_sessions` | live + persisted sessions, newest first |
| `dsh_get_session` | full view: status, inbox, parked approvals/questions, messages |
| `dsh_send_message` | follow-up instruction (persisted sessions resume) |
| `dsh_get_task_status` | lightweight poll: lifecycle state, pending counts |
| `dsh_get_result` | latest turn: assistant text (bounded), changed files, tool calls |
| `dsh_cancel_task` | cancel the active turn of a live session |
| `dsh_answer_question` | answer a question the agent asked the human |
| `dsh_approve` | decide one explicit permission approval |

Failures are MCP `isError` results with a stable machine-readable `code`; no
JSON-RPC error ever leaks a stack trace.

## Security model

- **Loopback only by default.** `host` defaults to `127.0.0.1`.
- **Bearer token by default.** Constant-time compare; a missing or wrong token
  is a `401`. `authMode: none` is refused for any non-loopback host.
- **No auto-registration.** Sessions can only be created inside a workspace a
  human already registered in DSH. An unregistered path is rejected with
  `WORKSPACE_NOT_FOUND`; the bridge never calls `registry.create`.
- **No approve-all.** Every grant is `allowed-once` for the exact tool call.
- **Unrecognized operations are never auto-approved.** The risk-tiered policy
  defaults to `require_human`; anything it cannot classify becomes a human
  decision.
- **Bounded output.** Result/message sizes are capped by config, so a runaway
  turn cannot flood the client.
- **No secrets in output.** Tokens, keys, cookies and env values are redacted;
  logs never carry token material.
- **Removal is clean.** Disable the bundle row and the MCP endpoint disappears
  while DSH keeps running.

Full details, threat model and reporting: [SECURITY.md](./SECURITY.md).

## Configuration

Every field is optional; defaults are security-first.

| Field | Default | Meaning |
| --- | --- | --- |
| `transport` | `http` | `http` (Streamable HTTP) or `stdio` |
| `host` | `127.0.0.1` | bind host (loopback only by default) |
| `port` | `3457` | bind port |
| `authMode` | `token` | `token` or `none` (loopback only) |
| `authToken` | `''` | static token; falls back to env, then a generated token file |
| `authTokenEnv` | `DSH_CLINE_BRIDGE_TOKEN` | env var read when `authToken` is empty |
| `tokenFile` | `$DSH_HOME/cline-bridge.token` | where a generated token is persisted |
| `resultMaxChars` | `8000` | max assistant-text chars from `dsh_get_result` |
| `resultMaxItems` | `50` | max tool calls from `dsh_get_result` |
| `sessionMaxItems` | `20` | max message rows from `dsh_get_session` |
| `sessionMaxChars` | `4000` | max chars per message from `dsh_get_session` |
| `logLevel` | `info` | `debug` \| `info` \| `warn` \| `error` |

## Development

```sh
npm install
npm run typecheck
npm test          # unit + MCP HTTP security suite
npm run test:release   # pack, install the real tarball, assert the published surface
```

`npm run test:release` is the release gate. It builds, tests, packs, unpacks the
tarball into a temp directory and asserts the published build is prebuilt,
loadable, loopback-only and free of sources, tests, tokens and logs.

## License

MIT. See [LICENSE](./LICENSE).
