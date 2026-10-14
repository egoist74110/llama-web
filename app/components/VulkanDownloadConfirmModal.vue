<script setup lang="ts">
import { t } from '../composables/useLocale'

const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ confirm: [] }>()

const s = t.llamacpp.vulkanConfirm

function onConfirm() {
  open.value = false
  emit('confirm')
}
</script>

<template>
  <UModal v-model:open="open" :title="s.title" :description="s.body">
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton size="sm" color="neutral" variant="ghost" @click="open = false">
          {{ s.cancel }}
        </UButton>
        <UButton size="sm" @click="onConfirm">
          {{ s.confirm }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
