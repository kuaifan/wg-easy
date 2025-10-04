import fs from 'node:fs/promises';
import path from 'node:path';
import debug from 'debug';

import type { ClientType } from '#db/repositories/client/types';
import { exec } from './cmd';

const ROUTING_DEBUG = debug('ClientRouting');

const STATE_DIR = '/var/lib/wg-easy';
const STATE_FILE = path.join(STATE_DIR, 'client-routing.json');
const UPSTREAM_CONFIG_DIR = '/etc/wireguard/upstreams';

const ROUTING_TABLE_BASE = 60000;
const ROUTING_PRIORITY_BASE = 1000;
const ROUTING_MARK_BASE = 0xc000;

const IPV4_REGEX = /^(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?$/;

function ensureArray<T>(value: T[] | null | undefined): T[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value;
}

type StoredClientState = {
  id: number;
  mark: number;
  table: number;
  upstreamInterface: string | null;
  upstreamConfigPath: string | null;
  ipv4Address: string;
  ipv6Address: string;
  chain4: string | null;
  chain6: string | null;
  proxySet4: string | null;
  proxySet6: string | null;
  directSet4: string | null;
  directSet6: string | null;
};

type RoutingState = {
  clients: Record<string, StoredClientState>;
};

function serializeState(state: RoutingState) {
  return JSON.stringify(state, null, 2);
}

async function readState(): Promise<RoutingState> {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf8');
    return JSON.parse(raw) as RoutingState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      ROUTING_DEBUG('Failed to read routing state: %o', error);
    }
    return { clients: {} };
  }
}

async function writeState(state: RoutingState) {
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(STATE_FILE, serializeState(state), { mode: 0o600 });
}

async function run(cmd: string) {
  try {
    await exec(cmd);
  } catch (error) {
    ROUTING_DEBUG('Command failed "%s": %o', cmd, error);
  }
}

function toRoutingMark(clientId: number) {
  return ROUTING_MARK_BASE + clientId;
}

function toRoutingTable(clientId: number) {
  return ROUTING_TABLE_BASE + clientId;
}

function toRoutingPriority(clientId: number) {
  return ROUTING_PRIORITY_BASE + clientId;
}

function createUpstreamInterfaceName(clientId: number) {
  return `wg-up-${clientId}`;
}

function createUpstreamConfigPath(clientId: number) {
  return path.join(UPSTREAM_CONFIG_DIR, `${createUpstreamInterfaceName(clientId)}.conf`);
}

function splitAllowedIps(allowedIps: string[]) {
  const ipv4: string[] = [];
  const ipv6: string[] = [];
  for (const entry of allowedIps) {
    if (!entry) {
      continue;
    }
    if (entry.includes(':')) {
      ipv6.push(entry);
    } else {
      ipv4.push(entry);
    }
  }
  return { ipv4, ipv6 };
}

async function resolveDomain(domain: string) {
  const result = { ipv4: new Set<string>(), ipv6: new Set<string>() };
  const output = await exec(`getent ahosts ${domain} || true`);
  if (!output) {
    return result;
  }
  const lines = output.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [address] = trimmed.split(/\s+/);
    if (!address) continue;
    if (address.includes(':')) {
      result.ipv6.add(address);
    } else {
      result.ipv4.add(address);
    }
  }
  return result;
}

export class ClientRoutingManager {
  async sync(clients: ClientType[]) {
    if (process.platform !== 'linux') {
      return;
    }

    await fs.mkdir(STATE_DIR, { recursive: true });
    await fs.mkdir(UPSTREAM_CONFIG_DIR, { recursive: true });

    const previous = await readState();
    const nextState: RoutingState = { clients: {} };
    const activeIds = new Set(clients.map((client) => client.id));

    for (const [id, stored] of Object.entries(previous.clients)) {
      const numericId = Number.parseInt(id, 10);
      if (!activeIds.has(numericId)) {
        await this.#teardownClient(stored);
      }
    }

    for (const client of clients) {
      const context = await this.#applyClient(client);
      nextState.clients[String(client.id)] = context;
    }

    await writeState(nextState);
  }

  async #applyClient(
    client: ClientType,
  ): Promise<StoredClientState> {
    const mark = toRoutingMark(client.id);
    const table = toRoutingTable(client.id);
    const priority = toRoutingPriority(client.id);
    const upstreamInterface = createUpstreamInterfaceName(client.id);
    const upstreamConfigPath = createUpstreamConfigPath(client.id);

    let chain4: string | null = null;
    let chain6: string | null = null;
    let proxySet4: string | null = null;
    let proxySet6: string | null = null;
    let directSet4: string | null = null;
    let directSet6: string | null = null;

    if (client.upstream?.enabled) {
      const valid =
        !!client.upstream.endpointHost &&
        !!client.upstream.endpointPort &&
        !!client.upstream.publicKey &&
        !!client.upstream.clientPrivateKey &&
        !!client.upstream.tunnelAddress;

      if (!valid) {
        ROUTING_DEBUG(
          'Skipping upstream interface for client %d due to incomplete configuration',
          client.id,
        );
        await this.#teardownUpstream(
          upstreamInterface,
          upstreamConfigPath,
          mark,
          table,
          priority,
        );
      } else {
        await this.#ensureUpstreamInterface(client, upstreamConfigPath);
        await this.#ensurePolicyRouting({
          client,
          mark,
          table,
          priority,
          upstreamInterface,
        });
        await this.#ensureMasquerade(upstreamInterface);
      }
    } else {
      await this.#teardownUpstream(upstreamInterface, upstreamConfigPath, mark, table, priority);
    }

    if (client.upstream?.enabled) {
      const splitTunnel = client.splitTunnel ?? {
        mode: 'direct',
        proxyCidrs: [],
        proxyDomains: [],
        directCidrs: [],
        directDomains: [],
      };

      const shouldProcessSplitTunnel = splitTunnel.mode !== 'direct';

      if (shouldProcessSplitTunnel) {
        const v4ChainName = `WG-EASY-CL-${client.id}`;
        const v6ChainName = `WG-EASY-CL6-${client.id}`;

        const ipsetPrefix = `wg-easy-client-${client.id}`;
        const proxySet4Name = `${ipsetPrefix}-proxy4`;
        const proxySet6Name = `${ipsetPrefix}-proxy6`;
        const directSet4Name = `${ipsetPrefix}-direct4`;
        const directSet6Name = `${ipsetPrefix}-direct6`;

        if (splitTunnel.mode === 'upstream') {
          await this.#configureMarkAllChain({
            family: 'inet',
            clientAddress: client.ipv4Address,
            chainName: v4ChainName,
            mark,
          });
          await this.#configureMarkAllChain({
            family: 'inet6',
            clientAddress: client.ipv6Address,
            chainName: v6ChainName,
            mark,
          });
          chain4 = v4ChainName;
          chain6 = v6ChainName;
          proxySet4 = null;
          proxySet6 = null;
          directSet4 = null;
          directSet6 = null;
        } else {
          const proxyTargets = await this.#buildProxyTargets(splitTunnel);
          ({ proxySet4, proxySet6, directSet4, directSet6 } = await this.#configureSelectiveChains({
            client,
            mark,
            proxySet4Name,
            proxySet6Name,
            directSet4Name,
            directSet6Name,
            chain4Name: v4ChainName,
            chain6Name: v6ChainName,
            proxyTargets,
          }));
          if (proxySet4 || directSet4) {
            chain4 = v4ChainName;
          }
          if (proxySet6 || directSet6) {
            chain6 = v6ChainName;
          }
        }
      } else {
        await this.#flushChains(client);
        await this.#destroyIpSets(client);
      }
    } else {
      await this.#flushChains(client);
      await this.#destroyIpSets(client);
    }

    return {
      id: client.id,
      mark,
      table,
      upstreamInterface: client.upstream?.enabled ? upstreamInterface : null,
      upstreamConfigPath: client.upstream?.enabled ? upstreamConfigPath : null,
      ipv4Address: client.ipv4Address,
      ipv6Address: client.ipv6Address,
      chain4,
      chain6,
      proxySet4,
      proxySet6,
      directSet4,
      directSet6,
    };
  }

  async #ensureUpstreamInterface(client: ClientType, configPath: string) {
    const upstream = client.upstream!;
    const allowedIps = ensureArray(upstream.allowedIps);
    const normalizedAllowedIps = allowedIps.length
      ? allowedIps
      : ['0.0.0.0/0', '::/0'];

    const configLines = [
      '[Interface]',
      `PrivateKey = ${upstream.clientPrivateKey}`,
    ];

    if (upstream.tunnelAddress) {
      configLines.push(`Address = ${upstream.tunnelAddress}`);
    }

    configLines.push('Table = off');

    configLines.push('', '[Peer]');
    configLines.push(`PublicKey = ${upstream.publicKey}`);
    if (upstream.preSharedKey) {
      configLines.push(`PresharedKey = ${upstream.preSharedKey}`);
    }
    configLines.push(`AllowedIPs = ${normalizedAllowedIps.join(', ')}`);
    configLines.push(
      `Endpoint = ${upstream.endpointHost}:${upstream.endpointPort}`,
    );
    if (upstream.persistentKeepalive) {
      configLines.push(
        `PersistentKeepalive = ${upstream.persistentKeepalive}`,
      );
    }

    await fs.mkdir(UPSTREAM_CONFIG_DIR, { recursive: true });
    await fs.writeFile(configPath, `${configLines.join('\n')}`.trim() + '\n', {
      mode: 0o600,
    });

    await run(`wg-quick down ${configPath} >/dev/null 2>&1 || true`);
    await run(`wg-quick up ${configPath}`);
  }

  async #ensurePolicyRouting({
    client,
    mark,
    table,
    priority,
    upstreamInterface,
  }: {
    client: ClientType;
    mark: number;
    table: number;
    priority: number;
    upstreamInterface: string;
  }) {
    await run(`ip rule delete fwmark ${mark} table ${table} priority ${priority} 2>/dev/null || true`);
    await run(`ip rule add fwmark ${mark} table ${table} priority ${priority}`);
    await run(`ip -6 rule delete fwmark ${mark} table ${table} priority ${priority} 2>/dev/null || true`);
    await run(`ip -6 rule add fwmark ${mark} table ${table} priority ${priority}`);

    await run(`ip route flush table ${table} 2>/dev/null || true`);
    await run(`ip -6 route flush table ${table} 2>/dev/null || true`);

    const upstream = client.upstream!;
    const allowedIps = ensureArray(upstream.allowedIps);
    const normalizedAllowedIps = allowedIps.length
      ? allowedIps
      : ['0.0.0.0/0', '::/0'];
    const { ipv4, ipv6 } = splitAllowedIps(normalizedAllowedIps);

    for (const network of ipv4) {
      await run(`ip route replace table ${table} ${network} dev ${upstreamInterface}`);
    }

    for (const network of ipv6) {
      await run(`ip -6 route replace table ${table} ${network} dev ${upstreamInterface}`);
    }
  }

  async #ensureMasquerade(interfaceName: string) {
    await run(`iptables -t nat -D POSTROUTING -o ${interfaceName} -j MASQUERADE 2>/dev/null || true`);
    await run(`iptables -t nat -A POSTROUTING -o ${interfaceName} -j MASQUERADE`);
  }

  async #configureMarkAllChain({
    family,
    clientAddress,
    chainName,
    mark,
  }: {
    family: 'inet' | 'inet6';
    clientAddress: string;
    chainName: string;
    mark: number;
  }) {
    const iptables = family === 'inet' ? 'iptables' : 'ip6tables';

    await run(`${iptables} -t mangle -N ${chainName} 2>/dev/null || true`);
    await run(`${iptables} -t mangle -F ${chainName}`);
    await run(
      `${iptables} -t mangle -D PREROUTING -s ${clientAddress} -j ${chainName} 2>/dev/null || true`,
    );
    await run(`${iptables} -t mangle -A PREROUTING -s ${clientAddress} -j ${chainName}`);
    await run(
      `${iptables} -t mangle -A ${chainName} -j MARK --set-mark ${mark}`,
    );
  }

  async #buildProxyTargets(
    splitTunnel: NonNullable<ClientType['splitTunnel']>,
  ) {
    const proxyTargets = {
      ipv4Proxy: new Set<string>(),
      ipv6Proxy: new Set<string>(),
      ipv4Direct: new Set<string>(),
      ipv6Direct: new Set<string>(),
    };

    for (const cidr of ensureArray(splitTunnel.proxyCidrs)) {
      if (cidr.includes(':')) {
        proxyTargets.ipv6Proxy.add(cidr);
      } else if (IPV4_REGEX.test(cidr)) {
        proxyTargets.ipv4Proxy.add(cidr);
      }
    }

    for (const cidr of ensureArray(splitTunnel.directCidrs)) {
      if (cidr.includes(':')) {
        proxyTargets.ipv6Direct.add(cidr);
      } else if (IPV4_REGEX.test(cidr)) {
        proxyTargets.ipv4Direct.add(cidr);
      }
    }

    for (const domain of ensureArray(splitTunnel.proxyDomains)) {
      const resolved = await resolveDomain(domain);
      resolved.ipv4.forEach((entry) => proxyTargets.ipv4Proxy.add(`${entry}/32`));
      resolved.ipv6.forEach((entry) => proxyTargets.ipv6Proxy.add(`${entry}/128`));
    }

    for (const domain of ensureArray(splitTunnel.directDomains)) {
      const resolved = await resolveDomain(domain);
      resolved.ipv4.forEach((entry) => proxyTargets.ipv4Direct.add(`${entry}/32`));
      resolved.ipv6.forEach((entry) => proxyTargets.ipv6Direct.add(`${entry}/128`));
    }

    return proxyTargets;
  }

  async #configureSelectiveChains({
    client,
    mark,
    proxySet4Name,
    proxySet6Name,
    directSet4Name,
    directSet6Name,
    chain4Name,
    chain6Name,
    proxyTargets,
  }: {
    client: ClientType;
    mark: number;
    proxySet4Name: string;
    proxySet6Name: string;
    directSet4Name: string;
    directSet6Name: string;
    chain4Name: string;
    chain6Name: string;
    proxyTargets: Awaited<ReturnType<typeof this.#buildProxyTargets>>;
  }) {
    const result = {
      proxySet4: null as string | null,
      proxySet6: null as string | null,
      directSet4: null as string | null,
      directSet6: null as string | null,
    };

    await this.#configureSelectiveChain({
      iptables: 'iptables',
      clientAddress: client.ipv4Address,
      chainName: chain4Name,
      proxySetName: proxyTargets.ipv4Proxy.size > 0 ? proxySet4Name : null,
      directSetName: proxyTargets.ipv4Direct.size > 0 ? directSet4Name : null,
      mark,
      proxyEntries: proxyTargets.ipv4Proxy,
      directEntries: proxyTargets.ipv4Direct,
      family: 'inet',
    });

    await this.#configureSelectiveChain({
      iptables: 'ip6tables',
      clientAddress: client.ipv6Address,
      chainName: chain6Name,
      proxySetName: proxyTargets.ipv6Proxy.size > 0 ? proxySet6Name : null,
      directSetName: proxyTargets.ipv6Direct.size > 0 ? directSet6Name : null,
      mark,
      proxyEntries: proxyTargets.ipv6Proxy,
      directEntries: proxyTargets.ipv6Direct,
      family: 'inet6',
    });

    if (proxyTargets.ipv4Proxy.size > 0) {
      result.proxySet4 = proxySet4Name;
    }
    if (proxyTargets.ipv6Proxy.size > 0) {
      result.proxySet6 = proxySet6Name;
    }
    if (proxyTargets.ipv4Direct.size > 0) {
      result.directSet4 = directSet4Name;
    }
    if (proxyTargets.ipv6Direct.size > 0) {
      result.directSet6 = directSet6Name;
    }

    return result;
  }

  async #configureSelectiveChain({
    iptables,
    clientAddress,
    chainName,
    proxySetName,
    directSetName,
    mark,
    proxyEntries,
    directEntries,
    family,
  }: {
    iptables: 'iptables' | 'ip6tables';
    clientAddress: string;
    chainName: string;
    proxySetName: string | null;
    directSetName: string | null;
    mark: number;
    proxyEntries: Set<string>;
    directEntries: Set<string>;
    family: 'inet' | 'inet6';
  }) {
    if (!proxySetName && !directSetName) {
      await run(`${iptables} -t mangle -D PREROUTING -s ${clientAddress} -j ${chainName} 2>/dev/null || true`);
      await run(`${iptables} -t mangle -F ${chainName} 2>/dev/null || true`);
      await run(`${iptables} -t mangle -X ${chainName} 2>/dev/null || true`);
      return;
    }

    await run(`${iptables} -t mangle -N ${chainName} 2>/dev/null || true`);
    await run(`${iptables} -t mangle -F ${chainName}`);
    await run(`${iptables} -t mangle -D PREROUTING -s ${clientAddress} -j ${chainName} 2>/dev/null || true`);
    await run(`${iptables} -t mangle -A PREROUTING -s ${clientAddress} -j ${chainName}`);

    if (directSetName) {
      await this.#syncIpSet({ name: directSetName, family, entries: directEntries });
      await run(
        `${iptables} -t mangle -A ${chainName} -m set --match-set ${directSetName} dst -j RETURN`,
      );
    } else {
      await this.#destroyIpSetByName(directSetName);
    }

    if (proxySetName) {
      await this.#syncIpSet({ name: proxySetName, family, entries: proxyEntries });
      await run(
        `${iptables} -t mangle -A ${chainName} -m set --match-set ${proxySetName} dst -j MARK --set-mark ${mark}`,
      );
    } else {
      await this.#destroyIpSetByName(proxySetName);
    }
  }

  async #syncIpSet({
    name,
    family,
    entries,
  }: {
    name: string;
    family: 'inet' | 'inet6';
    entries: Set<string>;
  }) {
    await run(`ipset create ${name} hash:net family ${family} -exist`);
    await run(`ipset flush ${name}`);
    for (const entry of entries) {
      await run(`ipset add ${name} ${entry}`);
    }
  }

  async #destroyIpSetByName(name: string | null) {
    if (!name) return;
    await run(`ipset destroy ${name} 2>/dev/null || true`);
  }

  async #flushChains(client: ClientType) {
    const chain4 = `WG-EASY-CL-${client.id}`;
    const chain6 = `WG-EASY-CL6-${client.id}`;
    await run(`iptables -t mangle -D PREROUTING -s ${client.ipv4Address} -j ${chain4} 2>/dev/null || true`);
    await run(`iptables -t mangle -F ${chain4} 2>/dev/null || true`);
    await run(`iptables -t mangle -X ${chain4} 2>/dev/null || true`);
    await run(`ip6tables -t mangle -D PREROUTING -s ${client.ipv6Address} -j ${chain6} 2>/dev/null || true`);
    await run(`ip6tables -t mangle -F ${chain6} 2>/dev/null || true`);
    await run(`ip6tables -t mangle -X ${chain6} 2>/dev/null || true`);
  }

  async #destroyIpSets(client: ClientType) {
    const prefix = `wg-easy-client-${client.id}`;
    await this.#destroyIpSetByName(`${prefix}-proxy4`);
    await this.#destroyIpSetByName(`${prefix}-proxy6`);
    await this.#destroyIpSetByName(`${prefix}-direct4`);
    await this.#destroyIpSetByName(`${prefix}-direct6`);
  }

  async #teardownUpstream(
    ifaceName: string,
    configPath: string,
    mark: number,
    table: number,
    priority: number,
  ) {
    await run(`wg-quick down ${configPath} >/dev/null 2>&1 || true`);
    await run(`iptables -t nat -D POSTROUTING -o ${ifaceName} -j MASQUERADE 2>/dev/null || true`);
    await run(`ip rule delete fwmark ${mark} table ${table} priority ${priority} 2>/dev/null || true`);
    await run(`ip -6 rule delete fwmark ${mark} table ${table} priority ${priority} 2>/dev/null || true`);
    await run(`ip route flush table ${table} 2>/dev/null || true`);
    await run(`ip -6 route flush table ${table} 2>/dev/null || true`);
    try {
      await fs.unlink(configPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        ROUTING_DEBUG('Failed to remove upstream config %s: %o', configPath, error);
      }
    }
  }

  async #teardownClient(state: StoredClientState) {
    await this.#teardownUpstream(
      state.upstreamInterface ?? createUpstreamInterfaceName(state.id),
      state.upstreamConfigPath ?? createUpstreamConfigPath(state.id),
      state.mark,
      state.table,
      toRoutingPriority(state.id),
    );

    await run(
      `iptables -t mangle -D PREROUTING -s ${state.ipv4Address} -j WG-EASY-CL-${state.id} 2>/dev/null || true`,
    );
    await run(`iptables -t mangle -F WG-EASY-CL-${state.id} 2>/dev/null || true`);
    await run(`iptables -t mangle -X WG-EASY-CL-${state.id} 2>/dev/null || true`);
    await run(
      `ip6tables -t mangle -D PREROUTING -s ${state.ipv6Address} -j WG-EASY-CL6-${state.id} 2>/dev/null || true`,
    );
    await run(`ip6tables -t mangle -F WG-EASY-CL6-${state.id} 2>/dev/null || true`);
    await run(`ip6tables -t mangle -X WG-EASY-CL6-${state.id} 2>/dev/null || true`);

    await this.#destroyIpSetByName(state.proxySet4);
    await this.#destroyIpSetByName(state.proxySet6);
    await this.#destroyIpSetByName(state.directSet4);
    await this.#destroyIpSetByName(state.directSet6);
  }
}
