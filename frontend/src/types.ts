export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Status = 'running' | 'done' | 'error' | 'aborted';
export interface Usage { calls?: number; input?: number; output?: number; cache_read?: number; cache_write?: number }
export interface ToolCall { id?: string; name: string; args?: Json; data?: Json; status: string; ok?: boolean; seconds?: number }
export interface Turn {
  turn: number; summary?: string; thinking?: string; reply?: string;
  status?: Status; tools: ToolCall[]; usage?: Usage;
}
export interface Message {
  role: 'user' | 'assistant'; text?: string; status?: Status; error?: string;
  turns?: Turn[]; usage?: Usage; model?: string; reasoning_effort?: string;
}
export interface Project { id: string; name: string; workspace: string; rules?: string; memory?: string }
export interface Scope { project_id?: string | null; project?: Project | null; workspace?: string; projects: Project[] }
export interface Session { id: string; title: string; project_id?: string | null; workspace?: string }
export interface RuntimeModel { id: string; name?: string; model?: string; provider?: string; provider_id?: string }
export interface RuntimeCatalog { current: string; items: RuntimeModel[] }
export interface Effort { current: string; options: string[] }
export interface WebManifest { name: string; rev: number; script?: string; style?: string; head?: string; order?: number }
export interface HostState {
  running: boolean; messages: Message[]; session_id?: string; sessions?: Session[];
  web_plugins?: WebManifest[]; scope?: Scope; plugins_enabled?: boolean;
  models?: RuntimeCatalog; effort?: Effort; [key: string]: unknown;
}
export interface HostSnapshot { state: HostState; connected: boolean; changing: boolean; notice: string }
export interface ModelValues { name?: string; model?: string; protocol?: string; apibase?: string; apikey?: string; context_win?: number }
export interface ModelEntry { key: string; protocol: string; provider?: string; values: ModelValues; has_key?: boolean; url_hidden?: boolean }
export interface ProviderEntry { id: string; values: ModelValues; has_key?: boolean; url_hidden?: boolean }
export interface ModelConfig {
  entries: ModelEntry[]; providers: ProviderEntry[]; revision: string; writable: boolean;
  reason?: string; reason_code?: string; source?: string; format?: string;
  convert?: { target: string; blocked?: boolean };
}
export interface ModelResult { config: ModelConfig; state: HostState }
export interface PluginField {
  type: 'boolean' | 'integer' | 'string' | 'choice'; label?: string; label_zh?: string;
  description?: string; description_zh?: string; multiline?: boolean; min?: number; max?: number;
  options?: { value: string; label?: string; label_zh?: string }[];
}
export interface PluginInfo {
  name: string; state: string; category?: string; description?: string; description_zh?: string;
  enabled: boolean; protected?: boolean; overridden?: boolean; restart_required?: boolean;
  requires?: string[]; provides?: string[]; dependents?: string[]; missing?: string[];
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
    };
  }
}
