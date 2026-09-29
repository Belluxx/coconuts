// `window.coconuts` exists only in the desktop app; see desktop/preload.cjs.

export type AgentProvider = 'cursor' | 'codex' | 'claude' | 'vscode';

export interface AgentQuestion {
  id: string;
  question: string;
  options: { id: string; label: string; description?: string }[];
  multiSelect: boolean;
  allowOther: boolean;
}

/** Selected option ids and free text, per question id. */
export type AgentAnswers = Record<string, { selected: string[]; text: string }>;

export interface AgentSource {
  provider: AgentProvider;
  project: string;
}

/** A finished reply or a pending question, delivered by the yacht. */
export interface AgentBottle extends AgentSource {
  id: string;
  response: string;
  status: string;
  read: boolean;
  question?: {
    questions: AgentQuestion[];
    state: 'pending' | 'answered' | 'resolved';
    replyMode: 'direct' | 'handoff';
  };
}

export interface AgentState {
  working: Record<string, AgentSource & { waiting?: boolean }>;
  bottles: AgentBottle[];
}

export interface ReplyResult { ok: boolean; error?: string }

export interface SetupAgent {
  id: AgentProvider;
  name: string;
  detected: boolean;
  installed: boolean;
  needsUpdate: boolean;
  connected: boolean;
  instruction: string;
  error: string;
}

export interface SetupState { firstRun: boolean; agents: SetupAgent[] }

interface DesktopBridge {
  onAgentState(callback: (state: AgentState) => void): () => void;
  markRead(id: string): Promise<void>;
  answer(id: string, answers: AgentAnswers): Promise<ReplyResult>;
  copyReply(id: string, answers: AgentAnswers): Promise<ReplyResult>;
  openAgent(id: string): Promise<boolean>;
  /** A user activation, so the island can lock the mouse when the window gains focus. */
  activate(): Promise<void>;
  setup: {
    state(): Promise<SetupState>;
    subscribe(callback: (state: SetupState) => void): () => void;
    install(selected: AgentProvider[]): Promise<SetupState>;
    dismiss(): Promise<void>;
    openAgent(provider: AgentProvider): Promise<boolean>;
    showConfig(provider: AgentProvider): Promise<void>;
  };
}

declare global { interface Window { coconuts?: DesktopBridge } }

export const desktop = window.coconuts;
