// State and actions of the chat page: conversations (browser-local), the models that can be
// chatted with right now, and the streaming request. The page only wires these to the UI.
import t from '~~/i18n/zh-CN'
import { newMessage, newId, streamChat, titleFrom, toRequestMessages, type ChatSession } from '~/utils/chat'
import { idbBackend, memoryBackend, type ChatBackend } from '~/utils/chat-db'

export interface ChatModelOption { value: string, label: string, hasMmproj: boolean }

export function useChat() {
  const { state } = useLive()

  // ---- models: only instances that are ready; the chat page never starts one ----
  const options = computed<ChatModelOption[]>(() => (state.value?.models ?? []).flatMap(m =>
    m.instances.filter(i => i.state === 'ready').map(i => ({
      value: `${m.name}:${i.profile}`,
      label: m.profiles.length > 1 ? `${m.name} · ${i.profile}` : m.name,
      hasMmproj: m.hasMmproj,
    }))))
  const selected = ref('')
  const option = computed(() => options.value.find(o => o.value === selected.value) ?? null)

  // ---- conversations ----
  let backend: ChatBackend = memoryBackend()
  const loaded = ref(false)
  const persistent = ref(true)
  const sessions = ref<ChatSession[]>([])
  const currentId = ref<string | null>(null)
  const current = computed(() => sessions.value.find(s => s.id === currentId.value) ?? null)

  async function save(s: ChatSession) {
    try { await backend.put(s) } catch { persistent.value = false }
  }

  onMounted(async () => {
    try { backend = await idbBackend() } catch { persistent.value = false }
    try {
      sessions.value = (await backend.all()).sort((a, b) => b.updatedAt - a.updatedAt)
    } catch { persistent.value = false }
    currentId.value = sessions.value[0]?.id ?? null
    loaded.value = true
  })

  // Keep a valid model selected: the conversation's last model if it is still up, else the first one up.
  watch([options, currentId], () => {
    if (options.value.some(o => o.value === selected.value)) return
    const last = current.value?.model
    selected.value = options.value.find(o => o.value === last)?.value ?? options.value[0]?.value ?? ''
  }, { immediate: true })
  watch(currentId, () => {
    const last = current.value?.model
    if (last && options.value.some(o => o.value === last)) selected.value = last
  })

  function newSession(): ChatSession {
    const now = Date.now()
    const s: ChatSession = { id: newId(), title: t.chat.newTitle, model: selected.value, renamed: false, createdAt: now, updatedAt: now, messages: [] }
    sessions.value = [s, ...sessions.value]
    currentId.value = s.id
    return sessions.value[0]!
  }
  // A blank conversation is reused instead of piling up empty ones.
  function startNew() {
    if (busy.value) return
    const blank = sessions.value.find(s => !s.messages.length)
    if (blank) currentId.value = blank.id
    else newSession()
  }
  function select(id: string) {
    if (!busy.value) currentId.value = id
  }
  async function rename(id: string, title: string) {
    const s = sessions.value.find(x => x.id === id)
    const v = title.trim()
    if (!s || !v) return
    s.title = v
    s.renamed = true
    await save(s)
  }
  async function remove(id: string) {
    if (busy.value && id === currentId.value) stop()
    sessions.value = sessions.value.filter(s => s.id !== id)
    if (currentId.value === id) currentId.value = sessions.value[0]?.id ?? null
    try { await backend.remove(id) } catch { persistent.value = false }
  }

  // ---- sending ----
  const busy = ref(false)
  let abort: AbortController | null = null

  /** Stream a reply to the conversation as it stands (its last message is the user's). */
  async function run(s: ChatSession) {
    if (!selected.value) return
    s.model = selected.value
    s.messages.push(newMessage('assistant'))
    const reply = s.messages[s.messages.length - 1]!
    const history = s.messages.slice(0, -1)
    abort = new AbortController()
    busy.value = true
    try {
      const r = await streamChat(
        fetch,
        { model: selected.value, messages: toRequestMessages(history) },
        abort.signal,
        (d) => { reply.content += d.content; reply.reasoning += d.reasoning },
        status => fmt(t.chat.requestFailed, { status }),
      )
      reply.stats = r.stats
      if (!reply.content && !reply.reasoning) reply.error = t.chat.emptyReply
    } catch (e) {
      if ((e as Error).name !== 'AbortError') reply.error = (e as Error).message || t.chat.networkError
    } finally {
      abort = null
      busy.value = false
      s.updatedAt = Date.now()
      sessions.value = [...sessions.value].sort((a, b) => b.updatedAt - a.updatedAt)
      await save(s)
    }
  }

  async function send(text: string, images: string[]) {
    if (busy.value || !selected.value || (!text.trim() && !images.length)) return
    const s = current.value ?? newSession()
    if (!s.messages.length && !s.renamed) s.title = titleFrom(text, images.length ? t.chat.imageTitle : t.chat.newTitle)
    s.messages.push(newMessage('user', text.trim(), images))
    await run(s)
  }

  /** Drop the last reply and ask again. */
  async function regenerate() {
    const s = current.value
    if (!s || busy.value || s.messages.at(-1)?.role !== 'assistant') return
    s.messages.pop()
    await run(s)
  }

  function stop() { abort?.abort() }
  onBeforeUnmount(stop)

  return { options, selected, option, loaded, persistent, sessions, currentId, current, busy, startNew, select, rename, remove, send, regenerate, stop }
}
