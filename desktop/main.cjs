'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, dialog, ipcMain, shell, clipboard } = require('electron');
const workspace = require('./workspace.cjs');
const tools = require('./tools.cjs');
const { Bridge, loadOrCreateState } = require('./bridge.cjs');
const { CheckpointStore } = require('./checkpoints.cjs');
const { AgentRunner } = require('./agent.cjs');
const { SessionStore } = require('./sessions.cjs');
const { openInEditor } = require('./editor.cjs');
const { RulesStore } = require('./project-rules.cjs');
const git = require('./git.cjs');
let bridge = null;
let runner = null;
let checkpoints = null;
let rulesStore = null;
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
  const state = loadOrCreateState(path.join(userData, 'bridge-state.json'));
  bridge = new Bridge({ token: state.token, port: state.port });
  await bridge.start();
  checkpoints = new CheckpointStore(path.join(userData, 'checkpoints'));
  rulesStore = new RulesStore(path.join(userData, 'rules'));
  runner = new AgentRunner({ bridge, workspace, tools, checkpoints, getRoot: () => currentRoot, sessions: new SessionStore(path.join(userData, 'sessions')), rules: rulesStore });
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
  runner.on('state', snapshot => send('studio:agent', snapshot));
  runner.on('file-written', data => { workspace.clearScanCache(); send('studio:file-written', data); });
  runner.on('attention', () => { if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFocused()) mainWindow.flashFrame(true); });
  // Trình duyệt chỉ được ĐỀ XUẤT ghi file; người dùng duyệt (kèm diff) trong Studio.
  bridge.onProposeWrite = (relPath, content) => runner.proposeExternalWrite(relPath, content);
  bridge.onGetWorkspace = async () => currentIndex();
  ipcMain.handle('studio:init', () => ({ workspace: currentIndex(), connection: publicBridgeInfo() }));
  ipcMain.handle('studio:choose-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'], title:'Select project folder' });
    if (result.canceled || !result.filePaths[0]) return null;
    if (runner) runner.cancel();
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
  ipcMain.handle('agent:state', () => runner.snapshot());
  ipcMain.handle('agent:start', (_event, goal) => runner.start(goal));
  ipcMain.handle('agent:reply', (_event, text) => runner.reply(text));
  ipcMain.handle('agent:retry', () => runner.retry());
  ipcMain.handle('agent:rotate-next', () => runner.rotateNext());
  ipcMain.handle('agent:previous', () => runner.previousSession());
  ipcMain.handle('agent:open-in-editor', (_event, rel, line, editor) => {
    if (!currentRoot) throw new Error('Hãy mở thư mục dự án trước.');
    return openInEditor(shell, { root: currentRoot, rel: String(rel || ''), line, editor: String(editor || 'vscode') });
  });
  ipcMain.handle('agent:resume', (_event, opts) => runner.resume({ continueRun: !(opts && opts.continueRun === false) }));
  ipcMain.handle('agent:discard-previous', () => runner.discardPrevious());
  ipcMain.handle('agent:attach', (_event, name, base64) => runner.attach(String(name || ''), String(base64 || '')));
  ipcMain.handle('agent:detach', (_event, id) => runner.detach(String(id)));
  ipcMain.handle('agent:cancel', () => runner.cancel());
  ipcMain.handle('agent:approve', (_event, id, decision, reason) => runner.approve(String(id), String(decision), String(reason || '')));
  ipcMain.handle('agent:set-policy', (_event, policy) => runner.setPolicy(policy));
  ipcMain.handle('agent:job-prompt', (_event, id) => runner.getJobPrompt(id));
  ipcMain.handle('agent:checkpoints', () => runner.listCheckpoints());
  ipcMain.handle('agent:undo', (_event, id, force) => runner.undo(String(id), !!force));
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length===0) createWindow(); });
});
app.on('window-all-closed', () => { if(process.platform!=='darwin') app.quit(); });
app.on('before-quit', () => { if (runner) runner.dispose(); if (bridge) bridge.stop().catch(()=>{}); });
