<template>
  <main v-if="data">
    <Panel>
      <PanelHead>
        <PanelHeadTitle :text="data.name" />
      </PanelHead>
      <PanelBody>
        <FormElement @submit.prevent="submit">
          <FormGroup>
            <FormHeading>
              {{ $t('form.sectionGeneral') }}
            </FormHeading>
            <FormTextField
              id="name"
              v-model="data.name"
              :label="$t('general.name')"
            />
            <FormSwitchField
              id="enabled"
              v-model="data.enabled"
              :label="$t('client.enabled')"
            />
            <FormDateField
              id="expiresAt"
              v-model="data.expiresAt"
              :description="$t('client.expireDateDesc')"
              :label="$t('client.expireDate')"
            />
          </FormGroup>
          <FormGroup>
            <FormHeading>{{ $t('client.address') }}</FormHeading>
            <FormTextField
              id="ipv4Address"
              v-model="data.ipv4Address"
              label="IPv4"
            />
            <FormTextField
              id="ipv6Address"
              v-model="data.ipv6Address"
              label="IPv6"
            />
            <FormInfoField
              id="endpoint"
              :data="data.endpoint ?? $t('client.notConnected')"
              :label="$t('client.endpoint')"
              :description="$t('client.endpointDesc')"
            />
          </FormGroup>
          <FormGroup>
            <FormHeading :description="$t('client.allowedIpsDesc')">
              {{ $t('general.allowedIps') }}
            </FormHeading>
            <FormNullArrayField v-model="data.allowedIps" name="allowedIps" />
          </FormGroup>
          <FormGroup>
            <FormHeading :description="$t('client.serverAllowedIpsDesc')">
              {{ $t('client.serverAllowedIps') }}
            </FormHeading>
            <FormArrayField
              v-model="data.serverAllowedIps"
              name="serverAllowedIps"
            />
          </FormGroup>
          <FormGroup>
            <FormHeading :description="$t('client.upstreamDesc')">
              {{ $t('client.upstream') }}
            </FormHeading>
            <FormSwitchField
              id="upstream-enabled"
              v-model="data.upstream.enabled"
              :label="$t('client.upstreamEnabled')"
            />
            <template v-if="data.upstream.enabled">
              <div class="col-span-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
                <BaseSecondaryButton type="button" @click="triggerUpstreamImport">
                  {{ $t('client.upstreamImport') }}
                </BaseSecondaryButton>
                <p class="text-sm text-gray-500 dark:text-neutral-300">
                  {{ $t('client.upstreamImportDesc') }}
                </p>
                <input
                  ref="upstreamFileInput"
                  type="file"
                  accept=".conf,text/plain"
                  class="hidden"
                  @change="onUpstreamFileChange"
                />
              </div>
              <FormNullTextField
                id="upstream-host"
                v-model="data.upstream.endpointHost"
                :label="$t('client.upstreamEndpoint')"
                :description="$t('client.upstreamEndpointDesc')"
              />
              <FormNumberField
                id="upstream-port"
                v-model="data.upstream.endpointPort"
                :label="$t('client.upstreamPort')"
              />
              <FormNullTextField
                id="upstream-public-key"
                v-model="data.upstream.publicKey"
                :label="$t('client.upstreamPublicKey')"
              />
              <FormNullTextField
                id="upstream-pre-shared-key"
                v-model="data.upstream.preSharedKey"
                :label="$t('client.upstreamPreSharedKey')"
                :description="$t('client.upstreamPreSharedKeyDesc')"
              />
              <FormNullTextField
                id="upstream-client-key"
                v-model="data.upstream.clientPrivateKey"
                :label="$t('client.upstreamClientKey')"
                :description="$t('client.upstreamClientKeyDesc')"
              />
              <div class="col-span-2 grid grid-cols-1 gap-4 sm:grid-cols-2">
                <FormNullTextField
                  id="upstream-tunnel-address"
                  v-model="data.upstream.tunnelAddress"
                  :label="$t('client.upstreamTunnelAddress')"
                  :description="$t('client.upstreamTunnelAddressDesc')"
                />
                <FormNumberField
                  id="upstream-keepalive"
                  v-model="data.upstream.persistentKeepalive"
                  :label="$t('client.upstreamPersistentKeepalive')"
                  :description="$t('client.upstreamPersistentKeepaliveDesc')"
                />
              </div>
              <FormArrayField
                v-model="data.upstream.allowedIps"
                name="upstreamAllowedIps"
                class="col-span-2"
                :label="$t('client.upstreamAllowedIps')"
                :description="$t('client.upstreamAllowedIpsDesc')"
              />
            </template>
          </FormGroup>
          <FormGroup v-if="data?.upstream?.enabled">
            <FormHeading :description="$t('client.splitTunnelDesc')">
              {{ $t('client.splitTunnel') }}
            </FormHeading>
            <FormSelectField
              id="split-tunnel-mode"
              v-model="data.splitTunnel.mode"
              :label="$t('client.splitTunnelMode')"
              :options="splitTunnelModeOptions"
            />
            <template v-if="data.splitTunnel.mode === 'custom'">
              <div
                class="col-span-2 rounded-lg border-2 border-gray-100 bg-gray-50 p-4 text-sm text-gray-600 dark:border-neutral-800 dark:bg-neutral-800/50 dark:text-neutral-200"
              >
                <p class="font-semibold text-gray-800 dark:text-neutral-100">
                  {{ $t('client.splitTunnelModeCustom') }}
                </p>
                <p class="mt-1">{{ $t('client.splitTunnelCustomDesc') }}</p>
              </div>
              <FormTextareaArrayField
                v-model="data.splitTunnel.proxyRules"
                name="splitTunnelProxyRules"
                class="col-span-2"
                :label="$t('client.splitTunnelProxyDomains')"
                :description="$t('client.splitTunnelProxyDomainsDesc')"
                :placeholder="$t('client.splitTunnelProxyDomainsPlaceholder')"
              />
              <FormTextareaArrayField
                v-model="data.splitTunnel.directRules"
                name="splitTunnelDirectRules"
                class="col-span-2"
                :label="$t('client.splitTunnelDirectDomains')"
                :description="$t('client.splitTunnelDirectDomainsDesc')"
                :placeholder="$t('client.splitTunnelDirectDomainsPlaceholder')"
              />
            </template>
          </FormGroup>
          <FormGroup>
            <FormHeading :description="$t('client.dnsDesc')">
              {{ $t('general.dns') }}
            </FormHeading>
            <FormNullArrayField v-model="data.dns" name="dns" />
          </FormGroup>
          <FormGroup>
            <FormHeading>{{ $t('form.sectionAdvanced') }}</FormHeading>
            <FormNumberField
              id="mtu"
              v-model="data.mtu"
              :description="$t('client.mtuDesc')"
              :label="$t('general.mtu')"
            />
            <FormNumberField
              id="persistentKeepalive"
              v-model="data.persistentKeepalive"
              :description="$t('client.persistentKeepaliveDesc')"
              :label="$t('general.persistentKeepalive')"
            />
          </FormGroup>
          <FormGroup>
            <FormHeading :description="$t('client.hooksDescription')">
              {{ $t('client.hooks') }}
            </FormHeading>
            <FormTextField
              id="PreUp"
              v-model="data.preUp"
              :description="$t('client.hooksLeaveEmpty')"
              :label="$t('hooks.preUp')"
            />
            <FormTextField
              id="PostUp"
              v-model="data.postUp"
              :description="$t('client.hooksLeaveEmpty')"
              :label="$t('hooks.postUp')"
            />
            <FormTextField
              id="PreDown"
              v-model="data.preDown"
              :description="$t('client.hooksLeaveEmpty')"
              :label="$t('hooks.preDown')"
            />
            <FormTextField
              id="PostDown"
              v-model="data.postDown"
              :description="$t('client.hooksLeaveEmpty')"
              :label="$t('hooks.postDown')"
            />
          </FormGroup>
          <FormGroup>
            <FormHeading>{{ $t('form.actions') }}</FormHeading>
            <FormPrimaryActionField type="submit" :label="$t('form.save')" />
            <FormSecondaryActionField
              :label="$t('form.revert')"
              @click="revert"
            />
            <ClientsDeleteDialog
              trigger-class="col-span-2"
              :client-name="data.name"
              @delete="deleteClient"
            >
              <FormSecondaryActionField
                label="Delete"
                class="w-full"
                type="button"
                tabindex="-1"
                as="span"
              />
            </ClientsDeleteDialog>
          </FormGroup>
        </FormElement>
      </PanelBody>
    </Panel>
  </main>
</template>

<script lang="ts" setup>
import {
  normalizeSplitTunnelConfig,
  normalizeUpstreamConfig,
} from '#shared/client-routing';
import { parseWireGuardUpstreamConfig } from '#shared/wireguard-import';

const authStore = useAuthStore();
authStore.update();

const route = useRoute();
const id = route.params.id as string;

const { data: _data, refresh } = await useFetch(`/api/client/${id}`, {
  method: 'get',
});

const { t } = useI18n();
const toast = useToast();

const upstreamFileInput = ref<HTMLInputElement | null>(null);

const splitTunnelModeOptions = computed(() => [
  { value: 'direct', label: t('client.splitTunnelModeDirect') },
  { value: 'upstream', label: t('client.splitTunnelModeUpstream') },
  { value: 'custom', label: t('client.splitTunnelModeCustom') },
]);

function applyClientDefaults(client: typeof _data.value) {
  if (!client) {
    return null;
  }

  const clone = structuredClone(client);
  clone.upstream = normalizeUpstreamConfig(clone.upstream);
  clone.splitTunnel = normalizeSplitTunnelConfig(clone.splitTunnel);
  return clone;
}

const data = ref(applyClientDefaults(_data.value));

watch(
  _data,
  (value) => {
    data.value = applyClientDefaults(value);
  },
  { immediate: true }
);

const _submit = useSubmit(
  `/api/client/${id}`,
  {
    method: 'post',
  },
  {
    revert: async (success) => {
      if (success) {
        await navigateTo('/');
      } else {
        await revert();
      }
    },
  }
);

function submit() {
  if (!data.value) {
    return Promise.resolve();
  }
  const payload = {
    ...data.value,
    upstream: normalizeUpstreamConfig(data.value.upstream),
    splitTunnel: normalizeSplitTunnelConfig(data.value.splitTunnel),
  };
  return _submit(payload as never);
}

function triggerUpstreamImport() {
  upstreamFileInput.value?.click();
}

async function onUpstreamFileChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];

  if (!file) {
    return;
  }

  try {
    const text = await file.text();
    const imported = parseWireGuardUpstreamConfig(text);

    if (!data.value) {
      throw new Error('Client data not loaded');
    }

    data.value.upstream = normalizeUpstreamConfig({
      ...data.value.upstream,
      ...imported,
      enabled: true,
    });

    toast.showToast({
      type: 'success',
      message: t('client.upstreamImportSuccess'),
    });
  } catch (error) {
    console.error(error);
    toast.showToast({
      type: 'error',
      message: t('client.upstreamImportFailed'),
    });
  } finally {
    input.value = '';
  }
}

async function revert() {
  await refresh();
  data.value = applyClientDefaults(_data.value);
}

const _deleteClient = useSubmit(
  `/api/client/${id}`,
  {
    method: 'delete',
  },
  {
    revert: async () => {
      await navigateTo('/');
    },
  }
);

function deleteClient() {
  return _deleteClient(undefined);
}
</script>
