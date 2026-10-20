<script setup lang="ts">
// Embedding engine (decision 64): one embedding model in its own llama-server, next to the chat models.
import { t } from '../composables/useLocale'

interface FileRef { dirId: string, rel: string }
interface Candidate { ref: FileRef, fileName: string, size: number, name: string | null, quantization: string | null, contextLength: number | null, dims: number | null, pooling: number | null }
interface Config { enabled: boolean, name: string, file: FileRef | null, device: 'gpu' | 'cpu', autoStart: boolean, ctxSize: number }
interface Doc { config: Config, candidates: Candidate[] | null }

const e = t.embedding
const { state: live } = useLive()
const toast = useToast()
const status = computed(() => live.value?.embedding ?? null)

const doc = ref<Doc | null>(null)
const candidates = ref<Candidate[]>([])
const loading = ref(false)
const saving = ref(false)
const acting = ref<'' | 'start' | 'stop' | 'restart'>('')
const form = reactive({ enabled: false, name: '', file: '', device: 'gpu' as 'gpu' | 'cpu', autoStart: false, ctxSize: '8192' })
const initial = ref('')

function messageOf(err: unknown): string {
  const x = err as { data?: { message?: string }, statusMessage?: string, message?: string }
  return x?.data?.message ?? x?.statusMessage ?? x?.message ?? String(err)
}
const keyOf = (r: FileRef | null) => (r ? `${r.dirId}\n${r.rel}` : '')
const refOf = (k: string): FileRef | null => {
  const i = k.indexOf('\n')
  return i > 0 ? { dirId: k.slice(0, i), rel: k.slice(i + 1) } : null
}

function reset() {
  const c = doc.value?.config
  if (!c) return
  Object.assign(form, { enabled: c.enabled, name: c.name, file: keyOf(c.file), device: c.device, autoStart: c.autoStart, ctxSize: String(c.ctxSize) })
  initial.value = JSON.stringify(form)
}

async function load() {
  loading.value = true
  try {
    const d = await $fetch<Doc>('/api/embedding')
    doc.value = d
    if (d.candidates) candidates.value = d.candidates
    reset()
  } catch (err) {
    toast.add({ title: e.loadFailed, description: messageOf(err), color: 'error', icon: 'i-lucide-circle-alert' })
  } finally {
    loading.value = false
  }
}
onMounted(() => load())

const fileItems = computed(() => candidates.value.map(c => ({
  value: keyOf(c.ref),
  label: [c.fileName, c.quantization, c.dims ? fmt(e.dims, { n: c.dims }) : null, formatBytes(c.size)].filter(Boolean).join(' · '),
})))
const savedMissing = computed(() => {
  const f = doc.value?.config.file
  return f && !candidates.value.some(c => keyOf(c.ref) === keyOf(f)) ? f.rel : null
})

// Picking a file fills an empty name with the file name without its quantization suffix.
watch(() => form.file, (k) => {
  if (form.name.trim() || !k) return
  const c = candidates.value.find(x => keyOf(x.ref) === k)
  if (c) form.name = c.fileName.replace(/\.gguf$/i, '').replace(/[-_.](?:i?q\d\w*|f16|f32|bf16)$/i, '').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64)
})

const dirty = computed(() => JSON.stringify(form) !== initial.value)
const badName = computed(() => !!form.name.trim() && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(form.name.trim()))
const badCtx = computed(() => !/^\d+$/.test(form.ctxSize.trim()) || Number(form.ctxSize) < 512 || Number(form.ctxSize) > 131072)
const incomplete = computed(() => form.enabled && (!form.name.trim() || !form.file))

async function save() {
  saving.value = true
  try {
    const d = await $fetch<Doc>('/api/embedding', {
      method: 'POST',
      body: { enabled: form.enabled, name: form.name.trim(), file: refOf(form.file), device: form.device, autoStart: form.autoStart, ctxSize: Number(form.ctxSize) },
    })
    doc.value = { ...d, candidates: candidates.value }
    reset()
    toast.add({ title: e.saved, color: 'success', icon: 'i-lucide-check' })
  } catch (err) {
    toast.add({ title: e.saveFailed, description: messageOf(err), color: 'error', icon: 'i-lucide-circle-alert' })
  } finally {
    saving.value = false
  }
}

async function act(what: 'start' | 'stop' | 'restart') {
  acting.value = what
  try {
    await $fetch(what === 'stop' ? '/api/embedding/stop' : '/api/embedding/start', { method: 'POST', body: what === 'restart' ? { restart: true } : {} })
  } catch (err) {
    toast.add({ title: e.actionFailed, description: messageOf(err), color: 'error', icon: 'i-lucide-circle-alert' })
  } finally {
    acting.value = ''
  }
}

const testText = ref('')
const testing = ref(false)
const testResult = ref<{ dims: number, ms: number, tokens: number | null, device: string | null, head: number[] } | null>(null)
async function runTest() {
  testing.value = true
  testResult.value = null
  try {
    testResult.value = await $fetch('/api/embedding/test', { method: 'POST', body: { text: testText.value || e.testDefault } })
  } catch (err) {
    toast.add({ title: e.testFailed, description: messageOf(err), color: 'error', icon: 'i-lucide-circle-alert' })
  } finally {
    testing.value = false
  }
}

const deviceLabel = (d: string | null | undefined) => (d === 'cpu' ? e.cpu : e.gpu)
const errorText = computed(() => {
  const er = status.value?.error
  if (!er) return ''
  const map = e.errors as Record<string, string>
  return fmt(map[er.code] ?? er.message, { detail: er.message })
})
const busy = computed(() => status.value?.state === 'loading')
const running = computed(() => status.value?.state === 'ready' || status.value?.state === 'loading')
const sample = computed(() => {
  const origin = import.meta.client ? window.location.origin : 'http://127.0.0.1:3000'
  const name = doc.value?.config.name || 'embedding-model'
  return `curl ${origin}/v1/embeddings -H "Content-Type: application/json" -d '{"model":"${name}","input":["${e.testDefault}"]}'`
})
</script>

<template>
  <AppCard :title="e.title" :hint="e.hint">
    <template #actions>
      <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-refresh-cw" :loading="loading" @click="load()">
        {{ e.rescan }}
      </UButton>
    </template>

    <!-- State and actions -->
    <div v-if="status && doc?.config.enabled" class="mb-3 flex flex-col gap-2 rounded-[10px] bg-elevated/60 px-3.5 py-3">
      <div class="flex flex-wrap items-center gap-2">
        <StatusPill :state="status.state" />
        <span class="font-mono text-sm">{{ status.name }}</span>
        <span v-if="status.runningDevice" class="lw-chip">{{ fmt(e.runningOn, { device: deviceLabel(status.runningDevice) }) }}</span>
        <span v-if="status.inflight" class="text-xs text-muted">{{ fmt(e.inflight, { n: status.inflight }) }}</span>
        <span v-if="status.restartNeeded" class="text-xs text-warning">{{ e.restartNeeded }}</span>
        <div class="ml-auto flex flex-wrap gap-1.5">
          <UButton v-if="!running" size="xs" icon="i-lucide-play" :loading="acting === 'start'" @click="act('start')">
            {{ e.start }}
          </UButton>
          <UButton v-if="status.state === 'ready'" size="xs" color="neutral" variant="outline" icon="i-lucide-rotate-ccw" :loading="acting === 'restart'" @click="act('restart')">
            {{ e.restart }}
          </UButton>
          <UButton v-if="running" size="xs" color="neutral" variant="outline" icon="i-lucide-square" :loading="acting === 'stop'" @click="act('stop')">
            {{ e.stop }}
          </UButton>
        </div>
      </div>
      <template v-if="status.error">
        <p class="m-0 text-xs text-error">
          {{ errorText }}
        </p>
        <details v-if="status.error.tail.length" class="text-xs">
          <summary class="cursor-pointer text-muted">
            {{ e.tail }}
          </summary>
          <pre class="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-default p-2 font-mono text-[11px] [overflow-wrap:anywhere]">{{ status.error.tail.join('\n') }}</pre>
        </details>
      </template>
      <div v-if="status.state === 'ready'" class="flex flex-wrap items-center gap-2">
        <UInput v-model="testText" size="sm" class="min-w-0 flex-1 basis-48" :placeholder="e.testDefault" :aria-label="e.testText" />
        <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-flask-conical" :loading="testing" @click="runTest">
          {{ e.test }}
        </UButton>
        <p v-if="testResult" class="m-0 basis-full font-mono text-xs text-muted [overflow-wrap:anywhere]">
          {{ fmt(e.testResult, { dims: testResult.dims, ms: testResult.ms, tokens: testResult.tokens ?? '-', device: deviceLabel(testResult.device) }) }}
          · [{{ testResult.head.join(', ') }}, …]
        </p>
      </div>
    </div>

    <div v-if="!doc" class="flex flex-col gap-2">
      <USkeleton class="h-9 w-full" />
      <USkeleton class="h-9 w-full" />
    </div>
    <div v-else class="divide-y divide-default">
      <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 pb-3">
        <div class="min-w-0 flex-1 basis-56">
          <p class="text-sm text-default">
            {{ e.enabled }}
          </p>
          <p class="text-xs text-muted">
            {{ e.enabledHint }}
          </p>
        </div>
        <USwitch v-model="form.enabled" :aria-label="e.enabled" />
      </div>
      <div class="flex flex-col gap-2 py-3">
        <div class="min-w-0">
          <p class="text-sm text-default">
            {{ e.file }}
          </p>
          <p class="text-xs text-muted">
            {{ e.fileHint }}
          </p>
        </div>
        <USelect v-if="fileItems.length" v-model="form.file" :items="fileItems" size="sm" class="w-full" :placeholder="e.filePlaceholder" :aria-label="e.file" />
        <p v-else class="m-0 text-xs text-warning">
          {{ e.noCandidates }}
        </p>
        <p v-if="savedMissing" class="m-0 text-xs text-warning [overflow-wrap:anywhere]">
          {{ fmt(e.missingFile, { rel: savedMissing }) }}
        </p>
      </div>
      <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
        <div class="min-w-0 flex-1 basis-56">
          <p class="text-sm text-default">
            {{ e.name }}
          </p>
          <p class="text-xs text-muted">
            {{ e.nameHint }}
          </p>
        </div>
        <UInput v-model="form.name" size="sm" class="w-full sm:w-64" :color="badName ? 'error' : undefined" :aria-label="e.name" />
      </div>
      <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
        <div class="min-w-0 flex-1 basis-56">
          <p class="text-sm text-default">
            {{ e.device }}
          </p>
          <p class="text-xs text-muted">
            {{ e.deviceHint }}
          </p>
        </div>
        <div class="lw-seg" role="radiogroup" :aria-label="e.device">
          <button v-for="d in (['gpu', 'cpu'] as const)" :key="d" type="button" role="radio" :aria-checked="form.device === d" :class="{ on: form.device === d }" @click="form.device = d">
            {{ deviceLabel(d) }}
          </button>
        </div>
      </div>
      <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
        <div class="min-w-0 flex-1 basis-56">
          <p class="text-sm text-default">
            {{ e.ctx }}
          </p>
          <p class="text-xs text-muted">
            {{ fmt(e.ctxHint, { min: 512, max: 131072 }) }}
          </p>
        </div>
        <UInput :model-value="form.ctxSize" type="number" size="sm" class="w-40" :color="badCtx ? 'error' : undefined" :aria-label="e.ctx" @update:model-value="(v: string | number | undefined) => { form.ctxSize = v == null ? '' : String(v) }" />
      </div>
      <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 pt-3">
        <div class="min-w-0 flex-1 basis-56">
          <p class="text-sm text-default">
            {{ e.autoStart }}
          </p>
          <p class="text-xs text-muted">
            {{ e.autoStartHint }}
          </p>
        </div>
        <USwitch v-model="form.autoStart" :aria-label="e.autoStart" />
      </div>
    </div>

    <div v-if="doc" class="mt-4 flex flex-wrap items-center gap-2">
      <UButton size="sm" icon="i-lucide-save" :disabled="!dirty || badName || badCtx || incomplete" :loading="saving" @click="save">
        {{ e.save }}
      </UButton>
      <UButton v-if="dirty" size="sm" color="neutral" variant="ghost" @click="reset">
        {{ t.settings.reset }}
      </UButton>
      <span v-if="incomplete" class="text-xs text-warning">{{ e.errors.incomplete }}</span>
      <span v-else-if="dirty" class="text-xs text-warning">{{ t.settings.dirty }}</span>
    </div>

    <div v-if="doc?.config.enabled" class="mt-4">
      <p class="mb-1 text-xs text-dimmed">
        {{ e.usage }}
      </p>
      <pre class="m-0 overflow-x-auto whitespace-pre-wrap rounded-md bg-elevated/60 p-2.5 font-mono text-[11px] [overflow-wrap:anywhere]">{{ sample }}</pre>
    </div>
  </AppCard>
</template>
