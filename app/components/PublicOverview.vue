<script setup lang="ts">
// Public access after the guide: state, client addresses with the self-check, API keys, and the
// actions (add an address, run the guide again, switch off). Everything else is under "Advanced".
import t from '~~/i18n/zh-CN'

const emit = defineEmits<{ start: [mode: 'setup' | 'add'] }>()
const p = t.publicAccess
const o = p.overview
const { save, saving } = useSettings()
const toast = useToast()
const closeOpen = ref(false)

async function close() {
  if (await save('public-close', { public: { enabled: false, tunnelEnabled: false, wizard: null } }, { quiet: true })) {
    closeOpen.value = false
    toast.add({ title: o.closed, color: 'success', icon: 'i-lucide-check' })
  }
}
</script>

<template>
  <div class="space-y-5">
    <section class="space-y-2">
      <h3 class="text-sm font-medium text-default">
        {{ o.status }}
      </h3>
      <PublicStatus />
    </section>

    <section class="space-y-2 border-t border-default pt-4">
      <div>
        <h3 class="text-sm font-medium text-default">
          {{ o.addresses }}
        </h3>
        <p class="text-xs text-muted">
          {{ o.addressesHint }}
        </p>
      </div>
      <PublicAddresses />
    </section>

    <section class="space-y-2 border-t border-default pt-4">
      <div>
        <h3 class="text-sm font-medium text-default">
          {{ o.keys }}
        </h3>
        <p class="text-xs text-muted">
          {{ t.keys.hint }}
        </p>
      </div>
      <PublicKeys />
    </section>

    <div class="flex flex-wrap gap-2 border-t border-default pt-4">
      <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-plus" @click="emit('start', 'add')">
        {{ o.add }}
      </UButton>
      <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-route" @click="emit('start', 'setup')">
        {{ o.rerun }}
      </UButton>
      <UButton size="sm" color="error" variant="outline" icon="i-lucide-power" @click="closeOpen = true">
        {{ o.close }}
      </UButton>
    </div>

    <details class="border-t border-default pt-4">
      <summary class="cursor-pointer text-sm text-muted">
        {{ o.advanced }}
      </summary>
      <div class="mt-3">
        <PublicAdvanced />
      </div>
    </details>

    <UModal v-model:open="closeOpen" :title="o.closeTitle" :description="o.closeBody">
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton size="sm" color="neutral" variant="ghost" @click="closeOpen = false">
            {{ o.cancel }}
          </UButton>
          <UButton size="sm" color="error" icon="i-lucide-power" :loading="saving === 'public-close'" @click="close">
            {{ o.closeConfirm }}
          </UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
