'use strict';
(() => {
  const sources = { subscription: '订阅', download: '下载', transfer: '转存', account: '账号', updater: '软件更新', service: '内置服务', app: '应用' };
  const labels = { debug: '调试', info: '信息', warn: '警告', error: '错误' };
  let visible = false, live = true, offset = 0, total = 0, latest, selected, refreshTimer, request = 0;
  const jobs = new Map(), pageSize = 100;
  function filter() {
    const range = $('log-range').value, result = { level: $('log-level').value, source: $('log-source').value, jobId: $('log-job').value, query: $('log-search').value, offset, limit: pageSize };
    if (range === 'custom') {
      if ($('log-from').value) result.from = new Date($('log-from').value).toISOString();
      if ($('log-to').value) result.to = new Date($('log-to').value).toISOString();
    } else if (range) result.from = new Date(Date.now() - Number(range) * 3600000).toISOString();
    return result;
  }
  function localTime(value) { return new Date(value).toLocaleString('zh-CN', { hour12: false }); }
  function format(entry) {
    return `${localTime(entry.time)}  ${entry.level.toUpperCase()} · ${labels[entry.level]}\n来源：${sources[entry.source] || entry.source}${entry.jobName ? '\n订阅：' + entry.jobName : ''}\n\n${entry.message}${entry.details ? '\n\n' + JSON.stringify(entry.details, null, 2) : ''}\n\n记录编号：${entry.id}`;
  }
  function showDetail(entry) { selected = format(entry); $('log-detail-content').textContent = selected; $('log-detail-dialog').showModal(); }
  function row(entry) {
    const tr = element('tr');
    const timeCell = element('td', 'log-time', localTime(entry.time)); timeCell.title = entry.time;
    const level = element('td'); level.append(element('span', 'log-level log-' + entry.level, labels[entry.level]));
    const source = element('td', 'log-source-cell'); source.append(element('span', '', sources[entry.source] || entry.source));
    if (entry.jobName) source.append(element('small', '', entry.jobName));
    const message = element('td', 'log-message', entry.message), detail = element('td');
    const open = button('详情', () => showDetail(entry), 'text-button'); open.setAttribute('aria-label', '查看日志详情：' + entry.message.slice(0, 80)); detail.append(open);
    tr.append(timeCell, level, source, message, detail); return tr;
  }
  async function refresh() {
    clearTimeout(refreshTimer); refreshTimer = null;
    if (!visible) return;
    const generation = ++request;
    try {
      const result = await call('logs-query', filter());
      if (generation !== request || !visible) return;
      latest = result; total = result.total;
      if (offset && offset >= total) { offset = Math.max(0, Math.ceil(total / pageSize) - 1) * pageSize; return refresh(); }
      $('log-rows').replaceChildren(...result.entries.map(row)); $('log-empty').hidden = result.entries.length > 0;
      $('log-result').textContent = `找到 ${total.toLocaleString()} 条记录`;
      $('log-stats').textContent = `错误 ${result.counts.error}　警告 ${result.counts.warn}　信息 ${result.counts.info}　调试 ${result.counts.debug}`;
      $('log-page').textContent = total ? `第 ${offset + 1}～${Math.min(total, offset + pageSize)} 条 · 最新在前` : '暂无记录';
      $('log-prev').disabled = offset === 0; $('log-next').disabled = offset + pageSize >= total;
      const warnings = [result.warning, result.malformed ? `有 ${result.malformed} 条不完整记录，已跳过` : ''].filter(Boolean);
      $('log-warning').hidden = warnings.length === 0; $('log-warning').textContent = warnings.join('；');
      $('log-retention').textContent = `保留 ${result.settings.days} 天 · 已用 ${bytes(result.bytes)} / ${result.settings.maxMB} MB`;
      const jobId = $('log-job').value;
      for (const job of [...(state?.jobs || []), ...result.jobs]) jobs.set(job.id, job.name);
      $('log-job').replaceChildren(new Option('全部订阅', ''), ...[...jobs].map(([id, name]) => new Option(name, id)));
      $('log-job').value = jobId;
    } catch (error) { $('log-warning').hidden = false; $('log-warning').textContent = error.message; }
  }
  function schedule() { if (visible && live && !refreshTimer) refreshTimer = setTimeout(() => { refreshTimer = null; refresh(); }, 600); }
  function setLive(value) { live = value; $('log-live').textContent = live ? '暂停刷新' : '恢复刷新'; $('log-live').setAttribute('aria-pressed', String(live)); $('log-live-state').textContent = live ? '● 实时刷新' : 'Ⅱ 刷新已暂停'; $('log-live-state').classList.toggle('paused', !live); }
  function navigate(showLogs) {
    visible = showLogs; request++; clearTimeout(refreshTimer); refreshTimer = null;
    $('subscriptions-view').hidden = showLogs; $('logs-view').hidden = !showLogs;
    for (const [id, active] of [['nav-subscriptions', !showLogs], ['nav-logs', showLogs]]) {
      $(id).classList.toggle('active', active); if (active) $(id).setAttribute('aria-current', 'page'); else $(id).removeAttribute('aria-current');
    }
    if (showLogs) refresh();
  }
  on('nav-subscriptions', 'click', () => navigate(false)); on('nav-logs', 'click', () => navigate(true));
  on('log-live', 'click', () => { setLive(!live); if (live) { offset = 0; refresh(); } else { clearTimeout(refreshTimer); refreshTimer = null; request++; } });
  on('log-refresh', 'click', refresh);
  function changed() { offset = 0; $('log-custom-range').hidden = $('log-range').value !== 'custom'; request++; clearTimeout(refreshTimer); refreshTimer = setTimeout(() => { refreshTimer = null; refresh(); }, 250); }
  for (const id of ['log-level', 'log-source', 'log-job', 'log-range', 'log-from', 'log-to']) on(id, 'change', changed);
  on('log-search', 'input', changed);
  on('log-reset', 'click', () => { for (const id of ['log-level', 'log-source', 'log-job', 'log-range', 'log-from', 'log-to', 'log-search']) $(id).value = ''; changed(); });
  on('log-prev', 'click', () => { offset = Math.max(0, offset - pageSize); setLive(false); refresh(); });
  on('log-next', 'click', () => { offset += pageSize; setLive(false); refresh(); });
  on('log-detail-close', 'click', () => $('log-detail-dialog').close());
  on('log-detail-copy', 'click', async () => { await call('logs-copy', selected); toast('已复制日志详情'); });
  on('log-export', 'click', async () => {
    $('log-export').disabled = true;
    try { const result = await call('logs-export', filter(), $('log-export-format').value); if (result) toast(`已导出 ${result.count} 条日志：${result.file}`); }
    finally { $('log-export').disabled = false; }
  });
  on('log-open', 'click', () => call('logs-open'));
  on('log-clear', 'click', () => $('log-clear-dialog').showModal());
  on('log-clear-cancel', 'click', () => $('log-clear-dialog').close());
  on('log-clear-confirm', 'click', async () => { await call('logs-clear'); $('log-clear-dialog').close(); offset = 0; await refresh(); toast('已清空日志，之后的事件会继续记录'); });
  on('log-settings', 'click', () => {
    if (!latest) return;
    $('log-record-level').value = latest.settings.level; $('log-days').value = latest.settings.days; $('log-max-mb').value = latest.settings.maxMB;
    $('log-settings-dialog').showModal();
  });
  on('log-settings-close', 'click', () => $('log-settings-dialog').close());
  on('log-settings-save', 'click', async () => {
    await call('logs-settings', { level: $('log-record-level').value, days: Number($('log-days').value), maxMB: Number($('log-max-mb').value) });
    $('log-settings-dialog').close(); await refresh(); toast('日志设置已保存');
  });
  window.archive.onLogsChanged(schedule);
})();
