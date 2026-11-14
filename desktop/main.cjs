'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, dialog, ipcMain, shell, clipboard } = require('electron');
const workspace = require('./workspace.cjs');
const tools = require('./tools.cjs');
const { Bridge, loadOrCreateState, saveState } = require('./bridge.cjs');
const { SettingsStore, DEFAULTS: SETTING_DEFAULTS, RANGES: SETTING_RANGES, RESTART_KEYS, LABELS: SETTING_LABELS, validateCheckpointDir } = require('./settings.cjs');
const { checkForUpdate, safeReleaseUrl, RELEASES_URL } = require('./update-check.cjs');
const APP_VERSION = require('../package.json').version;
const { CheckpointStore } = require('./checkpoints.cjs');
const { AgentRunner } = require('./agent.cjs');
const { SessionStore } = require('./sessions.cjs');
const { openInEditor } = require('./editor.cjs');
const { RulesStore } = require('./project-rules.cjs');
const git = require('./git.cjs');
const { TerminalManager } = require('./terminal.cjs');
const { WebPreview } = require('./web-preview.cjs');
let bridge = null;
let runner = null;            // phiên chính ('main')
let sessionStore = null;
const runners = new Map();    // id -> AgentRunner (tối đa 3 phiên song song: main, s2, s3)
const EXTRA_SLOTS = ['s2', 's3'];
let checkpoints = null;
let settingsStore = null;
let defaultCheckpointDir = '';
let rulesStore = null;
let terminal = null;
let preview = null;
let mainWindow = null;
let currentRoot = null;
let lastChatUrl = null;          // cuộc trò chuyện Gemini đang dùng cho chế độ chat
let chatActive = false;          // đã có ít nhất 1 lượt chat hoàn tất trong chuỗi hội thoại này (lần chạy app này)
const chatJobs = new Map();       // jobId -> { question, activePath, retried }
const CONV_RE = /^https:\/\/gemini\.google\.com\/(?:u\/\d+\/)?app\/[A-Za-z0-9_-]+/;

function publicBridgeInfo() {
  const { url, connected, appVersion, protocol, extension } = bridge.info();
  return { url, connected, appVersion, protocol, extension };
}
function toUI(index) {
  return { name:index.name, root:index.root, files:index.files, skipped:index.skipped, truncated:index.truncated };
}
function currentIndex() {
  return currentRoot ? toUI(workspace.scanProject(currentRoot)) : null;
}
function requireWorkspace() {
  if (!currentRoot) throw new Error('Open a project folder first');
  return currentRoot;
}
function R(sid) {
  const r = runners.get(sid == null || sid === '' ? 'main' : String(sid));
  if (!r) throw new Error('Phiên không tồn tại (có thể đã bị đóng).');
  return r;
}
function listSessions() {
  return [...runners.entries()].map(([id, r]) => ({ id, goal: r.run.goal, status: r.run.status, turn: r.run.turn, pending: r.pending.length }));
}
/** Cài đặt áp dụng ngay (không cần mở lại ứng dụng). */
function applyLiveSettings(s) {
  workspace.configureContext({ files: s.contextFiles, chars: s.contextChars });
  for (const r of runners.values()) r.setLimits({ maxTurns: s.maxTurns, contextBudgetChars: s.contextBudgetChars });
}
function settingsPayload(extra = {}) {
  return { settings: settingsStore.get(), defaults: SETTING_DEFAULTS, ranges: SETTING_RANGES, labels: SETTING_LABELS, restartKeys: RESTART_KEYS, version: APP_VERSION, checkpointDirInUse: checkpoints ? checkpoints.dir : '', ...extra };
}
function makeRunner(slot) {
  const sid = slot || 'main';
  const cfg = settingsStore ? settingsStore.get() : SETTING_DEFAULTS;
  const r = new AgentRunner({ maxTurns: cfg.maxTurns, contextBudgetChars: cfg.contextBudgetChars, bridge, workspace, tools, checkpoints, getRoot: () => currentRoot, sessions: sessionStore, rules: rulesStore, terminal, preview, slot, isMulti: () => runners.size > 1 });
  r.on('state', snapshot => { send('studio:agent', { ...snapshot, sessionId: sid }); if (runners.size > 1) send('studio:sessions', listSessions()); });
  r.on('file-written', data => { workspace.clearScanCache(); send('studio:file-written', data); });
  r.on('attention', () => { if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFocused()) mainWindow.flashFrame(true); });
  runners.set(sid, r);
  return r;
}
function closeSession(id) {
  const r = runners.get(id);
  if (!r) return;
  try { r.cancel(); } catch { /* ignore */ }
  r.dispose();
  runners.delete(id);
  if (currentRoot && sessionStore) sessionStore.clear(currentRoot, id);
}
function dropExtraSessions() {
  for (const id of [...runners.keys()]) if (id !== 'main') { const r = runners.get(id); try { r.dispose(); } catch { /* ignore */ } runners.delete(id); }
  send('studio:sessions', listSessions());
}
function createWindow() {
  const iconPath = path.join(__dirname, '../public/icon128.png');
  mainWindow = new BrowserWindow({
    width: 1480, height: 920, minWidth: 960, minHeight: 640,
    backgroundColor: '#090d16', title: 'Gemini Project Studio',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation:true, nodeIntegration:false, sandbox:true,
      webSecurity:true
    }
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({url}) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action:'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const dev = process.env.GPS_DEV_URL;
    if (dev && url.startsWith(dev)) return;
    if (!dev && url.startsWith('file:')) return;
    event.preventDefault();
  });
  if (process.env.GPS_DEV_URL) mainWindow.loadURL(process.env.GPS_DEV_URL);
  else mainWindow.loadFile(path.join(__dirname,'../dist/index.html'));
}
function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}
function notifyJob(job) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('studio:job', job);
}
function notifyStatus() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('studio:connection', publicBridgeInfo());
}
app.whenReady().then(async () => {
  const userData = app.getPath('userData');
  // Token + cổng được lưu lại: không phải ghép nối lại extension mỗi lần mở app.
  settingsStore = new SettingsStore(path.join(userData, 'settings.json'));
  const settings = settingsStore.get();
  const stateFile = path.join(userData, 'bridge-state.json');
  const state = loadOrCreateState(stateFile);
  if (settings.bridgePort !== state.port) { state.port = settings.bridgePort; try { saveState(stateFile, state); } catch { /* vẫn chạy với cổng này */ } }
  bridge = new Bridge({ token: state.token, port: state.port });
  await bridge.start();
  defaultCheckpointDir = path.join(userData, 'checkpoints');
  let cpDir = defaultCheckpointDir;
  if (settings.checkpointDir) { try { cpDir = validateCheckpointDir(settings.checkpointDir, null); } catch { cpDir = defaultCheckpointDir; } }
  checkpoints = new CheckpointStore(cpDir);
  rulesStore = new RulesStore(path.join(userData, 'rules'));
  preview = new WebPreview({ createWindow: opts => new BrowserWindow(opts), onChange: st => send('studio:preview', st) });
  terminal = new TerminalManager();
  terminal.on('update', list => send('studio:terminal', list));
  sessionStore = new SessionStore(path.join(userData, 'sessions'));
  runner = makeRunner('');
  workspace.configureContext({ files: settings.contextFiles, chars: settings.contextChars });
  bridge.on('job', job => {
    if (job.kind === 'chat') {
      const m = job.conversationUrl && CONV_RE.exec(job.conversationUrl);
      if (m && job.status !== 'queued') lastChatUrl = m[0];
      if (job.status === 'final') chatActive = true;
      const meta = chatJobs.get(job.id);
      // Tab Gemini đang ở cuộc trò chuyện khác → gửi lại kèm TOÀN BỘ ngữ cảnh trong chat mới (bản cũ làm mất snapshot).
      if (job.status === 'error' && job.code === 'conversation_mismatch' && meta && !meta.retried && currentRoot) {
        meta.retried = true;
        try {
          const ctx = workspace.buildContext(currentRoot, meta.question, { activePath: meta.activePath, isFollowUp: false });
          lastChatUrl = null; chatActive = false;
          bridge.requeue(job.id, { prompt: ctx.prompt, newChat: true });
          return;
        } catch { /* rơi xuống: báo lỗi như bình thường */ }
      }
      if (['final', 'error', 'cancelled'].includes(job.status)) setTimeout(() => chatJobs.delete(job.id), 60_000).unref();
    }
    notifyJob(job);
  });
  bridge.on('heartbeat', notifyStatus);
  // Trình duyệt chỉ được ĐỀ XUẤT ghi file; người dùng duyệt (kèm diff) trong Studio.
  bridge.onProposeWrite = (relPath, content) => runner.proposeExternalWrite(relPath, content);
  bridge.onGetWorkspace = async () => currentIndex();
  ipcMain.handle('studio:init', () => ({ workspace: currentIndex(), connection: publicBridgeInfo() }));
  ipcMain.handle('studio:choose-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'], title:'Select project folder' });
    if (result.canceled || !result.filePaths[0]) return null;
    for (const r of runners.values()) r.cancel();
    dropExtraSessions();   // phiên song song thuộc project cũ
    if (terminal) terminal.stopAll();   // tiến trình nền thuộc project cũ không được mồ côi
    if (preview) preview.close();
    // Bất biến: checkpoint nằm NGOÀI project. Nếu thư mục checkpoint tuỳ chọn trùng/nằm trong project mới → quay về mặc định.
    try { if (checkpoints && checkpoints.dir !== defaultCheckpointDir) validateCheckpointDir(checkpoints.dir, result.filePaths[0]); } catch { checkpoints.dir = defaultCheckpointDir; }
    currentRoot = result.filePaths[0];
    workspace.clearScanCache();
    return currentIndex();
  });
  ipcMain.handle('studio:read-file', (_event, relative) => workspace.readProjectFile(requireWorkspace(), relative));
  ipcMain.handle('studio:write-file', (_event, relative, content) => {
    const root = requireWorkspace();
    const res = workspace.writeProjectFile(root, relative, content);
    const cp = checkpoints.record(root, res.path, res.previous, content, { source: 'editor', note: 'Sửa trong trình soạn thảo' });
    return { path: res.path, size: res.size, backup: null, checkpoint: cp.id };
  });
  ipcMain.handle('studio:search', (_event, query) => workspace.grepProject(requireWorkspace(), String(query).slice(0,200)));
  ipcMain.handle('studio:prepare', (_event, question, activePath='', isFollowUp=false) => workspace.buildContext(requireWorkspace(), question, { activePath, isFollowUp }));
  ipcMain.handle('studio:send', (_event, question, activePath='', isFollowUp=false) => {
    // Chỉ coi là follow-up khi lần chạy app này THỰC SỰ có một cuộc chat Gemini đang diễn ra.
    // Mở lại lịch sử cũ sau khi khởi động lại app → Gemini chưa có snapshot → gửi lại đầy đủ trong chat mới.
    const followUp = !!isFollowUp && chatActive;
    if (!followUp) { lastChatUrl = null; chatActive = false; }
    const context = workspace.buildContext(requireWorkspace(), question, { activePath, isFollowUp: followUp });
    const queued = bridge.enqueue(String(question), context.prompt, context.included, { kind: 'chat', newChat: !followUp, expectConversation: followUp ? lastChatUrl : null });
    chatJobs.set(queued.id, { question: String(question), activePath, retried: false });
    return { ...queued, characters: context.characters };
  });
  ipcMain.handle('studio:connection',() => publicBridgeInfo());
  ipcMain.handle('studio:pair-info',() => JSON.stringify({ url:bridge.info().url, token:bridge.token }, null, 2));
  ipcMain.handle('studio:copy',(_event, value) => { clipboard.writeText(String(value).slice(0,350_000)); return true; });
  ipcMain.handle('studio:read-clipboard', () => clipboard.readText());
  ipcMain.handle('studio:open-gemini', (_event, targetBrowser) => {
    const url = 'https://gemini.google.com/app';
    if (targetBrowser === 'edge') {
      const edgePath1 = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
      const edgePath2 = 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe';
      const edgeBin = fs.existsSync(edgePath1) ? edgePath1 : (fs.existsSync(edgePath2) ? edgePath2 : 'msedge');
      try {
        require('node:child_process').spawn(edgeBin, [url], { detached: true, stdio: 'ignore' }).unref();
        return true;
      } catch {
        shell.openExternal(url);
        return false;
      }
    }
    if (targetBrowser === 'chrome') {
      const chromePath1 = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
      const chromePath2 = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
      const chromeBin = fs.existsSync(chromePath1) ? chromePath1 : (fs.existsSync(chromePath2) ? chromePath2 : 'chrome');
      try {
        require('node:child_process').spawn(chromeBin, [url], { detached: true, stdio: 'ignore' }).unref();
        return true;
      } catch {
        shell.openExternal(url);
        return false;
      }
    }
    shell.openExternal(url);
    return true;
  });
  ipcMain.handle('studio:show-extension',() => {
    const extensionPath = app.isPackaged ? path.join(process.resourcesPath,'extension') : path.join(__dirname,'../extension');
    shell.showItemInFolder(path.join(extensionPath,'manifest.json'));
    return extensionPath;
  });
  ipcMain.handle('studio:import-reply',(_event,id,text) => bridge.completeManually(id, text));
  // ----- Quy tắc & kỹ năng theo project (.gps) -----
  ipcMain.handle('rules:get', () => rulesStore.get(requireWorkspace()));
  ipcMain.handle('rules:save', (_event, text) => rulesStore.saveRules(requireWorkspace(), String(text == null ? '' : text)));
  ipcMain.handle('rules:save-skill', (_event, name, text) => rulesStore.saveSkill(requireWorkspace(), String(name || ''), String(text == null ? '' : text)));
  ipcMain.handle('rules:delete-skill', (_event, name) => rulesStore.deleteSkill(requireWorkspace(), String(name || '')));
  ipcMain.handle('rules:trust', (_event, hash) => rulesStore.trust(requireWorkspace(), String(hash || '')));
  ipcMain.handle('rules:revoke', () => rulesStore.revoke(requireWorkspace()));
  // ----- Cài đặt + kiểm tra cập nhật (chỉ khi người dùng bấm; không tự tải/cài) -----
  ipcMain.handle('settings:get', () => settingsPayload());
  ipcMain.handle('settings:set', (_event, patch) => {
    const r = settingsStore.set(patch, { projectRoot: currentRoot });
    applyLiveSettings(r.settings);
    return settingsPayload({ restartRequired: r.restartRequired });
  });
  ipcMain.handle('settings:reset', () => { settingsStore.reset(); applyLiveSettings(settingsStore.get()); return settingsPayload({ restartRequired: RESTART_KEYS }); });
  ipcMain.handle('settings:pick-dir', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'], title: 'Chọn thư mục lưu checkpoint (ngoài dự án)' });
    return result.canceled || !result.filePaths[0] ? '' : result.filePaths[0];
  });
  ipcMain.handle('app:check-update', () => checkForUpdate(APP_VERSION));
  ipcMain.handle('app:open-release', (_event, url) => {
    const safe = safeReleaseUrl(url) || RELEASES_URL;
    shell.openExternal(safe);
    return safe;
  });
  // ----- Xem trước web (chỉ localhost). Mở/chụp do người dùng bấm; agent phải qua thẻ duyệt (preview_open/preview_screenshot) -----
  ipcMain.handle('preview:status', () => preview.status());
  ipcMain.handle('preview:open', (_event, url) => preview.open(String(url || '')));
  ipcMain.handle('preview:close', () => { preview.close(); return preview.status(); });
  ipcMain.handle('preview:capture-attach', async (_event, sid) => {
    const shot = await preview.capture();
    const info = R(sid).attach('xem-truoc.png', shot.png.toString('base64'));   // vào hàng đính kèm; chỉ rời máy khi bạn gửi tin nhắn
    return { ...info, width: shot.width, height: shot.height, url: shot.url };
  });
  // ----- Terminal (tiến trình nền): người dùng tự bấm = tự duyệt; agent phải qua thẻ duyệt (process_start/process_send) -----
  ipcMain.handle('term:list', () => terminal.list());
  ipcMain.handle('term:start', (_event, command, name) => terminal.start(requireWorkspace(), String(command || ''), { name: String(name || ''), source: 'user' }));
  ipcMain.handle('term:read', (_event, id, since, tail) => terminal.read(String(id), { since: since === undefined ? null : since, tail }));
  ipcMain.handle('term:send', (_event, id, input) => terminal.send(String(id), String(input == null ? '' : input), { newline: true }));
  ipcMain.handle('term:stop', (_event, id) => terminal.stop(String(id)));
  ipcMain.handle('term:stop-all', () => { terminal.stopAll(); return true; });
  // ----- Git: xem status/diff; commit cần xác nhận bằng hộp thoại hệ thống (không push) -----
  ipcMain.handle('git:status', () => git.status(requireWorkspace()));
  ipcMain.handle('git:diff', (_event, rel, staged) => git.diff(requireWorkspace(), { path: String(rel || ''), staged: !!staged }));
  ipcMain.handle('git:commit', async (_event, req) => {
    const root = requireWorkspace();
    const r = req && typeof req === 'object' ? req : {};
    const hooks = r.hooks === true;
    const plan = await git.planCommit(root, { message: r.message, paths: Array.isArray(r.paths) ? r.paths.map(String) : [] });   // ném lỗi nếu không hợp lệ, chưa có tác dụng phụ
    const list = plan.files.map(f => `${f.path} (${f.label})`);
    const choice = await dialog.showMessageBox(mainWindow, {
      type: 'question', buttons: ['Tạo commit', 'Huỷ'], defaultId: 1, cancelId: 1, noLink: true, title: 'Xác nhận commit git',
      message: `Tạo commit trên nhánh "${plan.branch}"?`,
      detail: [plan.message.split('\n')[0], '', ...list.slice(0, 20), list.length > 20 ? `… +${list.length - 20} file` : '', '', `Git hook: ${hooks ? 'BẬT (chạy mã của repo)' : 'tắt'} · Studio không push.`].filter((x, k, a) => !(x === '' && a[k - 1] === '')).join('\n')
    });
    if (!choice || choice.response !== 0) throw new Error('Đã huỷ commit.');
    return git.commit(root, { message: r.message, paths: r.paths.map(String), hooks });
  });
  // ----- Agent -----
  ipcMain.handle('agent:state', (_event, sid) => R(sid).snapshot());
  ipcMain.handle('agent:start', (_event, goal, sid) => R(sid).start(goal));
  ipcMain.handle('agent:reply', (_event, text, sid) => R(sid).reply(text));
  ipcMain.handle('agent:retry', (_event, sid) => R(sid).retry());
  ipcMain.handle('agent:rotate-next', (_event, sid) => R(sid).rotateNext());
  ipcMain.handle('agent:previous', (_event, sid) => R(sid).previousSession());
  ipcMain.handle('agent:open-in-editor', (_event, rel, line, editor) => {
    if (!currentRoot) throw new Error('Hãy mở thư mục dự án trước.');
    return openInEditor(shell, { root: currentRoot, rel: String(rel || ''), line, editor: String(editor || 'vscode') });
  });
  ipcMain.handle('agent:resume', (_event, opts, sid) => R(sid).resume({ continueRun: !(opts && opts.continueRun === false) }));
  ipcMain.handle('agent:discard-previous', (_event, sid) => R(sid).discardPrevious());
  ipcMain.handle('agent:attach', (_event, name, base64, sid) => R(sid).attach(String(name || ''), String(base64 || '')));
  ipcMain.handle('agent:detach', (_event, id, sid) => R(sid).detach(String(id)));
  ipcMain.handle('agent:cancel', (_event, sid) => R(sid).cancel());
  ipcMain.handle('agent:approve', (_event, id, decision, reason, sid) => R(sid).approve(String(id), String(decision), String(reason || '')));
  ipcMain.handle('agent:set-policy', (_event, policy, sid) => R(sid).setPolicy(policy));
  ipcMain.handle('agent:job-prompt', (_event, id) => runner.getJobPrompt(id));   // job id là toàn cục (chung một bridge)
  ipcMain.handle('agent:checkpoints', () => runner.listCheckpoints());
  ipcMain.handle('agent:undo', (_event, id, force, sid) => R(sid).undo(String(id), !!force));
  // ----- Nhiều phiên song song: mỗi phiên một AgentRunner + một cuộc trò chuyện Gemini; chung bridge (hàng đợi gắn sessionId) -----
  ipcMain.handle('agent:sessions', () => listSessions());
  ipcMain.handle('agent:new-session', () => {
    requireWorkspace();
    const slot = EXTRA_SLOTS.find(x => !runners.has(x));
    if (!slot) throw new Error('Tối đa 3 phiên song song. Hãy đóng bớt một phiên.');
    runners.set(slot, makeRunner(slot));
    send('studio:sessions', listSessions());
    return slot;
  });
  ipcMain.handle('agent:close-session', (_event, sid) => {
    const id = String(sid || '');
    if (id === 'main' || !runners.has(id)) throw new Error('Không đóng được phiên này.');
    closeSession(id);
    send('studio:sessions', listSessions());
    return listSessions();
  });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length===0) createWindow(); });
});
app.on('window-all-closed', () => { if(process.platform!=='darwin') app.quit(); });
app.on('before-quit', () => { if (preview) preview.close(); if (terminal) terminal.dispose(); for (const r of runners.values()) r.dispose(); if (bridge) bridge.stop().catch(()=>{}); });
