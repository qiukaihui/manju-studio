import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.DSH_ROOT ||= path.join(root, 'projects');
process.env.DSH_SKILLS ||= path.join(root, 'skills');
process.env.DSH_STATE_DIR ||= path.join(root, 'data', 'state');
process.env.DSH_LOG_DIR ||= path.join(root, 'data', 'logs');
process.env.DSH_DESKTOP = '1';
process.env.STUDIO_AUTO_RESUME ||= '0';
for (const directory of [process.env.DSH_ROOT, process.env.DSH_STATE_DIR, process.env.DSH_LOG_DIR]) await mkdir(directory, { recursive: true });
await import('../studio/server.mjs');
