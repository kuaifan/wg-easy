<template>
  <div class="space-y-4">
    <!-- Rules List -->
    <div v-if="rules.length > 0" class="space-y-2">
      <div
        v-for="rule in rules"
        :key="rule.id"
        class="flex items-center gap-3 p-3 rounded-lg bg-gray-50 dark:bg-gray-800"
      >
        <div class="flex-1">
          <div class="flex items-center gap-2">
            <span
              :class="[
                'px-2 py-1 text-xs font-medium rounded',
                rule.ruleType === 'domain'
                  ? 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200'
                  : 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
              ]"
            >
              {{ rule.ruleType.toUpperCase() }}
            </span>
            <span
              :class="[
                'px-2 py-1 text-xs font-medium rounded',
                rule.action === 'proxy'
                  ? 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200'
                  : 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200',
              ]"
            >
              {{ rule.action.toUpperCase() }}
            </span>
          </div>
          <div class="mt-1 font-mono text-sm">
            {{ rule.ruleValue }}
          </div>
        </div>

        <div class="flex items-center gap-2">
          <button
            type="button"
            @click="toggleRule(rule.id, !rule.enabled)"
            :class="[
              'px-3 py-1 text-sm rounded transition-colors',
              rule.enabled
                ? 'bg-green-500 text-white hover:bg-green-600'
                : 'bg-gray-300 text-gray-700 hover:bg-gray-400 dark:bg-gray-600 dark:text-gray-300',
            ]"
          >
            {{ rule.enabled ? $t('splitTunneling.enabled') : $t('splitTunneling.disabled') }}
          </button>

          <button
            type="button"
            @click="deleteRule(rule.id)"
            class="px-3 py-1 text-sm bg-red-500 text-white rounded hover:bg-red-600 transition-colors"
          >
            {{ $t('form.delete') }}
          </button>
        </div>
      </div>
    </div>

    <div v-else class="text-gray-500 dark:text-gray-400 text-sm text-center py-4">
      {{ $t('splitTunneling.noRules') }}
    </div>

    <!-- Add Rule Form -->
    <form
      @submit.prevent="addRule"
      class="p-4 rounded-lg bg-blue-50 dark:bg-blue-900/20"
    >
      <h4 class="text-sm font-semibold mb-3">
        {{ $t('splitTunneling.addNewRule') }}
      </h4>

      <div class="grid grid-cols-1 md:grid-cols-4 gap-3">
        <div>
          <label class="block text-xs font-medium mb-1">
            {{ $t('splitTunneling.ruleType') }}
          </label>
          <select
            v-model="newRule.ruleType"
            class="w-full px-3 py-2 border rounded-md bg-white dark:bg-gray-800 dark:border-gray-600"
            required
          >
            <option value="domain">{{ $t('splitTunneling.domain') }}</option>
            <option value="ip">{{ $t('splitTunneling.ipCidr') }}</option>
          </select>
        </div>

        <div class="md:col-span-2">
          <label class="block text-xs font-medium mb-1">
            {{ $t('splitTunneling.value') }}
          </label>
          <input
            v-model="newRule.ruleValue"
            type="text"
            :placeholder="
              newRule.ruleType === 'domain'
                ? 'google.com or *.google.com'
                : '8.8.8.8 or 8.8.8.0/24'
            "
            class="w-full px-3 py-2 border rounded-md bg-white dark:bg-gray-800 dark:border-gray-600"
            required
          />
        </div>

        <div>
          <label class="block text-xs font-medium mb-1">
            {{ $t('splitTunneling.action') }}
          </label>
          <select
            v-model="newRule.action"
            class="w-full px-3 py-2 border rounded-md bg-white dark:bg-gray-800 dark:border-gray-600"
            required
          >
            <option value="proxy">{{ $t('splitTunneling.proxy') }}</option>
            <option value="direct">{{ $t('splitTunneling.direct') }}</option>
          </select>
        </div>
      </div>

      <div class="mt-3 flex gap-2">
        <button
          type="submit"
          :disabled="isSubmitting"
          class="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          {{ isSubmitting ? $t('splitTunneling.adding') : $t('splitTunneling.addRule') }}
        </button>

        <button
          type="button"
          @click="resetForm"
          class="px-4 py-2 bg-gray-200 text-gray-700 rounded-md hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300 transition-colors"
        >
          {{ $t('form.reset') }}
        </button>
      </div>
    </form>
  </div>
</template>

<script lang="ts" setup>
const props = defineProps<{
  clientId: number;
}>();

const emit = defineEmits<{
  (e: 'rules-changed'): void;
}>();

// Fetch rules
const { data: rulesData, refresh } = await useFetch(
  `/api/splitRule/${props.clientId}`,
  { method: 'get' }
);

const rules = computed(() => rulesData.value?.rules || []);

// New rule form
const newRule = ref<{
  ruleType: 'domain' | 'ip';
  ruleValue: string;
  action: 'proxy' | 'direct';
}>({
  ruleType: 'domain',
  ruleValue: '',
  action: 'proxy',
});

const isSubmitting = ref(false);

// Add rule
async function addRule() {
  isSubmitting.value = true;

  try {
    await $fetch(`/api/splitRule/${props.clientId}`, {
      method: 'post',
      body: newRule.value,
    });

    resetForm();
    await refresh();
    emit('rules-changed');
  } catch (error) {
    console.error('Failed to add rule:', error);
    alert('Failed to add rule. Please check the format and try again.');
  } finally {
    isSubmitting.value = false;
  }
}

// Delete rule
async function deleteRule(ruleId: number) {
  if (!confirm('Are you sure you want to delete this rule?')) {
    return;
  }

  try {
    await $fetch(`/api/splitRule/${props.clientId}/${ruleId}`, {
      method: 'delete',
    });

    await refresh();
    emit('rules-changed');
  } catch (error) {
    console.error('Failed to delete rule:', error);
    alert('Failed to delete rule.');
  }
}

// Toggle rule
async function toggleRule(ruleId: number, enabled: boolean) {
  try {
    await $fetch(`/api/splitRule/${props.clientId}/${ruleId}`, {
      method: 'post',
      body: { enabled },
    });

    await refresh();
    emit('rules-changed');
  } catch (error) {
    console.error('Failed to toggle rule:', error);
    alert('Failed to toggle rule.');
  }
}

// Reset form
function resetForm() {
  newRule.value = {
    ruleType: 'domain',
    ruleValue: '',
    action: 'proxy',
  };
}
</script>
