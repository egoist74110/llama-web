<script setup lang="ts">
// Conversation list: new / switch / rename (inline) / delete (with confirmation).
import t from '~~/i18n/zh-CN'
import type { ChatSession } from '~/utils/chat'

const props = defineProps<{ sessions: ChatSession[], currentId: string | null, busy: boolean }>()
const emit = defineEmits<{ new: [], select: [id: string], rename: [id: string, title: string], remove: [id: string] }>()
const S = t.chat.sessions

const editing = ref<string | null>(null)
const draft = ref('')
function startRename(s: ChatSession) {
  editing.value = s.id
  draft.value = s.title
}
function commit() {
  if (editing.value) emit('rename', editing.value, draft.value)
  editing.value = null
}

const pending = ref<ChatSession | null>(null)
const confirmOpen = computed({ get: () => !!pending.value, set: (v) => { if (!v) pending.value = null } })
function confirmRemove() {
  if (pending.value) emit('remove', pending.value.id)
  pending.value = null
}
const disabled = computed(() => props.busy)
</script>

<template>
  <aside class="lw-card flex min-h-0 flex-col gap-2 p-3" :aria-label="S.list">
    <UButton block color="primary" icon="i-lucide-plus" :disabled="disabled" @click="$emit('new')">
      {{ S.new }}
    </UButton>
    <p v-if="!sessions.length" class="m-0 px-1 py-3 text-center text-xs text-dimmed">
      {{ S.empty }}
    </p>
    <ul class="m-0 flex list-none flex-col gap-0.5 overflow-auto p-0">
      <li v-for="s in sessions" :key="s.id">
        <UInput
          v-if="editing === s.id"
          v-model="draft"
          size="sm"
          class="w-full"
          autofocus
          :aria-label="S.renameLabel"
          @keydown.enter.prevent="commit"
          @keydown.esc="editing = null"
          @blur="commit"
        />
        <div
          v-else
          class="group flex items-center gap-1 rounded-lg px-2 py-1.5 text-[13px]"
          :class="s.id === currentId ? 'bg-[var(--lw-sunken)] font-medium' : 'hover:bg-[var(--lw-sunken)]'"
        >
          <button type="button" class="min-w-0 flex-1 truncate bg-transparent text-left" :disabled="disabled" :aria-current="s.id === currentId ? 'true' : undefined" @click="$emit('select', s.id)">
            {{ s.title }}
          </button>
          <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-pencil" :aria-label="S.rename" :title="S.rename" class="opacity-60 hover:opacity-100" @click="startRename(s)" />
          <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-trash-2" :aria-label="S.delete" :title="S.delete" class="opacity-60 hover:opacity-100" @click="pending = s" />
        </div>
      </li>
    </ul>

    <UModal v-model:open="confirmOpen" :title="S.deleteTitle" :description="pending ? fmt(S.deleteBody, { title: pending.title }) : ''">
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="outline" @click="pending = null">
            {{ S.cancel }}
          </UButton>
          <UButton color="error" @click="confirmRemove">
            {{ S.confirm }}
          </UButton>
        </div>
      </template>
    </UModal>
  </aside>
</template>
