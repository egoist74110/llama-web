// Strings and data model for chapters 0 & 1 and shared node components.
// Example addresses use placeholders only (example.com, LAN IPs). No real domains or keys.

export const PRODUCT = {
  name: 'llama-web',
  taglineLine1: 'Unified LLM Gateway',
  taglineLine2: '& llama.cpp Manager',
  tagline: 'Unified LLM Gateway & llama.cpp Manager',
  platforms: 'Windows · macOS（Apple Silicon）',
  repo: 'github.com/egoist74110/llama-web',
} as const;

export type ClientKind = 'chat' | 'agent' | 'ide';

export const CLIENTS: readonly {kind: ClientKind; zh: string; en: string}[] = [
  {kind: 'chat', zh: '客户端', en: 'Chat app'},
  {kind: 'agent', zh: 'Agent', en: 'Automation'},
  {kind: 'ide', zh: 'IDE 插件', en: 'Code editor'},
];

export type ServiceKind = 'local' | 'cloud' | 'server';

// How far llama-web manages a service (matches the product's positioning):
// native  = llama.cpp, official or a fork: download, parameters, custom args, load / switch.
// launch  = another engine on this machine: start (user-written start command), stop, proxy its API.
// proxy   = a service elsewhere (another machine, cloud): API forwarding only.
export type ServiceTier = 'native' | 'launch' | 'proxy';

export const TIERS: Record<ServiceTier, string> = {
  native: '原生管理',
  launch: '启停 · 转发',
  proxy: '仅转发',
};

// Masked keys are drawn as dots; `keyTail` is the only visible part and is fake.
// Engine names are real projects; addresses are placeholders. NInfer is Linux-only, so it sits on
// another machine and can only be proxied.
export const SERVICES: readonly {
  kind: ServiceKind;
  tier: ServiceTier;
  name: string;
  url: string;
  keyTail: string | null;
}[] = [
  {kind: 'local', tier: 'native', name: 'llama.cpp', url: 'http://127.0.0.1:8081/v1', keyTail: null},
  {kind: 'cloud', tier: 'proxy', name: '云端 API', url: 'https://api.example.com/v1', keyTail: '3f9a'},
  {kind: 'local', tier: 'launch', name: 'Ollama', url: 'http://127.0.0.1:11434/v1', keyTail: null},
  {kind: 'server', tier: 'proxy', name: 'vLLM', url: 'http://192.168.1.30:8000/v1', keyTail: 'c071'},
  {kind: 'local', tier: 'launch', name: 'Strata', url: 'http://127.0.0.1:8082/v1', keyTail: null},
  {kind: 'server', tier: 'proxy', name: 'NInfer', url: 'http://192.168.1.50:8000/v1', keyTail: '82be'},
];
