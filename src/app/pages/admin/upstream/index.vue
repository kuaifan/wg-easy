<template>
  <main>
    <Panel>
      <PanelHead>
        <PanelHeadTitle :text="$t('splitTunneling.upstreamServers')" />
        <div class="flex gap-2">
          <NuxtLink to="/admin/upstream/create">
            <button
              class="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
            >
              {{ $t('splitTunneling.addUpstream') }}
            </button>
          </NuxtLink>
        </div>
      </PanelHead>
      <PanelBody>
        <div v-if="upstreams.length > 0" class="overflow-x-auto">
          <table class="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
            <thead class="bg-gray-50 dark:bg-gray-800">
              <tr>
                <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  {{ $t('general.name') }}
                </th>
                <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  {{ $t('splitTunneling.interface') }}
                </th>
                <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  {{ $t('splitTunneling.endpoint') }}
                </th>
                <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  {{ $t('general.status') }}
                </th>
                <th class="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  {{ $t('form.actions') }}
                </th>
              </tr>
            </thead>
            <tbody class="bg-white divide-y divide-gray-200 dark:bg-gray-900 dark:divide-gray-700">
              <tr v-for="upstream in upstreams" :key="upstream.id">
                <td class="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900 dark:text-white">
                  {{ upstream.name }}
                </td>
                <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400 font-mono">
                  {{ upstream.interfaceName }}
                </td>
                <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400 font-mono">
                  {{ upstream.endpoint }}
                </td>
                <td class="px-6 py-4 whitespace-nowrap">
                  <span
                    :class="[
                      'px-2 py-1 text-xs font-medium rounded',
                      upstream.enabled
                        ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
                        : 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300',
                    ]"
                  >
                    {{ upstream.enabled ? $t('general.enabled') : $t('general.disabled') }}
                  </span>
                </td>
                <td class="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                  <div class="flex justify-end gap-2">
                    <button
                      @click="toggleUpstream(upstream.id, !upstream.enabled)"
                      class="text-blue-600 hover:text-blue-900 dark:text-blue-400 dark:hover:text-blue-300"
                    >
                      {{ upstream.enabled ? $t('general.disable') : $t('general.enable') }}
                    </button>
                    <NuxtLink
                      :to="`/admin/upstream/${upstream.id}`"
                      class="text-indigo-600 hover:text-indigo-900 dark:text-indigo-400 dark:hover:text-indigo-300"
                    >
                      {{ $t('form.edit') }}
                    </NuxtLink>
                    <button
                      @click="deleteUpstream(upstream.id)"
                      class="text-red-600 hover:text-red-900 dark:text-red-400 dark:hover:text-red-300"
                    >
                      {{ $t('form.delete') }}
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="text-center py-8 text-gray-500 dark:text-gray-400">
          {{ $t('splitTunneling.noUpstreams') }}
        </div>
      </PanelBody>
    </Panel>
  </main>
</template>

<script lang="ts" setup>
const authStore = useAuthStore();
authStore.update();

const { data, refresh } = await useFetch('/api/upstream', {
  method: 'get',
});

const upstreams = computed(() => data.value?.upstreams || []);

async function toggleUpstream(id: number, enabled: boolean) {
  try {
    await $fetch(`/api/upstream/${id}/toggle`, {
      method: 'post',
      body: { enabled },
    });
    await refresh();
  } catch (error) {
    console.error('Failed to toggle upstream:', error);
    alert('Failed to toggle upstream server.');
  }
}

async function deleteUpstream(id: number) {
  if (!confirm('Are you sure you want to delete this upstream server? This cannot be undone.')) {
    return;
  }

  try {
    await $fetch(`/api/upstream/${id}`, {
      method: 'delete',
    });
    await refresh();
  } catch (error: any) {
    console.error('Failed to delete upstream:', error);
    alert(error?.data?.message || 'Failed to delete upstream server.');
  }
}
</script>
