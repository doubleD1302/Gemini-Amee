export interface ProjectFile { path:string; name:string; size:number; }
export interface WorkspaceInfo { name:string; root:string; files:ProjectFile[]; skipped:number; truncated:boolean; }
export interface ExtensionCompat { status:'unknown'|'ok'|'outdated'|'newer'; version:string; protocol:number; }
export interface BridgeConnection { url:string; connected:boolean; appVersion?:string; protocol?:number; extension?:ExtensionCompat; }
export interface Prepared { prompt:string; included:string[]; totalFiles:number; truncated:boolean; characters:number; }
export interface SearchMatch { path:string; line:number; snippet:string; }
export type JobStatus = 'queued'|'dispatched'|'sent'|'streaming'|'final'|'error'|'cancelled';
export interface Job { id:string; question:string; included:string[]; status:JobStatus; answer?:string; characters?:number; }

export type MessageRole = 'user' | 'assistant';

export interface ChatMessage {
  id: string;
  role: MessageRole;
  text: string;
  jobId?: string;
  status?: JobStatus | 'manual';
  included?: string[];
  preparedPrompt?: string;
  timestamp?: number;
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  workspaceRoot?: string;
  workspaceName?: string;
  model?: string;
  mode?: string;
  messages: ChatMessage[];
}
export type AgentStatus = 'idle'|'running'|'waiting_approval'|'waiting_user'|'done'|'error'|'cancelled';
export interface DiffRow { k: 'ctx'|'chg'|'del'|'add'; l: { n: number; s: string }|null; r: { n: number; s: string }|null; }
export interface DiffHunkView { header: string; rows: DiffRow[]; }
export interface EditGroup { path: string; count: number; diff: string; view: DiffHunkView[]; line: number; summary: string; }
export interface AgentStep {
  id: string; at: number;
  type: 'info'|'user'|'assistant'|'tool'|'error';
  text?: string; tool?: string; label?: string; summary?: string; diff?: string; view?: DiffHunkView[]; line?: number; output?: string;
  status?: 'running'|'waiting_approval'|'done'|'failed'|'rejected'|'error'|'expired'|'interrupted';
  checkpoint?: string;
}
export interface AgentPending { id: string; tool: string; label: string; summary: string; diff: string; view?: DiffHunkView[]; line?: number; group?: EditGroup|null; kind: 'edit'|'exec'; source: 'agent'|'vibe'; createdAt: number; }
export interface PreviousSession {
  id: string; goal: string; savedAt: number; status: string; turn: number; stepCount: number;
  filesChanged: string[]; interrupted: boolean; expiredApprovals: number; chatIndex: number;
}
export interface AgentContext {
  chars: number; tokens: number; budgetChars: number; budgetTokens: number; ratio: number;
  chatIndex: number; rotations: number; turnsInChat: number; rotateRequested: boolean;
}
export type AgentPlanStatus = 'pending'|'in_progress'|'done';
export interface AgentPlanItem { text: string; status: AgentPlanStatus; }
/** Kế hoạch do model xuất (tool `plan`): chỉ để hiển thị, văn bản mục là dữ liệu không tin cậy → render dạng text thuần. */
export interface AgentPlan { items: AgentPlanItem[]; updatedAt: number; }
/** Tệp đính kèm chờ gửi ở tin nhắn kế tiếp (chỉ thông tin, không có dữ liệu). */
export interface AgentAttachment { id: string; name: string; kind: 'image'|'text'; size: number; }
export interface AgentState {
  id: string|null; goal: string; status: AgentStatus; turn: number; maxTurns: number;
  conversationUrl: string|null; jobId: string|null; liveText: string; error: string; question: string;
  plan: AgentPlan|null;
  attachments: AgentAttachment[];
  policy: { autoEdits: boolean };
  context: AgentContext;
  steps: AgentStep[]; pending: AgentPending[];
}
export interface CheckpointInfo { id: string; path: string; created: boolean; at: number; source: string; note: string; undone: boolean; }
export interface AgentApi {
  state(): Promise<AgentState>;
  start(goal: string): Promise<AgentState>;
  reply(text: string): Promise<AgentState>;
  retry(): Promise<AgentState>;
  rotateNext(): Promise<AgentState>;
  previous(): Promise<PreviousSession|null>;
  openInEditor(rel: string, line: number, editor: string): Promise<{ opened: 'url'|'path'|'none'; fallback: boolean; editor: string; line: number; error?: string }>;
  resume(opts?: { continueRun?: boolean }): Promise<AgentState>;
  discardPrevious(): Promise<boolean>;
  attach(name: string, base64: string): Promise<AgentAttachment>;
  detach(id: string): Promise<boolean>;
  cancel(): Promise<AgentState>;
  approve(id: string, decision: 'approve'|'reject'|'approve_all_edits'|'approve_group', reason?: string): Promise<{ ok: boolean }>;
  setPolicy(policy: { autoEdits: boolean }): Promise<{ autoEdits: boolean }>;
  jobPrompt(id: string): Promise<string|null>;
  checkpoints(): Promise<CheckpointInfo[]>;
  undo(id: string, force?: boolean): Promise<CheckpointInfo>;
  onState(fn: (state: AgentState) => void): () => void;
}
export interface ProjectSkill { name: string; file: string; description: string; text: string; }
export interface ProjectRules {
  status: 'none'|'trusted'|'review'; rules: string; skills: ProjectSkill[]; warnings: string[]; hash: string;
  limits: { rulesChars: number; skillChars: number; skills: number };
}
export interface RulesApi {
  get(): Promise<ProjectRules>;
  save(text: string): Promise<{ path: string; status: string }>;
  saveSkill(name: string, text: string): Promise<{ path: string; status: string }>;
  deleteSkill(name: string): Promise<ProjectRules>;
  trust(hash: string): Promise<ProjectRules>;
  revoke(): Promise<ProjectRules>;
}
export interface StudioApi {
  init():Promise<{workspace:WorkspaceInfo|null;connection:BridgeConnection}>;
  chooseFolder():Promise<WorkspaceInfo|null>;
  readFile(path:string):Promise<{path:string;content:string;size:number}>;
  writeFile(path:string,content:string):Promise<{path:string;size:number;backup?:string|null;checkpoint?:string}>;
  search(query:string):Promise<SearchMatch[]>;
  prepare(question:string,activePath:string,isFollowUp?:boolean):Promise<Prepared>;
  send(question:string,activePath:string,isFollowUp?:boolean):Promise<Job>;
  connection():Promise<BridgeConnection>;
  pairInfo():Promise<string>;
  copy(value:string):Promise<boolean>;
  readClipboard():Promise<string>;
  openGemini(browser?: 'default' | 'edge' | 'chrome'): Promise<boolean | void>;
  showExtension():Promise<string>;
  importReply(id:string,text:string):Promise<boolean>;
  agent: AgentApi;
  rules: RulesApi;
  onJob(fn:(job:Job)=>void):()=>void;
  onConnection(fn:(conn:BridgeConnection)=>void):()=>void;
  onFileWritten?(fn:(data:{path:string})=>void):()=>void;
}
declare global { interface Window {studio:StudioApi;} }
