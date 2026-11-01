<script setup lang="ts">
// Web search card (decision 67): the global switch and the keys of the keyed backends. It talks to /api/web-search on its
// own; a key box is write-only (the view only says whether one is saved), an empty box keeps the saved key.
import { t } from '../composables/useLocale'
import type { WebSearchView } from '~~/server/core/web-search/admin'

const s = t.webSearch
const toast = useToast()
const view = ref<WebSearchView | null>(null)
const loadError = ref('')
const saving = ref(false)
const enabled = ref(true)
const order = ref<'free-only' | 'free-first' | 'keyed-first'>('free-only')
const guide = ref('')
const guideRequired = ref(true)
const orders = [{ label: s.orderFreeOnly, value: 'free-only' }, { label: s.orderFree, value: 'free-first' }, { label: s.orderKeyed, value: 'keyed-first' }]
const keys = reactive<Record<string, string>>({ tavily: '', brave: '' })
const clearing = reactive<Record<string, boolean>>({ tavily: false, brave: false })

const messageOf = (e: unknown) => {
  const err = e as { data?: { message?: string }, statusMessage?: string, message?: string }
  return err?.data?.message ?? err?.statusMessage ?? err?.message ?? String(e)
}

function apply(v: WebSearchView) {
  view.value = v
  enabled.value = v.enabled
  order.value = v.order
  // The editor shows the text the model will read: the saved one, or the default while none is saved.
  guide.value = v.guide || v.defaultGuide
  guideRequired.value = v.guideRequired
  for (const id of Object.keys(keys)) { keys[id] = ''; clearing[id] = false }
}

async function load() {
  try { apply(await $fetch<WebSearchView>('/api/web-search')) } catch (e) { loadError.value = messageOf(e) }
}
onMounted(load)

const free = computed(() => view.value?.backends.filter(b => !b.needsKey) ?? [])
const keyed = computed(() => view.value?.backends.filter(b => b.needsKey) ?? [])
const dirty = computed(() => !!view.value && (enabled.value !== view.value.enabled || order.value !== view.value.order || guide.value !== (view.value.guide || view.value.defaultGuide) || guideRequired.value !== view.value.guideRequired || Object.keys(keys).some(id => keys[id]!.trim() || clearing[id])))

async function save() {
  if (saving.value || !dirty.value) return
  saving.value = true
  const patch: Record<string, unknown> = { enabled: enabled.value, order: order.value, guide: guide.value, guideRequired: guideRequired.value }
  const changed: Record<string, string> = {}
  for (const id of Object.keys(keys)) {
    if (clearing[id]) changed[id] = ''
    else if (keys[id]!.trim()) changed[id] = keys[id]!.trim()
  }
  if (Object.keys(changed).length) patch.keys = changed
  try {
    apply(await $fetch<WebSearchView>('/api/web-search', { method: 'POST', body: patch }))
    toast.add({ title: t.settings.saved, color: 'success', icon: 'i-lucide-check' })
  } catch (e) {
    toast.add({ title: messageOf(e), color: 'error', icon: 'i-lucide-circle-alert' })
  } finally {
    saving.value = false
  }
}

const stateColor = (state: string) => (state === 'ready' ? 'text-success' : state === 'no-key' ? 'text-dimmed' : 'text-warning')
const stateText = (state: string) => (s.state as Record<string, string>)[state] ?? state
const nameOf = (id: string) => (s.backend as Record<string, string>)[id] ?? id
</script>

<template>
  <AppCard :title="s.title" :hint="s.hint">
    <p v-if="loadError" class="text-sm text-error">
      {{ loadError }}
    </p>
    <USkeleton v-else-if="!view" class="h-24 w-full rounded-[10px]" />
    <template v-else>
      <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 pb-3">
        <p class="min-w-0 flex-1 basis-56 text-sm text-default">
          {{ s.enabled }}
        </p>
        <USwitch v-model="enabled" :aria-label="s.enabled" />
      </div>
      <div class="flex flex-col gap-4 border-t border-default pt-3">
        <div>
          <div class="mb-1.5 flex items-center justify-between gap-3">
            <p class="m-0 text-xs font-medium text-muted">
              {{ s.guideLabel }}
            </p>
            <button v-if="view && guide !== view.defaultGuide" type="button" class="text-xs text-primary" @click="guide = view.defaultGuide">
              {{ s.guideReset }}
            </button>
          </div>
          <UTextarea v-model="guide" :rows="10" autoresize class="w-full" :ui="{ base: 'text-xs' }" :aria-label="s.guideLabel" />
          <p class="m-0 mt-1 text-xs text-dimmed">
            {{ s.guideHint }}
          </p>
          <div class="mt-3 flex items-center justify-between gap-3">
            <div class="min-w-0">
              <p class="m-0 text-sm text-default">
                {{ s.guideRequiredLabel }}
              </p>
              <p class="m-0 mt-0.5 text-xs text-dimmed">
                {{ s.guideRequiredHint }}
              </p>
            </div>
            <USwitch v-model="guideRequired" :aria-label="s.guideRequiredLabel" />
          </div>
        </div>
        <div>
          <p class="m-0 mb-1.5 text-xs font-medium text-muted">
            {{ s.orderLabel }}
          </p>
          <URadioGroup v-model="order" :items="orders" size="sm" :aria-label="s.orderLabel" />
        </div>
        <div>
          <p class="m-0 mb-1.5 text-xs font-medium text-muted">
            {{ s.freeGroup }}
          </p>
          <ul class="m-0 flex list-none flex-col gap-1 p-0">
            <li v-for="b in free" :key="b.id" class="flex items-center justify-between gap-3 text-sm">
              <span class="text-default">{{ nameOf(b.id) }}</span>
              <span class="text-xs" :class="stateColor(b.state)">{{ stateText(b.state) }}</span>
            </li>
          </ul>
        </div>
        <div>
          <p class="m-0 mb-1.5 text-xs font-medium text-muted">
            {{ s.keyedGroup }}
          </p>
          <ul class="m-0 flex list-none flex-col gap-3 p-0">
            <li v-for="b in keyed" :key="b.id" class="flex flex-col gap-1">
              <div class="flex items-center justify-between gap-3 text-sm">
                <span class="text-default">{{ nameOf(b.id) }}</span>
                <span class="text-xs" :class="stateColor(b.state)">{{ stateText(b.state) }}</span>
              </div>
              <UInput
                v-model="keys[b.id]"
                type="password"
                size="sm"
                class="w-full"
                autocomplete="off"
                :disabled="clearing[b.id]"
                :placeholder="b.hasKey && !clearing[b.id] ? s.keySaved : s.keyPlaceholder"
                :aria-label="nameOf(b.id)"
              />
              <p v-if="b.hasKey" class="m-0 text-xs text-dimmed">
                <button v-if="!clearing[b.id]" type="button" class="text-error" @click="clearing[b.id] = true; keys[b.id] = ''">
                  {{ s.clear }}
                </button>
                <button v-else type="button" class="text-primary" @click="clearing[b.id] = false">
                  {{ t.settings.reset }}
                </button>
              </p>
            </li>
          </ul>
        </div>
      </div>
      <div class="mt-4 flex flex-wrap items-center gap-2">
        <UButton size="sm" icon="i-lucide-save" :disabled="!dirty" :loading="saving" @click="save">
          {{ s.save }}
        </UButton>
        <span v-if="dirty" class="text-xs text-warning">{{ t.settings.dirty }}</span>
      </div>
    </template>
  </AppCard>
</template>
