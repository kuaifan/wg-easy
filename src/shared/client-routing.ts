export type ClientUpstreamConfig = {
  enabled: boolean;
  endpointHost: string | null;
  endpointPort: number | null;
  publicKey: string | null;
  preSharedKey: string | null;
  clientPrivateKey: string | null;
  allowedIps: string[];
  tunnelAddress: string | null;
  persistentKeepalive: number | null;
};

export type ClientSplitTunnelMode = 'direct' | 'upstream' | 'custom';

export type ClientSplitTunnelConfig = {
  mode: ClientSplitTunnelMode;
  proxyDomains: string[];
  proxyCidrs: string[];
  directDomains: string[];
  directCidrs: string[];
};

export function createDefaultUpstreamConfig(): ClientUpstreamConfig {
  return {
    enabled: false,
    endpointHost: null,
    endpointPort: null,
    publicKey: null,
    preSharedKey: null,
    clientPrivateKey: null,
    allowedIps: [],
    tunnelAddress: null,
    persistentKeepalive: null,
  };
}

export function createDefaultSplitTunnelConfig(): ClientSplitTunnelConfig {
  return {
    mode: 'direct',
    proxyDomains: [],
    proxyCidrs: [],
    directDomains: [],
    directCidrs: [],
  };
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed;
}

export function normalizeUpstreamConfig(
  value: ClientUpstreamConfig | null | undefined,
): ClientUpstreamConfig {
  if (!value) {
    return createDefaultUpstreamConfig();
  }

  return {
    ...createDefaultUpstreamConfig(),
    ...value,
    endpointHost: normalizeOptionalString(value.endpointHost),
    publicKey: normalizeOptionalString(value.publicKey),
    preSharedKey: normalizeOptionalString(value.preSharedKey),
    clientPrivateKey: normalizeOptionalString(value.clientPrivateKey),
    tunnelAddress: normalizeOptionalString(value.tunnelAddress),
    allowedIps: Array.isArray(value.allowedIps)
      ? value.allowedIps
          .map((entry) => normalizeOptionalString(entry) ?? '')
          .filter((entry) => entry.length > 0)
      : [],
  };
}

export function normalizeSplitTunnelConfig(
  value: ClientSplitTunnelConfig | null | undefined,
): ClientSplitTunnelConfig {
  if (!value) {
    return createDefaultSplitTunnelConfig();
  }

  const normalizeList = (input: unknown[]) =>
    input
      .map((entry) => normalizeOptionalString(entry) ?? '')
      .filter((entry) => entry.length > 0);

  const mode: ClientSplitTunnelMode =
    value.mode === 'custom' || value.mode === 'upstream' || value.mode === 'direct'
      ? value.mode
      : 'direct';

  return {
    ...createDefaultSplitTunnelConfig(),
    ...value,
    mode,
    proxyDomains: Array.isArray(value.proxyDomains)
      ? normalizeList(value.proxyDomains)
      : [],
    proxyCidrs: Array.isArray(value.proxyCidrs)
      ? normalizeList(value.proxyCidrs)
      : [],
    directDomains: Array.isArray(value.directDomains)
      ? normalizeList(value.directDomains)
      : [],
    directCidrs: Array.isArray(value.directCidrs)
      ? normalizeList(value.directCidrs)
      : [],
  };
}
