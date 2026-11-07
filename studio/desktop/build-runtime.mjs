import { cp, mkdir, rm, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const studio = path.dirname(here);
const root = path.dirname(studio);
const runtime = path.join(here, 'runtime');
await rm(runtime, { recursive: true, force: true });
await mkdir(runtime, { recursive: true });
for (const file of ['server.mjs', 'agent.mjs', 'flow.mjs', 'produce.mjs', 'episodes.mjs', 'settings.mjs']) await copyFile(path.join(studio, file), path.join(runtime, file));
for (const directory of ['lib', 'ui', 'assets']) await cp(path.join(studio, directory), path.join(runtime, directory), { recursive: true });
await cp(path.join(root, 'skills'), path.join(runtime, 'skills'), { recursive: true });
await cp(path.join(root, 'licenses'), path.join(runtime, 'licenses'), { recursive: true });
await mkdir(path.join(runtime, 'tools'), { recursive: true });
await copyFile(path.join(root, 'tools/report.mjs'), path.join(runtime, 'tools/report.mjs'));
for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) await copyFile(path.join(root, file), path.join(runtime, file));
console.log('已准备未混淆、未加密的桌面运行源码。');
