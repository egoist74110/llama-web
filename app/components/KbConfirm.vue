<script setup lang="ts">
// A small "are you sure" dialog for the knowledge base page (delete a base / a document).
defineProps<{ title: string, body: string, confirmLabel: string, cancelLabel: string, busy?: boolean }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ confirm: [] }>()
</script>

<template>
  <UModal v-model:open="open" :title="title" :description="body">
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton size="sm" color="neutral" variant="ghost" :disabled="busy" @click="open = false">
          {{ cancelLabel }}
        </UButton>
        <UButton size="sm" color="error" icon="i-lucide-trash-2" :loading="busy" @click="emit('confirm')">
          {{ confirmLabel }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
