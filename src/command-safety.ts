/**
 * Shell-command safety helpers used by the approval policy. Kept separate and
 * dependency-free so the classifier stays trivially auditable.
 */

/** Shell control operators that split a payload into multiple operations. */
const CONTROL_OPERATORS = /[;&|]|&&|\|\||>>|<<|\$\(|`/;

/** True when a command string contains a shell control operator. */
export function hasShellControlOperator(command: string): boolean {
  return CONTROL_OPERATORS.test(command);
}

/** Extract the raw command string from parsed tool-call arguments. */
export function extractCommand(args: Record<string, unknown>): string | undefined {
  for (const key of ['command', 'cmd', 'script']) {
    const value = args[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return undefined;
}
