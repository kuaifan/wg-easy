<template>
  <main v-if="data">
    <Panel>
      <PanelHead>
        <PanelHeadTitle :text="data.name" />
      </PanelHead>
      <PanelBody>
        <FormElement @submit.prevent="submit">
          <FormGroup>
            <FormHeading>{{ $t('form.sectionGeneral') }}</FormHeading>
            <FormTextField
              id="name"
              v-model="data.name"
              :label="$t('general.name')"
            />
            <FormTextField
              id="endpoint"
              v-model="data.endpoint"
              :label="$t('splitTunneling.endpoint')"
              :description="$t('splitTunneling.endpointDescription')"
            />
            <FormSwitchField
              id="enabled"
              v-model="data.enabled"
              :label="$t('general.enabled')"
            />
          </FormGroup>
          <FormGroup>
            <FormHeading>{{ $t('splitTunneling.keys') }}</FormHeading>
            <FormInfoField
              id="interfaceName"
              :data="data.interfaceName"
              :label="$t('splitTunneling.interface')"
              :description="$t('splitTunneling.interfaceDescription')"
            />
            <FormTextField
              id="publicKey"
              v-model="data.publicKey"
              :label="$t('splitTunneling.upstreamPublicKey')"
            />
            <FormInfoField
              id="hasPrivateKey"
              :data="data.hasPrivateKey ? $t('general.yes') : $t('general.no')"
              :label="$t('splitTunneling.hasPrivateKey')"
              :description="$t('splitTunneling.privateKeyNotShown')"
            />
          </FormGroup>
          <FormGroup>
            <FormHeading>{{ $t('form.sectionAdvanced') }}</FormHeading>
            <FormArrayField
              v-model="data.allowedIps"
              name="allowedIps"
              :label="$t('general.allowedIps')"
            />
            <FormNumberField
              id="persistentKeepalive"
              v-model="data.persistentKeepalive"
              :label="$t('general.persistentKeepalive')"
            />
            <FormNumberField
              id="mtu"
              v-model="data.mtu"
              :label="$t('general.mtu')"
            />
          </FormGroup>
          <FormGroup>
            <FormHeading>{{ $t('form.actions') }}</FormHeading>
            <FormPrimaryActionField type="submit" :label="$t('form.save')" />
            <FormSecondaryActionField
              :label="$t('form.revert')"
              @click="revert"
            />
            <FormSecondaryActionField
              :label="$t('form.delete')"
              @click="deleteUpstream"
              class="text-red-600 hover:text-red-700"
            />
          </FormGroup>
        </FormElement>
      </PanelBody>
    </Panel>
  </main>
</template>

<script lang="ts" setup>
const authStore = useAuthStore();
authStore.update();

const route = useRoute();
const id = route.params.id as string;

const { data: _data, refresh } = await useFetch(`/api/upstream/${id}`, {
  method: 'get',
});
const data = toRef(_data.value?.upstream);

const _submit = useSubmit(
  `/api/upstream/${id}`,
  {
    method: 'post',
  },
  {
    revert: async (success) => {
      if (success) {
        await navigateTo('/admin/upstream');
      } else {
        await revert();
      }
    },
  }
);

function submit() {
  return _submit(data.value);
}

async function revert() {
  await refresh();
  data.value = toRef(_data.value?.upstream).value;
}

async function deleteUpstream() {
  if (!confirm('Are you sure you want to delete this upstream server? This cannot be undone.')) {
    return;
  }

  try {
    await $fetch(`/api/upstream/${id}`, {
      method: 'delete',
    });
    await navigateTo('/admin/upstream');
  } catch (error: any) {
    alert(error?.data?.message || 'Failed to delete upstream server.');
  }
}
</script>
