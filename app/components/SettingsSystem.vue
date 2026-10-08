<script setup lang="ts">
// "This computer": the read-only detection result (GET /api/system) with recommendations and warnings.
// Windows shows CPU, memory and the NVIDIA card / driver; a Mac shows chip, cores and memory only
// (decision 38: no GPU wording there, the server sends no GPU fields for it).
import { t } from '../composables/useLocale'
import type { SystemInfo } from '~~/server/core/system'

const s = t.settings.system
const info = ref<SystemInfo | null>(null)
const error = ref('')
const loading = ref(false)

async function load(refresh = false) {
  if (loading.value) return
  loading.value = true
  try {
    info.value = await $fetch<SystemInfo>('/api/system', { query: refresh ? { refresh: '1' } : {} })
    error.value = ''
  } catch (e) {
    const err = e as { data?: { message?: string }, message?: string }
    error.value = err.data?.message ?? err.message ?? s.failed
  } finally {
    loading.value = false
  }
}
onMounted(() => load())

const mib = (n: number | null | undefined) => (n == null ? '-' : formatMiB(n))
const cpuFeatures = computed(() => {
  const f = info.value?.cpu.features
  if (!f) return ''
  const list: Array<[string, boolean | null]> = [['AVX', f.avx], ['AVX2', f.avx2], ['AVX-512', f.avx512], ['FMA', f.fma], ['F16C', f.f16c], ['NEON', f.neon]]
  return list.filter(([, on]) => on).map(([n]) => n).join(' · ')
})
const cores = computed(() => {
  const c = info.value?.cpu
  if (!c) return ''
  return c.physicalCores ? fmt(s.coresValue, { physical: c.physicalCores, logical: c.logicalCores }) : fmt(s.coresLogicalOnly, { logical: c.logicalCores })
})
const sockets = computed(() => {
  const c = info.value?.cpu
  return c && ((c.sockets ?? 1) > 1 || (c.numaNodes ?? 1) > 1) ? fmt(s.socketsValue, { sockets: c.sockets ?? '-', numa: c.numaNodes ?? '-' }) : ''
})
const gpuLine = (g: NonNullable<SystemInfo['nvidia']>['gpus'][number]) => (g.computeCap == null
  ? fmt(s.gpuRowNoCap, { name: g.name, memory: mib(g.memoryMiB) })
  : fmt(s.gpuRow, { name: g.name, memory: mib(g.memoryMiB), cap: g.computeCap.toFixed(1) }))
const driver = computed(() => {
  const n = info.value?.nvidia
  if (!n?.driver) return ''
  return n.maxCuda ? fmt(s.driverValue, { driver: n.driver, cuda: n.maxCuda }) : fmt(s.driverOnly, { driver: n.driver })
})
const recommend = computed(() => (info.value?.recommend ? (info.value.recommend.acceleration === 'cuda' ? s.recommendCuda : s.recommendCpu) : ''))
const mem = computed(() => (info.value ? fmt(s.memoryValue, { total: mib(info.value.memory.totalMiB), free: mib(info.value.memory.freeMiB) }) : ''))

function warningText(w: SystemInfo['warnings'][number]): string {
  const template = (t.system.warnings as Record<string, string>)[w.code] ?? w.code
  return fmt(template, (w.params ?? {}) as Record<string, string | number>)
}
const detectedAt = computed(() => (info.value ? fmt(s.detectedAt, { time: formatClock(Date.parse(info.value.detectedAt)) }) : ''))
</script>

<template>
  <AppCard :title="s.title" :hint="s.hint">
    <template #actions>
      <UButton size="xs" color="neutral" variant="outline" icon="i-lucide-refresh-cw" :loading="loading" @click="load(true)">
        {{ loading ? s.refreshing : s.refresh }}
      </UButton>
    </template>

    <p v-if="error && !info" class="text-sm text-error">
      {{ s.failed }}：{{ error }}
    </p>
    <USkeleton v-else-if="!info" class="h-24 w-full" />
    <div v-else class="space-y-4">
      <dl class="grid grid-cols-[auto_1fr] gap-x-5 gap-y-2.5 text-sm">
        <template v-if="info.mac">
          <dt class="text-muted">
            {{ s.chip }}
          </dt>
          <dd class="min-w-0 break-words">
            {{ info.mac.chip ?? '-' }}
          </dd>
          <template v-if="info.mac.model">
            <dt class="text-muted">
              {{ s.model }}
            </dt>
            <dd class="min-w-0 break-words">
              {{ info.mac.model }}
            </dd>
          </template>
          <template v-if="info.mac.performanceCores != null || info.mac.efficiencyCores != null">
            <dt class="text-muted">
              {{ s.macCores }}
            </dt>
            <dd class="m-0">
              {{ fmt(s.macCoresValue, { perf: info.mac.performanceCores ?? '-', eff: info.mac.efficiencyCores ?? '-' }) }}
            </dd>
          </template>
          <dt class="text-muted">
            {{ s.memoryUnified }}
          </dt>
          <dd class="m-0">
            {{ mem }}
          </dd>
          <template v-if="info.mac.macos">
            <dt class="text-muted">
              {{ s.macos }}
            </dt>
            <dd class="m-0">
              {{ info.mac.macos }}
            </dd>
          </template>
        </template>

        <template v-else>
          <dt class="text-muted">
            {{ s.cpu }}
          </dt>
          <dd class="min-w-0 break-words">
            {{ info.cpu.model ?? '-' }}
          </dd>
          <dt class="text-muted">
            {{ s.cores }}
          </dt>
          <dd class="m-0">
            {{ cores }}
          </dd>
          <template v-if="sockets">
            <dt class="text-muted">
              {{ s.sockets }}
            </dt>
            <dd class="m-0">
              {{ sockets }}
            </dd>
          </template>
          <dt class="text-muted">
            {{ s.features }}
          </dt>
          <dd class="font-mono text-xs leading-5">
            {{ cpuFeatures || s.featuresNone }}
          </dd>
          <dt class="text-muted">
            {{ s.memory }}
          </dt>
          <dd class="m-0">
            {{ mem }}
          </dd>
          <template v-if="info.nvidia">
            <dt class="text-muted">
              {{ s.gpu }}
            </dt>
            <dd class="min-w-0">
              <template v-if="info.nvidia.gpus.length">
                <p v-for="g in info.nvidia.gpus" :key="g.index" class="break-words">
                  {{ gpuLine(g) }}
                </p>
              </template>
              <span v-else class="text-muted">{{ info.nvidia.state === 'unknown' ? s.gpuUnknown : s.gpuNone }}</span>
            </dd>
            <template v-if="driver">
              <dt class="text-muted">
                {{ s.driver }}
              </dt>
              <dd class="m-0">
                {{ driver }}
              </dd>
            </template>
          </template>
          <template v-if="recommend">
            <dt class="text-muted">
              {{ s.recommend }}
            </dt>
            <dd class="m-0">
              <span class="lw-chip lw-chip-accent">{{ recommend }}</span>
            </dd>
          </template>
        </template>
      </dl>

      <div class="space-y-1.5 border-t border-default pt-3">
        <h3 class="text-xs font-semibold text-muted">
          {{ s.warnings }}
        </h3>
        <ul v-if="info.warnings.length" class="list-none space-y-1 p-0 text-sm">
          <li v-for="(w, i) in info.warnings" :key="i" class="flex items-start gap-2" :class="w.severity === 'warning' ? 'text-warning' : 'text-muted'">
            <UIcon :name="w.severity === 'warning' ? 'i-lucide-triangle-alert' : 'i-lucide-info'" class="mt-0.5 shrink-0" />
            <span class="min-w-0 break-words">{{ warningText(w) }}</span>
          </li>
        </ul>
        <p v-else class="text-sm text-muted">
          {{ s.noWarnings }}
        </p>
        <p class="text-xs text-dimmed">
          {{ detectedAt }}
        </p>
      </div>
    </div>
  </AppCard>
</template>
