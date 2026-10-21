// Putting knowledge into a chat request (decision 65 ⑩⑪): the retrieved block (inject mode), the `search_knowledge`
// tool (tool mode). Pure functions over the parsed request body; texts come from the dictionary of the saved locale.
import { fmt, t } from '../i18n'
import { MAX_FILTER_TAGS, type TagCount } from './tags'

export const TOOL_NAME = 'search_knowledge'
/** Tool rounds the gateway answers itself; the request after that has no `search_knowledge` tool (decision 65 ⑪). */
export const MAX_TOOL_ROUNDS = 3

/** What a search hit needs to be shown to a model. */
export interface HitText {
  docName: string
  startLine: number
  headingPath: string
  text: string
}

/** The messages of a chat body, or null when the body is not one. */
export function messagesOf(json: unknown): any[] | null {
  const m = (json as { messages?: unknown } | null)?.messages
  return Array.isArray(m) ? m : null
}

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(p => (p && typeof p === 'object' && (p as { type?: unknown }).type === 'text' && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : null))
      .filter((x): x is string => x !== null).join('\n')
  }
  return ''
}

/** Text of the last `user` message (a string, or the `text` parts of an array joined by a newline); '' = none. */
export function queryOf(json: unknown): string {
  const messages = messagesOf(json)
  if (!messages) return ''
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m && typeof m === 'object' && m.role === 'user') return textOfContent(m.content).trim()
  }
  return ''
}

/** `[n] 《doc》 第 N 行 · heading` and the text, one entry per hit, blank line between. '' for no hits. */
export function formatHits(hits: readonly HitText[]): string {
  return hits.map((h, i) => {
    const title = fmt(t.kbPrompt.hitTitle, { n: i + 1, doc: h.docName, line: h.startLine })
    const heading = h.headingPath ? fmt(t.kbPrompt.hitHeading, { heading: h.headingPath }) : ''
    return `${title}${heading}\n${h.text}`
  }).join('\n\n')
}

/** The block inject mode adds to the system message. */
export function injectBlock(hits: readonly HitText[]): string {
  return `${t.kbPrompt.injectHeader}\n\n${formatHits(hits)}`
}

/**
 * Append `block` to the system message (first message with role system / developer), or insert a new system message at
 * the front. Mutates `json`. Returns false when the body has no messages array.
 */
export function injectIntoSystem(json: any, block: string): boolean {
  const messages = messagesOf(json)
  if (!messages) return false
  const first = messages[0]
  if (first && typeof first === 'object' && (first.role === 'system' || first.role === 'developer')) {
    if (typeof first.content === 'string') first.content = `${first.content}\n\n${block}`
    else if (Array.isArray(first.content)) first.content.push({ type: 'text', text: block })
    else first.content = block
  } else {
    messages.unshift({ role: 'system', content: block })
  }
  return true
}

const nameOf = (tool: any): unknown => tool?.function?.name ?? tool?.name

/** The client already defines its own `search_knowledge`: ours stays out and the request is passed through. */
export function hasToolNamed(json: any, name = TOOL_NAME): boolean {
  return Array.isArray(json?.tools) && json.tools.some((x: unknown) => nameOf(x) === name)
}

/**
 * The `tags` parameter of the tool: the tags the model may pick from (most chunks first). Up to MAX_FILTER_TAGS they
 * are an enum; beyond that the parameter is a plain string array and the description lists the first MAX_FILTER_TAGS.
 */
function tagsParameter(tags: readonly TagCount[]) {
  if (tags.length <= MAX_FILTER_TAGS) {
    return { type: 'array', items: { type: 'string', enum: tags.map(x => x.tag) }, description: t.kbPrompt.toolTags }
  }
  const first = [...tags].sort((a, b) => b.count - a.count).slice(0, MAX_FILTER_TAGS).map(x => x.tag)
  return {
    type: 'array',
    items: { type: 'string' },
    description: `${t.kbPrompt.toolTags} ${fmt(t.kbPrompt.toolTagsMore, { n: MAX_FILTER_TAGS, list: first.join('、') })}`,
  }
}

/** `tags` = tags of the bound knowledge bases the model may filter by; none = no `tags` parameter. */
export function toolDefinition(kbNames: readonly string[], tags: readonly TagCount[] = []) {
  return {
    type: 'function',
    function: {
      name: TOOL_NAME,
      description: fmt(t.kbPrompt.toolDescription, { names: kbNames.join('、') }),
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: t.kbPrompt.toolQuery },
          top_k: { type: 'integer', minimum: 1, maximum: 20, description: t.kbPrompt.toolTopK },
          ...(tags.length ? { tags: tagsParameter(tags) } : {}),
        },
        required: ['query'],
      },
    },
  }
}

/** Add our tool (creating `tools` when absent). `tool_choice` is left alone. */
export function addTool(json: any, kbNames: readonly string[], tags: readonly TagCount[] = []): void {
  if (!Array.isArray(json.tools)) json.tools = []
  json.tools.push(toolDefinition(kbNames, tags))
}

/** Take our tool out again; `tools` goes away entirely when nothing else is left. */
export function removeTool(json: any): void {
  if (!Array.isArray(json.tools)) return
  json.tools = json.tools.filter((x: unknown) => nameOf(x) !== TOOL_NAME)
  if (json.tools.length === 0) delete json.tools
}
