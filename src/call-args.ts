/**
 * Small log-shape parsers: locate the tool/call event for one call id and
 * read its command/paths from the arguments JSON. Independent of any goal
 * machinery so approval decisions stay cheap and side-effect free.
 */

/** Parse a tool-call arguments string; undefined when it is not JSON. */
export function parseArgsJson(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

const COMMAND_KEYS = ['command', 'cmd', 'script'];
const PATH_KEYS = [
  'file_path', 'path', 'filepath', 'old_path', 'new_path', 'src', 'dest',
  'old_file', 'new_file', 'filename', 'directory', 'cwd', 'folder',
];

/** Extract one command string from parsed tool-call arguments, if present. */
export function extractCommand(args: Record<string, unknown>): string | undefined {
  for (const key of COMMAND_KEYS) {
    const value = args[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return undefined;
}

/** Extract readable file-path values from parsed tool-call arguments. */
export function extractFilePaths(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of PATH_KEYS) {
    const value = args[key];
    if (typeof value === 'string' && value.trim() !== '') out.push(value);
    else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && item.trim() !== '') out.push(item);
      }
    }
  }
  return out;
}

/** The raw command a tool call was issued with (bash/exec tools), if any. */
export function commandForCall(
  events: readonly { type: string; data?: unknown }[] | undefined,
  callId?: string,
): string | undefined {
  if (events === undefined || callId === undefined) return undefined;
  for (const event of events) {
    if (event.type !== 'tool/call') continue;
    const data = event.data as Record<string, unknown> | undefined;
    if (data === undefined || data.callId !== callId) continue;
    const raw = typeof data.arguments === 'string' ? data.arguments : '';
    const args = raw === '' ? undefined : parseArgsJson(raw);
    return args === undefined ? undefined : extractCommand(args);
  }
  return undefined;
}

/** File paths a tool call named in its arguments, if any. */
export function filePathsForCall(
  events: readonly { type: string; data?: unknown }[] | undefined,
  callId?: string,
): string[] {
  if (events === undefined || callId === undefined) return [];
  for (const event of events) {
    if (event.type !== 'tool/call') continue;
    const data = event.data as Record<string, unknown> | undefined;
    if (data === undefined || data.callId !== callId) continue;
    const raw = typeof data.arguments === 'string' ? data.arguments : '';
    const args = raw === '' ? undefined : parseArgsJson(raw);
    return args === undefined ? [] : extractFilePaths(args);
  }
  return [];
}
