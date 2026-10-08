<script setup lang="ts">
// Add / edit one external upstream in a slide-over. The API key is write-only: the list only says whether one is
// saved, a blank box keeps it, "clear" removes it. Server messages (Chinese) are shown as they come.
import { t } from '../composables/useLocale'
import type { ConnectionView } from '~~/server/core/upstreams'

const props = defineProps<{ open: boolean, upstream: ConnectionView | null }>()
const emit = defineEmits<{ 'update:open': [boolean], saved: [name: string, createdId: string | null, isNew: boolean] }>()

const f = t.upstreams.form
const p = t.upstreams.page
const open = computed({ get: () => props.open, set: v => emit('update:open', v) })
const isNew = computed(() => !props.upstream)

const form = reactive({ name: '', baseUrl: '', monitorUrl: '', apiKey: '', clearKey: false, manualModels: '', startCommand: '', startCwd: '' })
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
  form.startCommand = u?.startCommand ?? ''
  form.startCwd = u?.startCwd ?? ''
  error.value = ''
})

const messageOf = (e: unknown) => {
  const err = e as { data?: { message?: string }, statusMessage?: string, message?: string }
  return err?.data?.message ?? err?.statusMessage ?? err?.message ?? String(e)
}
const ready = computed(() => !!form.name.trim() && !!form.baseUrl.trim())

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
    startCommand: form.startCommand.trim(),
    startCwd: form.startCwd.trim(),
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
          <UInput
            v-model="form.startCommand"
            class="w-full"
            autocomplete="off"
            :placeholder="ui.isMac ? f.startCommandPlaceholderMac : f.startCommandPlaceholderWin"
            :ui="{ base: 'font-mono text-xs' }"
          />
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
