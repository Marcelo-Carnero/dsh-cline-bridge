import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

// Package root = the parent of the directory holding this script.
const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = dirname(scriptDir);

const child = spawn(process.execPath, ['--test', 'test/*.test.mjs'], { stdio: 'inherit', cwd: root });
child.on('exit', (code) => {
  process.exit(code ?? 1);
});
