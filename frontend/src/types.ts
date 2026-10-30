export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Status = 'running' | 'done' | 'error' | 'aborted' | 'interrupted';
export interface Usage { calls?: number; input?: number; output?: number; cache_read?: number; cache_write?: number }
export interface ToolCall { id?: string; name: string; args?: Json; data?: Json; status: string; ok?: boolean; seconds?: number }
export interface Turn {
  turn: number; summary?: string; thinking?: string; reply?: string;
  status?: Status; tools: ToolCall[]; usage?: Usage; llm?: LlmTiming;
}
export interface LlmTiming { seconds?: number; ttft?: number | null }
export interface Message {
  role: 'user' | 'assistant'; text?: string; status?: Status; error?: string;
  turns?: Turn[]; usage?: Usage; model?: string; reasoning_effort?: string; run_id?: string;
  /** Unix seconds at message creation; absent for historical messages. */
  created_at?: number;
  /** Plugin-provided transcript notes, e.g. steered user messages, placed after ``turn``. */
  notes?: MessageNote[];
  /** Files sent with a user message. */
  attachments?: Attachment[];
}
export interface Attachment { id?: string; name: string; mime: string; size: number; image: boolean; url: string; path?: string }
export interface MessageNote { kind: string; text: string; turn: number; created_at?: number }
export interface Project { id: string; name: string; workspace: string; updated?: number }
export interface Scope { project_id?: string | null; project?: Project | null; workspace?: string; default_workspace?: string; projects: Project[] }
export interface Session { id: string; title: string; project_id?: string | null; workspace?: string; parent_id?: string | null; updated?: number; pinned?: number; running?: boolean; unread?: boolean }
export interface Run {
  id: string; session_id: string; source: string; status: Status | 'cancelling'; seq: number;
  workspace: string; project_id?: string | null; created: number; ended?: number | null; error?: string | null;
}
export interface RunEvent {
  run_id: string; session_id: string; seq: number; run?: Run;
  messages?: Message[]; message?: Message; name?: string; data?: Json;
}
export interface RuntimeModel { id: string; name?: string; model?: string; provider?: string; provider_id?: string }
export interface RuntimeCatalog { current: string; items: RuntimeModel[] }
export interface Effort { current: string; options: string[] }
export interface AgentPreset { id: string; name: string; name_zh?: string; description?: string; description_zh?: string; builtin?: boolean }
export interface PresetCatalog { current: string | null; items: AgentPreset[]; errors?: string[] }
export interface WebManifest { name: string; rev: number; script?: string; style?: string; head?: string; order?: number }
export interface HostState {
  running: boolean; messages: Message[]; session_id?: string; sessions?: Session[];
  web_plugins?: WebManifest[]; scope?: Scope; plugins_enabled?: boolean;
  models?: RuntimeCatalog; effort?: Effort; presets?: PresetCatalog; parallel_runs?: boolean; run_id?: string | null; runs?: Run[];
  local?: { url: string; host: string; port: number }; [key: string]: unknown;
}
export interface HostSnapshot { state: HostState; connected: boolean; changing: boolean; notice: string }
export interface ModelValues { name?: string; model?: string; protocol?: string; apibase?: string; apikey?: string; context_win?: number }
export interface ModelEntry { key: string; protocol: string; provider?: string; values: ModelValues; has_key?: boolean; url_hidden?: boolean;
  options?: Record<string, string | number | boolean>; options_hidden?: string[] }
export interface ProviderEntry { id: string; values: ModelValues; has_key?: boolean; url_hidden?: boolean }
export interface MixinValues { llm_nos?: string[]; max_retries?: number | null; base_delay?: number | null; spring_back?: number | null }
export interface MixinEntry { key: string; members: string[]; indexed: boolean; values: MixinValues }
export interface ModelConfig {
  entries: ModelEntry[]; providers: ProviderEntry[]; mixins?: MixinEntry[]; revision: string; writable: boolean;
  reason?: string; source?: string; format?: string;
}
export interface ModelResult { config: ModelConfig; state: HostState }
export interface PluginField {
  type: 'boolean' | 'integer' | 'string' | 'choice'; label?: string; label_zh?: string;
  description?: string; description_zh?: string; multiline?: boolean; min?: number; max?: number;
  options?: { value: string; label?: string; label_zh?: string }[];
}
export interface PluginInfo {
  name: string; state: string; category?: string; description?: string; description_zh?: string;
  enabled: boolean; protected?: boolean; overridden?: boolean; restart_required?: boolean; hot?: boolean;
  requires?: string[]; provides?: string[]; dependents?: string[]; missing?: string[];
  packages?: string[]; missing_packages?: string[]; worker_only?: boolean; workers?: string[];
  error?: string; fields: Record<string, PluginField>; config: Record<string, Json>;
}
export interface PluginCatalog { items: PluginInfo[]; revision: string; profile: string; restart_required: boolean }

declare global {
  interface Window {
    GAH_LANG: 'zh' | 'en'; T: (zh: string, en: string) => string;
    GAHOutput: {
      setMarkdown(node: HTMLElement, text: string): void;
      toolSummary(name: string, args?: Json): { kind: string; tool: string; target: string; detail: string };
      isAskUser(name: string): boolean;
      askUserPayload(name: string, args?: Json, data?: Json): { question: string; candidates: string[] } | null;
      copyButton(getText: () => string, label?: string): HTMLButtonElement;
    };
    GAHFiles: {
      ref(path: string): import('./sdk').FileRef;
      url(path: string, opts?: { download?: boolean; info?: boolean }): string;
      localPath(raw: string): string;
      open(ref: import('./sdk').FileRef | string, event?: MouseEvent): Promise<boolean>;
      addOpener(fn: import('./sdk').FileOpener): () => void;
    };
  }
}
