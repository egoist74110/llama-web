<script setup lang="ts">
// Add / edit one external upstream in a slide-over. The API key is write-only: the list only says whether one is
// saved, a blank box keeps it, "clear" removes it. Server messages (Chinese) are shown as they come.
import { t } from '../composables/useLocale'
import { bindingIncomplete } from '~/utils/kb'
import type { KnowledgeBinding } from '~~/server/core/kb/binding'
import type { ConnectionView } from '~~/server/core/upstreams'

const props = defineProps<{ open: boolean, upstream: ConnectionView | null }>()
const emit = defineEmits<{ 'update:open': [boolean], saved: [name: string, createdId: string | null, isNew: boolean] }>()

const f = t.upstreams.form
const p = t.upstreams.page
const open = computed({ get: () => props.open, set: v => emit('update:open', v) })
const isNew = computed(() => !props.upstream)

const form = reactive({ name: '', baseUrl: '', monitorUrl: '', apiKey: '', clearKey: false, manualModels: '', startCwd: '' })
// Start commands (decision 68): the first is the default entry (renamable, never removable). New ones have no id yet.
const DEFAULT_ID = 'default'
const MAX_COMMANDS = 10
const cmds = ref<Array<{ id: string, name: string, command: string }>>([{ id: DEFAULT_ID, name: '', command: '' }])
const sel = ref(0)
const cmdLabel = (c: { id: string, name: string }) => c.name.trim() || (c.id === DEFAULT_ID ? f.startCommandDefaultName : f.startCommandNew)
const cmdItems = computed(() => cmds.value.map((c, i) => ({ label: cmdLabel(c), value: i })))
const current = computed(() => cmds.value[sel.value] ?? cmds.value[0]!)
function addCommand() {
  if (cmds.value.length >= MAX_COMMANDS) return
  cmds.value.push({ id: '', name: '', command: '' })
  sel.value = cmds.value.length - 1
}
function removeCommand() {
  if (current.value.id === DEFAULT_ID) return
  cmds.value.splice(sel.value, 1)
  sel.value = 0
}
// What "on" starts as: every knowledge base (including later ones), injected, 5 hits.
const knowledge = ref<KnowledgeBinding>({ enabled: false, all: true, kbs: [], mode: 'inject', topK: 5, tags: [], minSimilarity: null })
const knowledgeIncomplete = computed(() => bindingIncomplete(knowledge.value))
// Gateway web search for this upstream (decision 67): on by default.
const webSearch = ref(true)
const ws = t.webSearch
const kb = t.kbBinding
const ui = usePlatformUi()
const toast = useToast()
const saving = ref(false)
const error = ref('')

// Fresh values every time the panel opens.
watch(() => props.open, (o) => {
  if (!o) return
  const u = props.upstream
  form.name = u?.name ?? ''
  form.baseUrl = u?.baseUrl ?? ''
  form.monitorUrl = u?.monitorUrl ?? ''
  form.apiKey = ''
  form.clearKey = false
  form.manualModels = u?.manualModels.join('\n') ?? ''
  cmds.value = u?.startCommands.length ? u.startCommands.map(c => ({ ...c })) : [{ id: DEFAULT_ID, name: '', command: '' }]
  sel.value = 0
  form.startCwd = u?.startCwd ?? ''
  const b = u?.knowledge
  knowledge.value = b ? { ...b, kbs: [...b.kbs], tags: [...(b.tags ?? [])], all: b.enabled ? b.all : b.all || b.kbs.length === 0 } : { enabled: false, all: true, kbs: [], mode: 'inject', topK: 5, tags: [], minSimilarity: null }
  webSearch.value = u?.webSearch !== false
  error.value = ''
})

const messageOf = (e: unknown) => {
  const err = e as { data?: { message?: string }, statusMessage?: string, message?: string }
  return err?.data?.message ?? err?.statusMessage ?? err?.message ?? String(e)
}
const ready = computed(() => !!form.name.trim() && !!form.baseUrl.trim() && !knowledgeIncomplete.value)

async function copyPrompt() {
  try {
    await navigator.clipboard.writeText(f.guide.aiPrompt)
    toast.add({ title: f.guide.copied, color: 'success', icon: 'i-lucide-check' })
  } catch {
    toast.add({ title: f.guide.copyFailed, color: 'warning', icon: 'i-lucide-circle-alert' })
  }
}

async function save() {
  if (saving.value || !ready.value) return
  saving.value = true
  error.value = ''
  const body: Record<string, unknown> = {
    name: form.name.trim(),
    baseUrl: form.baseUrl.trim(),
    monitorUrl: form.monitorUrl.trim(),
    manualModels: form.manualModels.split('\n').map(x => x.trim()).filter(Boolean),
    // Empty extra entries are dropped; the default entry always stays.
    startCommands: cmds.value
      .filter(c => c.id === DEFAULT_ID || c.name.trim() || c.command.trim())
      .map(c => ({ ...(c.id ? { id: c.id } : {}), name: c.name.trim(), command: c.command.trim() })),
    startCwd: form.startCwd.trim(),
    knowledge: knowledge.value,
    webSearch: webSearch.value,
  }
  if (form.clearKey) body.apiKey = ''
  else if (form.apiKey.trim()) body.apiKey = form.apiKey.trim()
  try {
    const u = props.upstream
    const r = await $fetch<{ createdId?: string | null }>(u ? `/api/upstreams/${encodeURIComponent(u.id)}` : '/api/upstreams', { method: 'POST', body })
    emit('saved', form.name.trim(), r.createdId ?? null, isNew.value)
    open.value = false
  } catch (e) {
    error.value = messageOf(e)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <USlideover
    v-model:open="open"
    :title="upstream ? fmt(f.editTitle, { name: upstream.name }) : f.addTitle"
    :description="f.description"
    :ui="{ content: 'w-full max-w-lg', body: 'space-y-4' }"
  >
    <template #body>
      <form id="upstream-form" class="flex flex-col gap-4" @submit.prevent="save">
        <UFormField :label="f.name" :hint="undefined">
          <UInput v-model="form.name" class="w-full" maxlength="24" :placeholder="f.namePlaceholder" autocomplete="off" />
          <p class="mt-1 text-xs text-dimmed">
            {{ f.nameHint }}
          </p>
        </UFormField>
        <UFormField :label="f.baseUrl">
          <UInput v-model="form.baseUrl" class="w-full font-mono" :placeholder="f.baseUrlPlaceholder" autocomplete="off" :ui="{ base: 'font-mono text-xs' }" />
          <p class="mt-1 text-xs text-dimmed">
            {{ f.baseUrlHint }}
          </p>
        </UFormField>
        <UFormField :label="f.monitorUrl">
          <UInput v-model="form.monitorUrl" class="w-full" autocomplete="off" :ui="{ base: 'font-mono text-xs' }" />
          <p class="mt-1 text-xs text-dimmed">
            {{ f.monitorUrlHint }}
          </p>
        </UFormField>
        <UFormField :label="f.apiKey">
          <UInput
            v-model="form.apiKey"
            type="password"
            class="w-full"
            autocomplete="new-password"
            :disabled="form.clearKey"
            :placeholder="upstream?.hasKey && !form.clearKey ? f.apiKeySaved : f.apiKeyNew"
          />
          <p v-if="upstream?.hasKey" class="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-dimmed">
            <template v-if="form.clearKey">
              <span class="text-warning">{{ f.apiKeyClearPending }}</span>
              <button type="button" class="text-primary" @click="form.clearKey = false">{{ f.apiKeyClearUndo }}</button>
            </template>
            <button v-else type="button" class="text-error" @click="form.clearKey = true; form.apiKey = ''">{{ f.apiKeyClear }}</button>
          </p>
          <p class="mt-1 text-xs text-dimmed">
            {{ p.keyHint }}
          </p>
        </UFormField>
        <UFormField :label="f.manualModels">
          <UTextarea v-model="form.manualModels" :rows="4" autoresize class="w-full" :placeholder="f.manualModelsPlaceholder" :ui="{ base: 'font-mono text-xs' }" />
          <p class="mt-1 text-xs text-dimmed">
            {{ f.manualModelsHint }}
          </p>
        </UFormField>
        <UFormField :label="f.startCommand">
          <div class="flex flex-col gap-2">
            <div class="flex items-center gap-2">
              <USelect v-model="sel" :items="cmdItems" class="min-w-0 flex-1" :aria-label="f.startCommandPick" />
              <UButton type="button" size="sm" color="neutral" variant="outline" icon="i-lucide-plus" :disabled="cmds.length >= MAX_COMMANDS" @click="addCommand">
                {{ f.startCommandAdd }}
              </UButton>
              <UButton v-if="current.id !== DEFAULT_ID" type="button" size="sm" color="error" variant="ghost" icon="i-lucide-trash-2" :aria-label="f.startCommandRemove" :title="f.startCommandRemove" @click="removeCommand" />
            </div>
            <UInput v-model="current.name" class="w-full" maxlength="24" autocomplete="off" :aria-label="f.startCommandName" :placeholder="current.id === DEFAULT_ID ? f.startCommandDefaultName : f.startCommandNamePlaceholder" />
            <UInput
              v-model="current.command"
              class="w-full"
              autocomplete="off"
              :placeholder="ui.isMac ? f.startCommandPlaceholderMac : f.startCommandPlaceholderWin"
              :ui="{ base: 'font-mono text-xs' }"
            />
          </div>
          <p class="mt-1 text-xs text-dimmed">
            {{ f.startCommandNameHint }}
          </p>
          <p class="mt-1 text-xs text-dimmed">
            {{ f.startCommandHint }}
          </p>
        </UFormField>
        <UFormField :label="f.startCwd">
          <UInput v-model="form.startCwd" class="w-full" autocomplete="off" :ui="{ base: 'font-mono text-xs' }" />
          <p class="mt-1 text-xs text-dimmed">
            {{ f.startCwdHint }}
          </p>
        </UFormField>
        <section class="rounded-[10px] border border-default px-3.5 py-3">
          <p class="m-0 mb-2.5 text-xs text-dimmed">
            {{ kb.upstreamHint }}
          </p>
          <KnowledgeBindingForm v-model="knowledge" />
        </section>
        <section class="flex items-center justify-between gap-3 rounded-[10px] border border-default px-3.5 py-3">
          <div class="min-w-0">
            <p class="m-0 text-sm text-default">
              {{ ws.upstreamLabel }}
            </p>
            <p class="m-0 mt-0.5 text-xs text-dimmed">
              {{ ws.upstreamHint }}
            </p>
          </div>
          <USwitch v-model="webSearch" :aria-label="ws.upstreamLabel" />
        </section>
        <details class="rounded-[10px] border border-default px-3.5 py-2.5 text-[13px]">
          <summary class="cursor-pointer font-medium">
            {{ f.guide.title }}
          </summary>
          <div class="mt-2.5 flex flex-col gap-3 text-xs text-muted">
            <p class="m-0">
              {{ f.guide.intro }}
            </p>
            <div v-for="g in (ui.isMac ? [{ t: f.guide.macTitle, l: f.guide.mac }, { t: f.guide.winTitle, l: f.guide.win }] : [{ t: f.guide.winTitle, l: f.guide.win }, { t: f.guide.macTitle, l: f.guide.mac }])" :key="g.t">
              <p class="m-0 mb-1 font-medium text-default">
                {{ g.t }}
              </p>
              <ul class="m-0 flex list-none flex-col gap-1 p-0">
                <li v-for="x in g.l" :key="x" class="break-all">
                  {{ x }}
                </li>
              </ul>
            </div>
            <div>
              <p class="m-0 mb-1 font-medium text-default">
                {{ f.guide.aiTitle }}
              </p>
              <p class="m-0 mb-1.5">
                {{ f.guide.aiBody }}
              </p>
              <pre class="m-0 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[var(--lw-sunken)] p-2.5 font-sans text-xs text-default">{{ f.guide.aiPrompt }}</pre>
              <UButton class="mt-2" size="xs" color="neutral" variant="outline" icon="i-lucide-copy" @click="copyPrompt">
                {{ f.guide.copy }}
              </UButton>
            </div>
          </div>
        </details>
        <p v-if="error" role="alert" class="m-0 text-sm text-error">
          {{ error }}
        </p>
      </form>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" @click="open = false">
          {{ f.cancel }}
        </UButton>
        <UButton type="submit" form="upstream-form" icon="i-lucide-check" :disabled="!ready" :loading="saving">
          {{ f.save }}
        </UButton>
      </div>
    </template>
  </USlideover>
</template>
