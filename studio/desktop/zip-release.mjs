import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(here, 'release', 'win-unpacked');
const { version } = JSON.parse(await readFile(path.join(here, 'package.json'), 'utf8'));
const output = path.join(here, 'release', `ManjuStudio-${version}-Windows-x64.zip`);
await writeFile(path.join(source, '使用说明.txt'), '\ufeff' + [
  '漫剧工坊开源桌面预览版', '',
  '解压整个文件夹，再双击“漫剧工坊.exe”。',
  '在设置中填写自己的语言模型接口、模型名和密钥。',
  '启动本机 ComfyUI，配置地址；默认三套工作流已带入，需安装相应模型和节点。',
  '可以导入自己的 API 工作流，或使用“恢复内置工作流”按钮。',
  '项目保存在“文档／漫剧工坊项目”；配置和日志保存在当前用户的应用数据目录。',
  '视频拼接需要本机 FFmpeg：安装后加入 PATH，或设置 DSH_FFMPEG 指向 ffmpeg 可执行文件。',
  '程序不带模型、个人密钥和私人项目。软件为预览版，尚未完成 Windows 真机完整验收。',
  '源码与完整说明：https://github.com/qiukaihui/manju-studio',
].join('\r\n'), 'utf8');
await rm(output, { force: true });
if (process.platform === 'win32') {
  await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "Compress-Archive -Path (Join-Path $env:MANJU_ZIP_SOURCE '*') -DestinationPath $env:MANJU_ZIP_OUTPUT -Force"],
  { env: { ...process.env, MANJU_ZIP_SOURCE: source, MANJU_ZIP_OUTPUT: output }, windowsHide: true });
} else await promisify(execFile)('zip', ['-q', '-r', '-X', output, '.'], { cwd: source });
console.log(path.basename(output));
