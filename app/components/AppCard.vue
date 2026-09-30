<script setup lang="ts">
// The one card style for every page: a titled group with an optional one-line hint.
defineProps<{ title: string, hint?: string }>()
</script>

<template>
  <section class="rounded-[var(--ui-radius)] border border-default bg-elevated">
    <header class="flex items-start justify-between gap-3 px-5 pt-4">
      <div class="min-w-0">
        <h2 class="text-sm font-semibold text-highlighted">
          {{ title }}
        </h2>
        <p v-if="hint" class="mt-0.5 text-xs text-muted">
          {{ hint }}
        </p>
      </div>
      <slot name="actions" />
    </header>
    <div class="px-5 pb-4 pt-3">
      <slot />
    </div>
  </section>
</template>
