<script setup lang="ts">
// The one card style for every page: a titled group with an optional one-line hint.
defineProps<{ title: string, hint?: string }>()
</script>

<template>
  <section class="lw-card lw-anchor">
    <header class="flex items-start justify-between gap-3 px-5 pb-1.5 pt-[18px]">
      <div class="min-w-0">
        <h2 class="m-0 text-[15px] font-semibold">
          {{ title }}
        </h2>
        <p v-if="hint" class="mt-[3px] text-xs text-dimmed">
          {{ hint }}
        </p>
      </div>
      <slot name="actions" />
    </header>
    <div class="px-5 pb-[18px] pt-2.5">
      <slot />
    </div>
  </section>
</template>
