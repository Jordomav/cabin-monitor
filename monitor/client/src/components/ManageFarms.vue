<script setup>
import { ref, computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useBaseStore } from '@/stores/baseStore'
import ConfirmModal from '@/components/ConfirmModal.vue'
import FarmEditForm from '@/components/FarmEditForm.vue'

defineEmits(['close'])
const base = useBaseStore()
const { farmsConfig } = storeToRefs(base)

// 'list' = overview; 'form' = create/edit a farm.
const mode = ref('list')
const editingFarm = ref(null) // null in form mode → create
const busy = ref(false)
const formError = ref('')
const formErrors = ref([])
const formWarnings = ref([])
const banner = ref('') // transient success / warning line on the list view

const wings = computed(() => farmsConfig.value?.wings || [])
const priorityLabels = computed(() => farmsConfig.value?.priority_labels || {})
const farmsByWing = (wingId) =>
  (farmsConfig.value?.farms || []).filter((f) => f.wing === wingId)
const orphanFarms = computed(() =>
  (farmsConfig.value?.farms || []).filter(
    (f) => !wings.value.some((w) => w.id === f.wing)
  )
)

function openCreate() {
  editingFarm.value = null
  resetFormState()
  mode.value = 'form'
}
function openEdit(farm) {
  editingFarm.value = farm
  resetFormState()
  mode.value = 'form'
}
function resetFormState() {
  formError.value = ''
  formErrors.value = []
  formWarnings.value = []
}

async function saveFarm(payload) {
  busy.value = true
  const res = editingFarm.value
    ? await base.updateFarm(editingFarm.value.id, payload)
    : await base.createFarm(payload)
  busy.value = false
  if (!res.ok) {
    formError.value = res.error
    formErrors.value = res.errors
    return
  }
  banner.value = res.warnings.length
    ? '⚠️ ' + res.warnings.join(' ')
    : editingFarm.value
      ? 'Farm updated.'
      : 'Farm created.'
  mode.value = 'list'
}

// --- Delete farm -----------------------------------------------------------
const confirmDeleteFarm = ref(null)
async function doDeleteFarm() {
  const id = confirmDeleteFarm.value.id
  confirmDeleteFarm.value = null
  const res = await base.deleteFarm(id)
  banner.value = res.ok ? 'Farm deleted.' : res.error
}

// --- Wings -----------------------------------------------------------------
const newWing = ref({ id: '', label: '', color: '' })
const wingError = ref('')
async function addWing() {
  wingError.value = ''
  const res = await base.createWing({
    id: newWing.value.id.trim(),
    label: newWing.value.label.trim(),
    color: newWing.value.color.trim() || null
  })
  if (res.ok) newWing.value = { id: '', label: '', color: '' }
  else wingError.value = res.error
}
const confirmDeleteWing = ref(null)
async function doDeleteWing() {
  const id = confirmDeleteWing.value.id
  confirmDeleteWing.value = null
  const res = await base.deleteWing(id)
  if (!res.ok) wingError.value = res.error
}

// --- Central computer id ---------------------------------------------------
const centralId = ref(0)
const centralMsg = ref('')
function syncCentral() {
  centralId.value = farmsConfig.value?.central_computer_id ?? 0
}
syncCentral()
async function saveCentral() {
  centralMsg.value = ''
  const res = await base.updateCentralId(Number(centralId.value))
  centralMsg.value = res.ok ? 'Saved.' : res.error
}

const card = 'bg-base-card border border-base-line rounded-xl'
</script>

<template>
  <Teleport to="body">
    <div class="fixed inset-0 z-50 flex flex-col bg-base-bg">
      <header
        class="sticky top-0 flex items-center justify-between px-4 py-3 border-b border-base-line bg-base-bg"
        style="padding-top: calc(0.75rem + env(safe-area-inset-top))"
      >
        <button
          v-if="mode === 'form'"
          class="text-sm text-gray-400 active:text-gray-200"
          @click="mode = 'list'"
        >
          ‹ Back
        </button>
        <h2 class="font-semibold">🛠 Manage Farms</h2>
        <button class="text-sm text-gray-400 active:text-gray-200" @click="$emit('close')">
          Done
        </button>
      </header>

      <main class="flex-1 overflow-y-auto px-4 py-4 max-w-md w-full mx-auto space-y-4">
        <p v-if="!farmsConfig" class="text-sm text-gray-500">Loading…</p>

        <!-- FORM MODE -->
        <div v-else-if="mode === 'form'" :class="card" class="p-4">
          <FarmEditForm
            :farm="editingFarm"
            :wings="wings"
            :priority-labels="priorityLabels"
            :busy="busy"
            :error="formError"
            :errors="formErrors"
            :warnings="formWarnings"
            @save="saveFarm"
            @cancel="mode = 'list'"
          />
        </div>

        <!-- LIST MODE -->
        <template v-else>
          <p
            v-if="banner"
            class="text-sm text-emerald-300 bg-emerald-900/30 rounded-lg px-3 py-2"
          >
            {{ banner }}
          </p>

          <button
            class="w-full py-2.5 rounded-lg bg-emerald-600 active:bg-emerald-700 text-sm font-medium text-white"
            @click="openCreate"
          >
            + Add farm
          </button>

          <section v-for="wing in wings" :key="wing.id" :class="card" class="overflow-hidden">
            <div class="flex items-center justify-between px-4 py-2.5 border-b border-base-line">
              <span class="text-sm font-semibold">{{ wing.label }}</span>
              <button
                class="text-xs text-red-400/80 active:text-red-300"
                @click="confirmDeleteWing = wing"
              >
                Delete wing
              </button>
            </div>
            <div class="divide-y divide-base-line">
              <div
                v-for="farm in farmsByWing(wing.id)"
                :key="farm.id"
                class="flex items-center justify-between px-4 py-2.5"
              >
                <div class="min-w-0">
                  <p class="text-sm truncate">{{ farm.label }}</p>
                  <p class="text-[11px] text-gray-500">
                    id: {{ farm.id }} · computer #{{ farm.computer_id }} · P{{ farm.priority }}
                  </p>
                </div>
                <div class="flex gap-2 shrink-0">
                  <button
                    class="text-xs px-2.5 py-1 rounded-lg border border-base-line active:bg-base-bg"
                    @click="openEdit(farm)"
                  >
                    Edit
                  </button>
                  <button
                    class="text-xs px-2.5 py-1 rounded-lg border border-base-line text-red-400 active:bg-base-bg"
                    @click="confirmDeleteFarm = farm"
                  >
                    Delete
                  </button>
                </div>
              </div>
              <p
                v-if="!farmsByWing(wing.id).length"
                class="px-4 py-2.5 text-xs text-gray-500"
              >
                No farms in this wing.
              </p>
            </div>
          </section>

          <p v-if="orphanFarms.length" class="text-xs text-amber-400">
            {{ orphanFarms.length }} farm(s) reference a missing wing.
          </p>

          <!-- Add wing -->
          <section :class="card" class="p-4 space-y-2">
            <h3 class="text-sm font-semibold">Add wing</h3>
            <div class="grid grid-cols-3 gap-2">
              <input
                v-model="newWing.id"
                placeholder="id"
                class="px-2 py-2 rounded-lg bg-base-bg border border-base-line text-sm outline-none"
              />
              <input
                v-model="newWing.label"
                placeholder="Label"
                class="px-2 py-2 rounded-lg bg-base-bg border border-base-line text-sm outline-none"
              />
              <input
                v-model="newWing.color"
                placeholder="color"
                class="px-2 py-2 rounded-lg bg-base-bg border border-base-line text-sm outline-none"
              />
            </div>
            <p v-if="wingError" class="text-xs text-red-400">{{ wingError }}</p>
            <button
              class="w-full py-2 rounded-lg border border-base-line text-sm active:bg-base-bg"
              @click="addWing"
            >
              Add wing
            </button>
          </section>

          <!-- Central computer id -->
          <section :class="card" class="p-4 space-y-2">
            <h3 class="text-sm font-semibold">Central computer ID</h3>
            <div class="flex gap-2">
              <input
                v-model.number="centralId"
                type="number"
                min="0"
                class="flex-1 px-3 py-2 rounded-lg bg-base-bg border border-base-line text-sm outline-none"
              />
              <button
                class="px-4 rounded-lg border border-base-line text-sm active:bg-base-bg"
                @click="saveCentral"
              >
                Save
              </button>
            </div>
            <p v-if="centralMsg" class="text-xs text-gray-400">{{ centralMsg }}</p>
          </section>
        </template>
      </main>
    </div>

    <ConfirmModal
      v-if="confirmDeleteFarm"
      :title="`Delete ${confirmDeleteFarm.label}?`"
      body="Removes this farm from the database. The farm computer keeps running until it can no longer find itself in the config."
      confirm-label="Delete"
      danger
      @confirm="doDeleteFarm"
      @cancel="confirmDeleteFarm = null"
    />
    <ConfirmModal
      v-if="confirmDeleteWing"
      :title="`Delete wing ${confirmDeleteWing.label}?`"
      body="Only allowed if no farms reference it."
      confirm-label="Delete"
      danger
      @confirm="doDeleteWing"
      @cancel="confirmDeleteWing = null"
    />
  </Teleport>
</template>
