import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

export async function concatLocal({ files, output, signal, onLog = () => {} }) {
  if (!files.length) throw new Error('没有可拼接的视频');
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'manju-concat-'));
  try {
    const list = path.join(tmp, 'files.txt');
    await writeFile(list, files.map((file) => `file '${file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');
    await mkdir(path.dirname(output), { recursive: true });
    await new Promise((resolve, reject) => {
      const child = spawn(process.env.DSH_FFMPEG || 'ffmpeg', ['-hide_banner', '-y', '-f', 'concat', '-safe', '0', '-i', list,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', output], { windowsHide: true, signal });
      child.stderr.on('data', (d) => onLog(String(d).trim()));
      child.on('error', reject);
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`本地视频拼接失败（${code}）`)));
    });
  } finally { await rm(tmp, { recursive: true, force: true }); }
}
