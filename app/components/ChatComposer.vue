<script setup lang="ts">
// Input box: text, optional images (only when the model has a vision file), send / stop.
import { t } from '../composables/useLocale'
import { dataUrlBytes, imageLimit, MAX_IMAGE_BYTES, MAX_SESSION_IMAGE_BYTES } from '~/utils/chat'

const props = defineProps<{ busy: boolean, canSend: boolean, vision: boolean, usedBytes: number }>()
const emit = defineEmits<{ send: [text: string, images: string[]], stop: [] }>()
const C = t.chat.composer
const toast = useToast()
const MB = 1024 * 1024

const text = ref('')
const images = ref<string[]>([])
const input = ref<HTMLInputElement | null>(null)

const readFile = (f: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader()
  r.onload = () => resolve(String(r.result))
  r.onerror = () => reject(r.error)
  r.readAsDataURL(f)
})

async function addFiles(files: FileList | File[]) {
  for (const f of Array.from(files)) {
    const warn = (description: string) => toast.add({ description, color: 'warning', icon: 'i-lucide-image-off' })
    if (!f.type.startsWith('image/')) { warn(fmt(C.notImage, { name: f.name })); continue }
    const pending = images.value.reduce((n, u) => n + dataUrlBytes(u), 0)
    const why = imageLimit(f.size, props.usedBytes + pending)
    if (why === 'single') { warn(fmt(C.tooBig, { name: f.name, max: MAX_IMAGE_BYTES / MB })); continue }
    if (why === 'total') { warn(fmt(C.totalFull, { name: f.name, max: MAX_SESSION_IMAGE_BYTES / MB })); continue }
    try { images.value = [...images.value, await readFile(f)] } catch { warn(fmt(C.readFailed, { name: f.name })) }
  }
}
function onPick(e: Event) {
  const el = e.target as HTMLInputElement
  if (el.files) void addFiles(el.files)
  el.value = ''
}
function onPaste(e: ClipboardEvent) {
  const files = Array.from(e.clipboardData?.files ?? []).filter(f => f.type.startsWith('image/'))
  if (files.length && props.vision) { e.preventDefault(); void addFiles(files) }
}

const ready = computed(() => props.canSend && !props.busy && (!!text.value.trim() || images.value.length > 0))
function submit() {
  if (!ready.value) return
  emit('send', text.value, images.value)
  text.value = ''
  images.value = []
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit() }
}
</script>

<template>
  <div class="flex flex-col gap-2 border-t border-default p-3">
    <div v-if="images.length" class="flex flex-wrap gap-2">
      <div v-for="(u, i) in images" :key="i" class="relative">
        <img :src="u" :alt="t.chat.message.image" class="size-16 rounded-lg object-cover">
        <button
          type="button"
          class="absolute -right-1.5 -top-1.5 inline-flex size-5 items-center justify-center rounded-full bg-[var(--lw-text)] text-[var(--lw-surface)]"
          :aria-label="C.removeImage"
          @click="images = images.filter((_, k) => k !== i)"
        >
          <UIcon name="i-lucide-x" class="size-3" />
        </button>
      </div>
    </div>
    <div class="flex items-end gap-2">
      <input ref="input" type="file" accept="image/*" multiple class="hidden" @change="onPick">
      <UButton
        color="neutral"
        variant="outline"
        icon="i-lucide-image-plus"
        :disabled="!vision"
        :aria-label="C.attach"
        :title="vision ? C.attach : C.noVision"
        @click="input?.click()"
      />
      <UTextarea
        v-model="text"
        :rows="1"
        :maxrows="8"
        autoresize
        class="min-w-0 flex-1"
        :placeholder="canSend ? C.placeholder : C.emptyHint"
        :aria-label="C.placeholder"
        @keydown="onKey"
        @paste="onPaste"
      />
      <UButton v-if="busy" color="neutral" icon="i-lucide-square" @click="$emit('stop')">
        {{ C.stop }}
      </UButton>
      <UButton v-else color="primary" icon="i-lucide-send" :disabled="!ready" @click="submit">
        {{ C.send }}
      </UButton>
    </div>
    <p v-if="!vision && canSend" class="m-0 text-xs text-dimmed">
      {{ C.noVision }}
    </p>
  </div>
</template>
