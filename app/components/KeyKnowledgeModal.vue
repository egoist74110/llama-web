<script setup lang="ts">
// Knowledge base permissions of one API key (decisions 65 ⑧ / 69 ⑧): all knowledge bases or a chosen few, and whether
// the key may write. Only requests that come through the public entry with this key are limited by it.
import { t } from '../composables/useLocale'
import type { KeyView } from '~~/server/core/keys'
import type { KbView } from '~~/server/core/kb/manager'

const props = defineProps<{ keyView: KeyView | null }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ saved: [keys: KeyView[]] }>()

const k = t.keys.knowledge
const toast = useToast()

const bases = ref<Array<{ id: string, name: string }> | null>(null)
const loadError = ref('')
const scope = ref<'all' | 'some'>('all')
const selected = ref<string[]>([])
const write = ref(false)
const busy = ref(false)

const scopes = computed(() => [{ label: k.all, value: 'all' }, { label: k.some, value: 'some' }])

watch(() => [open.value, props.keyView?.id] as const, async ([isOpen]) => {
  if (!isOpen || !props.keyView) return
  scope.value = props.keyView.kbs === null ? 'all' : 'some'
  selected.value = [...(props.keyView.kbs ?? [])]
  write.value = props.keyView.kbWrite
  bases.value = null
  loadError.value = ''
  try {
    bases.value = (await $fetch<{ bases: KbView[] }>('/api/kb')).bases.map(b => ({ id: b.id, name: b.name }))
  } catch (e) {
    loadError.value = messageOf(e)
  }
}, { immediate: true })

// Knowledge bases of the list, then ids the key still holds that no longer exist (can be unticked).
const rows = computed(() => {
  const known = bases.value ?? []
  const ids = new Set(known.map(b => b.id))
  return [
    ...known.map(b => ({ id: b.id, label: b.name, missing: false })),
    ...selected.value.filter(id => !ids.has(id)).map(id => ({ id, label: fmt(k.missing, { id }), missing: true })),
  ]
})
function toggle(id: string, on: boolean) {
  selected.value = on ? [...new Set([...selected.value, id])] : selected.value.filter(x => x !== id)
}

async function save() {
  const kv = props.keyView
  if (!kv || busy.value) return
  busy.value = true
  try {
    const r = await $fetch<{ keys: KeyView[] }>(`/api/keys/${encodeURIComponent(kv.id)}/knowledge`, {
      method: 'POST',
      body: { kbs: scope.value === 'all' ? null : selected.value, kbWrite: write.value },
    })
    toast.add({ title: fmt(k.saved, { name: kv.name }), color: 'success', icon: 'i-lucide-check' })
    emit('saved', r.keys)
    open.value = false
  } catch (e) {
    toast.add({ title: k.saveFailed, description: messageOf(e), color: 'error', icon: 'i-lucide-circle-alert' })
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <UModal v-model:open="open" :title="keyView ? fmt(k.title, { name: keyView.name }) : ''" :description="k.description">
    <template #body>
      <div class="flex min-w-0 flex-col gap-4">
        <div class="flex flex-col gap-2">
          <span class="text-[13px] font-medium">{{ k.scopeLabel }}</span>
          <URadioGroup v-model="scope" :items="scopes" />
          <div v-if="scope === 'some'" class="ml-6 flex flex-col gap-2">
            <p v-if="loadError" class="m-0 break-words text-xs text-error">
              {{ loadError }}
            </p>
            <USkeleton v-else-if="!bases" class="h-12 w-full" />
            <template v-else>
              <div v-if="!rows.length" class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                <span>{{ k.none }}</span>
                <NuxtLink to="/knowledge" class="text-primary" @click="open = false">
                  {{ k.toKbPage }}
                </NuxtLink>
              </div>
              <ul v-else class="m-0 flex max-h-56 list-none flex-col gap-1.5 overflow-y-auto p-0">
                <li v-for="r in rows" :key="r.id" class="min-w-0">
                  <UCheckbox :model-value="selected.includes(r.id)" :label="r.label" :ui="{ label: r.missing ? 'break-all text-warning' : 'break-words' }" @update:model-value="(v: boolean | 'indeterminate') => toggle(r.id, v === true)" />
                </li>
              </ul>
            </template>
          </div>
        </div>

        <div class="flex flex-col gap-1.5">
          <div class="flex items-center justify-between gap-3">
            <span class="text-[13px] font-medium">{{ k.writeLabel }}</span>
            <USwitch v-model="write" :aria-label="k.writeLabel" />
          </div>
          <p class="m-0 text-xs text-muted">
            {{ k.writeHint }}
          </p>
        </div>

        <p class="m-0 text-xs text-muted">
          {{ k.localNote }}
        </p>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton size="sm" color="neutral" variant="ghost" :disabled="busy" @click="open = false">
          {{ k.cancel }}
        </UButton>
        <UButton size="sm" icon="i-lucide-save" :loading="busy" @click="save">
          {{ k.save }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
