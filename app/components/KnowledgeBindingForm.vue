<script setup lang="ts">
// Knowledge settings of a model or an external upstream (decision 65 ⑨): the switch, which knowledge bases (all,
// including ones created later, or a picked list), how they are used and how many hits. v-model = the binding.
// Saving is up to the parent (it can use bindingIncomplete() to block a save with nothing picked).
import { t } from '../composables/useLocale'
import { bindingIncomplete, mergeTags, parseSimilarity } from '~/utils/kb'
import type { KnowledgeBinding } from '~~/server/core/kb/binding'
import type { KbView } from '~~/server/core/kb/manager'

const model = defineModel<KnowledgeBinding>({ required: true })

const k = t.kbBinding
const bases = ref<KbView[] | null>(null)
const loadFailed = ref(false)

async function loadBases() {
  loadFailed.value = false
  try {
    const r = await $fetch<{ bases: KbView[] }>('/api/kb')
    bases.value = r.bases
    // A knowledge base deleted since the binding was saved is not shown any more: drop it from the picked list too.
    const ids = new Set(r.bases.map(b => b.id))
    if (model.value.kbs.some(id => !ids.has(id))) model.value = { ...model.value, kbs: model.value.kbs.filter(id => ids.has(id)) }
  } catch {
    loadFailed.value = true
  }
}
onMounted(loadBases)

const patch = (p: Partial<KnowledgeBinding>) => { model.value = { ...model.value, ...p } }
const toggle = (id: string, on: boolean) => {
  const set = new Set(model.value.kbs)
  if (on) set.add(id)
  else set.delete(id)
  patch({ kbs: [...set] })
}
const setTopK = (v: string | number) => {
  const n = Math.floor(Number(v))
  patch({ topK: Number.isFinite(n) ? Math.min(20, Math.max(1, n)) : model.value.topK })
}
const incomplete = computed(() => bindingIncomplete(model.value))

// Tags of the knowledge bases this binding covers (all of them, or the picked ones); tags already in the binding stay listed.
const tagOptions = computed(() => {
  const covered = (bases.value ?? []).filter(b => model.value.all || model.value.kbs.includes(b.id))
  return mergeTags(covered.map(b => b.tags ?? []), model.value.tags)
})

const simText = ref(model.value.minSimilarity === null ? '' : String(model.value.minSimilarity))
const simBad = computed(() => !parseSimilarity(simText.value).ok)
const setSimilarity = (v: string | number) => {
  simText.value = String(v ?? '')
  const r = parseSimilarity(simText.value)
  if (r.ok) patch({ minSimilarity: r.value })
}
// The parent loads the saved binding after this form exists: follow it.
watch(() => model.value.minSimilarity, (v) => {
  if (parseSimilarity(simText.value).value !== v) simText.value = v === null ? '' : String(v)
})
</script>

<template>
  <div class="flex flex-col gap-3">
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <p class="m-0 text-sm font-medium text-default">
          {{ k.title }}
        </p>
        <p class="m-0 mt-0.5 text-xs text-muted">
          {{ k.switchHint }}
        </p>
      </div>
      <USwitch :model-value="model.enabled" :aria-label="k.title" @update:model-value="(v: boolean) => patch({ enabled: v })" />
    </div>

    <template v-if="model.enabled">
      <div class="flex flex-col gap-1.5">
        <span class="text-xs font-medium text-muted">{{ k.scope }}</span>
        <div class="lw-seg max-w-full flex-wrap self-start" role="radiogroup" :aria-label="k.scope">
          <button type="button" role="radio" :aria-checked="model.all" :class="{ on: model.all }" @click="patch({ all: true })">
            {{ k.scopeAll }}
          </button>
          <button type="button" role="radio" :aria-checked="!model.all" :class="{ on: !model.all }" @click="patch({ all: false })">
            {{ k.scopeSome }}
          </button>
        </div>
        <template v-if="bases && !bases.length">
          <p class="m-0 text-xs text-muted">
            {{ k.none }}
            <NuxtLink to="/knowledge" class="text-primary">{{ k.noneLink }}</NuxtLink>
          </p>
          <p v-if="model.all" class="m-0 text-xs text-dimmed">
            {{ k.noneAll }}
          </p>
        </template>
        <ul v-if="!model.all && bases?.length" class="m-0 flex list-none flex-col gap-1.5 p-0" :aria-label="k.pick">
          <li v-for="b in bases" :key="b.id">
            <UCheckbox
              :model-value="model.kbs.includes(b.id)"
              :label="b.name"
              @update:model-value="(v: boolean | 'indeterminate') => toggle(b.id, v === true)"
            />
          </li>
        </ul>
        <p v-if="incomplete" role="alert" class="m-0 text-xs text-error">
          {{ k.pickEmpty }}
        </p>
      </div>

      <div class="flex flex-col gap-1.5">
        <span class="text-xs font-medium text-muted">{{ k.mode }}</span>
        <div class="lw-seg max-w-full flex-wrap self-start" role="radiogroup" :aria-label="k.mode">
          <button type="button" role="radio" :aria-checked="model.mode === 'inject'" :class="{ on: model.mode === 'inject' }" @click="patch({ mode: 'inject' })">
            {{ k.modeInject }}
          </button>
          <button type="button" role="radio" :aria-checked="model.mode === 'tool'" :class="{ on: model.mode === 'tool' }" @click="patch({ mode: 'tool' })">
            {{ k.modeTool }}
          </button>
        </div>
        <p class="m-0 text-xs text-dimmed">
          {{ model.mode === 'inject' ? k.modeInjectHint : k.modeToolHint }}
        </p>
      </div>

      <div class="flex flex-col gap-1.5">
        <label class="text-xs font-medium text-muted">{{ k.topK }}</label>
        <UInput :model-value="model.topK" type="number" :min="1" :max="20" class="w-28" :aria-label="k.topK" @update:model-value="setTopK" />
        <p class="m-0 text-xs text-dimmed">
          {{ k.topKHint }}
        </p>
      </div>

      <div v-if="tagOptions.length" class="flex flex-col gap-1.5">
        <span class="text-xs font-medium text-muted">{{ k.tags }}</span>
        <KbTagPicker :model-value="model.tags" :options="tagOptions" :label="k.tags" @update:model-value="(v: string[]) => patch({ tags: v })" />
        <p class="m-0 text-xs text-dimmed">
          {{ k.tagsHint }}
        </p>
      </div>

      <div class="flex flex-col gap-1.5">
        <label class="text-xs font-medium text-muted">{{ k.minSimilarity }}</label>
        <UInput :model-value="simText" type="number" min="0" max="1" step="0.05" class="w-28" :placeholder="k.minSimilarityPlaceholder" :aria-label="k.minSimilarity" :color="simBad ? 'error' : undefined" @update:model-value="setSimilarity" />
        <p v-if="simBad" role="alert" class="m-0 text-xs text-error">
          {{ k.minSimilarityBad }}
        </p>
        <p v-else class="m-0 text-xs text-dimmed">
          {{ k.minSimilarityHint }}
        </p>
      </div>
    </template>
  </div>
</template>
