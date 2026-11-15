<script setup lang="ts">
// Difference between two versions of an entry (title, tags, body by line). Colors are the semantic ones, so light
// and dark both read. Long unchanged runs fold and can be opened.
import { t } from '../composables/useLocale'
import { diffTags } from '~/utils/kb'
import { diffLines, foldSame } from '~/utils/text-diff'

interface Side { title: string, tags: readonly string[], body: string }
const props = defineProps<{ a: Side, b: Side, aLabel?: string, bLabel?: string }>()
const d = t.kb.page.diff

const titleChanged = computed(() => props.a.title !== props.b.title)
const tags = computed(() => diffTags(props.a.tags, props.b.tags))
const bodyChanged = computed(() => props.a.body.replace(/\r\n/g, '\n') !== props.b.body.replace(/\r\n/g, '\n'))
const rows = computed(() => foldSame(diffLines(props.a.body, props.b.body)))
const nothing = computed(() => !titleChanged.value && !tags.value.added.length && !tags.value.removed.length && !bodyChanged.value)

// Folded runs the user opened (by index in `rows`); a new comparison starts folded again.
const opened = ref<Set<number>>(new Set())
watch(rows, () => { opened.value = new Set() })
const open = (i: number) => { opened.value = new Set(opened.value).add(i) }

const rowCls = (op: string) => ({
  add: 'bg-success/10 text-success',
  del: 'bg-error/10 text-error',
  same: 'text-muted',
}[op] ?? '')
const mark = (op: string) => ({ add: '+', del: '-', same: ' ' }[op] ?? ' ')
</script>

<template>
  <div class="flex min-w-0 flex-col gap-3 text-[13px]">
    <p v-if="nothing" class="m-0 text-muted">
      {{ d.none }}
    </p>

    <div v-if="titleChanged" class="flex min-w-0 flex-col gap-1">
      <span class="text-xs font-medium text-dimmed">{{ d.title }}</span>
      <div class="flex gap-2 rounded-md bg-error/10 px-2 py-1 text-error">
        <span class="w-3 shrink-0 select-none font-mono">-</span><span class="min-w-0 break-words">{{ a.title }}</span>
      </div>
      <div class="flex gap-2 rounded-md bg-success/10 px-2 py-1 text-success">
        <span class="w-3 shrink-0 select-none font-mono">+</span><span class="min-w-0 break-words">{{ b.title }}</span>
      </div>
    </div>

    <div v-if="tags.added.length || tags.removed.length" class="flex min-w-0 flex-col gap-1">
      <span class="text-xs font-medium text-dimmed">{{ d.tags }}</span>
      <div class="flex flex-wrap items-center gap-1.5">
        <span v-for="x in tags.added" :key="`+${x}`" class="inline-flex max-w-full items-center gap-1 rounded-md bg-success/10 px-2 py-0.5 text-xs text-success" :title="d.added">
          <span class="select-none">+</span><span class="break-all">{{ x }}</span>
        </span>
        <span v-for="x in tags.removed" :key="`-${x}`" class="inline-flex max-w-full items-center gap-1 rounded-md bg-error/10 px-2 py-0.5 text-xs text-error line-through" :title="d.removed">
          <span class="select-none no-underline">-</span><span class="break-all">{{ x }}</span>
        </span>
      </div>
    </div>

    <div class="flex min-w-0 flex-col gap-1">
      <span class="text-xs font-medium text-dimmed">{{ d.body }}</span>
      <p v-if="!bodyChanged" class="m-0 text-muted">
        {{ d.bodySame }}
      </p>
      <div v-else class="flex min-w-0 flex-col overflow-hidden rounded-md border border-default font-mono text-xs">
        <template v-for="(r, i) in rows" :key="i">
          <template v-if="r.op === 'fold'">
            <button v-if="!opened.has(i)" type="button" class="cursor-pointer border-0 bg-elevated/60 px-2 py-1 text-center text-xs text-dimmed hover:text-default" @click="open(i)">
              {{ fmt(d.folded, { n: r.rows.length }) }}
            </button>
            <template v-else>
              <div v-for="(x, j) in r.rows" :key="`${i}-${j}`" class="flex gap-2 px-2 py-0.5" :class="rowCls(x.op)">
                <span class="w-3 shrink-0 select-none">{{ mark(x.op) }}</span>
                <span class="min-w-0 flex-1 whitespace-pre-wrap break-words">{{ x.text || ' ' }}</span>
              </div>
            </template>
          </template>
          <div v-else class="flex gap-2 px-2 py-0.5" :class="rowCls(r.op)">
            <span class="w-3 shrink-0 select-none">{{ mark(r.op) }}</span>
            <span class="min-w-0 flex-1 whitespace-pre-wrap break-words">{{ r.text || ' ' }}</span>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
