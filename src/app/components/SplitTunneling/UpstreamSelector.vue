<template>
  <div class="space-y-3">
    <select
      :value="modelValue"
      @change="handleChange"
      class="w-full px-3 py-2 border rounded-md bg-white dark:bg-gray-800 dark:border-gray-600"
      :required="required"
    >
      <option :value="null" v-if="!required">
        {{ $t('splitTunneling.noUpstream') }}
      </option>
      <option
        v-for="upstream in upstreamOptions"
        :key="upstream.id"
        :value="upstream.id"
      >
        {{ upstream.name }} ({{ upstream.interfaceName }})
        {{ upstream.enabled ? '' : ' - ' + $t('general.disabled') }}
      </option>
    </select>

    <div v-if="upstreamOptions.length === 0" class="text-amber-600 dark:text-amber-400 text-sm">
      ⚠️ {{ $t('splitTunneling.noUpstreamsAvailable') }}
      <NuxtLink to="/admin/upstream" class="underline hover:text-amber-700">
        {{ $t('splitTunneling.createUpstream') }}
      </NuxtLink>
    </div>
  </div>
</template>

<script lang="ts" setup>
const props = defineProps<{
  modelValue: number | null;
  required?: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: number | null): void;
}>();

// Fetch upstream servers
const { data: upstreamsData } = await useFetch('/api/upstream', {
  method: 'get',
});

const upstreamOptions = computed(() => {
  return upstreamsData.value?.upstreams || [];
});

function handleChange(event: Event) {
  const target = event.target as HTMLSelectElement;
  const value = target.value === '' || target.value === 'null' ? null : Number(target.value);
  emit('update:modelValue', value);
}
</script>
