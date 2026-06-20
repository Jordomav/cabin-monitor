<script setup>
import { reactive, computed } from 'vue'

// `farm` null → create mode; otherwise edit mode (id is locked). The parent
// owns the API call and passes back busy/error/errors/warnings to display.
const props = defineProps({
  farm: { type: Object, default: null },
  wings: { type: Array, required: true },
  priorityLabels: { type: Object, required: true },
  busy: { type: Boolean, default: false },
  error: { type: String, default: '' },
  errors: { type: Array, default: () => [] },
  warnings: { type: Array, default: () => [] }
})
const emit = defineEmits(['save', 'cancel'])

const isEdit = computed(() => !!props.farm)
const SIDES = ['top', 'bottom', 'left', 'right', 'front', 'back']

const f = reactive({
  id: props.farm?.id ?? '',
  label: props.farm?.label ?? '',
  computer_id: props.farm?.computer_id ?? 0,
  wing: props.farm?.wing ?? props.wings[0]?.id ?? '',
  priority: props.farm?.priority ?? 4,
  high_threshold: props.farm?.high_threshold ?? 90,
  low_threshold: props.farm?.low_threshold ?? 50,
  monitor_side: props.farm?.monitor_side ?? 'top',
  vault_side: props.farm?.vault_side ?? 'left',
  modem_side: props.farm?.modem_side ?? 'right',
  redstone_side: props.farm?.redstone_side ?? 'bottom',
  color: props.farm?.color ?? '',
  report_interval: props.farm?.report_interval ?? 5
})

const priorityOptions = computed(() =>
  [1, 2, 3, 4].map((n) => ({ value: n, label: `${n} — ${props.priorityLabels[n] || ''}` }))
)

function submit() {
  const payload = {
    label: f.label.trim(),
    computer_id: Number(f.computer_id),
    wing: f.wing,
    priority: Number(f.priority),
    high_threshold: Number(f.high_threshold),
    low_threshold: Number(f.low_threshold),
    monitor_side: f.monitor_side,
    vault_side: f.vault_side,
    modem_side: f.modem_side,
    redstone_side: f.redstone_side,
    color: f.color.trim() || null,
    report_interval: Number(f.report_interval)
  }
  if (!isEdit.value) payload.id = f.id.trim()
  emit('save', payload)
}

const field = 'w-full px-3 py-2 rounded-lg bg-base-bg border border-base-line text-sm outline-none focus:border-emerald-500'
const lbl = 'text-xs text-gray-400 mb-1 block'
</script>

<template>
  <form class="space-y-3" @submit.prevent="submit">
    <h3 class="font-semibold">{{ isEdit ? `Edit ${farm.label}` : 'Add farm' }}</h3>

    <div v-if="error" class="text-sm text-red-400 bg-red-900/30 rounded-lg px-3 py-2">
      {{ error }}
      <ul v-if="errors.length > 1" class="list-disc list-inside mt-1 text-xs">
        <li v-for="(e, i) in errors" :key="i">{{ e }}</li>
      </ul>
    </div>
    <div
      v-if="warnings.length"
      class="text-sm text-amber-300 bg-amber-900/30 rounded-lg px-3 py-2"
    >
      <p v-for="(w, i) in warnings" :key="i">⚠️ {{ w }}</p>
    </div>

    <div class="grid grid-cols-2 gap-3">
      <div v-if="!isEdit">
        <label :class="lbl">id (lowercase, a–z0–9_)</label>
        <input v-model="f.id" :class="field" placeholder="cobble" autocomplete="off" />
      </div>
      <div :class="{ 'col-span-2': isEdit }">
        <label :class="lbl">Label</label>
        <input v-model="f.label" :class="field" placeholder="Cobble Farm" />
      </div>

      <div>
        <label :class="lbl">Computer ID</label>
        <input v-model.number="f.computer_id" type="number" min="0" :class="field" />
      </div>
      <div>
        <label :class="lbl">Wing</label>
        <select v-model="f.wing" :class="field">
          <option v-for="w in wings" :key="w.id" :value="w.id">{{ w.label }}</option>
        </select>
      </div>

      <div>
        <label :class="lbl">Priority</label>
        <select v-model.number="f.priority" :class="field">
          <option v-for="o in priorityOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
      </div>
      <div>
        <label :class="lbl">Report interval (s)</label>
        <input v-model.number="f.report_interval" type="number" min="1" :class="field" />
      </div>

      <div>
        <label :class="lbl">Pause at % (high)</label>
        <input v-model.number="f.high_threshold" type="number" min="0" max="100" :class="field" />
      </div>
      <div>
        <label :class="lbl">Resume at % (low)</label>
        <input v-model.number="f.low_threshold" type="number" min="0" max="100" :class="field" />
      </div>

      <div>
        <label :class="lbl">Vault side</label>
        <select v-model="f.vault_side" :class="field">
          <option v-for="s in SIDES" :key="s">{{ s }}</option>
        </select>
      </div>
      <div>
        <label :class="lbl">Redstone side</label>
        <select v-model="f.redstone_side" :class="field">
          <option v-for="s in SIDES" :key="s">{{ s }}</option>
        </select>
      </div>
      <div>
        <label :class="lbl">Monitor side</label>
        <select v-model="f.monitor_side" :class="field">
          <option v-for="s in SIDES" :key="s">{{ s }}</option>
        </select>
      </div>
      <div>
        <label :class="lbl">Modem side</label>
        <select v-model="f.modem_side" :class="field">
          <option v-for="s in SIDES" :key="s">{{ s }}</option>
        </select>
      </div>

      <div class="col-span-2">
        <label :class="lbl">Color (optional)</label>
        <input v-model="f.color" :class="field" placeholder="green" />
      </div>
    </div>

    <p v-if="isEdit" class="text-[11px] text-gray-500">
      Changing a peripheral side takes effect after that computer reboots (Ctrl+R).
    </p>

    <div class="flex gap-2 pt-1">
      <button
        type="button"
        class="flex-1 py-2.5 rounded-lg border border-base-line text-sm text-gray-300 active:bg-base-bg"
        @click="emit('cancel')"
      >
        Cancel
      </button>
      <button
        type="submit"
        :disabled="busy"
        class="flex-1 py-2.5 rounded-lg bg-emerald-600 active:bg-emerald-700 text-sm font-medium text-white disabled:opacity-40"
      >
        {{ busy ? 'Saving…' : isEdit ? 'Save' : 'Create' }}
      </button>
    </div>
  </form>
</template>
