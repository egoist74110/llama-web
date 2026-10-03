<script setup lang="ts">
// "Add folder" on the models page: choose a folder (native dialog) or paste a path, add it to the
// model directories and scan right away. The page then jumps to the scan results.
import t from '~~/i18n/zh-CN'
import { checkNewDir } from '~/utils/model-dirs'

const emit = defineEmits<{ added: [] }>()
const s = t.models.addDir
const ui = usePlatformUi()
const toast = useToast()
const { doc, saving, load, save } = useSettings()
const { picking, pick } = usePickFolder()
const { state } = useLive()

const open = ref(false)
const path = ref('')
const working = ref(false)
const windows = computed(() => state.value?.platform?.os === 'win32')

async function addDir(raw: string): Promise<boolean> {
  const value = raw.trim().replace(/^"(.*)"$/, '$1').trim()
  if (!value || working.value) return false
  if (!doc.value) await load()
  const dirs = (doc.value?.modelDirs ?? []).map(d => ({ id: d.id, path: d.path, enabled: d.enabled, maxDepth: d.maxDepth }))
  const check = checkNewDir(dirs, value, windows.value)
  if (check.kind === 'duplicate') {
    toast.add({ title: fmt(s.duplicate, { path: check.path }), color: 'warning', icon: 'i-lucide-circle-alert' })
    return false
  }
  if (check.kind === 'inside') {
    toast.add({ title: fmt(s.inside, { path: check.path, depth: check.depth }), color: 'warning', icon: 'i-lucide-circle-alert' })
    return false
  }
  working.value = true
  try {
    if (!await save('add-dir', { modelDirs: [...dirs, { path: value, enabled: true, maxDepth: 3 }] }, { quiet: true })) return false
    // Drop the cached scan and let the scan tab read the new directory.
    emit('added')
    return true
  } finally {
    working.value = false
  }
}

async function choose() {
  const picked = await pick()
  if (picked) await addDir(picked)
}

async function onPrimary() {
  if (ui.value.canPickFolder) await choose()
  else open.value = true
}

async function submit() {
  if (await addDir(path.value)) {
    open.value = false
    path.value = ''
  }
}
</script>

<template>
  <div class="flex items-center gap-1.5">
    <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-folder-plus" :loading="picking || working || saving === 'add-dir'" @click="onPrimary">
      {{ s.button }}
    </UButton>
    <UButton v-if="ui.canPickFolder" size="sm" color="neutral" variant="ghost" icon="i-lucide-keyboard" :aria-label="s.paste" :title="s.paste" @click="open = true" />
    <UModal v-model:open="open" :title="s.title" :description="s.hint">
      <template #body>
        <form @submit.prevent="submit">
          <UInput v-model="path" class="w-full" :placeholder="dirPathPlaceholder(ui.isMac)" :aria-label="s.pathLabel" :ui="{ base: 'font-mono text-xs' }" autofocus />
        </form>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton size="sm" color="neutral" variant="ghost" @click="open = false">
            {{ s.cancel }}
          </UButton>
          <UButton size="sm" icon="i-lucide-plus" :disabled="!path.trim()" :loading="working" @click="submit">
            {{ s.confirm }}
          </UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
