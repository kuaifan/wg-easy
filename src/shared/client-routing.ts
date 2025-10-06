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
  proxyRules: string[];
  directRules: string[];
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
    proxyRules: [],
    directRules: [],
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

  const normalizeList = (input: unknown[]) => {
    if (!Array.isArray(input)) {
      return [];
    }

    const normalized: string[] = [];

    for (const entry of input) {
      if (typeof entry !== 'string') {
        continue;
      }

      normalized.push(entry.replace(/\r?\n/g, '\n'));
    }

    const isBoundaryBlank = (value: string) => value.trim().length === 0;

    let start = 0;
    let end = normalized.length;

    while (start < end && isBoundaryBlank(normalized[start])) {
      start += 1;
    }

    while (end > start && isBoundaryBlank(normalized[end - 1])) {
      end -= 1;
    }

    return normalized.slice(start, end);
  };

  const mode: ClientSplitTunnelMode =
    value.mode === 'custom' || value.mode === 'upstream' || value.mode === 'direct'
      ? value.mode
      : 'direct';

  const {
    proxyRules: currentProxyRules,
    directRules: currentDirectRules,
    proxyDomains,
    proxyCidrs,
    directDomains,
    directCidrs,
    ...rest
  } = (value ?? {}) as Partial<ClientSplitTunnelConfig> & {
    proxyDomains?: unknown[];
    proxyCidrs?: unknown[];
    directDomains?: unknown[];
    directCidrs?: unknown[];
  };

  const legacyProxyRules = [
    ...(Array.isArray(proxyDomains) ? proxyDomains : []),
    ...(Array.isArray(proxyCidrs) ? proxyCidrs : []),
  ];

  const legacyDirectRules = [
    ...(Array.isArray(directDomains) ? directDomains : []),
    ...(Array.isArray(directCidrs) ? directCidrs : []),
  ];

  const proxyRules = Array.isArray(currentProxyRules)
    ? normalizeList(currentProxyRules)
    : legacyProxyRules.length > 0
      ? normalizeList(legacyProxyRules)
      : [];

  const directRules = Array.isArray(currentDirectRules)
    ? normalizeList(currentDirectRules)
    : legacyDirectRules.length > 0
      ? normalizeList(legacyDirectRules)
      : [];

  return {
    ...createDefaultSplitTunnelConfig(),
    ...rest,
    mode,
    proxyRules,
    directRules,
  };
}
