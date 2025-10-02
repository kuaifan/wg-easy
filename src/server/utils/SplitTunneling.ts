import fs from 'node:fs/promises';
import debug from 'debug';
import type { ClientType } from '#db/repositories/client/types';
import type { UpstreamServerType } from '#db/repositories/upstream/types';
import type { SplitRuleType } from '#db/repositories/splitRule/types';

const ST_DEBUG = debug('SplitTunneling');

interface ClientConfig {
  client: ClientType;
  upstream: UpstreamServerType;
  rules: SplitRuleType[];
}

class SplitTunneling {
  private readonly RT_TABLES_FILE = '/etc/iproute2/rt_tables';
  private readonly DNSMASQ_CONF_DIR = '/etc/dnsmasq.d';
  private readonly DNSMASQ_CONF_FILE = `${this.DNSMASQ_CONF_DIR}/split-tunneling.conf`;
  private readonly DNSMASQ_MAIN_CONF = '/etc/dnsmasq.conf';

  /**
   * Initialize split tunneling system
   */
  async initialize() {
    ST_DEBUG('Initializing Split Tunneling...');

    try {
      // Create dnsmasq config directory
      await exec(`mkdir -p ${this.DNSMASQ_CONF_DIR}`).catch(() => {});

      // Ensure dnsmasq main config exists
      await this.ensureDnsmasqMainConfig();

      // Ensure routing tables are configured
      await this.ensureRouteTables();

      // Enable IP forwarding and other kernel parameters
      await this.ensureKernelParameters();

      ST_DEBUG('Split Tunneling initialized successfully.');
    } catch (err) {
      ST_DEBUG('Failed to initialize Split Tunneling:', err);
      throw err;
    }
  }

  /**
   * Ensure dnsmasq main configuration exists
   */
  private async ensureDnsmasqMainConfig() {
    try {
      await fs.access(this.DNSMASQ_MAIN_CONF);
      ST_DEBUG('dnsmasq.conf already exists');
    } catch {
      ST_DEBUG('Creating dnsmasq.conf...');
      const config = `# dnsmasq configuration for wg-easy split tunneling
no-resolv
server=1.1.1.1
server=8.8.8.8
cache-size=1000
conf-dir=${this.DNSMASQ_CONF_DIR}/,*.conf
`;
      await fs.writeFile(this.DNSMASQ_MAIN_CONF, config);
      ST_DEBUG('dnsmasq.conf created');
    }
  }

  /**
   * Ensure routing tables are configured
   */
  private async ensureRouteTables() {
    try {
      const content = await fs.readFile(this.RT_TABLES_FILE, 'utf-8');
      const lines = content.split('\n');
      const existingTables = new Set(
        lines
          .filter((l) => !l.startsWith('#') && l.trim())
          .map((l) => l.split(/\s+/)[0])
      );

      // Add client routing tables (100-199)
      const newLines: string[] = [];
      for (let i = 100; i < 200; i++) {
        if (!existingTables.has(String(i))) {
          newLines.push(`${i} client_${i - 99}`);
        }
      }

      if (newLines.length > 0) {
        await fs.appendFile(
          this.RT_TABLES_FILE,
          '\n# wg-easy split tunneling tables\n' + newLines.join('\n') + '\n'
        );
        ST_DEBUG(`Added ${newLines.length} routing tables`);
      }
    } catch (err) {
      ST_DEBUG('Error ensuring route tables:', err);
    }
  }

  /**
   * Ensure kernel parameters are set
   */
  private async ensureKernelParameters() {
    const params = [
      'net.ipv4.ip_forward=1',
      'net.ipv4.conf.all.src_valid_mark=1',
      'net.ipv4.conf.all.rp_filter=2',
      'net.ipv4.conf.default.rp_filter=2',
    ];

    for (const param of params) {
      await exec(`sysctl -w ${param}`).catch((err) => {
        ST_DEBUG(`Failed to set ${param}:`, err);
      });
    }
  }

  /**
   * Apply all split tunneling configurations
   */
  async applyAllConfigs() {
    ST_DEBUG('Applying all split tunneling configs...');

    try {
      // 1. Clean up old configurations
      await this.cleanup();

      // 2. Get all data
      const clients = await Database.clients.getAll();
      const upstreams = await Database.upstreams.getAll();

      // 3. Start upstream interfaces
      for (const upstream of upstreams) {
        if (upstream.enabled) {
          await this.startUpstreamInterface(upstream);
        }
      }

      // 4. Configure each client
      const activeConfigs: ClientConfig[] = [];

      for (const client of clients) {
        if (!client.enabled || !client.upstreamEnabled || !client.upstreamId) {
          continue;
        }

        const upstream = upstreams.find((u) => u.id === client.upstreamId);
        if (!upstream || !upstream.enabled) {
          ST_DEBUG(
            `Client ${client.id}: upstream not found or disabled`
          );
          continue;
        }

        const rules = await Database.splitRules.getByClientId(client.id);

        activeConfigs.push({ client, upstream, rules });
        await this.applyClientConfig({ client, upstream, rules });
      }

      // 5. Generate dnsmasq configuration
      await this.generateDnsmasqConfig(activeConfigs);
      await this.reloadDnsmasq();

      ST_DEBUG(
        `All configs applied successfully. Active clients: ${activeConfigs.length}`
      );
    } catch (err) {
      ST_DEBUG('Error applying configs:', err);
      throw err;
    }
  }

  /**
   * Start upstream WireGuard interface
   */
  async startUpstreamInterface(upstream: UpstreamServerType) {
    ST_DEBUG(`Starting upstream interface ${upstream.interfaceName}...`);

    const config = this.generateUpstreamConfig(upstream);
    const confPath = `/etc/wireguard/${upstream.interfaceName}.conf`;

    await fs.writeFile(confPath, config, { mode: 0o600 });

    try {
      // Try to stop first (if exists)
      await exec(`wg-quick down ${upstream.interfaceName}`).catch(() => {});

      // Start interface
      await exec(`wg-quick up ${upstream.interfaceName}`);

      ST_DEBUG(
        `Upstream interface ${upstream.interfaceName} started successfully.`
      );
    } catch (err) {
      ST_DEBUG(`Failed to start ${upstream.interfaceName}:`, err);
      throw new Error(
        `Failed to start upstream interface: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Generate upstream interface WireGuard configuration
   */
  private generateUpstreamConfig(upstream: UpstreamServerType): string {
    const lines = [
      '# Auto-generated by wg-easy split tunneling',
      '# Do not edit manually',
      '',
      '[Interface]',
      `PrivateKey = ${upstream.privateKey}`,
      `MTU = ${upstream.mtu}`,
      '',
      '[Peer]',
      `PublicKey = ${upstream.publicKey}`,
    ];

    if (upstream.presharedKey) {
      lines.push(`PresharedKey = ${upstream.presharedKey}`);
    }

    lines.push(
      `Endpoint = ${upstream.endpoint}`,
      `AllowedIPs = ${upstream.allowedIps.join(', ')}`,
      `PersistentKeepalive = ${upstream.persistentKeepalive}`,
      ''
    );

    return lines.join('\n');
  }

  /**
   * Apply configuration for a single client
   */
  private async applyClientConfig({ client, upstream, rules }: ClientConfig) {
    const clientId = client.id;
    const clientIp = client.ipv4Address;
    const ipsetName = `client_${clientId}_proxy`;
    const fwmark = 100 + clientId;
    const routeTable = 100 + clientId;

    ST_DEBUG(`Configuring client ${clientId} (${clientIp})...`);

    try {
      // 1. Create ipset
      await exec(`ipset create ${ipsetName} hash:ip timeout 3600 -exist`);
      await exec(`ipset flush ${ipsetName}`);

      // 2. Add IP rules to ipset
      const ipRules = rules.filter(
        (r) => r.enabled && r.ruleType === 'ip' && r.action === 'proxy'
      );

      for (const rule of ipRules) {
        try {
          await exec(`ipset add ${ipsetName} ${rule.ruleValue} -exist`);
          ST_DEBUG(`  Added IP rule: ${rule.ruleValue}`);
        } catch (err) {
          ST_DEBUG(`  Failed to add IP rule ${rule.ruleValue}:`, err);
        }
      }

      // 3. Configure iptables marking
      await exec(
        `iptables -t mangle -A PREROUTING ` +
          `-s ${clientIp} ` +
          `-m set --match-set ${ipsetName} dst ` +
          `-j MARK --set-mark ${fwmark} ` +
          `-m comment --comment "wg-easy-split-client-${clientId}"`
      );

      // 4. Configure policy routing
      await exec(
        `ip rule add fwmark ${fwmark} table ${routeTable} prio ${1000 + clientId}`
      );

      await exec(
        `ip route add default dev ${upstream.interfaceName} table ${routeTable}`
      );

      // 5. Enable reverse path filtering
      await exec(
        `sysctl -w net.ipv4.conf.${upstream.interfaceName}.rp_filter=2`
      ).catch(() => {});

      ST_DEBUG(
        `Client ${clientId} configured: ` +
          `${ipRules.length} IP rules, ` +
          `upstream=${upstream.interfaceName}`
      );
    } catch (err) {
      ST_DEBUG(`Error configuring client ${clientId}:`, err);
      throw err;
    }
  }

  /**
   * Generate dnsmasq configuration
   */
  private async generateDnsmasqConfig(configs: ClientConfig[]) {
    ST_DEBUG('Generating dnsmasq configuration...');

    const lines = [
      '# Auto-generated by wg-easy split tunneling',
      '# Do not edit manually',
      '# Last updated: ' + new Date().toISOString(),
      '',
    ];

    for (const { client, rules } of configs) {
      const clientId = client.id;
      const ipsetName = `client_${clientId}_proxy`;

      const domainRules = rules.filter(
        (r) => r.enabled && r.ruleType === 'domain' && r.action === 'proxy'
      );

      if (domainRules.length === 0) {
        continue;
      }

      lines.push(`# Client: ${client.name} (ID=${clientId})`);

      for (const rule of domainRules) {
        const domain = rule.ruleValue;
        // dnsmasq ipset syntax: ipset=/domain/ipset_name
        lines.push(`ipset=/${domain}/${ipsetName}`);
      }

      lines.push('');
    }

    await fs.writeFile(this.DNSMASQ_CONF_FILE, lines.join('\n'));

    ST_DEBUG(
      `dnsmasq config generated: ${configs.length} clients, ` +
        `${configs.reduce((sum, c) => sum + c.rules.filter((r) => r.ruleType === 'domain').length, 0)} domain rules`
    );
  }

  /**
   * Reload dnsmasq configuration
   */
  private async reloadDnsmasq() {
    ST_DEBUG('Reloading dnsmasq...');

    try {
      // Send HUP signal to reload config
      await exec('killall -HUP dnsmasq');
      ST_DEBUG('dnsmasq reloaded successfully.');
    } catch (err) {
      ST_DEBUG('Failed to reload dnsmasq:', err);
      // Try to start dnsmasq
      try {
        await exec('dnsmasq');
        ST_DEBUG('dnsmasq started.');
      } catch (startErr) {
        ST_DEBUG('Failed to start dnsmasq:', startErr);
      }
    }
  }

  /**
   * Stop upstream interface
   */
  async stopUpstreamInterface(interfaceName: string) {
    ST_DEBUG(`Stopping upstream interface ${interfaceName}...`);

    try {
      await exec(`wg-quick down ${interfaceName}`);
      ST_DEBUG(`Upstream interface ${interfaceName} stopped.`);
    } catch (err) {
      ST_DEBUG(`Failed to stop ${interfaceName}:`, err);
    }
  }

  /**
   * Clean up single client configuration
   */
  async cleanupClientConfig(clientId: number) {
    ST_DEBUG(`Cleaning up client ${clientId} config...`);

    const ipsetName = `client_${clientId}_proxy`;
    const fwmark = 100 + clientId;
    const routeTable = 100 + clientId;

    // Delete iptables rules
    await exec(
      `iptables -t mangle -D PREROUTING ` +
        `-m comment --comment "wg-easy-split-client-${clientId}" ` +
        `-j MARK --set-mark ${fwmark}`
    ).catch(() => {});

    // Delete policy routing
    await exec(`ip rule del fwmark ${fwmark} table ${routeTable}`).catch(
      () => {}
    );
    await exec(`ip route flush table ${routeTable}`).catch(() => {});

    // Delete ipset
    await exec(`ipset destroy ${ipsetName}`).catch(() => {});
  }

  /**
   * Clean up all split tunneling configurations
   */
  async cleanup() {
    ST_DEBUG('Cleaning up all split tunneling configs...');

    try {
      // 1. Stop all upstream interfaces
      const upstreams = await Database.upstreams.getAll();
      for (const upstream of upstreams) {
        await this.stopUpstreamInterface(upstream.interfaceName);
      }

      // 2. Clean up iptables mangle table wg-easy rules
      const mangleRules = await exec('iptables -t mangle -S PREROUTING').catch(
        () => ''
      );
      const wgEasyRules = mangleRules
        .split('\n')
        .filter((line) => line.includes('wg-easy-split-client-'));

      for (const rule of wgEasyRules) {
        const deleteRule = rule.replace('-A', '-D');
        await exec(`iptables -t mangle ${deleteRule}`).catch(() => {});
      }

      // 3. Clean up policy routing
      for (let i = 100; i < 200; i++) {
        await exec(`ip rule del table ${i}`).catch(() => {});
        await exec(`ip route flush table ${i}`).catch(() => {});
      }

      // 4. Clean up all client_* ipsets
      const ipsets = await exec('ipset list -n').catch(() => '');
      const clientIpsets = ipsets
        .split('\n')
        .filter((name) => name.startsWith('client_') && name.endsWith('_proxy'));

      for (const ipset of clientIpsets) {
        await exec(`ipset destroy ${ipset}`).catch(() => {});
      }

      // 5. Clear dnsmasq configuration
      await fs
        .writeFile(
          this.DNSMASQ_CONF_FILE,
          '# Split tunneling disabled\n'
        )
        .catch(() => {});

      ST_DEBUG('Cleanup completed.');
    } catch (err) {
      ST_DEBUG('Error during cleanup:', err);
    }
  }

  /**
   * Get split tunneling status
   */
  async getStatus() {
    const clients = await Database.clients.getAll();
    const upstreams = await Database.upstreams.getAll();

    const activeClients = clients.filter(
      (c) => c.enabled && c.upstreamEnabled && c.upstreamId
    );

    const activeUpstreams = upstreams.filter((u) => u.enabled);

    const upstreamStatus = await Promise.all(
      activeUpstreams.map(async (upstream) => {
        try {
          await exec(`ip link show ${upstream.interfaceName}`);
          return {
            id: upstream.id,
            name: upstream.name,
            interfaceName: upstream.interfaceName,
            status: 'up' as const,
          };
        } catch {
          return {
            id: upstream.id,
            name: upstream.name,
            interfaceName: upstream.interfaceName,
            status: 'down' as const,
          };
        }
      })
    );

    return {
      totalClients: clients.length,
      activeClients: activeClients.length,
      totalUpstreams: upstreams.length,
      activeUpstreams: activeUpstreams.length,
      upstreams: upstreamStatus,
    };
  }

  /**
   * Health check for split tunneling system
   */
  async healthCheck() {
    ST_DEBUG('Running health check...');

    try {
      // 1. Check upstream interfaces
      const upstreams = await Database.upstreams.getAllEnabled();

      for (const upstream of upstreams) {
        try {
          await exec(`ip link show ${upstream.interfaceName}`);
        } catch {
          // Interface doesn't exist, try to restart
          ST_DEBUG(
            `Interface ${upstream.interfaceName} not found, restarting...`
          );
          await this.startUpstreamInterface(upstream);
        }
      }

      // 2. Check dnsmasq
      try {
        await exec('pgrep dnsmasq');
      } catch {
        ST_DEBUG('dnsmasq not running, starting...');
        await exec('dnsmasq').catch(() => {});
      }

      // 3. Verify critical ipsets exist
      const clients = await Database.clients.getAll();
      const activeClients = clients.filter(
        (c) => c.enabled && c.upstreamEnabled
      );

      for (const client of activeClients) {
        const ipsetName = `client_${client.id}_proxy`;
        try {
          await exec(`ipset list ${ipsetName}`);
        } catch {
          // ipset doesn't exist, recreate client config
          ST_DEBUG(`ipset ${ipsetName} not found, recreating...`);
          const upstream = await Database.upstreams.get(client.upstreamId!);
          if (upstream) {
            const rules = await Database.splitRules.getByClientId(client.id);
            await this.applyClientConfig({ client, upstream, rules });
          }
        }
      }

      ST_DEBUG('Health check completed.');
    } catch (err) {
      ST_DEBUG('Health check failed:', err);
    }
  }
}

export default new SplitTunneling();
