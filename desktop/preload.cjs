'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const invoke = (channel,...args) => ipcRenderer.invoke(channel,...args);

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
  agent: {
    state: () => invoke('agent:state'),
    start: goal => invoke('agent:start', goal),
    reply: text => invoke('agent:reply', text),
    retry: () => invoke('agent:retry'),
    rotateNext: () => invoke('agent:rotate-next'),
    previous: () => invoke('agent:previous'),
    openInEditor: (rel, line, editor) => invoke('agent:open-in-editor', rel, line, editor),
    resume: opts => invoke('agent:resume', opts),
    discardPrevious: () => invoke('agent:discard-previous'),
    attach: (name, base64) => invoke('agent:attach', name, base64),
    detach: id => invoke('agent:detach', id),
    cancel: () => invoke('agent:cancel'),
    approve: (id, decision, reason) => invoke('agent:approve', id, decision, reason),
    setPolicy: policy => invoke('agent:set-policy', policy),
    jobPrompt: id => invoke('agent:job-prompt', id),
    checkpoints: () => invoke('agent:checkpoints'),
    undo: (id, force) => invoke('agent:undo', id, force),
    onState: callback => {
      const listener = (_event, snapshot) => callback(snapshot);
      ipcRenderer.on('studio:agent', listener);
      return () => ipcRenderer.removeListener('studio:agent', listener);
    }
  },
  onFileWritten: callback => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('studio:file-written', listener);
    return () => ipcRenderer.removeListener('studio:file-written', listener);
  }
});
