/**
 * Risk-tiered approval policy. Self-contained on purpose: the classifier only
 * reads the tool name and the raw command string, so the whole decision table
 * is auditable in one file. Unrecognized operations are NEVER auto-approved.
 */
import { hasShellControlOperator } from './command-safety.js';

export type RiskLevel = 'L0' | 'L1' | 'L2' | 'L3';
export type ApprovalDecision = 'auto_approve' | 'require_human' | 'deny';

export interface UserApprovalPolicy {
  read?: 'auto' | 'ask';
  test?: 'auto' | 'ask';
  build?: 'auto' | 'ask';
  workspaceWrite?: 'auto' | 'ask';
  localCommit?: 'auto' | 'ask';
  externalWrite?: 'auto' | 'ask';
  gitPush?: 'auto' | 'ask';
  npmPublish?: 'auto' | 'ask';
  githubRelease?: 'auto' | 'ask';
  secrets?: 'deny' | 'ask';
  dangerFullAccess?: 'deny' | 'ask';
}

export const DEFAULT_APPROVAL_POLICY: UserApprovalPolicy = {
  read: 'auto',
  test: 'auto',
  build: 'auto',
  workspaceWrite: 'auto',
  localCommit: 'auto',
  externalWrite: 'ask',
  gitPush: 'ask',
  npmPublish: 'ask',
  githubRelease: 'ask',
  secrets: 'deny',
  dangerFullAccess: 'ask',
};

const FORCE_PUSH = /\bgit\s+push\b[\s\S]*?(?:--force|-f\b|--force-with-lease)/i;
const NPM_UNPUBLISH = /\bnpm\s+unpublish\b/i;
const RAW_SECRET_ACCESS = /(?:\.env|\.credentials|apiKey|secret|id_rsa|private_key)\b/i;
const LOCAL_COMMIT_CMD = /\bgit\s+(?:add|commit)\b/i;
const GIT_PUSH_CMD = /\bgit\s+push\b/i;
const NPM_PUBLISH_CMD = /\bnpm\s+publish\b/i;
const GH_RELEASE_CMD = /\bgh\s+release\b/i;

/** Action classes the policy reasons about. */
export type ActionClass =
  | 'filesystem.read'
  | 'filesystem.write'
  | 'git.read'
  | 'git.mutate'
  | 'npm.publish'
  | 'github.release'
  | 'process.exec'
  | 'process.spawn'
  | 'network'
  | 'credentials.metadata';

const READ_TOOLS = new Set([
  'read', 'view', 'cat', 'grep', 'glob', 'list', 'search', 'ls', 'stat', 'head', 'tail',
  'git_status', 'git_log', 'git_diff', 'git_show', 'git_branch', 'web_fetch', 'web_search',
  'fetch', 'http_get',
]);
const WRITE_TOOLS = new Set([
  'write', 'edit', 'str_replace', 'insert', 'replace', 'apply_patch', 'str-replace-editor',
  'rename', 'move', 'delete', 'rm', 'cp', 'mv', 'notebook_edit',
]);
const SPAWN_TOOLS = new Set(['bash', 'execute', 'run_command', 'terminal', 'shell', 'exec', 'run_terminal_cmd']);

/** Classify a tool call for policy purposes from its name and optional command. */
export function classesForTool(toolName: string, command?: string): ActionClass[] {
  const name = toolName.toLowerCase();
  const cmd = command ?? '';
  if (SPAWN_TOOLS.has(name)) {
    const out: ActionClass[] = ['process.exec'];
    if (/\bgit\s+push\b/i.test(cmd)) out.push('git.mutate');
    else if (/\bgit\s+(?:add|commit|checkout|branch|merge|rebase|reset|restore|cherry-pick)\b/i.test(cmd)) out.push('git.mutate');
    else if (/\bgit\b/i.test(cmd)) out.push('git.read');
    if (/\bnpm\s+publish\b/i.test(cmd)) out.push('npm.publish');
    if (/\bgh\s+release\b/i.test(cmd)) out.push('github.release');
    return out;
  }
  if (name === 'bash_output' || name === 'read_command_output') return ['process.exec'];
  if (name === 'ask_user_question') return [];
  if (READ_TOOLS.has(name)) return ['filesystem.read'];
  if (WRITE_TOOLS.has(name)) return ['filesystem.write'];
  if (name.startsWith('browser') || name.startsWith('playwright')) return ['network'];
  return ['process.exec'];
}

export interface ApprovalEvaluation {
  level: RiskLevel;
  capability: ActionClass | 'danger-full-access' | 'system.destructive';
  decision: ApprovalDecision;
  reason: string;
}


/** The complete decision table. Fail-closed for anything unrecognized. */
export function evaluateApproval(
  toolName: string,
  command?: string,
  policy: UserApprovalPolicy = DEFAULT_APPROVAL_POLICY,
  context: { externalWrite?: boolean } = {},
): ApprovalEvaluation {
  const merged: UserApprovalPolicy = { ...DEFAULT_APPROVAL_POLICY, ...policy };
  const cmd = command ?? '';
  const classes = classesForTool(toolName, command);

  // --- L3: destructive / sensitive: never auto-approved -----------------------
  if (FORCE_PUSH.test(cmd) || NPM_UNPUBLISH.test(cmd)) {
    return {
      level: 'L3',
      capability: 'system.destructive',
      decision: 'require_human',
      reason: 'Destructive / force operation requires explicit human confirmation',
    };
  }
  if (RAW_SECRET_ACCESS.test(cmd) || RAW_SECRET_ACCESS.test(toolName)) {
    return merged.secrets === 'deny'
      ? { level: 'L3', capability: 'credentials.metadata', decision: 'deny', reason: 'Raw secret file access is denied by policy' }
      : { level: 'L3', capability: 'credentials.metadata', decision: 'require_human', reason: 'Raw secret access requires explicit human confirmation' };
  }
  if (toolName.toLowerCase() === 'danger-full-access') {
    return {
      level: 'L3',
      capability: 'danger-full-access',
      decision: merged.dangerFullAccess === 'deny' ? 'deny' : 'require_human',
      reason: 'Broad danger-full-access grant requires explicit human confirmation',
    };
  }
  // A shell payload with control operators is multiple operations. Never let
  // one recognized prefix grant approval to the rest of the payload.
  if (cmd !== '' && hasShellControlOperator(cmd)) {
    return {
      level: 'L1',
      capability: 'process.exec',
      decision: 'require_human',
      reason: 'Compound shell command requires explicit human confirmation',
    };
  }

  // --- L2: publishing / remote / release --------------------------------------
  if (GH_RELEASE_CMD.test(cmd) || classes.includes('github.release')) {
    return {
      level: 'L2',
      capability: 'github.release',
      decision: merged.githubRelease === 'auto' ? 'auto_approve' : 'require_human',
      reason: 'GitHub Release operation',
    };
  }
  if (NPM_PUBLISH_CMD.test(cmd) || classes.includes('npm.publish')) {
    return {
      level: 'L2',
      capability: 'npm.publish',
      decision: merged.npmPublish === 'auto' ? 'auto_approve' : 'require_human',
      reason: 'NPM package publish operation',
    };
  }
  if (GIT_PUSH_CMD.test(cmd)) {
    return {
      level: 'L2',
      capability: 'git.mutate',
      decision: merged.gitPush === 'auto' ? 'auto_approve' : 'require_human',
      reason: 'Remote git push operation',
    };
  }

  // --- L1: local state changes ------------------------------------------------
  if (LOCAL_COMMIT_CMD.test(cmd)) {
    return {
      level: 'L1',
      capability: 'git.mutate',
      decision: merged.localCommit === 'auto' ? 'auto_approve' : 'require_human',
      reason: 'Local git commit operation',
    };
  }
  if (classes.includes('filesystem.write')) {
    if (context.externalWrite === true) {
      return {
        level: 'L1',
        capability: 'filesystem.write',
        decision: merged.externalWrite === 'auto' ? 'auto_approve' : 'require_human',
        reason: 'Write outside the managed workspace',
      };
    }
    return {
      level: 'L1',
      capability: 'filesystem.write',
      decision: merged.workspaceWrite === 'auto' ? 'auto_approve' : 'require_human',
      reason: 'Workspace file write operation',
    };
  }

  // --- L0: known-safe reads / tests / builds ----------------------------------
  const isTest = /\b(?:npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+test|jest|vitest|pytest|cargo\s+test|go\s+test)\b/i.test(cmd);
  if (isTest) {
    return {
      level: 'L0',
      capability: 'process.spawn',
      decision: merged.test === 'ask' ? 'require_human' : 'auto_approve',
      reason: 'Automated test suite execution',
    };
  }
  const isBuild = /\b(?:npm\s+(?:run\s+)?build|pnpm\s+(?:run\s+)?build|yarn\s+build|tsc|make|cmake|cargo\s+build|mvn\s+package)\b/i.test(cmd);
  if (isBuild) {
    return {
      level: 'L0',
      capability: 'process.exec',
      decision: merged.build === 'ask' ? 'require_human' : 'auto_approve',
      reason: 'Build step execution',
    };
  }
  if (classes.includes('git.read')) {
    return {
      level: 'L0',
      capability: 'git.read',
      decision: merged.read === 'ask' ? 'require_human' : 'auto_approve',
      reason: 'Read-only git query',
    };
  }
  if (classes.includes('filesystem.read') || classes.includes('network')) {
    return {
      level: 'L0',
      capability: 'filesystem.read',
      decision: merged.read === 'ask' ? 'require_human' : 'auto_approve',
      reason: 'Read-only operation',
    };
  }

  // Unrecognized operations are not auto-approved: L0 only covers known-safe classes.
  return {
    level: 'L1',
    capability: classes[0] ?? 'process.exec',
    decision: 'require_human',
    reason: 'Unrecognized operation requires confirmation',
  };
}
