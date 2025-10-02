<template>
  <main>
    <Panel>
      <PanelHead>
        <PanelHeadTitle :text="$t('splitTunneling.createUpstream')" />
      </PanelHead>
      <PanelBody>
        <FormElement @submit.prevent="submit">
          <FormGroup>
            <FormHeading>{{ $t('form.sectionGeneral') }}</FormHeading>
            <FormTextField
              id="name"
              v-model="formData.name"
              :label="$t('general.name')"
              required
            />
            <FormTextField
              id="endpoint"
              v-model="formData.endpoint"
              :label="$t('splitTunneling.endpoint')"
              :description="$t('splitTunneling.endpointDescription')"
              placeholder="example.com:51820"
              required
            />
          </FormGroup>
          <FormGroup>
            <FormHeading>{{ $t('splitTunneling.keys') }}</FormHeading>
            <FormTextField
              id="publicKey"
              v-model="formData.publicKey"
              :label="$t('splitTunneling.upstreamPublicKey')"
              :description="$t('splitTunneling.upstreamPublicKeyDesc')"
              placeholder="Base64 encoded public key (44 characters)"
              required
            />
            <FormTextField
              id="privateKey"
              v-model="formData.privateKey"
              :label="$t('splitTunneling.localPrivateKey')"
              :description="$t('splitTunneling.localPrivateKeyDesc')"
              placeholder="Base64 encoded private key (44 characters)"
              required
            />
            <div class="flex gap-2">
              <button
                type="button"
                @click="generateKeys"
                class="px-3 py-2 bg-gray-200 text-gray-700 rounded-md hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300 text-sm"
              >
                {{ $t('splitTunneling.generateKeys') }}
              </button>
            </div>
            <FormTextField
              id="presharedKey"
              v-model="formData.presharedKey"
              :label="$t('splitTunneling.presharedKey')"
              :description="$t('splitTunneling.presharedKeyDesc')"
              placeholder="Optional"
            />
          </FormGroup>
          <FormGroup>
            <FormHeading>{{ $t('form.sectionAdvanced') }}</FormHeading>
            <FormArrayField
              v-model="formData.allowedIps"
              name="allowedIps"
              :label="$t('general.allowedIps')"
              :description="$t('splitTunneling.allowedIpsDescription')"
            />
            <FormNumberField
              id="persistentKeepalive"
              v-model="formData.persistentKeepalive"
              :label="$t('general.persistentKeepalive')"
              :description="$t('splitTunneling.persistentKeepaliveDesc')"
            />
            <FormNumberField
              id="mtu"
              v-model="formData.mtu"
              :label="$t('general.mtu')"
              :description="$t('splitTunneling.mtuDescription')"
            />
            <FormSwitchField
              id="enabled"
              v-model="formData.enabled"
              :label="$t('general.enabled')"
            />
          </FormGroup>
          <FormGroup>
            <FormHeading>{{ $t('form.actions') }}</FormHeading>
            <FormPrimaryActionField type="submit" :label="$t('form.create')" />
            <FormSecondaryActionField
              :label="$t('form.cancel')"
              @click="navigateTo('/admin/upstream')"
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

const formData = ref({
  name: '',
  endpoint: '',
  publicKey: '',
  privateKey: '',
  presharedKey: '',
  allowedIps: ['0.0.0.0/0'],
  persistentKeepalive: 25,
  mtu: 1360,
  enabled: true,
});

const _submit = useSubmit(
  '/api/upstream',
  {
    method: 'post',
  },
  {
    revert: async (success) => {
      if (success) {
        await navigateTo('/admin/upstream');
      }
    },
  }
);

function submit() {
  return _submit(formData.value);
}

async function generateKeys() {
  if (!confirm('Generate new WireGuard key pair? This will replace the current private key.')) {
    return;
  }

  try {
    // Note: In production, this should call an API endpoint
    // For now, just show a placeholder
    alert('Please generate keys using: wg genkey | tee privatekey | wg pubkey');
  } catch (error) {
    console.error('Failed to generate keys:', error);
  }
}
</script>
