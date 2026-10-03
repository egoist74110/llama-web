<script setup lang="ts">
// Failure / crash card: diagnosed reason + advice, the last output lines, a jump to the full
// model log and (optionally) a manual retry. Shown by the overview and the model card.
import t from '~~/i18n/zh-CN'
import type { StateInstance } from '~~/server/core/live'

const props = defineProps<{
  modelId: string
  profile: string
  state: string
  failure: NonNullable<StateInstance['failure']>
  /** Show the retry button (the model card has its own in the header). */
  retryButton?: boolean
}>()

const { busy, retry } = useModelActions()
const f = t.failure
const ui = usePlatformUi()
const advice = computed(() => failureAdvice(props.failure.kind, ui.value.isMac))
// The end of the output is what matters: keep it in view.
const tailEl = ref<HTMLElement | null>(null)
const toEnd = () => nextTick(() => { if (tailEl.value) tailEl.value.scrollTop = tailEl.value.scrollHeight })
onMounted(toEnd)
watch(() => props.failure.tail.length, toEnd)
const working = computed(() => !!busy.value[`retry:${props.modelId}`])

// Just updated llama.cpp and a load fails: suggest the previous version, unless the cause is
// clearly not the engine (memory, files, ports, configuration, or a model needing a newer build).
const NOT_VERSION = new Set(['oom', 'file-missing', 'port-in-use', 'no-runtime', 'bad-args', 'unsupported-arch', 'split-mode-unsupported'])
const { state: live } = useLive()
const llamacpp = useLlamacpp()
const rollback = computed(() => {
  const l = live.value?.llamacpp
  return l?.rollback && !NOT_VERSION.has(props.failure.kind) ? { tag: l.rollback, current: l.current } : null
})
</script>

<template>
  <div class="space-y-2 rounded-lg bg-error/10 px-3 py-2.5 text-sm">
    <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
      <UIcon name="i-lucide-triangle-alert" class="size-4 text-error" />
      <span class="font-medium text-error">{{ reasonText(failure.kind) }}</span>
      <span v-if="failure.exitCode !== null" class="text-xs text-muted">{{ fmt(f.exitCode, { code: failure.exitCode }) }}</span>
    </div>
    <p class="text-default">
      {{ advice }}
    </p>
    <div v-if="rollback" class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <p class="min-w-0 flex-1 basis-60 text-default">
        {{ fmt(f.rollback, rollback) }}
      </p>
      <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-history" @click="llamacpp.ask(rollback.tag)">
        {{ fmt(f.rollbackButton, rollback) }}
      </UButton>
    </div>
    <p v-if="state === 'failed'" class="text-xs text-muted">
      {{ f.noRetry }}
    </p>
    <details class="text-xs" open>
      <summary class="cursor-pointer text-muted">
        {{ fmt(f.tailTitle, { n: failure.tail.length }) }}
      </summary>
      <pre v-if="failure.tail.length" ref="tailEl" class="mt-1.5 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-md bg-elevated px-2.5 py-2 font-mono text-[11px] leading-relaxed text-default">{{ failure.tail.join('\n') }}</pre>
      <p v-else class="mt-1 text-muted">
        {{ f.noTail }}
      </p>
    </details>
    <div class="flex flex-wrap items-center gap-2">
      <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-scroll-text" :to="{ path: '/logs', query: { model: modelId } }">
        {{ f.openLog }}
      </UButton>
      <UButton v-if="retryButton" size="sm" icon="i-lucide-rotate-cw" :loading="working" @click="retry(modelId, profile)">
        {{ f.retry }}
      </UButton>
    </div>
  </div>
</template>
