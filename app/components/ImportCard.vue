<script setup lang="ts">
// Import of the old swap-config.json (moves into the first-run wizard in 2-4).
import t from '~~/i18n/zh-CN'

const path = ref('')
const busy = ref(false)
const result = ref<{ text: string, lines: string[], failed: boolean } | null>(null)

async function runImport(dryRun: boolean) {
  busy.value = true
  try {
    const r = await $fetch<{ imported: Array<{ name: string, mmproj: string | null }>, defaultsApplied: boolean, warnings: string[] }>('/api/import', {
      method: 'POST', body: { path: path.value, dryRun },
    })
    result.value = {
      failed: false,
      text: fmt(dryRun ? t.import.previewDone : t.import.done, { count: r.imported.length }),
      lines: [
        ...r.imported.map(m => fmt(t.import.model, { name: m.name, mmproj: m.mmproj ?? t.import.no })),
        ...(r.imported.some(m => m.mmproj) ? [t.import.mmprojAuto] : []),
        ...(r.imported.length ? [r.defaultsApplied ? t.import.defaultsApplied : t.import.defaultsKept] : []),
        ...r.warnings,
      ],
    }
  } catch (e) {
    result.value = { failed: true, text: (e as { data?: { message?: string } }).data?.message ?? String(e), lines: [] }
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <AppCard :title="t.import.title" :hint="t.import.hint">
    <form class="flex flex-wrap gap-2" @submit.prevent="runImport(false)">
      <UInput v-model="path" class="min-w-64 flex-1" :placeholder="t.import.path" :aria-label="t.import.path" />
      <UButton color="neutral" variant="outline" :disabled="busy || !path" @click="runImport(true)">
        {{ t.import.preview }}
      </UButton>
      <UButton type="submit" :disabled="busy || !path" :loading="busy">
        {{ t.import.run }}
      </UButton>
    </form>
    <div v-if="result" class="mt-3">
      <p class="text-sm" :class="result.failed ? 'text-error' : 'text-success'">
        {{ result.text }}
      </p>
      <ul class="mt-1 space-y-0.5 text-xs text-muted">
        <li v-for="(l, i) in result.lines" :key="i">
          {{ l }}
        </li>
      </ul>
    </div>
  </AppCard>
</template>
