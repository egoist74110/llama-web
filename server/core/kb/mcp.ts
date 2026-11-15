// MCP server for the knowledge bases (decision 65 ⑦ / 69 ⑦): Streamable HTTP, stateless, JSON responses only. This module
// is the JSON-RPC layer; the HTTP wrapper (path, method, body) is in http.ts and the operations are in external.ts.
// Pure module (no Nitro).
import { fmt, t } from '../i18n'
import type { KbAccess } from './access'
import { isOpName, isWriteOp, KbApiError, READ_OPS, runOp, WRITE_OPS, type ExternalDeps, type OpName } from './external'

/** Newest first. */
export const MCP_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const

export const RPC = { parse: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602, internal: -32603 } as const

export interface McpContext {
  deps: ExternalDeps
  access: KbAccess
  /** Reported as `serverInfo.version`. */
  version: string
}

export type RpcResponse =
  | { jsonrpc: '2.0', id: string | number | null, result: unknown }
  | { jsonrpc: '2.0', id: string | number | null, error: { code: number, message: string } }

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)

const rpcError = (id: string | number | null, code: number, message: string): RpcResponse => ({ jsonrpc: '2.0', id, error: { code, message } })
const rpcResult = (id: string | number, result: unknown): RpcResponse => ({ jsonrpc: '2.0', id, result })

export const parseErrorResponse = (): RpcResponse => rpcError(null, RPC.parse, t.kbApi.mcpParseError)

// ---- tools ----

interface Tool {
  name: OpName
  description: string
  inputSchema: Json
}

function schema(props: Record<string, Json>, required: string[]): Json {
  return { type: 'object', properties: props, required }
}

/** The 12 tools; the 4 write tools only when `write` (a read-only caller does not see them). */
export function mcpTools(write: boolean): Tool[] {
  const p = t.kbApi.params
  const d = t.kbApi.tools as Record<OpName, string>
  const kbId: Json = { type: 'string', description: p.kbId }
  const guideRev: Json = { type: 'string', description: p.guideRev }
  const baseVersion: Json = { type: 'integer', description: p.baseVersion }
  const entryId: Json = { type: 'integer', description: p.entryId }
  const sourceId: Json = { type: 'integer', description: p.sourceId }
  const tags: Json = { type: 'array', items: { type: 'string' }, description: p.tags }
  const offset: Json = { type: 'integer', minimum: 0 }
  const all: Tool[] = [
    { name: 'list_knowledge_bases', description: d.list_knowledge_bases, inputSchema: schema({}, []) },
    { name: 'kb_guide', description: d.kb_guide, inputSchema: schema({ kb_id: kbId }, ['kb_id']) },
    {
      name: 'search_knowledge', description: d.search_knowledge,
      inputSchema: schema({
        query: { type: 'string', description: p.query },
        kb_ids: { type: 'array', items: { type: 'string' }, description: p.kbIds },
        top_k: { type: 'integer', minimum: 1, maximum: 20, description: p.topK },
        tags: { type: 'array', items: { type: 'string' }, description: p.filterTags },
        min_similarity: { type: 'number', minimum: 0, maximum: 1, description: p.minSimilarity },
      }, ['query']),
    },
    {
      name: 'list_entries', description: d.list_entries,
      inputSchema: schema({ kb_id: kbId, tag: { type: 'string' }, query: { type: 'string' }, offset, limit: { type: 'integer', minimum: 1, maximum: 200 } }, ['kb_id']),
    },
    { name: 'get_entry', description: d.get_entry, inputSchema: schema({ kb_id: kbId, entry_id: entryId }, ['kb_id', 'entry_id']) },
    { name: 'get_entry_history', description: d.get_entry_history, inputSchema: schema({ kb_id: kbId, entry_id: entryId }, ['kb_id', 'entry_id']) },
    { name: 'list_sources', description: d.list_sources, inputSchema: schema({ kb_id: kbId }, ['kb_id']) },
    {
      name: 'read_source', description: d.read_source,
      inputSchema: schema({ kb_id: kbId, source_id: sourceId, offset, length: { type: 'integer', minimum: 1, maximum: 20000 } }, ['kb_id', 'source_id']),
    },
    {
      name: 'add_entry', description: d.add_entry,
      inputSchema: schema({
        kb_id: kbId, guide_rev: guideRev, title: { type: 'string', minLength: 1, maxLength: 200 },
        body: { type: 'string', minLength: 1, maxLength: 20000 }, tags,
      }, ['kb_id', 'guide_rev', 'title', 'body']),
    },
    {
      name: 'update_entry', description: d.update_entry,
      inputSchema: schema({
        kb_id: kbId, guide_rev: guideRev, entry_id: entryId, base_version: baseVersion,
        title: { type: 'string', minLength: 1, maxLength: 200 }, body: { type: 'string', minLength: 1, maxLength: 20000 }, tags,
      }, ['kb_id', 'guide_rev', 'entry_id', 'base_version']),
    },
    {
      name: 'delete_entry', description: d.delete_entry,
      inputSchema: schema({ kb_id: kbId, guide_rev: guideRev, entry_id: entryId, base_version: baseVersion }, ['kb_id', 'guide_rev', 'entry_id', 'base_version']),
    },
    {
      name: 'add_source', description: d.add_source,
      inputSchema: schema({ kb_id: kbId, guide_rev: guideRev, name: { type: 'string', minLength: 1, maxLength: 200 }, text: { type: 'string', minLength: 1 }, tags }, ['kb_id', 'guide_rev', 'name', 'text']),
    },
  ]
  return write ? all : all.filter(x => !isWriteOp(x.name))
}

/** Keep READ_OPS / WRITE_OPS and the tool list in step (checked by a test). */
export const TOOL_NAMES: readonly OpName[] = [...READ_OPS, ...WRITE_OPS]

function toolError(err: KbApiError): unknown {
  const body = { error: { code: err.code, message: err.message, ...(err.extra ?? {}) } }
  return { content: [{ type: 'text', text: JSON.stringify(body) }], isError: true }
}

async function callTool(ctx: McpContext, name: OpName, args: unknown): Promise<unknown> {
  try {
    // A caller that may not write cannot call a write tool, whatever else is wrong with the call.
    if (isWriteOp(name) && !ctx.access.write) throw new KbApiError(403, 'kb_read_only', t.kbApi.kbReadOnly)
    const result = await runOp(ctx.deps, ctx.access, name, args)
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false }
  } catch (e) {
    if (e instanceof KbApiError) return toolError(e)
    return toolError(new KbApiError(500, 'internal_error', t.api.internalError))
  }
}

// ---- JSON-RPC ----

function negotiate(asked: unknown): string {
  return typeof asked === 'string' && (MCP_PROTOCOLS as readonly string[]).includes(asked) ? asked : MCP_PROTOCOLS[0]
}

/** One JSON-RPC message; null = nothing to answer (a notification, or a response sent to us). */
async function handleMessage(msg: unknown, ctx: McpContext): Promise<RpcResponse | null> {
  if (!isObj(msg)) return rpcError(null, RPC.invalidRequest, t.kbApi.mcpInvalidRequest)
  const hasId = msg.id !== undefined
  const id = msg.id
  const rpcId = typeof id === 'string' || typeof id === 'number' ? id : null
  if (typeof msg.method !== 'string') {
    // A response to a request of ours: there are none, ignore it.
    if ('result' in msg || 'error' in msg) return null
    return rpcError(rpcId, RPC.invalidRequest, t.kbApi.mcpInvalidRequest)
  }
  if (msg.jsonrpc !== '2.0') return hasId ? rpcError(rpcId, RPC.invalidRequest, t.kbApi.mcpInvalidRequest) : null
  // A notification (no id): handled silently, whatever it is.
  if (!hasId) return null
  if (rpcId === null) return rpcError(null, RPC.invalidRequest, t.kbApi.mcpInvalidRequest)
  const params = msg.params
  if (params !== undefined && params !== null && !isObj(params)) return rpcError(rpcId, RPC.invalidParams, fmt(t.kbApi.mcpInvalidParams, { detail: 'params' }))
  const p: Json = isObj(params) ? params : {}

  switch (msg.method) {
    case 'initialize':
      return rpcResult(rpcId, {
        protocolVersion: negotiate(p.protocolVersion),
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'llama-web', version: ctx.version },
        instructions: t.kbApi.mcpInstructions,
      })
    case 'ping':
      return rpcResult(rpcId, {})
    case 'tools/list':
      return rpcResult(rpcId, { tools: mcpTools(ctx.access.write) })
    case 'tools/call': {
      if (typeof p.name !== 'string' || !p.name) return rpcError(rpcId, RPC.invalidParams, fmt(t.kbApi.mcpInvalidParams, { detail: 'name' }))
      if (!isOpName(p.name)) return rpcError(rpcId, RPC.invalidParams, fmt(t.kbApi.mcpUnknownTool, { name: p.name }))
      if (p.arguments !== undefined && p.arguments !== null && !isObj(p.arguments)) return rpcError(rpcId, RPC.invalidParams, fmt(t.kbApi.mcpInvalidParams, { detail: 'arguments' }))
      return rpcResult(rpcId, await callTool(ctx, p.name, p.arguments ?? {}))
    }
    default:
      return rpcError(rpcId, RPC.methodNotFound, fmt(t.kbApi.mcpMethodNotFound, { method: msg.method }))
  }
}

/**
 * The body of one POST /v1/mcp, already parsed: a message or a batch. `status` 202 with no `json` when there is nothing to
 * answer (only notifications).
 */
export async function handleMcpBody(body: unknown, ctx: McpContext): Promise<{ status: 200 | 202, json?: unknown }> {
  if (Array.isArray(body)) {
    if (body.length === 0) return { status: 200, json: rpcError(null, RPC.invalidRequest, t.kbApi.mcpInvalidRequest) }
    const out: RpcResponse[] = []
    for (const m of body) {
      const r = await handleMessage(m, ctx)
      if (r) out.push(r)
    }
    return out.length ? { status: 200, json: out } : { status: 202 }
  }
  const r = await handleMessage(body, ctx)
  return r ? { status: 200, json: r } : { status: 202 }
}
