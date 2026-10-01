<script setup lang="ts">
// API keys for the public entry: create (random), masked list, show / copy, revoke (confirmed).
// Part of the public access module (overview and the guide's last step); no card of its own.
import t from '~~/i18n/zh-CN'
import type { KeyView } from '~~/server/core/keys'

const s = t.keys
const toast = useToast()
// The module shows how many keys are usable; keep the count current.
const { load: refreshSettings } = useSettings()

const keys = ref<KeyView[] | null>(null)
const loadError = ref('')
const busy = ref('')
const name = ref('')
// Plain-text keys the user asked to see, by id (only kept on this page).
const shown = reactive<Record<string, string>>({})
const confirming = ref<KeyView | null>(null)
const confirmOpen = computed({
  get: () => confirming.value !== null,
  set: (v: boolean) => { if (!v) confirming.value = null },
})

function messageOf(e: unknown): string {
  const err = e as { data?: { message?: string }, statusMessage?: string, message?: string }
  return err?.data?.message ?? err?.statusMessage ?? err?.message ?? String(e)
}
const fail = (e: unknown) => toast.add({ title: s.actionFailed, description: messageOf(e), color: 'error', icon: 'i-lucide-circle-alert' })

async function load() {
  try {
    keys.value = (await $fetch<{ keys: KeyView[] }>('/api/keys')).keys
    loadError.value = ''
  } catch (e) {
    loadError.value = messageOf(e)
  }
}
onMounted(load)

const nameBad = computed(() => !name.value.trim() || name.value.trim().length > 40)

async function create() {
  if (busy.value || nameBad.value) return
  busy.value = 'create'
  try {
    const r = await $fetch<{ keys: KeyView[], created: { id: string, key: string } | null }>('/api/keys', { method: 'POST', body: { name: name.value.trim() } })
    keys.value = r.keys
    if (r.created) shown[r.created.id] = r.created.key
    toast.add({ title: fmt(s.created, { name: name.value.trim() }), color: 'success', icon: 'i-lucide-check' })
    name.value = ''
    void refreshSettings()
  } catch (e) {
    fail(e)
  } finally {
    busy.value = ''
  }
}

async function reveal(k: KeyView): Promise<string | null> {
  if (shown[k.id]) return shown[k.id]!
  try {
    const r = await $fetch<{ key: string }>(`/api/keys/${encodeURIComponent(k.id)}/reveal`, { method: 'POST' })
    shown[k.id] = r.key
    return r.key
  } catch (e) {
    fail(e)
    return null
  }
}

async function toggle(k: KeyView) {
  if (shown[k.id]) delete shown[k.id]
  else await reveal(k)
}

async function copy(k: KeyView) {
  const wasShown = !!shown[k.id]
  const key = await reveal(k)
  if (!wasShown) delete shown[k.id]
  if (!key) return
  try {
    await navigator.clipboard.writeText(key)
    toast.add({ title: s.copied, color: 'success', icon: 'i-lucide-check' })
  } catch {
    // Clipboard blocked: show it so it can be selected by hand.
    shown[k.id] = key
  }
}

async function revoke() {
  const k = confirming.value
  if (!k || busy.value) return
  busy.value = `revoke:${k.id}`
  try {
    keys.value = (await $fetch<{ keys: KeyView[] }>(`/api/keys/${encodeURIComponent(k.id)}/revoke`, { method: 'POST' })).keys
    delete shown[k.id]
    toast.add({ title: fmt(s.revokedToast, { name: k.name }), color: 'success', icon: 'i-lucide-check' })
    confirming.value = null
    void refreshSettings()
  } catch (e) {
    fail(e)
  } finally {
    busy.value = ''
  }
}

const when = (iso: string | null) => iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '-'
</script>

<template>
  <div>
    <p v-if="loadError" class="text-sm text-error">
      {{ s.loadFailed }}：{{ loadError }}
    </p>
    <USkeleton v-else-if="!keys" class="h-16 w-full" />
    <template v-else>
      <p v-if="!keys.length" class="text-sm text-muted">
        {{ s.empty }}
      </p>
      <ul v-else class="divide-y divide-default">
        <li v-for="k in keys" :key="k.id" class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3 first:pt-0">
          <div class="min-w-0 flex-1 basis-64">
            <p class="flex items-center gap-2 text-sm" :class="k.revoked ? 'text-muted line-through' : 'text-default'">
              {{ k.name }}
              <UBadge :color="k.revoked ? 'neutral' : 'success'" variant="subtle" size="sm">
                {{ k.revoked ? s.revoked : s.active }}
              </UBadge>
            </p>
            <p class="mt-1 break-all font-mono text-xs text-muted">
              {{ shown[k.id] ?? k.masked }}
            </p>
            <p class="mt-0.5 text-xs text-dimmed">
              {{ s.createdAt }} {{ when(k.createdAt) }}<template v-if="k.revoked && k.revokedAt">
                · {{ fmt(s.revokedAt, { time: when(k.revokedAt) }) }}
              </template>
            </p>
          </div>
          <div v-if="!k.revoked" class="flex items-center gap-1">
            <UButton size="xs" color="neutral" variant="ghost" :icon="shown[k.id] ? 'i-lucide-eye-off' : 'i-lucide-eye'" @click="toggle(k)">
              {{ shown[k.id] ? s.hide : s.show }}
            </UButton>
            <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-copy" @click="copy(k)">
              {{ s.copy }}
            </UButton>
            <UButton size="xs" color="error" variant="ghost" icon="i-lucide-ban" :loading="busy === `revoke:${k.id}`" @click="confirming = k">
              {{ s.revoke }}
            </UButton>
          </div>
        </li>
      </ul>
      <form class="mt-4 flex flex-wrap items-center gap-2" @submit.prevent="create">
        <UInput v-model="name" size="sm" class="w-56" :placeholder="s.namePlaceholder" :aria-label="s.name" maxlength="40" />
        <UButton type="submit" size="sm" icon="i-lucide-key-round" :disabled="nameBad" :loading="busy === 'create'">
          {{ s.create }}
        </UButton>
      </form>
    </template>

    <UModal v-model:open="confirmOpen" :title="confirming ? fmt(s.revokeTitle, { name: confirming.name }) : ''" :description="s.revokeBody">
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton size="sm" color="neutral" variant="ghost" @click="confirming = null">
            {{ s.cancel }}
          </UButton>
          <UButton size="sm" color="error" icon="i-lucide-ban" :loading="busy.startsWith('revoke:')" @click="revoke">
            {{ s.revokeConfirm }}
          </UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
