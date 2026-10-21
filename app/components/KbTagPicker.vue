<script setup lang="ts">
// Multi-select of tags (decision 65 ⑭) as toggle chips; v-model = the chosen tags. Shared by the search test and the
// knowledge binding form. Long lists scroll inside the box, so the page never grows sideways.
defineProps<{ options: Array<{ tag: string, count: number }>, label: string }>()
const model = defineModel<string[]>({ required: true })

const toggle = (tag: string) => {
  model.value = model.value.includes(tag) ? model.value.filter(x => x !== tag) : [...model.value, tag]
}
</script>

<template>
  <div class="flex max-h-36 flex-wrap gap-1.5 overflow-y-auto" role="group" :aria-label="label">
    <button
      v-for="o in options"
      :key="o.tag"
      type="button"
      class="lw-chip cursor-pointer"
      :class="{ 'lw-chip-accent': model.includes(o.tag) }"
      :aria-pressed="model.includes(o.tag)"
      @click="toggle(o.tag)"
    >
      <span class="max-w-[16rem] truncate">{{ o.tag }}</span>
      <span class="lw-num text-dimmed">{{ o.count }}</span>
    </button>
  </div>
</template>
