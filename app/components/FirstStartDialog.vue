<script setup lang="ts">
// First start of a model enabled from a scan: confirm context, thinking, vision and MTP, then start it.
import t from '~~/i18n/zh-CN'
import { MTP_DEFAULT_N, mtpValid, type MtpInput } from '~~/server/core/mtp'
import { validThinkingLimit } from '~~/server/core/thinking-limit'
import { readStartGuard } from '~/utils/memory-check'

interface Ref { dirId: string, rel: string }
interface Candidate { ref: Ref, fileName: string, size: number }
interface SetupDoc { name: string, candidates: { mmproj: Candidate[], draft: Candidate[] }, current: { mmproj: Ref | null, draft: Ref | null, ctxSize: number | string | null }, mtpN: number }

const s = t.models.firstStart
const props = defineProps<{ modelId: string, name: string }>()
const open = defineModel<boolean>('open', { required: true })
const { busy } = useModelActions()
const feedback = useModelStartFeedback()
const guard = useStartGuard()
const ui = usePlatformUi()

const info = ref<SetupDoc | null>(null)
const ctxSize = ref<number | string>('')
const setGlobalContext = ref(false)
const setGlobalThinking = ref(false)
const setGlobalThinkingLimit = ref(false)
const thinking = ref(true)
const thinkingLimit = ref<number | string>(0)
const thinkingLimitOk = computed(() => thinkingLimit.value !== '' && validThinkingLimit(Number(thinkingLimit.value)))
const vision = ref(false)
const offload = ref(true)
const mmprojKey = ref('')
const mtp = ref<MtpInput>({ enabled: false, mode: null, draft: null, n: MTP_DEFAULT_N })
const saving = ref(false)

const key = (r: Ref) => `${r.dirId}/${r.rel}`
const items = (list: Candidate[]) => list.map(c => ({ value: key(c.ref), label: `${c.fileName} · ${formatBytes(c.size)}` }))
const find = (list: Candidate[], k: string) => list.find(c => key(c.ref) === k)?.ref ?? null
const hasVision = computed(() => !!info.value?.candidates.mmproj.length)
const mtpAnswer = computed<MtpInput>(() => ({ ...mtp.value, n: mtp.value.enabled ? mtp.value.n : MTP_DEFAULT_N, draft: mtp.value.enabled && mtp.value.mode === 'file' ? mtp.value.draft : null }))
const mtpOk = computed(() => mtpValid(mtpAnswer.value))
// Match the existing number form: empty omits the flag; finite values are checked by llama-server.
const contextValid = computed(() => ctxSize.value === '' || Number.isFinite(Number(ctxSize.value)))
const contextK = computed(() => ctxSize.value === '' || !contextValid.value ? '' : `${+(Number(ctxSize.value) / 1024).toPrecision(4)}K`)

function fail(e: unknown) {
  feedback.httpFailure(e, undefined, props.name)
}

watch(open, async (v) => {
  if (!v) return
  info.value = null
  try {
    const r = await $fetch<SetupDoc>(`/api/models/${encodeURIComponent(props.modelId)}/setup`)
    info.value = r
    ctxSize.value = r.current.ctxSize ?? ''
    setGlobalContext.value = false
    setGlobalThinking.value = false
    setGlobalThinkingLimit.value = false
    // MTP always starts off; opening it requires an explicit mode choice.
    thinking.value = true
    thinkingLimit.value = 0
    mtp.value = { enabled: false, mode: null, draft: null, n: r.mtpN }
    mmprojKey.value = r.candidates.mmproj[0] ? key(r.candidates.mmproj[0].ref) : ''
    vision.value = !!r.candidates.mmproj.length
    offload.value = true
  } catch (e) {
    fail(e)
    open.value = false
  }
})

async function confirm() {
  if (!info.value || !mtpOk.value || !contextValid.value || !thinkingLimitOk.value || saving.value) return
  saving.value = true
  const attempt = feedback.begin(props.modelId)
  try {
    await $fetch(`/api/models/${encodeURIComponent(props.modelId)}/setup`, {
      method: 'POST',
      body: {
        ctxSize: ctxSize.value === '' ? null : Number(ctxSize.value),
        setGlobalContext: setGlobalContext.value,
        setGlobalThinking: setGlobalThinking.value,
        setGlobalThinkingLimit: thinking.value && setGlobalThinkingLimit.value,
        thinking: thinking.value,
        thinkingLimit: Number(thinkingLimit.value),
        mmproj: vision.value ? find(info.value.candidates.mmproj, mmprojKey.value) : null,
        ...(vision.value && ui.value.hasGpu ? { mmprojOffload: offload.value } : {}),
        mtp: mtp.value.enabled,
        mtpMode: mtp.value.mode,
        draft: mtpAnswer.value.draft,
        mtpN: mtp.value.enabled ? mtp.value.n : MTP_DEFAULT_N,
        start: true,
      },
    })
    feedback.accepted(attempt)
    open.value = false
  } catch (e) {
    // The answers are saved before the memory check: a refused start becomes the usual start dialog (risky / unknown can be confirmed there).
    const g = readStartGuard(e)
    if (g) {
      feedback.cancel(props.modelId)
      guard.open({ modelId: props.modelId, profile: undefined, name: props.name, action: 'start', guard: g })
      open.value = false
    } else feedback.httpFailure(e, attempt)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UModal v-model:open="open" :title="fmt(s.title, { name })" :description="s.body">
    <template #body>
      <p v-if="!info" class="m-0 text-sm text-muted">
        {{ s.loading }}
      </p>
      <div v-else class="flex flex-col gap-5">
        <section class="flex flex-col gap-1.5">
          <label for="first-start-context" class="text-sm font-semibold">{{ s.context.title }}</label>
          <div class="flex items-center gap-3">
            <UInput id="first-start-context" v-model.number="ctxSize" type="number" step="any" class="w-40 max-w-full font-mono" :color="contextValid ? undefined : 'error'" aria-describedby="first-start-context-hint" />
            <span class="font-mono text-sm text-muted" aria-live="polite">{{ contextK }}</span>
          </div>
          <p id="first-start-context-hint" class="m-0 text-xs text-muted">{{ s.context.hint }}</p>
          <UCheckbox v-model="setGlobalContext" :label="s.context.global" />
          <p v-if="setGlobalContext" class="m-0 text-xs text-muted">{{ s.context.globalHint }}</p>
        </section>

        <section class="flex flex-col gap-1.5">
          <div class="flex items-center justify-between gap-3">
            <h3 class="m-0 text-sm font-semibold">
              {{ s.thinking.title }}
            </h3>
            <div class="lw-seg" role="radiogroup" :aria-label="s.thinking.title">
              <button type="button" role="radio" :aria-checked="thinking" :class="{ on: thinking }" @click="thinking = true">
                {{ s.thinking.on }}
              </button>
              <button type="button" role="radio" :aria-checked="!thinking" :class="{ on: !thinking }" @click="thinking = false">
                {{ s.thinking.off }}
              </button>
            </div>
          </div>
          <p class="m-0 text-xs text-muted">
            {{ thinking ? s.thinking.hintOn : s.thinking.hintOff }}
          </p>
          <UCheckbox v-model="setGlobalThinking" :label="s.thinking.global" />
          <ThinkingLimit v-model="thinkingLimit" :enabled="thinking" id-prefix="first-start" />
          <template v-if="thinking">
            <UCheckbox v-model="setGlobalThinkingLimit" :label="s.thinking.globalLimit" />
            <p v-if="setGlobalThinking || setGlobalThinkingLimit" class="m-0 text-xs text-muted">{{ s.thinking.globalHint }}</p>
          </template>
          <p v-else-if="setGlobalThinking" class="m-0 text-xs text-muted">{{ s.thinking.globalHint }}</p>
          <p v-if="!thinking && !thinkingLimitOk" class="text-xs text-error">{{ t.models.thinkingLimit.hiddenInvalid }}</p>
        </section>

        <section class="flex flex-col gap-1.5">
          <div class="flex items-center justify-between gap-3">
            <h3 class="m-0 text-sm font-semibold">
              {{ s.vision.title }}
            </h3>
            <USwitch v-model="vision" :disabled="!hasVision" :aria-label="s.vision.title" />
          </div>
          <template v-if="hasVision">
            <p class="m-0 text-xs text-muted">
              {{ s.vision.found }}
            </p>
            <USelect v-if="vision" v-model="mmprojKey" :items="items(info.candidates.mmproj)" size="sm" class="font-mono" :aria-label="s.vision.title" />
            <template v-if="vision && ui.hasGpu">
              <div class="flex items-center justify-between gap-3">
                <span class="text-sm">{{ s.vision.offload }}</span>
                <USwitch v-model="offload" :aria-label="s.vision.offload" />
              </div>
              <p class="m-0 text-xs text-muted">
                {{ offload ? s.vision.offloadOn : s.vision.offloadOff }}
              </p>
            </template>
          </template>
          <p v-else class="m-0 text-xs text-warning">
            {{ s.vision.none }}
          </p>
        </section>

        <MtpChoice v-model="mtp" :candidates="info.candidates.draft" id-prefix="first-start" />
        <p class="m-0 text-xs text-muted">{{ s.mtp.extraHint }}</p>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton size="sm" color="neutral" variant="ghost" @click="open = false">
          {{ s.cancel }}
        </UButton>
        <UButton size="sm" icon="i-lucide-play" :disabled="!info || !contextValid || !mtpOk || !thinkingLimitOk" :loading="saving || !!busy[`start:${modelId}`]" @click="confirm">
          {{ s.confirm }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
