<script setup lang="ts">
// A small "are you sure" dialog for the knowledge base page (delete a base / a document / an entry). `tone` 'neutral' is
// for actions that lose nothing for good (revert, restore the default guide, discard a draft): primary button.
const props = defineProps<{ title: string, body: string, confirmLabel: string, cancelLabel: string, busy?: boolean, tone?: 'danger' | 'neutral' }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ confirm: [] }>()
const neutral = computed(() => props.tone === 'neutral')
</script>

<template>
  <UModal v-model:open="open" :title="title" :description="body">
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton size="sm" color="neutral" variant="ghost" :disabled="busy" @click="open = false">
          {{ cancelLabel }}
        </UButton>
        <UButton size="sm" :color="neutral ? 'primary' : 'error'" :icon="neutral ? 'i-lucide-check' : 'i-lucide-trash-2'" :loading="busy" @click="emit('confirm')">
          {{ confirmLabel }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
