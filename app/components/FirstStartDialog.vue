<script setup lang="ts">
// First start of a model enabled from a scan: confirm context, thinking, vision and MTP, then start it.
import t from '~~/i18n/zh-CN'

interface Ref { dirId: string, rel: string }
interface Candidate { ref: Ref, fileName: string, size: number }
interface SetupDoc { name: string, candidates: { mmproj: Candidate[], draft: Candidate[] }, current: { mmproj: Ref | null, draft: Ref | null, ctxSize: number | string | null }, mtpN: number }

const s = t.models.firstStart
const props = defineProps<{ modelId: string, name: string }>()
const open = defineModel<boolean>('open', { required: true })
const { busy } = useModelActions()
const feedback = useModelStartFeedback()

const info = ref<SetupDoc | null>(null)
const ctxSize = ref<number | string>('')
const setGlobalContext = ref(false)
const thinking = ref(true)
const vision = ref(false)
const mmprojKey = ref('')
const mtp = ref(false)
const draftKey = ref('')
const mtpN = ref(3)
const saving = ref(false)

const key = (r: Ref) => `${r.dirId}/${r.rel}`
const items = (list: Candidate[]) => list.map(c => ({ value: key(c.ref), label: `${c.fileName} · ${formatBytes(c.size)}` }))
const find = (list: Candidate[], k: string) => list.find(c => key(c.ref) === k)?.ref ?? null
const hasVision = computed(() => !!info.value?.candidates.mmproj.length)
const hasDraft = computed(() => !!info.value?.candidates.draft.length)
const nValid = computed(() => Number.isInteger(mtpN.value) && mtpN.value >= 1 && mtpN.value <= 16)
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
    // Starting point: thinking on, the files that were found are on, MTP at the recommended multiplier.
    thinking.value = true
    mtpN.value = r.mtpN
    mmprojKey.value = r.candidates.mmproj[0] ? key(r.candidates.mmproj[0].ref) : ''
    vision.value = !!r.candidates.mmproj.length
    draftKey.value = r.candidates.draft[0] ? key(r.candidates.draft[0].ref) : ''
    mtp.value = !!r.candidates.draft.length
  } catch (e) {
    fail(e)
    open.value = false
  }
})

async function confirm() {
  if (!info.value || !nValid.value || !contextValid.value) return
  saving.value = true
  const attempt = feedback.begin(props.modelId)
  try {
    await $fetch(`/api/models/${encodeURIComponent(props.modelId)}/setup`, {
      method: 'POST',
      body: {
        ctxSize: ctxSize.value === '' ? null : Number(ctxSize.value),
        setGlobalContext: setGlobalContext.value,
        thinking: thinking.value,
        mmproj: vision.value ? find(info.value.candidates.mmproj, mmprojKey.value) : null,
        mtp: mtp.value,
        draft: mtp.value ? find(info.value.candidates.draft, draftKey.value) : null,
        mtpN: mtpN.value,
        start: true,
      },
    })
    feedback.accepted(attempt)
    open.value = false
  } catch (e) {
    feedback.httpFailure(e, attempt)
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
          </template>
          <p v-else class="m-0 text-xs text-warning">
            {{ s.vision.none }}
          </p>
        </section>

        <section class="flex flex-col gap-1.5">
          <div class="flex items-center justify-between gap-3">
            <h3 class="m-0 text-sm font-semibold">
              {{ s.mtp.title }}
            </h3>
            <USwitch v-model="mtp" :aria-label="s.mtp.title" />
          </div>
          <template v-if="hasDraft">
            <p class="m-0 text-xs text-muted">
              {{ s.mtp.found }}
            </p>
            <USelect v-if="mtp" v-model="draftKey" :items="items(info.candidates.draft)" size="sm" class="font-mono" :aria-label="s.mtp.title" />
          </template>
          <p v-else class="m-0 text-xs text-muted">
            {{ s.mtp.none }}
          </p>
          <label v-if="mtp" class="mt-1 flex items-center gap-2 text-sm">
            {{ s.mtp.n }}
            <UInput v-model.number="mtpN" type="number" size="sm" class="w-20" :min="1" :max="16" :color="nValid ? undefined : 'error'" :aria-label="s.mtp.n" />
            <span class="text-xs text-dimmed">{{ s.mtp.nHint }}</span>
          </label>
        </section>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton size="sm" color="neutral" variant="ghost" @click="open = false">
          {{ s.cancel }}
        </UButton>
        <UButton size="sm" icon="i-lucide-play" :disabled="!info || !contextValid || (mtp && !nValid)" :loading="saving || !!busy[`start:${modelId}`]" @click="confirm">
          {{ s.confirm }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
