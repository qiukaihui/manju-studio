import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('../studio/tests/', import.meta.url));
const files = (await readdir(directory)).filter((file) => file.endsWith('.test.mjs')).map((file) => directory + file);
const child = spawn(process.execPath, ['--test', ...files], { stdio: 'inherit' });
child.on('error', () => { process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
