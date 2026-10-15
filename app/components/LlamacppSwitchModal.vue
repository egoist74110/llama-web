<script setup lang="ts">
// Confirmation before switching / rolling back the llama.cpp version (mounted once in the layout).
import { t } from '../composables/useLocale'

const s = t.llamacpp
const { pending, pendingLabel, busy, confirm } = useLlamacpp()
const name = computed(() => pendingLabel.value ?? pending.value ?? '')
const open = computed({
  get: () => pending.value !== null,
  set: (v: boolean) => { if (!v) pending.value = null },
})
</script>

<template>
  <UModal v-model:open="open" :title="pending ? fmt(s.confirmTitle, { tag: name }) : ''" :description="pending ? fmt(s.confirmBody, { tag: name }) : ''">
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton size="sm" color="neutral" variant="ghost" @click="pending = null">
          {{ s.cancel }}
        </UButton>
        <UButton size="sm" icon="i-lucide-history" :loading="busy" @click="confirm">
          {{ s.confirm }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
