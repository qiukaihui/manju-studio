const { app, BrowserWindow, dialog, session } = require('electron');
const { fork, spawnSync } = require('node:child_process');
const { mkdirSync, appendFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

let worker;
let window;
let origin;
let quitting = false;
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.whenReady().then(start).catch((e) => { dialog.showErrorBox('启动失败', e.message); app.quit(); });
}

async function start() {
  const sessionToken = randomBytes(32).toString('hex');
  const runtime = app.isPackaged ? path.join(process.resourcesPath, 'runtime') : path.join(__dirname, 'runtime');
  const data = app.getPath('userData');
  const projects = path.join(app.getPath('documents'), '漫剧工坊项目');
  for (const dir of ['state', 'logs', 'bin']) mkdirSync(path.join(data, dir), { recursive: true });
  mkdirSync(projects, { recursive: true });
  // Agent commands can use node without installing a separate system runtime.
  if (process.platform === 'win32') writeFileSync(path.join(data, 'bin', 'node.cmd'), `@echo off\r\n"${process.execPath}" %*\r\n`);
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_DESKTOP: '1', PORT: '0',
    DSH_SESSION_TOKEN: sessionToken,
    STUDIO_AUTO_RESUME: '0', DSH_ROOT: projects, DSH_SKILLS: path.join(runtime, 'skills'),
    DSH_STATE_DIR: path.join(data, 'state'), DSH_LOG_DIR: path.join(data, 'logs'),
    DSH_FFMPEG: process.env.DSH_FFMPEG || 'ffmpeg',
    PATH: [path.join(data, 'bin'), path.join(runtime, 'bin'), process.env.PATH || ''].join(path.delimiter) };
  delete env.LLM_API_KEY;
  delete env.COMFY_URL;
  worker = fork(path.join(runtime, 'server.mjs'), [], { execPath: process.execPath, env,
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const logfile = path.join(data, 'logs', 'desktop.log');
  for (const stream of [worker.stdout, worker.stderr]) stream.on('data', (chunk) => appendFileSync(logfile, chunk));
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('本地服务启动超时，请查看应用日志。')), 30000);
    worker.once('error', (e) => { clearTimeout(timer); reject(e); });
    worker.once('exit', () => { clearTimeout(timer); reject(new Error('本地服务未能启动，请查看应用日志。')); });
    worker.on('message', (msg) => { if (msg.type === 'ready') { clearTimeout(timer); resolve(msg.port); } });
  });
  origin = `http://127.0.0.1:${port}`;
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    if (details.url.startsWith(origin + '/')) details.requestHeaders['X-Studio-Session'] = sessionToken;
    callback({ requestHeaders: details.requestHeaders });
  });
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    // Only the backend talks to the user-configured language model. The UI stays local.
    const allowed = details.url.startsWith(origin + '/') || /^(data:|blob:)/.test(details.url);
    callback({ cancel: !allowed });
  });
  window = new BrowserWindow({ width: 1440, height: 950, minWidth: 1080, minHeight: 720,
    show: false, autoHideMenuBar: true, title: '漫剧工坊',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, devTools: !app.isPackaged } });
  const configure = (contents) => {
    contents.on('will-navigate', (event, url) => { if (!url.startsWith(origin + '/')) event.preventDefault(); });
    contents.setWindowOpenHandler(({ url }) => ({ action: url.startsWith(origin + '/') ? 'allow' : 'deny',
      overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, devTools: false } } }));
    contents.on('did-create-window', (child) => configure(child.webContents));
  };
  configure(window.webContents);
  window.once('ready-to-show', () => window.show());
  worker.on('exit', () => { if (!quitting) { dialog.showErrorBox('本地服务已退出', '请重新打开软件。项目文件保存在“文档／漫剧工坊项目”中。'); app.quit(); } });
  await window.loadURL(origin + '/#settings');
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  quitting = true;
  if (!worker?.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(worker.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else worker.kill('SIGTERM');
});
