<script setup lang="ts">
// Confirmation before switching / rolling back the llama.cpp version (mounted once in the layout).
import t from '~~/i18n/zh-CN'

const s = t.llamacpp
const { pending, busy, confirm } = useLlamacpp()
const open = computed({
  get: () => pending.value !== null,
  set: (v: boolean) => { if (!v) pending.value = null },
})
</script>

<template>
  <UModal v-model:open="open" :title="pending ? fmt(s.confirmTitle, { tag: pending }) : ''" :description="pending ? fmt(s.confirmBody, { tag: pending }) : ''">
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
