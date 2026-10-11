/**
 * MCP server surface: session-lifecycle plus approval/question tools Cline
 * calls. Every tool maps onto a Bridge operation; nothing here reaches the
 * filesystem, the shell, or DSH internals directly. Outputs are JSON text
 * blocks; failures are reported as isError results.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Bridge } from './bridge.js';
import { BridgeError } from './bridge.js';
import type { ResolvedBridgeConfig } from './config.js';
import type { BridgeLogger } from './log.js';
import { redactValue } from './redact.js';
import { BRIDGE_NAME, BRIDGE_VERSION } from './version.js';

function textResult(value: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(redactValue(value), null, 2) }] };
}

function errorResult(error: unknown): { content: { type: 'text'; text: string }[]; isError: true } {
  if (error instanceof BridgeError) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) } }, null, 2) }],
      isError: true,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: { code: 'INTERNAL', message } }, null, 2) }],
    isError: true,
  };
}

/** Wrap one async handler into the MCP error convention. */
function safe<A>(handler: (args: A) => Promise<unknown>) {
  return async (args: A): Promise<{ content: { type: 'text'; text: string }[]; isError?: true }> => {
    try {
      return textResult(await handler(args));
    } catch (error) {
      return errorResult(error);
    }
  };
}

export function createMcpServer(bridge: Bridge, cfg: ResolvedBridgeConfig, log: BridgeLogger): McpServer {
  const server = new McpServer(
    { name: BRIDGE_NAME, version: BRIDGE_VERSION },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    'dsh_health',
    {
      title: 'DSH bridge health',
      description:
        'Bridge and DSH runtime status: versions, live/persisted/active session counts and ' +
        'capability flags. Never returns tokens, keys, cookies or environment secrets.',
      inputSchema: z.object({}),
    },
    safe(async () => bridge.health()),
  );

  server.registerTool(
    'dsh_list_workspaces',
    {
      title: 'List registered workspaces',
      description:
        'List the workspaces DSH already registered/authorized. Sessions can only be created ' +
        'inside these. Arbitrary paths are never opened or auto-registered.',
      inputSchema: z.object({}),
    },
    safe(async () => bridge.listWorkspaces()),
  );

  server.registerTool(
    'dsh_create_session',
    {
      title: 'Create a DSH session',
      description:
        'Create a real DSH agent session in a registered workspace (id, path, or title from ' +
        'dsh_list_workspaces). Optionally set a title and send an initial message that starts ' +
        'the first turn.',
      inputSchema: z.object({
        workspace: z.string().min(1).describe('Workspace id, path, or title from dsh_list_workspaces'),
        title: z.string().max(200).optional().describe('Session title shown in the DSH UI'),
        message: z.string().max(20000).optional().describe('Initial task message that starts the first turn'),
      }),
    },
    safe(async (args: { workspace: string; title?: string; message?: string }) =>
      bridge.createSession(args.workspace, args.title, args.message)),
  );

  server.registerTool(
    'dsh_list_sessions',
    {
      title: 'List DSH sessions',
      description:
        'List live and persisted DSH sessions (newest first), with live status and titles. ' +
        'Optionally filter by workspace and page through limit/offset.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).optional().describe('Max sessions (default 50)'),
        offset: z.number().int().min(0).optional().describe('Skip N sessions'),
        workspace: z.string().optional().describe('Workspace id, path, or title'),
      }),
    },
    safe(async (args: { limit?: number; offset?: number; workspace?: string }) => bridge.listSessions(args)),
  );

  server.registerTool(
    'dsh_get_session',
    {
      title: 'Inspect a DSH session',
      description:
        'Full session view: status, pending inbox, parked approvals/questions, recent ' +
        'user/assistant messages (newest first), last turn span.',
      inputSchema: z.object({
        session_id: z.string().min(1),
        max_items: z.number().int().min(1).max(100).optional().describe('Max message rows (default from bridge config)'),
        max_chars: z.number().int().min(1).max(50000).optional().describe('Max chars per message (default from bridge config)'),
      }),
    },
    safe(async (args: { session_id: string; max_items?: number; max_chars?: number }) =>
      bridge.getSession(args.session_id, args.max_items, args.max_chars)),
  );

  server.registerTool(
    'dsh_send_message',
    {
      title: 'Send a message to a DSH session',
      description:
        'Send a follow-up instruction to an existing DSH session (live or persisted; ' +
        'persisted sessions resume). Empty messages are rejected.',
      inputSchema: z.object({
        session_id: z.string().min(1),
        message: z.string().min(1).max(50000).describe('Follow-up instruction for the DSH agent'),
      }),
    },
    safe(async (args: { session_id: string; message: string }) => bridge.sendMessage(args.session_id, args.message)),
  );

  server.registerTool(
    'dsh_get_task_status',
    {
      title: 'Poll a DSH session status',
      description:
        'Lightweight status poll: lifecycle state (idle/running/waiting_for_approval/ ' +
        'waiting_for_user/completed/failed/cancelled/...), live flag, pending counts, ' +
        'parked approvals and questions.',
      inputSchema: z.object({
        session_id: z.string().min(1),
      }),
    },
    safe(async (args: { session_id: string }) => bridge.getTaskStatus(args.session_id)),
  );

  server.registerTool(
    'dsh_get_result',
    {
      title: 'Read the latest DSH turn result',
      description:
        'Latest turn result: assistant text (bounded), changed files, tool calls with ' +
        'error flags, and any terminal turn error.',
      inputSchema: z.object({
        session_id: z.string().min(1),
        max_chars: z.number().int().min(1).max(50000).optional().describe('Max assistant-text chars (default from bridge config)'),
      }),
    },
    safe(async (args: { session_id: string; max_chars?: number }) => bridge.getResult(args.session_id, args.max_chars)),
  );

  server.registerTool(
    'dsh_cancel_task',
    {
      title: 'Cancel a live DSH session',
      description:
        'Cancel the active turn of a live session. Reports cancellation of live activity. ' +
        'Does not kill processes.',
      inputSchema: z.object({
        session_id: z.string().min(1),
      }),
    },
    safe(async (args: { session_id: string }) => bridge.cancelTask(args.session_id)),
  );

  server.registerTool(
    'dsh_answer_question',
    {
      title: 'Answer a pending user question',
      description:
        'Answer a question the DSH agent asked the human (status waiting_for_user). Pass the ' +
        'question_id from dsh_get_task_status, one or more offered option labels, and optional ' +
        'free text.',
      inputSchema: z.object({
        question_id: z.string().min(1),
        session_id: z.string().optional(),
        selected: z.array(z.string()).default([]),
        custom: z.string().optional(),
      }),
    },
    safe(async (args: { question_id: string; session_id?: string; selected: string[]; custom?: string }) =>
      bridge.answerQuestion(args.question_id, args.session_id, { selected: args.selected, custom: args.custom })),
  );

  server.registerTool(
    'dsh_approve',
    {
      title: 'Decide one pending approval',
      description:
        'Decide one explicit DSH permission approval (status waiting_for_approval). Requires ' +
        'the exact approval_id and an explicit approve/reject decision. There is no ' +
        'approve-all; every grant is allowed-once for the exact tool call. Rejecting ' +
        'fails the call closed.',
      inputSchema: z.object({
        session_id: z.string().min(1),
        approval_id: z.string().min(1),
        decision: z.enum(['approve', 'reject']),
      }),
    },
    safe(async (args: { session_id: string; approval_id: string; decision: 'approve' | 'reject' }) =>
      bridge.approve(args.session_id, args.approval_id, args.decision)),
  );

  log.debug(`MCP server created: ${BRIDGE_NAME}@${BRIDGE_VERSION}`);
  return server;
}

/** Expected tool list — used by health checks and the release test. */
export const BRIDGE_TOOL_NAMES = [
  'dsh_health',
  'dsh_list_workspaces',
  'dsh_create_session',
  'dsh_list_sessions',
  'dsh_get_session',
  'dsh_send_message',
  'dsh_get_task_status',
  'dsh_get_result',
  'dsh_cancel_task',
  'dsh_answer_question',
  'dsh_approve',
] as const;

