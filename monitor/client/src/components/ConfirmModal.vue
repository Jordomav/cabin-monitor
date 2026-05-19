<script setup>
import { ref, computed, watch } from 'vue'

// Controlled by the parent: render with v-if when there's a pending action.
const props = defineProps({
  title: { type: String, required: true },
  body: { type: String, default: '' },
  confirmLabel: { type: String, default: 'Confirm' },
  // When set, the user must type this exact string to enable Confirm
  // (used for "Shutdown All" → type CONFIRM).
  requireText: { type: String, default: null },
  danger: { type: Boolean, default: false }
})
const emit = defineEmits(['confirm', 'cancel'])

const typed = ref('')
watch(
  () => props.title,
  () => (typed.value = '')
)

const canConfirm = computed(
  () => !props.requireText || typed.value === props.requireText
)
</script>

<template>
  <Teleport to="body">
    <div
      class="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/60"
      @click.self="emit('cancel')"
    >
      <div class="w-full max-w-xs bg-base-card border border-base-line rounded-2xl p-5">
        <h3 class="font-semibold" :class="danger ? 'text-red-400' : 'text-gray-100'">
          {{ title }}
        </h3>
        <p v-if="body" class="text-sm text-gray-400 mt-2">{{ body }}</p>

        <div v-if="requireText" class="mt-3">
          <p class="text-xs text-gray-500 mb-1">
            Type <span class="font-mono text-gray-300">{{ requireText }}</span> to confirm
          </p>
          <input
            v-model="typed"
            type="text"
            autocomplete="off"
            class="w-full px-3 py-2 rounded-lg bg-base-bg border border-base-line
                   text-sm outline-none focus:border-red-500"
            @keyup.enter="canConfirm && emit('confirm')"
          />
        </div>

        <div class="flex gap-2 mt-4">
          <button
            class="flex-1 py-2.5 rounded-lg border border-base-line text-sm
                   text-gray-300 active:bg-base-bg"
            @click="emit('cancel')"
          >
            Cancel
          </button>
          <button
            :disabled="!canConfirm"
            class="flex-1 py-2.5 rounded-lg text-sm font-medium text-white
                   disabled:opacity-40"
            :class="danger ? 'bg-red-600 active:bg-red-700' : 'bg-emerald-600 active:bg-emerald-700'"
            @click="emit('confirm')"
          >
            {{ confirmLabel }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
