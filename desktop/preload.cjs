'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const invoke = (channel,...args) => ipcRenderer.invoke(channel,...args);

/** API Agent gắn với một phiên (sessionId được gắn vào cuối mỗi lời gọi IPC; main xử lý mặc định là 'main'). */
function agentApi(sid) {
  return {
    state: () => invoke('agent:state', sid),
    start: goal => invoke('agent:start', goal, sid),
    reply: text => invoke('agent:reply', text, sid),
    retry: () => invoke('agent:retry', sid),
    rotateNext: () => invoke('agent:rotate-next', sid),
    previous: () => invoke('agent:previous', sid),
    openInEditor: (rel, line, editor) => invoke('agent:open-in-editor', rel, line, editor),
    resume: opts => invoke('agent:resume', opts, sid),
    discardPrevious: () => invoke('agent:discard-previous', sid),
    attach: (name, base64) => invoke('agent:attach', name, base64, sid),
    detach: id => invoke('agent:detach', id, sid),
    cancel: () => invoke('agent:cancel', sid),
    approve: (id, decision, reason) => invoke('agent:approve', id, decision, reason, sid),
    setPolicy: policy => invoke('agent:set-policy', policy, sid),
    jobPrompt: id => invoke('agent:job-prompt', id),
    checkpoints: () => invoke('agent:checkpoints'),
    undo: (id, force) => invoke('agent:undo', id, force, sid),
    onState: callback => {
      const listener = (_event, snapshot) => { if ((snapshot && snapshot.sessionId) === sid) callback(snapshot); };
      ipcRenderer.on('studio:agent', listener);
      return () => ipcRenderer.removeListener('studio:agent', listener);
    }
  };
}

contextBridge.exposeInMainWorld('studio', {
  init: () => invoke('studio:init'),
  chooseFolder: () => invoke('studio:choose-folder'),
  readFile: path => invoke('studio:read-file',path),
  writeFile: (path, content) => invoke('studio:write-file', path, content),
  search: query => invoke('studio:search',query),
  prepare: (question,activePath,isFollowUp) => invoke('studio:prepare',question,activePath,isFollowUp),
  send: (question,activePath,isFollowUp) => invoke('studio:send',question,activePath,isFollowUp),
  connection: () => invoke('studio:connection'),
  pairInfo: () => invoke('studio:pair-info'),
  copy: value => invoke('studio:copy',value),
  readClipboard: () => invoke('studio:read-clipboard'),
  openGemini: browser => invoke('studio:open-gemini', browser),
  showExtension: () => invoke('studio:show-extension'),
  importReply: (id,text) => invoke('studio:import-reply',id,text),
  onJob: callback => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('studio:job', listener);
    return () => ipcRenderer.removeListener('studio:job',listener);
  },
  onConnection: callback => {
    const listener = (_event,info) => callback(info);
    ipcRenderer.on('studio:connection',listener);
    return () => ipcRenderer.removeListener('studio:connection',listener);
  },
  terminal: {
    list: () => invoke('term:list'),
    start: (command, name) => invoke('term:start', command, name),
    read: (id, since, tail) => invoke('term:read', id, since, tail),
    send: (id, input) => invoke('term:send', id, input),
    stop: id => invoke('term:stop', id),
    stopAll: () => invoke('term:stop-all'),
    onUpdate: callback => {
      const listener = (_event, list) => callback(list);
      ipcRenderer.on('studio:terminal', listener);
      return () => ipcRenderer.removeListener('studio:terminal', listener);
    }
  },
  git: {
    status: () => invoke('git:status'),
    diff: (path, staged) => invoke('git:diff', path, staged),
    commit: req => invoke('git:commit', req)
  },
  rules: {
    get: () => invoke('rules:get'),
    save: text => invoke('rules:save', text),
    saveSkill: (name, text) => invoke('rules:save-skill', name, text),
    deleteSkill: name => invoke('rules:delete-skill', name),
    trust: hash => invoke('rules:trust', hash),
    revoke: () => invoke('rules:revoke')
  },
  agent: agentApi('main'),
  // Mỗi phiên song song có API riêng gắn với sessionId (tối đa 3: main, s2, s3).
  agentFor: sid => agentApi(String(sid || 'main')),
  sessions: {
    list: () => invoke('agent:sessions'),
    create: () => invoke('agent:new-session'),
    close: sid => invoke('agent:close-session', sid),
    onChange: callback => {
      const listener = (_event, list) => callback(list);
      ipcRenderer.on('studio:sessions', listener);
      return () => ipcRenderer.removeListener('studio:sessions', listener);
    }
  },
  onFileWritten: callback => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('studio:file-written', listener);
    return () => ipcRenderer.removeListener('studio:file-written', listener);
  }
});
