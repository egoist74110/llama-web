<script setup lang="ts">
// One enabled model: state, start / stop / retry, profile dropdown, missing-file warning.
import t from '~~/i18n/zh-CN'
import type { StateDoc } from '~~/server/core/live'

const props = defineProps<{ model: StateDoc['models'][number] }>()
const { busy, start, stop, retry, setProfile } = useModelActions()
const { state: live } = useLive()

// Shown state: the current profile's instance, else whatever profile is up.
const shown = computed(() => props.model.instances.find(i => i.profile === props.model.activeProfile) ?? props.model.instances[0] ?? null)
const state = computed(() => shown.value?.state ?? 'stopped')
// Waiting for another model to unload first: no instance yet, but a load is queued.
const queued = computed(() => state.value === 'stopped' && !!live.value?.queue.some(q => q.modelId === props.model.id))
const otherProfile = computed(() => (shown.value && shown.value.profile !== props.model.activeProfile ? shown.value.profile : null))
const missing = computed(() => props.model.missing)
const failed = computed(() => state.value === 'failed' || state.value === 'crashed')
const winding = computed(() => state.value === 'draining' || state.value === 'unloading')
const working = computed(() => !!(busy.value[`start:${props.model.id}`] || busy.value[`stop:${props.model.id}`] || busy.value[`retry:${props.model.id}`]))
</script>

<template>
  <section
    class="rounded-[var(--ui-radius)] border bg-elevated px-5 py-4"
    :class="missing.length ? 'border-error/60' : 'border-default'"
  >
    <div class="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
      <div class="min-w-0 space-y-1">
        <div class="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <StateDot :state="state" />
          <h3 class="text-base font-medium text-highlighted">
            {{ model.name }}
          </h3>
          <UBadge v-if="queued" color="warning" variant="subtle" size="sm">
            {{ t.models.card.queued }}
          </UBadge>
          <StateBadge v-else :state="state" />
        </div>
        <p class="break-all text-xs text-muted" :title="model.files.model">
          {{ model.files.model }}
        </p>
        <div class="flex flex-wrap items-center gap-1.5 pt-0.5">
          <UBadge :color="model.hasMmproj ? 'primary' : 'neutral'" variant="subtle" size="sm" icon="i-lucide-image">
            {{ model.hasMmproj ? t.models.card.mmproj : t.models.card.mmprojNone }}
          </UBadge>
          <UBadge v-if="model.files.draft" color="neutral" variant="subtle" size="sm">
            {{ t.models.card.draft }}
          </UBadge>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <div class="flex items-center gap-2" :title="t.models.card.profileHint">
          <span class="text-xs text-muted">{{ t.models.card.profile }}</span>
          <USelect
            :model-value="model.activeProfile"
            :items="model.profiles"
            size="sm"
            class="w-32"
            :disabled="!!busy[`profile:${model.id}`]"
            :aria-label="t.models.card.profile"
            @update:model-value="(p: string) => setProfile(model.id, p)"
          />
        </div>
        <UButton
          v-if="state === 'stopped' && !queued"
          size="sm"
          icon="i-lucide-play"
          :disabled="missing.length > 0"
          :loading="working"
          @click="start(model.id)"
        >
          {{ t.models.card.start }}
        </UButton>
        <UButton
          v-if="failed"
          size="sm"
          icon="i-lucide-rotate-cw"
          :disabled="missing.length > 0"
          :loading="working"
          @click="retry(model.id, shown?.profile)"
        >
          {{ t.models.card.retry }}
        </UButton>
        <UButton
          v-if="state !== 'stopped' || queued"
          size="sm"
          color="neutral"
          variant="outline"
          icon="i-lucide-square"
          :disabled="winding"
          :loading="working || winding"
          @click="stop(model.id)"
        >
          {{ winding ? t.models.card.stopping : t.models.card.stop }}
        </UButton>
      </div>
    </div>

    <UProgress v-if="state === 'loading'" size="xs" class="mt-3" />
    <p v-if="otherProfile" class="mt-2 text-xs text-muted">
      {{ fmt(t.models.card.runningProfile, { profile: otherProfile }) }}
    </p>
    <p v-if="shown?.error" class="mt-2 text-sm text-error">
      {{ reasonText(shown.error) }}
    </p>
    <div v-if="missing.length" class="mt-3 rounded-lg bg-error/10 px-3 py-2 text-sm text-error">
      <p class="font-medium">
        {{ t.models.card.missingTitle }}
      </p>
      <ul class="mt-0.5 list-disc pl-5">
        <li v-for="m in missing" :key="m">
          {{ t.models.card.missing[m] }}
        </li>
      </ul>
      <p class="mt-1 text-xs opacity-80">
        {{ t.models.card.missingHint }}
      </p>
    </div>
  </section>
</template>
