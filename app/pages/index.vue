<script setup lang="ts">
// Minimal status page: current model, state, enabled models. Proper UI comes in stage 2.
import t from '~~/i18n/zh-CN'

interface Instance { profile: string, state: keyof typeof t.status.states, inflight: number, error: string | null }
interface StateDoc {
  models: Array<{ id: string, name: string, activeProfile: string, profiles: string[], hasMmproj: boolean, instances: Instance[] }>
  queue: Array<{ modelId: string, profile: string, started: boolean, waiting: number }>
  llamacpp: { current: string, runtime: { state: string, tag?: string, step?: 'resolve' | 'download' | 'extract', detail?: string, code?: string } }
}

const { data, error, refresh } = await useFetch<StateDoc>('/api/state')
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => { timer = setInterval(() => refresh(), 2000) })
onBeforeUnmount(() => clearInterval(timer))

const fmt = (s: string, v: Record<string, string> = {}) => s.replace(/\{(\w+)\}/g, (m, k: string) => v[k] ?? m)
const stateLabel = (s: keyof typeof t.status.states) => t.status.states[s] ?? s
const running = computed(() => (data.value?.models ?? []).flatMap(m => m.instances.map(i => ({ model: m, inst: i }))))
const runtimeText = computed(() => {
  const r = data.value?.llamacpp.runtime
  if (!r) return ''
  const rt = t.status.runtime
  switch (r.state) {
    case 'working': return fmt(rt.working[r.step ?? 'resolve'], { detail: r.detail ?? '' })
    case 'ready': return fmt(rt.ready, { tag: r.tag ?? '' })
    case 'error': return fmt(rt.error, { code: r.code ?? '', detail: r.detail ?? '' })
    case 'disabled': return rt.disabled
    default: return rt.idle
  }
})

const path = ref('')
const busy = ref(false)
const result = ref<{ text: string, lines: string[], failed: boolean } | null>(null)
async function runImport(dryRun: boolean) {
  busy.value = true
  try {
    const r = await $fetch<{ imported: Array<{ name: string, mmproj: string | null }>, defaultsApplied: boolean, warnings: string[] }>('/api/import', {
      method: 'POST', body: { path: path.value, dryRun },
    })
    const c = String(r.imported.length)
    result.value = {
      failed: false,
      text: fmt(dryRun ? t.import.previewDone : t.import.done, { count: c }),
      lines: [
        ...r.imported.map(m => fmt(t.import.model, { name: m.name, mmproj: m.mmproj ?? t.import.no })),
        ...(r.imported.some(m => m.mmproj) ? [t.import.mmprojAuto] : []),
        ...(r.imported.length ? [r.defaultsApplied ? t.import.defaultsApplied : t.import.defaultsKept] : []),
        ...r.warnings,
      ],
    }
    if (!dryRun) await refresh()
  } catch (e) {
    result.value = { failed: true, text: (e as { data?: { message?: string } }).data?.message ?? String(e), lines: [] }
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <main class="wrap">
    <header>
      <h1>{{ t.app.title }}</h1>
      <span class="muted">{{ t.app.subtitle }} · {{ t.status.refresh }}</span>
    </header>

    <p v-if="error" class="bad">{{ t.status.loadFailed }}</p>

    <template v-if="data">
      <section class="card">
        <h2>{{ t.status.current }}</h2>
        <p v-if="!running.length" class="muted">{{ t.status.none }}</p>
        <ul v-else class="rows">
          <li v-for="r in running" :key="r.model.id + r.inst.profile">
            <span class="dot" :class="r.inst.state" />
            <b>{{ r.model.name }}</b>
            <span class="tag">{{ r.inst.profile }}</span>
            <span>{{ stateLabel(r.inst.state) }}</span>
            <span v-if="r.inst.inflight" class="muted">{{ t.status.inflight }} {{ r.inst.inflight }}</span>
            <span v-if="r.inst.error" class="bad">{{ r.inst.error }}</span>
          </li>
        </ul>
        <p v-if="data.queue.length" class="muted">
          {{ t.status.queue }}：{{ data.queue.map(q => `${q.modelId}:${q.profile}`).join('、') }}
        </p>
      </section>

      <section class="card">
        <h2>{{ t.status.models }}</h2>
        <p v-if="!data.models.length" class="muted">{{ t.status.noModels }}</p>
        <ul v-else class="rows">
          <li v-for="m in data.models" :key="m.id">
            <b>{{ m.name }}</b>
            <span class="tag">{{ t.status.active }} {{ m.activeProfile }}</span>
            <span v-if="m.profiles.length > 1" class="muted">{{ t.status.profile }}：{{ m.profiles.join('、') }}</span>
          </li>
        </ul>
      </section>

      <section class="card">
        <h2>{{ t.status.llamacpp }}</h2>
        <p>{{ runtimeText }}</p>
      </section>
    </template>

    <section class="card">
      <h2>{{ t.import.title }}</h2>
      <p class="muted">{{ t.import.hint }}</p>
      <form class="import" @submit.prevent="runImport(false)">
        <input v-model="path" type="text" :placeholder="t.import.path" :aria-label="t.import.path">
        <button type="button" :disabled="busy || !path" @click="runImport(true)">{{ t.import.preview }}</button>
        <button type="submit" :disabled="busy || !path" class="primary">{{ t.import.run }}</button>
      </form>
      <div v-if="result">
        <p :class="result.failed ? 'bad' : 'ok'">{{ result.text }}</p>
        <ul class="lines"><li v-for="(l, i) in result.lines" :key="i">{{ l }}</li></ul>
      </div>
    </section>
  </main>
</template>

<style scoped>
.wrap { max-width: 860px; margin: 0 auto; padding: 28px 16px 60px; }
header { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; }
h1 { font-size: 22px; margin: 0; }
h2 { font-size: 15px; margin: 0 0 8px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 18px; margin: 16px 0; }
.muted { color: var(--muted); }
.ok { color: var(--ok); }
.bad { color: var(--bad); }
.rows, .lines { list-style: none; margin: 0; padding: 0; }
.rows li { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 4px 0; }
.lines li { color: var(--muted); font-size: 13px; padding: 1px 0; }
.tag { font-size: 12px; padding: 0 8px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); }
.dot { width: 9px; height: 9px; border-radius: 50%; background: var(--muted); }
.dot.ready { background: var(--ok); }
.dot.loading, .dot.draining, .dot.unloading { background: var(--warn); }
.dot.failed, .dot.crashed { background: var(--bad); }
.import { display: flex; gap: 8px; flex-wrap: wrap; margin: 8px 0; }
.import input { flex: 1 1 320px; padding: 6px 10px; border-radius: 6px; border: 1px solid var(--line); background: var(--bg); color: var(--text); }
button { padding: 6px 14px; border-radius: 6px; border: 1px solid var(--line); background: var(--panel); color: var(--text); cursor: pointer; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button:disabled { opacity: .5; cursor: default; }
</style>
