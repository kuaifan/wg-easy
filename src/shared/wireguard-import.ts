import type { ClientUpstreamConfig } from './client-routing';

type SectionName = 'interface' | 'peer' | null;

type ParsedConfig = {
  interface: Record<string, string>;
  peers: Record<string, string>[];
};

export type WireGuardUpstreamImport = Pick<
  ClientUpstreamConfig,
  | 'endpointHost'
  | 'endpointPort'
  | 'publicKey'
  | 'preSharedKey'
  | 'clientPrivateKey'
  | 'allowedIps'
  | 'tunnelAddress'
  | 'persistentKeepalive'
>;

export function parseWireGuardUpstreamConfig(
  content: string,
): WireGuardUpstreamImport {
  const parsed = parseConfig(content);

  if (Object.keys(parsed.interface).length === 0) {
    throw new Error('Missing [Interface] section');
  }
  if (parsed.peers.length === 0) {
    throw new Error('Missing [Peer] section');
  }

  const iface = parsed.interface;
  const peer = parsed.peers[0];

  const clientPrivateKey = normalizeString(iface.privatekey);
  if (!clientPrivateKey) {
    throw new Error('Missing PrivateKey in [Interface] section');
  }

  const publicKey = normalizeString(peer.publickey);
  if (!publicKey) {
    throw new Error('Missing PublicKey in [Peer] section');
  }

  const endpoint = normalizeString(peer.endpoint);
  if (!endpoint) {
    throw new Error('Missing Endpoint in [Peer] section');
  }

  const { host: endpointHost, port: endpointPort } = parseEndpoint(endpoint);
  if (!endpointHost || !endpointPort) {
    throw new Error('Endpoint must include host and port');
  }

  const tunnelAddress = extractFirstValue(iface.address);

  return {
    endpointHost,
    endpointPort,
    publicKey,
    preSharedKey:
      normalizeString(peer.presharedkey ?? peer.psk ?? peer.sharedkey) ?? null,
    clientPrivateKey,
    allowedIps: extractList(peer.allowedips),
    tunnelAddress,
    persistentKeepalive: parseInteger(peer.persistentkeepalive),
  };
}

function parseConfig(content: string): ParsedConfig {
  const result: ParsedConfig = {
    interface: {},
    peers: [],
  };

  let currentSection: SectionName = null;

  const lines = content.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }

    if (line.startsWith('#') || line.startsWith(';')) {
      continue;
    }

    if (line.startsWith('[') && line.endsWith(']')) {
      const name = line.slice(1, -1).trim().toLowerCase();
      if (name === 'interface') {
        currentSection = 'interface';
      } else if (name === 'peer') {
        currentSection = 'peer';
        result.peers.push({});
      } else {
        currentSection = null;
      }
      continue;
    }

    const eqIndex = line.indexOf('=');
    if (eqIndex === -1 || !currentSection) {
      continue;
    }

    const rawKey = line.slice(0, eqIndex).trim();
    const rawValue = line.slice(eqIndex + 1).trim();

    if (rawKey.length === 0) {
      continue;
    }

    const key = normalizeKey(rawKey);
    const value = stripInlineComment(rawValue);

    if (currentSection === 'interface') {
      result.interface[key] = value;
    } else if (currentSection === 'peer') {
      const target = result.peers[result.peers.length - 1];
      target[key] = value;
    }
  }

  return result;
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[\s_-]+/g, '');
}

function stripInlineComment(value: string): string {
  const match = value.match(/^(.*?)(?:\s*[#;].*)?$/);
  if (!match) {
    return value.trim();
  }
  return match[1].trim();
}

function normalizeString(value: string | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function extractList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function extractFirstValue(value: string | undefined): string | null {
  const first = extractList(value)[0];
  return normalizeString(first ?? undefined);
}

function parseInteger(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return parsed;
}

function parseEndpoint(endpoint: string): { host: string | null; port: number | null } {
  let host: string | null = null;
  let port: number | null = null;

  let value = endpoint.trim();
  if (value.length === 0) {
    return { host, port };
  }

  if (value.startsWith('[')) {
    const closingIndex = value.indexOf(']');
    if (closingIndex !== -1) {
      host = value.slice(1, closingIndex).trim();
      const remainder = value.slice(closingIndex + 1).trim();
      if (remainder.startsWith(':')) {
        port = parsePort(remainder.slice(1));
      }
    } else {
      host = value;
    }
  } else {
    const lastColon = value.lastIndexOf(':');
    if (lastColon === -1) {
      host = value;
    } else {
      host = value.slice(0, lastColon).trim();
      port = parsePort(value.slice(lastColon + 1));
    }
  }

  if (host && host.length === 0) {
    host = null;
  }

  return { host, port };
}

function parsePort(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (Number.isNaN(parsed) || parsed < 1 || parsed > 65535) {
    return null;
  }
  return parsed;
}
