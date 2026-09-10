'use strict';
const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, Notification, nativeImage, safeStorage, shell, powerMonitor } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const QRCode = require('qrcode');
const { Quark, parseShare, delay } = require('./quark.cjs');
const { Engine } = require('./engine.cjs');
const { atomicJson, validateDestination } = require('./model.cjs');

// Keep profile/keychain identity stable across the visible application rename.
app.setName('Archive Subscriptions');
const smoke = process.argv.includes('--smoke-test');
const testStartup = smoke && process.platform === 'win32' && process.argv.includes('--test-startup');
if (smoke) app.setPath('userData', process.env.ARCHIVE_TEST_DATA_DIR || require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'archive-smoke-')));
else app.setPath('userData', path.join(app.getPath('appData'), 'Archive Subscriptions'));
app.setAppUserModelId(testStartup ? 'local.archive.subscriptions.smoke-' + crypto.randomUUID() : 'local.archive.subscriptions');
const dataDir = app.getPath('userData');
const stateFile = path.join(dataDir, 'subscriptions.json');
const credentialFile = path.join(dataDir, 'credentials.bin');
const assets = path.join(__dirname, '..', 'assets');
const vendorDir = app.isPackaged ? path.join(process.resourcesPath, 'vendor') : path.join(__dirname, '..', 'vendor', `${process.platform}-${process.arch}`);
const uiPath = path.join(__dirname, 'ui', 'index.html');
let config = { version: 1, paused: false, notifications: true, jobs: [] };
let loggedIn = false, window, tray, engine, quark, loginController, loginState = { state: 'idle' };
let quitting = false, exiting = false, timer, writeQueue = Promise.resolve();
let pauseGeneration = 0;
const states = new Map(), selectedFolders = new Set(), approvedSources = new Map();
let selectedShare = null;

function safeError(err) { return err?.message || '操作失败，请稍后重试'; }
function startupEnabled() { return (!smoke || testStartup) && app.getLoginItemSettings({ path: process.execPath, args: ['--background'] }).openAtLogin; }
function snapshot() {
  return { version: app.getVersion(), platform: process.platform, loggedIn, login: loginState,
    paused: config.paused, notifications: config.notifications, autostart: startupEnabled(),
    busy: Boolean(engine?.running), jobs: config.jobs.map(job => ({ ...job,
      source: { kind: job.source.kind, label: job.source.label }, state: states.get(job.id) || { phase: job.lastError ? 'error' : 'idle', current: job.lastError || '等待下次检查', error: job.lastError || '' }
    })) };
}
function emit() {
  if (window && !window.isDestroyed()) window.webContents.send('archive:state', snapshot());
  if (tray) {
    tray.setToolTip(`夸克网盘定时同步 · ${config.paused ? '已暂停' : engine?.running ? '正在下载 / 检查' : '等待更新'}`);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开夸克网盘定时同步', click: show },
      { label: config.paused ? '恢复全部订阅' : '暂停全部订阅', click: () => setPaused(!config.paused) },
      { label: '立即检查全部', enabled: loggedIn && !engine?.running && config.jobs.length > 0, click: () => checkAll() },
      { type: 'separator' }, { label: '退出并停止下载', click: quit }
    ]));
  }
}
function persist() {
  const content = JSON.parse(JSON.stringify(config));
  writeQueue = writeQueue.catch(() => {}).then(() => atomicJson(stateFile, content));
  emit(); return writeQueue;
}
async function saveSecret(jar) {
  if (smoke) return;
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统凭据加密不可用，无法保存登录信息');
  const temp = credentialFile + '.tmp';
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(temp, safeStorage.encryptString(JSON.stringify(jar)), { mode: 0o600 });
  await fs.rename(temp, credentialFile);
}
function notify(title, body) {
  if (!smoke && config.notifications && Notification.isSupported()) {
    const notice = new Notification({ title, body, icon: path.join(assets, 'icon.png'), silent: false });
    notice.on('click', show); notice.show();
  }
}
function update(id, state) { states.set(id, { ...states.get(id), ...state }); emit(); }
function show() { if (window && !window.isDestroyed()) { window.show(); window.focus(); } }
async function setPaused(paused) {
  config.paused = Boolean(paused); if (paused) { pauseGeneration++; engine.stop(); }
  else for (const job of config.jobs) if (job.enabled) job.nextRun = Date.now();
  await persist(); if (!paused) tick();
}
async function runJob(job) {
  if (!loggedIn) throw new Error('请先扫码登录夸克');
  if (smoke) { update(job.id, { phase: 'idle', current: '没有新增文件，已跳过 348 个已有文件', skipped: 348 }); return; }
  if (engine.running) throw new Error('已有订阅正在运行');
  await engine.run(job); emit();
}
async function checkAll() {
  const generation = pauseGeneration;
  for (const job of config.jobs.filter(x => x.enabled)) {
    if (quitting || engine.running || generation !== pauseGeneration) break;
    await runJob(job).catch(err => update(job.id, { phase: 'error', error: safeError(err), current: safeError(err) }));
  }
}
async function tick() {
  if (smoke || quitting || config.paused || !loggedIn || engine.running) return;
  const job = config.jobs.find(x => x.enabled && (!x.nextRun || x.nextRun <= Date.now()));
  if (job) await runJob(job).catch(err => update(job.id, { phase: 'error', error: safeError(err), current: safeError(err) }));
}
async function quit() {
  if (exiting) return; exiting = true; quitting = true;
  clearInterval(timer); loginController?.abort();
  if (testStartup) app.setLoginItemSettings({ openAtLogin: false });
  await engine?.close(); await writeQueue.catch(() => {});
  app.quit();
}
function register(name, handler) {
  ipcMain.handle('archive:' + name, async (event, ...args) => {
    if (event.sender !== window?.webContents || !event.senderFrame?.url.startsWith('file://')) throw new Error('不允许的调用来源');
    try { return { ok: true, value: await handler(...args) }; }
    catch (err) { return { ok: false, error: safeError(err) }; }
  });
}
function approveSource(source) {
  const token = crypto.randomUUID(); approvedSources.set(token, source); return token;
}
function folderResult(items, source) {
  const folders = items.filter(x => x.dir === true || x.file === false || x.file_type === 0);
  return { folders: folders.map(x => ({ fid: x.fid, name: x.file_name })), files: items.length - folders.length,
    selectionToken: approveSource(source) };
}
async function beginLogin() {
  if (engine.running) throw new Error('请先暂停下载再更换登录');
  loginController?.abort(); const controller = new AbortController(); loginController = controller;
  const signal = controller.signal;
  loginState = { state: 'loading' }; emit();
  const candidate = new Quark();
  const qr = smoke ? { url: 'Archive Subscriptions test QR', expiresAt: Date.now() + 180000 } : await candidate.beginLogin(signal);
  loginState = { state: 'waiting', image: await QRCode.toDataURL(qr.url, { width: 240, margin: 1 }), expiresAt: qr.expiresAt }; emit();
  if (smoke) return;
  (async () => {
    try {
      while (Date.now() < qr.expiresAt) {
        await delay(2500, signal);
        if (await candidate.pollLogin(qr, signal)) {
          candidate.save = saveSecret;
          await saveSecret(candidate.jar.serializeSync());
          quark = candidate; engine.quark = candidate;
          loggedIn = true; loginState = { state: 'success' }; selectedShare = null; approvedSources.clear();
          emit(); tick(); return;
        }
      }
      loginState = { state: 'expired' }; emit();
    } catch (err) {
      if (!signal.aborted) { loginState = { state: 'error', error: safeError(err) }; emit(); }
    }
  })();
}

function setupIPC() {
  register('state', () => snapshot());
  register('login', beginLogin);
  register('cancel-login', () => { loginController?.abort(); loginState = { state: 'idle' }; emit(); });
  register('logout', async () => {
    await setPaused(true); loginController?.abort(); await engine.close();
    await fs.unlink(credentialFile).catch(err => { if (err.code !== 'ENOENT') throw err; });
    // The private embedded service may keep refreshed cookies in its database.
    // Remove only this app-owned database after the service has exited.
    const service = path.resolve(dataDir, 'service');
    if (service.startsWith(path.resolve(dataDir) + path.sep)) await fs.rm(service, { recursive: true, force: true });
    quark = new Quark(); engine.quark = quark; loggedIn = false;
    loginState = { state: 'idle' }; selectedShare = null; approvedSources.clear(); emit();
  });
  register('choose-folder', async () => {
    if (smoke) { const dir = path.join(dataDir, 'downloads'); await fs.mkdir(dir, { recursive: true }); selectedFolders.add(dir); return dir; }
    const result = await dialog.showOpenDialog(window, { title: '选择新增文件下载到的本地文件夹', properties: ['openDirectory', 'createDirectory'] });
    const dir = result.canceled ? null : result.filePaths[0]; if (dir) { await validateDestination(dir); selectedFolders.add(dir); }
    return dir;
  });
  register('list-folders', async (request = {}) => {
    if (!loggedIn) throw new Error('请先扫码登录');
    const fid = String(request.fid || '0'); const label = String(request.label || '网盘根目录').slice(0, 1500);
    if (!/^[a-zA-Z0-9_-]+$/.test(fid)) throw new Error('目录编号无效');
    const kind = request.kind === 'share' ? 'share' : 'drive';
    if (kind === 'share' && !selectedShare) throw new Error('请先读取分享链接');
    const items = smoke ? (fid === '0' ? [{ fid: 'demo-archive', file_name: 'archive', file: false }] : []) : await quark.list(fid, undefined, kind === 'share' ? selectedShare : undefined);
    return folderResult(items, { kind, fid, label, ...(kind === 'share' ? { share: { id: selectedShare.id, url: selectedShare.url, passcode: selectedShare.passcode } } : {}) });
  });
  register('open-share', async (text, passcode) => {
    if (!loggedIn) throw new Error('请先扫码登录');
    const share = parseShare(text, passcode);
    selectedShare = smoke ? { ...share, token: 'test' } : await quark.shareToken(share);
    const items = smoke ? [{ fid: 'shared-archive', file_name: 'archive', file: false }] : await quark.list('0', undefined, selectedShare);
    return folderResult(items, { kind: 'share', fid: '0', label: '分享全部内容', share });
  });
  register('save-job', async input => {
    if (!loggedIn) throw new Error('请先扫码登录');
    if (config.jobs.length >= 20) throw new Error('最多支持 20 个订阅');
    const source = approvedSources.get(input.sourceToken);
    if (!source) throw new Error('请重新选择网盘或分享中的目录');
    const destination = input.destination;
    if (!selectedFolders.has(destination)) throw new Error('请使用“选择文件夹”按钮选择本地目录');
    await validateDestination(destination);
    const interval = Number(input.interval);
    if (!Number.isInteger(interval) || interval < 5 || interval > 1440) throw new Error('检查间隔需要在 5 到 1440 分钟之间');
    if (source.kind === 'share' && !input.allowSave) throw new Error('请确认允许将分享内容转存到自己的网盘');
    for (const job of config.jobs) {
      const a = path.resolve(job.destination).toLowerCase(), b = path.resolve(destination).toLowerCase();
      if (a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep)) throw new Error('本地目录与已有订阅重叠，请选择独立的文件夹');
    }
    const job = { id: crypto.randomUUID(), name: String(input.name || '新订阅').trim().slice(0, 80) || '新订阅',
      source, destination, interval, enabled: true, nextRun: Date.now() };
    config.jobs.push(job); approvedSources.delete(input.sourceToken); await persist(); tick(); return job.id;
  });
  register('toggle-job', async id => {
    const job = config.jobs.find(x => x.id === id); if (!job) throw new Error('订阅不存在');
    job.enabled = !job.enabled; if (!job.enabled && states.get(id)?.phase && ['checking', 'saving', 'downloading'].includes(states.get(id).phase)) engine.stop();
    if (job.enabled) job.nextRun = Date.now(); await persist(); tick();
  });
  register('remove-job', async id => {
    const job = config.jobs.find(x => x.id === id); if (!job) return;
    if (engine.running) throw new Error('请先暂停当前下载，再移除订阅');
    config.jobs = config.jobs.filter(x => x.id !== id); states.delete(id); await persist();
  });
  register('check-job', async id => {
    const job = config.jobs.find(x => x.id === id); if (!job) throw new Error('订阅不存在');
    if (engine.running) throw new Error('已有订阅正在运行');
    runJob(job).catch(err => update(id, { phase: 'error', error: safeError(err), current: safeError(err) }));
  });
  register('set-interval', async (id, value) => {
    const job = config.jobs.find(x => x.id === id), interval = Number(value);
    if (!job || !Number.isInteger(interval) || interval < 5 || interval > 1440) throw new Error('检查间隔需要在 5 到 1440 分钟之间');
    job.interval = interval; job.nextRun = Date.now() + interval * 60000; await persist();
  });
  register('pause', value => setPaused(value));
  register('notifications', async value => { config.notifications = Boolean(value); await persist(); });
  register('autostart', value => {
    if (!smoke || testStartup) app.setLoginItemSettings({ openAtLogin: Boolean(value), path: process.execPath, args: ['--background'] });
    const enabled = startupEnabled(); emit();
    if ((!smoke || testStartup) && enabled !== Boolean(value)) throw new Error('系统未能保存开机启动设置，请检查系统的启动项设置');
    return enabled;
  });
  register('open-destination', id => {
    const job = config.jobs.find(x => x.id === id); if (!job) throw new Error('订阅不存在');
    return shell.openPath(job.destination);
  });
  register('quit', () => { quit(); });
  register('hide', () => window.hide());
}

async function makeWindow() {
  // ICO supplies size-specific HICONs on Windows; PNG keeps its original 1024px size.
  window = new BrowserWindow({ width: 1080, height: 780, minWidth: 800, minHeight: 650, show: false,
    title: '夸克网盘定时同步', backgroundColor: '#f6f7f9', icon: path.join(assets, process.platform === 'win32' ? 'icon.ico' : 'icon.png'), autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  window.on('close', event => {
    if (!quitting && tray) { event.preventDefault(); window.hide(); }
    else if (!quitting) { event.preventDefault(); quit(); }
  });
  await window.loadFile(uiPath);
  if (!smoke && (!process.argv.includes('--background') || !config.jobs.length)) window.show();
}

async function smokeTest() {
  window.showInactive();
  const iconCheck = process.platform === 'win32' && process.env.ARCHIVE_ICON_CHECK_SCRIPT;
  if (iconCheck) {
    // Read the actual packaged window's HICONs without blocking its message loop.
    const { stdout } = await require('node:util').promisify(require('node:child_process').execFile)(
      'powershell.exe', ['-NoProfile', '-NonInteractive', '-File', iconCheck,
        '-WindowHandle', window.getNativeWindowHandle().readBigUInt64LE().toString()], { windowsHide: true });
    console.log(stdout.trim());
  }
  // Check the packaged service paths and executable permissions as well as UI.
  await engine.command('rclone', ['version']);
  await engine.start(); await engine.close();
  const errors = [];
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  await delay(500);
  const evaluate = script => window.webContents.executeJavaScript(script);
  const assert = (ok, text) => { if (!ok) throw new Error(text); };
  assert(tray && !tray.isDestroyed(), 'system tray icon was not created');
  assert(await evaluate("document.querySelector('h1').textContent === '夸克网盘定时同步'"), 'application name not rendered');
  if (testStartup) {
    await evaluate("document.querySelector('#autostart').click()");
    const enabledState = await evaluate("window.archive.call('state')");
    assert(enabledState.autostart, 'autostart is reported disabled immediately after enabling it');
    await delay(100);
    assert(await evaluate("document.querySelector('#autostart').checked"), 'autostart checkbox reverted');
    assert(await evaluate("document.querySelector('#toast').textContent.includes('已开启')"), 'autostart success feedback is missing');
    await new Promise(resolve => { window.webContents.once('did-finish-load', resolve); window.webContents.reload(); });
    for (let retry = 0; retry < 100; retry++) {
      if (await evaluate("document.querySelector('#autostart').checked")) break;
      await delay(25);
    }
    assert(await evaluate("document.querySelector('#autostart').checked"), 'autostart state was lost after reloading the UI');
    await evaluate("document.querySelector('#autostart').click()");
    assert(!(await evaluate("window.archive.call('state')")).autostart, 'autostart could not be disabled');
    await delay(100);
    assert(!(await evaluate("document.querySelector('#autostart').checked")), 'autostart checkbox stayed checked after disabling');
    assert(await evaluate("document.querySelector('#toast').textContent.includes('已关闭')"), 'autostart disable feedback is missing');
  }
  await evaluate("document.querySelector('#add-subscription').click()");
  await delay(100);
  assert(await evaluate("document.querySelector('#wizard').open"), 'wizard not opened');
  await evaluate("document.querySelector('#choose-local').click()");
  await delay(100);
  await evaluate("document.querySelector('#choose-drive').click()");
  await delay(100);
  await evaluate("document.querySelector('[data-folder]').click()");
  await delay(100);
  await evaluate("document.querySelector('#select-current').click(); document.querySelector('#job-name').value='Archive 演示订阅'; document.querySelector('#save-subscription').click()");
  await delay(300);
  assert(config.jobs.length === 1, 'drive subscription not saved');
  assert(config.jobs[0].source.fid === 'demo-archive', 'wrong source folder');
  await evaluate("document.querySelector('#global-pause').click()");
  await delay(100); assert(config.paused, 'global pause did not persist');
  await evaluate("document.querySelector('#add-subscription').click()"); await delay(100);
  await evaluate("document.querySelector('[data-mode=share]').click(); document.querySelector('#share-url').value='https://pan.quark.cn/s/test123?pwd=ABCD'; document.querySelector('#read-share').click()");
  await delay(150);
  assert(await evaluate("document.querySelector('#folder-dialog').open"), 'share folders not displayed');
  await evaluate("document.querySelector('[data-folder]').click()"); await delay(100);
  await evaluate("document.querySelector('#select-current').click()"); await delay(100);
  assert(await evaluate("document.querySelector('#source-label').textContent.includes('archive')"), 'share folder not selected');
  await evaluate("document.querySelector('#cancel-wizard').click()"); await delay(300);
  assert(await evaluate("!document.querySelector('#wizard').open && !document.querySelector('#folder-dialog').open"), 'dialogs did not close');
  const png = await window.webContents.capturePage();
  const output = process.env.ARCHIVE_SMOKE_OUTPUT || path.join(dataDir, 'smoke.png');
  await fs.mkdir(path.dirname(output), { recursive: true }); await fs.writeFile(output, png.toPNG());
  assert(errors.length === 0, 'renderer error: ' + errors.join('; '));
  await atomicJson(path.join(path.dirname(output), 'smoke-result.json'), { ok: true, platform: process.platform, arch: process.arch, version: app.getVersion(), checks: ['packaged rclone', 'packaged OpenList startup and shutdown', 'render', 'system tray icon', 'folder picker', 'drive subscription', 'pause persistence', 'share parsing', 'share subfolder', ...(iconCheck ? ['Windows native taskbar icon size and branding'] : []), ...(testStartup ? ['Windows autostart enable, reload, disable'] : [])], screenshot: path.basename(output) });
  await quit();
}

if (!app.requestSingleInstanceLock() && !smoke) { app.quit(); }
else {
  app.on('second-instance', show);
  app.on('before-quit', event => { if (!quitting) { event.preventDefault(); quit(); } });
  app.on('window-all-closed', () => {});
  app.on('activate', show);
  app.whenReady().then(async () => {
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    try {
      const read = JSON.parse(await fs.readFile(stateFile, 'utf8'));
      if (read.version !== 1 || !Array.isArray(read.jobs)) throw new Error('配置格式不支持');
      config = { ...config, ...read };
    } catch (err) { if (err.code !== 'ENOENT') throw new Error('订阅配置无法读取。为保护已有配置，应用已停止，请保留数据目录后联系维护者。'); }
    if (smoke) config = { version: 1, paused: false, notifications: true, jobs: [] };
    let jar;
    if (!smoke) {
      try { jar = JSON.parse(safeStorage.decryptString(await fs.readFile(credentialFile))); }
      catch (err) { if (err.code !== 'ENOENT') loginState = { state: 'error', error: '登录凭据无法在此系统读取，请重新扫码登录' }; }
    }
    quark = new Quark(jar, saveSecret);
    engine = new Engine({ dataDir, vendorDir, quark, update, persist, notify });
    setupIPC();
    app.setAboutPanelOptions({ applicationName: '夸克网盘定时同步', applicationVersion: app.getVersion() });
    Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([
      { label: '夸克网盘定时同步', submenu: [{ label: '关于夸克网盘定时同步', role: 'about' }, { type: 'separator' }, { label: '退出并停止下载', accelerator: 'Cmd+Q', click: quit }] },
      { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] }
    ]) : null);
    try {
      if (process.platform === 'win32') {
        // Let Windows select the ICO frame for the current taskbar DPI.
        tray = new Tray(path.join(assets, 'tray.ico'));
      } else {
        const icon = nativeImage.createFromPath(path.join(assets, process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png'));
        if (process.platform === 'darwin') icon.setTemplateImage(true);
        tray = new Tray(icon);
      }
      tray.on('click', show);
    } catch {}
    if (smoke) loggedIn = true;
    await makeWindow(); emit();
    if (smoke) return smokeTest();
    if (jar) {
      quark.list('0').then(() => { loggedIn = true; emit(); tick(); }).catch(err => { loginState = { state: 'error', error: safeError(err) }; emit(); });
    }
    timer = setInterval(() => tick(), 5000);
    powerMonitor.on('resume', () => tick());
    powerMonitor.on('suspend', () => engine.stop());
  }).catch(async err => {
    if (smoke) {
      if (testStartup) app.setLoginItemSettings({ openAtLogin: false });
      const output = process.env.ARCHIVE_SMOKE_OUTPUT || path.join(dataDir, 'smoke.png');
      await atomicJson(path.join(path.dirname(output), 'smoke-result.json'), { ok: false, error: safeError(err) });
      await engine?.close(); app.exit(1);
    } else {
      dialog.showErrorBox('夸克网盘定时同步无法启动', safeError(err)); await engine?.close(); app.exit(1);
    }
  });
}
