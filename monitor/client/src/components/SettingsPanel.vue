<script setup>
import { usePushNotifications } from '@/composables/usePushNotifications'

defineEmits(['close'])

const push = usePushNotifications()

const TYPE_LABELS = {
  power: 'Power alerts (warning / critical / restored)',
  farm_offline: 'Farm goes offline',
  vault_full: 'Vault full (98%+)'
}
</script>

<template>
  <Teleport to="body">
    <div
      class="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60"
      @click.self="$emit('close')"
    >
      <div
        class="w-full sm:max-w-sm bg-base-card border border-base-line
               rounded-t-2xl sm:rounded-2xl p-5 space-y-4"
      >
        <div class="flex items-center justify-between">
          <h3 class="font-semibold">⚙️ Notifications</h3>
          <button class="text-gray-400 text-sm" @click="$emit('close')">Done</button>
        </div>

        <p v-if="!push.supported.value" class="text-sm text-amber-400">
          This browser doesn’t support push notifications.
        </p>

        <template v-else>
          <button
            v-if="!push.subscribed.value"
            :disabled="push.busy.value"
            class="w-full py-2.5 rounded-lg bg-emerald-600 text-white text-sm
                   font-medium disabled:opacity-50"
            @click="push.enable()"
          >
            {{ push.busy.value ? 'Enabling…' : 'Enable Notifications' }}
          </button>
          <button
            v-else
            :disabled="push.busy.value"
            class="w-full py-2.5 rounded-lg border border-base-line text-sm
                   text-gray-300 disabled:opacity-50"
            @click="push.disable()"
          >
            Disable Notifications
          </button>

          <p v-if="push.error.value" class="text-sm text-red-400">
            {{ push.error.value }}
          </p>
          <p
            v-if="push.permission.value === 'denied'"
            class="text-xs text-gray-500"
          >
            Permission is blocked — re-enable it in your browser site settings.
          </p>

          <div class="space-y-2 pt-2 border-t border-base-line">
            <label
              v-for="t in push.alertTypes"
              :key="t"
              class="flex items-center justify-between gap-3 text-sm"
              :class="{ 'opacity-40': !push.subscribed.value }"
            >
              <span>{{ TYPE_LABELS[t] }}</span>
              <input
                type="checkbox"
                class="h-5 w-5 accent-emerald-500"
                :checked="push.prefs.value[t]"
                :disabled="!push.subscribed.value"
                @change="push.setPref(t, $event.target.checked)"
              />
            </label>
          </div>
        </template>
      </div>
    </div>
  </Teleport>
</template>
