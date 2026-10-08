<script setup lang="ts">
// Model directories: add / remove / disable / depth. Existing rows keep their id (models refer to it).
import { t } from '../composables/useLocale'

const s = t.settings.dirs
const { doc, saving, save } = useSettings()
const { picking, pick } = usePickFolder()
const ui = usePlatformUi()

interface Row { key: number, id?: string, path: string, enabled: boolean, depth: string }
let seq = 0
const rows = ref<Row[]>([])
const initial = ref('')

function fromDoc(): Row[] {
  return (doc.value?.modelDirs ?? []).map(d => ({ key: seq++, id: d.id, path: d.path, enabled: d.enabled, depth: String(d.maxDepth) }))
}
const snapshot = (r: Row[]) => JSON.stringify(r.map(({ id, path, enabled, depth }) => ({ id, path, enabled, depth })))
function reset() {
  rows.value = fromDoc()
  initial.value = snapshot(rows.value)
}
watch(() => JSON.stringify(doc.value?.modelDirs), reset, { immediate: true })

const dirty = computed(() => snapshot(rows.value) !== initial.value)
const missing = (id?: string) => !!id && doc.value?.modelDirs.find(d => d.id === id)?.exists === false
// type="number" inputs hand back numbers; the row keeps text (converted on update, String() as a guard).
const badDepth = (r: Row) => !/^\d+$/.test(String(r.depth).trim()) || Number(r.depth) > 10
const invalid = computed(() => rows.value.some(r => !r.path.trim() || badDepth(r)))

function add() {
  rows.value.push({ key: seq++, path: '', enabled: true, depth: '3' })
}

async function choose(r: Row) {
  const picked = await pick()
  if (picked) r.path = picked
}

async function submit() {
  await save('dirs', {
    modelDirs: rows.value.map(r => ({ id: r.id, path: r.path, enabled: r.enabled, maxDepth: Number(r.depth) })),
  })
}
</script>

<template>
  <AppCard :title="s.title" :hint="s.hint">
    <p v-if="!rows.length" class="text-sm text-muted">
      {{ s.empty }}
    </p>
    <ul class="divide-y divide-default">
      <li v-for="(r, i) in rows" :key="r.key" class="space-y-2 py-3 first:pt-0">
        <div class="flex flex-wrap items-center gap-2">
          <UInput v-model="r.path" class="min-w-64 flex-1 font-mono" :placeholder="dirPathPlaceholder(ui.isMac)" :aria-label="s.path" :color="r.path.trim() ? undefined : 'error'" />
          <UButton color="neutral" variant="outline" size="sm" icon="i-lucide-folder-open" :loading="picking" :aria-label="s.pick" :title="s.pick" @click="choose(r)" />
          <label class="flex items-center gap-1.5 text-xs text-muted">
            {{ s.depth }}
            <UInput :model-value="r.depth" type="number" size="sm" class="w-20" :color="badDepth(r) ? 'error' : undefined" :aria-label="s.depth" @update:model-value="(v: string | number | undefined) => { r.depth = v == null ? '' : String(v) }" />
          </label>
          <label class="flex items-center gap-1.5 text-xs text-muted">
            <USwitch v-model="r.enabled" size="sm" :aria-label="s.enabled" />
            {{ s.enabled }}
          </label>
          <UButton color="neutral" variant="ghost" size="sm" icon="i-lucide-trash-2" :aria-label="s.remove" @click="rows.splice(i, 1)" />
        </div>
        <p v-if="missing(r.id)" class="text-xs text-warning">
          {{ s.missing }}
        </p>
        <p v-else-if="!r.enabled && r.id" class="text-xs text-muted">
          {{ s.disabledNote }}
        </p>
      </li>
    </ul>
    <p class="mt-1 text-xs text-muted">
      {{ s.depthHint }}
    </p>
    <div class="mt-3 flex flex-wrap items-center gap-2">
      <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-plus" @click="add">
        {{ s.add }}
      </UButton>
      <UButton size="sm" icon="i-lucide-save" :disabled="!dirty || invalid" :loading="saving === 'dirs'" @click="submit">
        {{ t.settings.save }}
      </UButton>
      <UButton v-if="dirty" size="sm" color="neutral" variant="ghost" @click="reset">
        {{ t.settings.reset }}
      </UButton>
      <span v-if="dirty" class="text-xs text-warning">{{ t.settings.dirty }}</span>
      <span v-else-if="rows.length" class="text-xs text-muted">{{ s.scanHint }}</span>
    </div>
  </AppCard>
</template>
