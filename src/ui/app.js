'use strict';
const $ = id => document.getElementById(id);
let state, mode = 'drive', sourceToken = null, destination = null, folderStack = [], folderSelection = null, removeId = null;
let toastTimer, busyFolders = false;
const phases = { checking: '检查中', saving: '转存中', downloading: '下载中', idle: '等待更新', paused: '已暂停', error: '需要处理' };
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6500); }
async function call(name, ...args) { try { return await window.archive.call(name, ...args); } catch (err) { toast(err.message); throw err; } }
function element(tag, className, text) { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el; }
function button(text, handler, className = 'subtle') { const el = element('button', className, text); el.addEventListener('click', () => Promise.resolve(handler()).catch(() => {})); return el; }
function bytes(value) { if (!value) return '0 B'; const unit = Math.min(3, Math.floor(Math.log(value) / Math.log(1024))); return (value / 1024 ** unit).toFixed(unit ? 1 : 0) + ' ' + ['B', 'KB', 'MB', 'GB'][unit]; }
function time(value) { return value ? new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '首次检查'; }
function jobCard(job) {
  const live = job.state || {}, paused = state.paused || !job.enabled, active = ['checking', 'saving', 'downloading'].includes(live.phase);
  const card = element('article', 'job'); card.dataset.job = job.id;
  const heading = element('div', 'job-heading'); heading.append(element('div', 'folder-icon', '▱'));
  const title = element('div'); title.append(element('div', 'job-title', job.name), element('div', 'source-type', job.source.kind === 'share' ? '分享链接订阅' : '我的夸克网盘'));
  const badge = element('span', 'badge' + (paused ? ' paused' : live.phase === 'error' ? ' error' : ''), paused && !active ? '已暂停' : phases[live.phase] || '等待更新');
  heading.append(title, badge); card.append(heading);
  const paths = element('dl', 'paths'); paths.append(element('dt', '', '来源'), element('dd', '', job.source.label), element('dt', '', '保存'), element('dd', '', job.destination)); card.append(paths);
  const status = element('div', 'job-status');
  let statusText = live.current || '等待下次检查';
  if (live.phase === 'downloading') statusText = `${live.current} · ${bytes(live.bytes)} · ${bytes(live.speed)}/s`;
  if (paused && !active) statusText = '订阅已暂停，已有文件保留。也可以手动检查一次。';
  status.append(element('span', live.phase === 'error' ? 'error' : '', statusText)); card.append(status);
  if (active) { const bar = element('div', 'progress'), progress = document.createElement('progress'); if (live.totalBytes > 0) { progress.max = live.totalBytes; progress.value = live.bytes || 0; } bar.append(progress); card.append(bar); }
  const bottom = element('div', 'job-bottom'), timing = element('div', 'timing');
  timing.append(document.createTextNode('每 '));
  const interval = element('input', 'job-interval'); interval.type = 'number'; interval.min = '5'; interval.max = '1440'; interval.value = job.interval; interval.setAttribute('aria-label', '检查间隔（分钟）');
  interval.addEventListener('change', () => call('set-interval', job.id, interval.value).catch(() => {})); timing.append(interval, document.createTextNode(` 分钟检查${!paused && !active ? ' · 下次 ' + time(job.nextRun) : ''}`));
  const actions = element('div', 'job-actions'); const check = button('立即检查', () => call('check-job', job.id)); check.disabled = state.busy || !state.loggedIn;
  actions.append(button('打开目录', () => call('open-destination', job.id)), check,
    button(job.enabled ? '暂停' : '恢复', () => call('toggle-job', job.id)),
    button('×', () => { removeId = job.id; $('remove-dialog').showModal(); }, 'icon-button'));
  bottom.append(timing, actions); card.append(bottom); return card;
}
function render(next) {
  state = next;
  $('version').textContent = `v${state.version} · ${{ darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[state.platform] || state.platform}`;
  const updating = state.updater || { phase: 'idle' };
  $('auto-updates').checked = Boolean(state.autoUpdates);
  const updateMessages = { idle: '尚未检查', checking: '正在连接 GitHub…', current: '没有可用的新版本', downloading: `正在下载 v${updating.version} · ${updating.progress}%`, verifying: '正在校验并准备更新…', ready: `v${updating.version} 已准备好${state.busy ? '，请先暂停或等待当前下载完成' : '，可以重启更新'}`, installing: '正在准备重启更新…', error: updating.error || '更新检查失败，请重试' };
  $('update-status').textContent = updateMessages[updating.phase] || updateMessages.idle;
  $('update-status').classList.toggle('error', updating.phase === 'error');
  $('update-progress').hidden = updating.phase !== 'downloading'; $('update-progress').value = updating.progress || 0;
  $('check-update').disabled = ['checking', 'downloading', 'verifying', 'installing', 'ready'].includes(updating.phase);
  $('install-update').hidden = updating.phase !== 'ready'; $('install-update').disabled = state.busy;
  $('open-updates').textContent = updating.phase === 'ready' ? '软件更新 · 可安装' : '软件更新';
  $('account-status').textContent = state.loggedIn ? '夸克网盘已连接' : '尚未登录夸克';
  $('account-dot').classList.toggle('connected', state.loggedIn);
  $('account-button').textContent = state.loggedIn ? '管理登录' : '登录夸克网盘';
  $('global-pause').textContent = state.paused ? '恢复全部' : '暂停全部';
  $('notifications').checked = state.notifications; $('autostart').checked = state.autostart;
  $('count').textContent = state.jobs.length;
  $('overall').textContent = state.paused ? '全部订阅已暂停' : state.busy ? '正在检查或下载新增文件' : state.jobs.length ? `${state.jobs.filter(x => x.enabled).length} 个订阅正在等待更新` : '准备好接收新文件';
  $('empty').hidden = state.jobs.length > 0;
  const focused = document.activeElement;
  if (!focused?.classList.contains('job-interval')) $('jobs').replaceChildren(...state.jobs.map(jobCard));
  const login = state.login || {}, waiting = login.state === 'waiting';
  $('qr-image').hidden = !waiting; if (waiting) $('qr-image').src = login.image;
  const messages = { idle: '点击“刷新二维码”开始登录', loading: '正在生成二维码…', waiting: '请用手机夸克扫码确认', expired: '二维码已过期，点击下方按钮重新生成', success: '登录成功，可以开始订阅了', error: login.error || '登录失败，请重试' };
  $('qr-status').textContent = messages[login.state] || messages.idle;
  $('logout').hidden = !state.loggedIn;
  $('refresh-login').textContent = state.loggedIn ? '重新扫码 / 更换账号' : '刷新二维码';
  if (login.state === 'success' && $('login-dialog').open) { $('login-dialog').close(); toast('夸克登录成功，现在可以创建订阅'); }
}
async function openLogin() {
  $('login-dialog').showModal();
  if (!state.loggedIn && state.login.state !== 'waiting') await call('login');
}
function openWizard() {
  if (!state.loggedIn) { openLogin().catch(() => {}); return; }
  sourceToken = null; destination = null; mode = 'drive'; folderStack = [];
  $('source-label').textContent = '尚未选择来源'; $('local-label').textContent = '尚未选择本地目录';
  $('wizard-error').textContent = ''; $('allow-save').checked = false; $('share-url').value = ''; $('share-passcode').value = '';
  $('job-name').value = 'archive'; setMode('drive'); $('wizard').showModal();
}
function setMode(value) {
  mode = value; sourceToken = null; folderSelection = null; $('source-label').textContent = '尚未选择来源';
  $('drive-controls').hidden = mode !== 'drive'; $('share-controls').hidden = mode !== 'share';
  document.querySelectorAll('[data-mode]').forEach(button => button.classList.toggle('selected', button.dataset.mode === mode));
}
function drawFolders(result) {
  folderSelection = result.selectionToken;
  $('folder-list').replaceChildren(...result.folders.map(folder => {
    const row = button('', () => enterFolder(folder), 'folder-row'); row.dataset.folder = folder.fid;
    row.append(element('span', 'folder-small', '▱'), element('span', '', folder.name), element('span', '', '›')); return row;
  }));
  if (!result.folders.length) $('folder-list').append(element('p', 'help', '此目录没有子文件夹。可以直接订阅当前目录。'));
  $('folder-path').textContent = folderStack.map(x => x.name).join(' / ');
  $('folder-detail').textContent = `${result.folders.length} 个子文件夹，${result.files} 个文件。所选目录的内容会直接保存到本地目标文件夹。`;
  $('folder-up').disabled = folderStack.length <= 1; $('select-current').disabled = false;
}
async function loadCurrent() {
  if (busyFolders) return; busyFolders = true; $('select-current').disabled = true;
  try {
    const current = folderStack.at(-1);
    const result = await call('list-folders', { kind: mode, fid: current.fid, label: folderStack.map(x => x.name).join(' / ') });
    drawFolders(result);
  } finally { busyFolders = false; }
}
async function enterFolder(folder) { if (busyFolders) return; folderStack.push({ fid: folder.fid, name: folder.name }); try { await loadCurrent(); } catch (err) { folderStack.pop(); throw err; } }
function on(id, event, handler) { $(id).addEventListener(event, () => Promise.resolve().then(handler).catch(() => {})); }
on('account-button', 'click', openLogin);
on('close-login', 'click', async () => { $('login-dialog').close(); await call('cancel-login'); });
$('login-dialog').addEventListener('cancel', () => call('cancel-login').catch(() => {}));
on('refresh-login', 'click', () => call('login'));
on('logout', 'click', async () => { await call('logout'); $('login-dialog').close(); });
on('add-subscription', 'click', openWizard); on('empty-add', 'click', openWizard);
on('cancel-wizard', 'click', () => $('wizard').close());
document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => setMode(button.dataset.mode)));
on('choose-local', 'click', async () => { const selected = await call('choose-folder'); if (selected) { destination = selected; $('local-label').textContent = selected; } });
on('choose-drive', 'click', async () => { folderStack = [{ fid: '0', name: '网盘根目录' }]; await loadCurrent(); $('folder-dialog').showModal(); });
on('read-share', 'click', async () => {
  $('read-share').disabled = true;
  try { const result = await call('open-share', $('share-url').value, $('share-passcode').value); folderStack = [{ fid: '0', name: '分享全部内容' }]; drawFolders(result); $('folder-dialog').showModal(); }
  finally { $('read-share').disabled = false; }
});
on('folder-up', 'click', async () => { if (busyFolders || folderStack.length <= 1) return; const last = folderStack.pop(); try { await loadCurrent(); } catch (err) { folderStack.push(last); throw err; } });
on('close-folders', 'click', () => $('folder-dialog').close());
on('select-current', 'click', () => { sourceToken = folderSelection; $('source-label').textContent = folderStack.map(x => x.name).join(' / '); $('folder-dialog').close(); });
on('save-subscription', 'click', async () => {
  $('wizard-error').textContent = ''; $('save-subscription').disabled = true;
  try {
    if (!sourceToken) throw new Error('请先选择来源目录'); if (!destination) throw new Error('请先选择本地目录');
    await call('save-job', { name: $('job-name').value, sourceToken, destination, interval: Number($('interval').value), allowSave: $('allow-save').checked });
    $('wizard').close(); toast(state.paused ? '订阅已创建。全部订阅目前处于暂停状态。' : '订阅已创建，开始检查新增文件');
  } catch (err) { $('wizard-error').textContent = err.message; }
  finally { $('save-subscription').disabled = false; }
});
on('global-pause', 'click', () => call('pause', !state.paused));
on('notifications', 'change', () => call('notifications', $('notifications').checked));
on('autostart', 'change', async () => {
  const enabled = $('autostart').checked; $('autostart').disabled = true;
  try { const saved = await call('autostart', enabled); toast(saved ? '已开启：登录电脑后自动运行' : '已关闭开机启动'); }
  finally { $('autostart').checked = state.autostart; $('autostart').disabled = false; }
});
on('quit', 'click', () => call('quit'));
on('open-updates', 'click', () => $('updates-dialog').showModal());
on('close-updates', 'click', () => $('updates-dialog').close());
on('auto-updates', 'change', async () => { await call('auto-updates', $('auto-updates').checked); });
on('check-update', 'click', () => call('check-update'));
on('install-update', 'click', () => call('install-update'));
on('release-page', 'click', () => call('release-page'));
on('cancel-remove', 'click', () => $('remove-dialog').close());
on('confirm-remove', 'click', async () => { await call('remove-job', removeId); $('remove-dialog').close(); });
window.archive.onState(render);
call('state').then(render).catch(err => toast(err.message));
