'use strict';
const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, Notification, nativeImage, safeStorage, shell, powerMonitor, net, clipboard } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const QRCode = require('qrcode');
const { Quark, parseShare, delay } = require('./quark.cjs');
const { Engine } = require('./engine.cjs');
const { PluginManager, validatePlugin } = require('./plugins.cjs');
const { atomicJson, validateDestination } = require('./model.cjs');
const { Updater } = require('./updater.cjs');
const { electronFetcher } = require('./update-network.cjs');
const { startup, registerLinuxDesktop } = require('./desktop.cjs');
const { LogStore, sanitize } = require('./logs.cjs');

// Keep profile/keychain identity stable across the visible application rename.
app.setName('Archive Subscriptions');
const smoke = process.argv.includes('--smoke-test');
const testStartup = smoke && process.platform === 'win32' && process.argv.includes('--test-startup');
if (smoke) app.setPath('userData', process.env.ARCHIVE_TEST_DATA_DIR || require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'archive-smoke-')));
else app.setPath('userData', path.join(app.getPath('appData'), 'Archive Subscriptions'));
if (process.platform === 'win32') app.setAppUserModelId(testStartup ? 'local.archive.subscriptions.smoke-' + crypto.randomUUID() : 'local.archive.subscriptions');
if (process.platform === 'linux') { app.setDesktopName('quark-timed-sync.desktop'); app.commandLine.appendSwitch('class', 'quark-timed-sync'); }
const dataDir = app.getPath('userData');
const stateFile = path.join(dataDir, 'subscriptions.json');
const credentialFile = path.join(dataDir, 'credentials.bin');
const logs = new LogStore(path.join(dataDir, 'logs'));
const log = (level, source, message, context) => logs.write(level, source, message, context);
const jobContext = job => ({ jobId: job.id, jobName: job.name });
let logEventTimer;
logs.on('changed', () => {
  if (logEventTimer || quitting) return;
  logEventTimer = setTimeout(() => { logEventTimer = null; if (window && !window.isDestroyed()) window.webContents.send('archive:logs-changed'); }, 150);
});
const assets = path.join(__dirname, '..', 'assets');
const vendorDir = app.isPackaged ? path.join(process.resourcesPath, 'vendor') : path.join(__dirname, '..', 'vendor', `${process.platform}-${process.arch}`);
const uiPath = path.join(__dirname, 'ui', 'index.html');
let config = { version: 1, paused: false, notifications: true, autoUpdates: false, jobs: [] };
let loggedIn = false, window, tray, engine, quark, updater, installing = false, loginController, loginState = { state: 'idle' };
const desktopIcon = app.isPackaged ? path.join(process.resourcesPath, 'icon.png') : path.join(assets, 'icon.png');
const startupSettings = startup({ app, icon: desktopIcon });
let quitting = false, exiting = false, timer, writeQueue = Promise.resolve();
let plugins;
let pauseGeneration = 0;
const states = new Map(), selectedFolders = new Set(), approvedSources = new Map();
let selectedShare = null;

function safeError(err) { return err?.message || '操作失败，请稍后重试'; }
function startupEnabled() { return (!smoke || testStartup) && startupSettings.get(); }
function snapshot() {
  return { version: app.getVersion(), platform: process.platform, loggedIn, login: loginState,
    paused: config.paused, notifications: config.notifications, autostart: startupEnabled(), autoUpdates: Boolean(config.autoUpdates), updater: updater?.state,
    busy: Boolean(engine?.running), jobs: config.jobs.map(job => ({ ...job, pluginStatus: plugins?.status(job.id) || [],
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
  if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') throw new Error('请先启用系统密钥环（GNOME Keyring 或 KWallet），再扫码登录');
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
  await persist(); log('info', 'subscription', paused ? '已暂停全部订阅' : '已恢复全部订阅'); if (!paused) tick();
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
  if (smoke || quitting || installing || config.paused || !loggedIn || engine.running) return;
  const job = config.jobs.find(x => x.enabled && (!x.nextRun || x.nextRun <= Date.now()));
  if (job) await runJob(job).catch(err => update(job.id, { phase: 'error', error: safeError(err), current: safeError(err) }));
}
async function quit() {
  if (exiting) return; exiting = true; quitting = true;
  await plugins?.close();
  clearInterval(timer); loginController?.abort();
  if (testStartup) app.setLoginItemSettings({ openAtLogin: false });
  await updater?.stop(); await engine?.close(); await writeQueue.catch(() => {});
  await log('info', 'app', '应用退出，已停止后台任务'); await logs.close(); clearTimeout(logEventTimer);
  app.quit();
}
function register(name, handler) {
  ipcMain.handle('archive:' + name, async (event, ...args) => {
    if (event.sender !== window?.webContents || !event.senderFrame?.url.startsWith('file://')) throw new Error('不允许的调用来源');
    try { return { ok: true, value: await handler(...args) }; }
    catch (err) { if (!name.startsWith('logs-')) log('error', 'app', '操作失败：' + name, { details: { error: sanitize(err) } }); return { ok: false, error: safeError(err) }; }
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
  log('info', 'account', '开始扫码登录');
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
          log('info', 'account', '夸克账号登录成功');
          emit(); tick(); return;
        }
      }
      loginState = { state: 'expired' }; log('warn', 'account', '登录二维码已过期'); emit();
    } catch (err) {
      if (!signal.aborted) { loginState = { state: 'error', error: safeError(err) }; log('error', 'account', '扫码登录失败', { details: { error: err } }); emit(); }
    }
  })();
}

function setupIPC() {
  register('configure-plugin', async id => {
    const job = config.jobs.find(item => item.id === id); if (!job) throw new Error('订阅不存在');
    const selected = await dialog.showOpenDialog(window, { title: '选择已安装插件的本地配置',
      properties: ['openFile'], filters: [{ name: 'Plugin JSON', extensions: ['json'] }] });
    if (selected.canceled) return;
    const file = selected.filePaths[0];
    if ((await fs.stat(file)).size > 65536) throw new Error('插件配置过大');
    const plugin = validatePlugin(JSON.parse(await fs.readFile(file, 'utf8')));
    const choice = await dialog.showMessageBox(window, { type: 'question', title: '启用本地后处理插件',
      message: `启用 ${plugin.id} ${plugin.version}？`, detail: '此插件将使用你的本地账户权限执行。请确认它来自你信任的安装程序。\n\n' + JSON.stringify(plugin.command),
      buttons: ['取消', '启用插件'], defaultId: 0, cancelId: 0 });
    if (choice.response !== 1) return;
    plugins.cancel(job.id);
    job.plugins = [...(job.plugins || []).filter(item => item.id !== plugin.id), plugin];
    await persist(); await plugins.retry(job.id); void plugins.pump().catch(() => {});
  });
  register('disable-plugins', async id => {
    const job = config.jobs.find(item => item.id === id); if (!job) throw new Error('订阅不存在');
    plugins.cancel(job.id); job.plugins = []; await persist();
  });
  register('retry-plugins', async id => { await plugins.retry(id); void plugins.pump().catch(() => {}); });
  register('state', () => snapshot());
  register('logs-query', filter => logs.query(filter));
  register('logs-settings', settings => logs.configure(settings));
  register('logs-clear', () => logs.clear());
  register('logs-copy', text => { if (typeof text !== 'string' || text.length > 40000) throw new Error('日志内容过长'); clipboard.writeText(text); });
  register('logs-open', async () => { const error = await shell.openPath(logs.directory); if (error) throw new Error(error); });
  register('logs-export', async (filter, format) => {
    if (!['text', 'jsonl'].includes(format)) throw new Error('日志导出格式无效');
    const extension = format === 'jsonl' ? 'jsonl' : 'txt';
    const name = '夸克同步日志-' + new Date().toISOString().slice(0, 10) + '.' + extension;
    const result = smoke ? { filePath: path.join(dataDir, name) } : await dialog.showSaveDialog(window, {
      title: '导出筛选后的全部日志', defaultPath: path.join(app.getPath('downloads'), name),
      filters: [{ name: format === 'jsonl' ? 'JSON Lines' : '文本日志', extensions: [extension] }]
    });
    if (result.canceled || !result.filePath) return null;
    return { ...await logs.export(result.filePath, filter, format), file: result.filePath };
  });
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
    log('info', 'account', '已退出夸克账号');
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
    config.jobs.push(job); approvedSources.delete(input.sourceToken); await persist();
    log('info', 'subscription', '已创建订阅', { ...jobContext(job), details: { kind: source.kind, intervalMinutes: interval, destination } }); tick(); return job.id;
  });
  register('toggle-job', async id => {
    const job = config.jobs.find(x => x.id === id); if (!job) throw new Error('订阅不存在');
    job.enabled = !job.enabled; if (!job.enabled && states.get(id)?.phase && ['checking', 'saving', 'downloading'].includes(states.get(id).phase)) engine.stop();
    if (job.enabled) job.nextRun = Date.now(); await persist(); tick();
    log('info', 'subscription', job.enabled ? '已恢复订阅' : '已暂停订阅', jobContext(job));
  });
  register('remove-job', async id => {
    const job = config.jobs.find(x => x.id === id); if (!job) return;
    if (engine.running) throw new Error('请先暂停当前下载，再移除订阅');
    config.jobs = config.jobs.filter(x => x.id !== id); states.delete(id); await persist();
    plugins.cancel(id);
    log('info', 'subscription', '已移除订阅，已有文件保留', jobContext(job));
  });
  register('check-job', async id => {
    const job = config.jobs.find(x => x.id === id); if (!job) throw new Error('订阅不存在');
    if (engine.running) throw new Error('已有订阅正在运行');
    log('info', 'subscription', '手动检查订阅', jobContext(job));
    runJob(job).catch(err => update(id, { phase: 'error', error: safeError(err), current: safeError(err) }));
  });
  register('set-interval', async (id, value) => {
    const job = config.jobs.find(x => x.id === id), interval = Number(value);
    if (!job || !Number.isInteger(interval) || interval < 5 || interval > 1440) throw new Error('检查间隔需要在 5 到 1440 分钟之间');
    job.interval = interval; job.nextRun = Date.now() + interval * 60000; await persist();
    log('info', 'subscription', `检查间隔已改为 ${interval} 分钟`, jobContext(job));
  });
  register('pause', value => setPaused(value));
  register('notifications', async value => { config.notifications = Boolean(value); await persist(); });
  register('auto-updates', async value => {
    config.autoUpdates = Boolean(value); await persist();
    log('info', 'updater', config.autoUpdates ? '已开启自动检查软件更新' : '已关闭自动检查软件更新');
    if (!smoke) updater.enable(config.autoUpdates);
  });
  register('check-update', () => { updater.check().catch(() => {}); });
  register('install-update', async () => {
    if (smoke) throw new Error('测试模式不会替换程序');
    if (installing || engine.running) throw new Error('请等当前下载结束，或先暂停下载再更新');
    installing = true;
    try { await updater.prepareInstall([dataDir, ...config.jobs.map(job => job.destination)]); await quit(); }
    catch (error) { installing = false; throw error; }
  });
  register('release-page', () => shell.openExternal('https://github.com/Shadowfax-YJ/quark-timed-sync/releases'));
  register('autostart', value => {
    if (!smoke || testStartup) startupSettings.set(Boolean(value));
    const enabled = startupEnabled(); emit();
    if ((!smoke || testStartup) && enabled !== Boolean(value)) throw new Error('系统未能保存开机启动设置，请检查系统的启动项设置');
    log('info', 'app', enabled ? '已开启登录电脑时启动' : '已关闭登录电脑时启动');
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
  assert(!config.autoUpdates, 'automatic updates must default to off');
  await evaluate("document.querySelector('#open-updates').click(); document.querySelector('#auto-updates').click()"); await delay(100);
  assert(config.autoUpdates, 'update preference did not persist');
  await evaluate("document.querySelector('#auto-updates').click(); document.querySelector('#close-updates').click()"); await delay(100);
  assert(!config.autoUpdates, 'automatic updates could not be disabled');
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
  await evaluate("document.querySelector('#open-updates').click()");
  await fs.writeFile(path.join(path.dirname(output), 'updates.png'), (await window.webContents.capturePage()).toPNG());
  await evaluate("document.querySelector('#close-updates').click()");
  await log('warn', 'subscription', '测试：检查已暂停', jobContext(config.jobs[0]));
  await log('error', 'download', '测试：下载失败，下次检查重试', { ...jobContext(config.jobs[0]), details: { file: '目录/测试.zip', error: 'network timeout', token: 'smoke-private-token' } });
  await evaluate("document.querySelector('#nav-logs').click()"); await delay(900);
  assert(await evaluate("!document.querySelector('#logs-view').hidden && document.querySelector('#subscriptions-view').hidden && document.querySelectorAll('#log-rows tr').length > 0"), 'logs navigation or persisted records failed');
  await evaluate("document.querySelector('#log-level').value='error'; document.querySelector('#log-level').dispatchEvent(new Event('change'))"); await delay(600);
  assert(await evaluate("document.querySelectorAll('#log-rows tr').length === 1 && document.querySelector('#log-rows').textContent.includes('下载失败')"), 'log level filter failed');
  await evaluate("document.querySelector('#log-rows button').click()"); await delay(100);
  assert(await evaluate("document.querySelector('#log-detail-dialog').open && document.querySelector('#log-detail-content').textContent.includes('测试.zip') && !document.querySelector('#log-detail-content').textContent.includes('smoke-private-token')"), 'log details or redaction failed');
  await evaluate("document.querySelector('#log-detail-copy').click()"); await delay(100);
  assert(clipboard.readText().includes('测试.zip') && !clipboard.readText().includes('smoke-private-token'), 'copy log details failed');
  await evaluate("document.querySelector('#log-detail-close').click(); document.querySelector('#log-search').value='不存在的日志'; document.querySelector('#log-search').dispatchEvent(new Event('input'))"); await delay(600);
  assert(await evaluate("!document.querySelector('#log-empty').hidden"), 'log search empty state failed');
  await evaluate("document.querySelector('#log-search').value=''; document.querySelector('#log-search').dispatchEvent(new Event('input'))"); await delay(600);
  await evaluate("document.querySelector('#log-export-format').value='jsonl'; document.querySelector('#log-export').click()"); await delay(400);
  const exportFile = (await fs.readdir(dataDir)).find(name => name.endsWith('.jsonl'));
  const exportedLogs = (await fs.readFile(path.join(dataDir, exportFile), 'utf8')).trim().split('\n').map(JSON.parse);
  assert(exportedLogs.length === 1 && exportedLogs[0].level === 'error', 'filtered log export failed');
  await evaluate("document.querySelector('#log-reset').click()"); await delay(600);
  await evaluate("document.querySelector('#log-live').click()"); await delay(100);
  const rowCount = await evaluate("document.querySelectorAll('#log-rows tr').length");
  await log('info', 'app', '测试：暂停刷新期间继续记录'); await delay(900);
  assert(await evaluate("document.querySelectorAll('#log-rows tr').length") === rowCount, 'pause log refresh failed');
  await evaluate("document.querySelector('#log-live').click()"); await delay(400);
  assert(await evaluate("document.querySelector('#log-rows').textContent.includes('暂停刷新期间继续记录')"), 'resume log refresh failed');
  await evaluate("document.querySelector('#log-settings').click()"); await delay(100);
  await evaluate("document.querySelector('#log-days').value='7'; document.querySelector('#log-record-level').value='debug'; document.querySelector('#log-settings-save').click()"); await delay(300);
  assert(logs.settings.days === 7 && logs.settings.level === 'debug', 'log retention preferences failed');
  await fs.writeFile(path.join(path.dirname(output), 'logs.png'), (await window.webContents.capturePage()).toPNG());
  await evaluate("document.querySelector('#log-clear').click(); document.querySelector('#log-clear-confirm').click()"); await delay(400);
  assert((await logs.query()).total === 0 && config.jobs.length === 1 && config.paused, 'clear logs modified subscriptions or retained records');
  await evaluate("document.querySelector('#nav-subscriptions').click()"); await delay(100);
  assert(await evaluate("!document.querySelector('#subscriptions-view').hidden && document.querySelector('#logs-view').hidden"), 'return to subscriptions failed');
  assert(errors.length === 0, 'renderer error: ' + errors.join('; '));
  await atomicJson(path.join(path.dirname(output), 'smoke-result.json'), { ok: true, platform: process.platform, arch: process.arch, version: app.getVersion(), checks: ['packaged rclone', 'packaged OpenList startup and shutdown', 'render', 'system tray icon', 'folder picker', 'drive subscription', 'pause persistence', 'share parsing', 'share subfolder', 'log navigation, filtering, details, credential redaction, copy, export, pause/resume refresh, retention settings and clear', ...(iconCheck ? ['Windows native taskbar icon size and branding'] : []), ...(testStartup ? ['Windows autostart enable, reload, disable'] : [])], screenshot: path.basename(output) });
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
    await logs.init().catch(error => { logs.disabled = true; logs.failure = '日志初始化失败：' + sanitize(error.message); });
    log('info', 'app', '应用启动', { details: { version: app.getVersion(), platform: process.platform, arch: process.arch } });
    try {
      const read = JSON.parse(await fs.readFile(stateFile, 'utf8'));
      if (read.version !== 1 || !Array.isArray(read.jobs)) throw new Error('配置格式不支持');
      config = { ...config, ...read };
    } catch (err) { if (err.code !== 'ENOENT') throw new Error('订阅配置无法读取。为保护已有配置，应用已停止，请保留数据目录后联系维护者。'); }
    if (smoke) config = { version: 1, paused: false, notifications: true, autoUpdates: false, jobs: [] };
    let jar;
    if (!smoke) {
      try { jar = JSON.parse(safeStorage.decryptString(await fs.readFile(credentialFile))); }
      catch (err) { if (err.code !== 'ENOENT') loginState = { state: 'error', error: '登录凭据无法在此系统读取，请重新扫码登录' }; }
    }
    quark = new Quark(jar, saveSecret);
    plugins = new PluginManager({ dataDir, getJobs: () => config.jobs, changed: emit, log });
    await plugins.init().catch(() => { plugins.failure = '后处理目录暂不可用，基础同步继续'; });
    engine = new Engine({ dataDir, vendorDir, quark, update, persist, notify, log, plugins });
    updater = new Updater({ dataDir, version: app.getVersion(), packaged: app.isPackaged && !smoke,
      fetcher: smoke ? async () => new Response('', { status: 404 }) : electronFetcher(net) });
    let notifiedVersion, loggedUpdatePhase;
    updater.on('state', state => {
      emit();
      if (state.phase !== loggedUpdatePhase) {
        loggedUpdatePhase = state.phase;
        const messages = { checking: '正在检查软件更新', current: '当前没有新版本', downloading: '正在下载软件更新', verifying: '正在校验更新包', ready: '软件更新已准备好', installing: '正在安装软件更新', error: '软件更新失败' };
        if (messages[state.phase]) log(state.phase === 'error' ? 'error' : 'info', 'updater', messages[state.phase], { details: { version: state.version, error: state.error || undefined } });
      }
      if (state.phase === 'ready' && notifiedVersion !== state.version) {
        notifiedVersion = state.version; notify('软件更新已下载', `v${state.version} 已准备好，打开“软件更新”可重启安装。`);
      }
    });
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
    await makeWindow();
    const updateId = process.argv.find(arg => arg.startsWith('--update-id='))?.slice('--update-id='.length);
    await updater.init(updateId).catch(error => updater.set({ phase: 'error', error: safeError(error) }));
    if (!smoke && app.isPackaged && process.platform === 'linux') {
      try { registerLinuxDesktop(process.execPath, desktopIcon); } catch { /* Menu registration is optional on read-only profiles. */ }
    }
    emit();
    if (smoke) return smokeTest();
    if (config.autoUpdates) updater.enable(true);
    if (jar) {
      quark.list('0').then(() => { loggedIn = true; log('info', 'account', '已连接夸克网盘'); emit(); tick(); }).catch(err => { loginState = { state: 'error', error: safeError(err) }; log('error', 'account', '夸克连接失败，请检查网络或重新登录', { details: { error: err } }); emit(); });
    }
    timer = setInterval(() => { tick(); void plugins.pump().catch(() => log('error', 'plugin', '后处理队列暂不可用')); }, 5000);
    powerMonitor.on('resume', () => { log('info', 'app', '电脑已唤醒，恢复订阅调度'); tick(); });
    powerMonitor.on('suspend', () => { log('info', 'app', '电脑进入睡眠，停止当前下载'); engine.stop(); });
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
