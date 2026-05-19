<script setup>
import { reactive } from 'vue'
import { useBaseStore } from '@/stores/baseStore'
import FarmCard from '@/components/FarmCard.vue'

const base = useBaseStore()

// Collapsed state per wing (expanded by default).
const collapsed = reactive({})
const toggle = (id) => (collapsed[id] = !collapsed[id])
</script>

<template>
  <section class="space-y-3">
    <h2 class="text-sm font-semibold text-gray-300 px-1">🏭 FARMS</h2>

    <p v-if="base.configError" class="text-sm text-red-400 px-1">
      {{ base.configError }}
    </p>
    <p v-else-if="!base.farmsConfig" class="text-sm text-gray-500 px-1">
      Loading farm config…
    </p>

    <div
      v-for="wing in base.wings"
      :key="wing.id"
      class="bg-base-card border border-base-line rounded-2xl overflow-hidden"
    >
      <button
        class="w-full flex items-center justify-between px-4 py-2.5 text-sm font-semibold"
        @click="toggle(wing.id)"
      >
        <span>{{ wing.label }}</span>
        <span class="text-gray-500 text-xs">
          {{ base.farmsInWing(wing.id).length }}
          <span class="ml-1">{{ collapsed[wing.id] ? '▸' : '▾' }}</span>
        </span>
      </button>

      <transition name="wing">
        <div v-show="!collapsed[wing.id]" class="px-3 pb-3 space-y-2">
          <FarmCard
            v-for="farm in base.farmsInWing(wing.id)"
            :key="farm.id"
            :farm="farm"
          />
        </div>
      </transition>
    </div>
  </section>
</template>

<style scoped>
.wing-enter-active,
.wing-leave-active {
  transition: opacity 0.15s ease;
}
.wing-enter-from,
.wing-leave-to {
  opacity: 0;
}
</style>
