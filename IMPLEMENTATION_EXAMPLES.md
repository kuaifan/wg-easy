# 核心代码实现示例

本文档提供关键模块的完整代码示例，可直接参考实现。

---

## 1. 数据库 Schema 定义

### 1.1 上游服务器 Schema

```typescript
// src/server/database/repositories/upstream/schema.ts
import { sql, relations } from 'drizzle-orm';
import { int, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { client } from '../client/schema';

export const upstreamServer = sqliteTable('upstream_servers', {
  id: int().primaryKey({ autoIncrement: true }),
  name: text().notNull(),
  interfaceName: text('interface_name').notNull().unique(),
  endpoint: text().notNull(),
  publicKey: text('public_key').notNull(),
  privateKey: text('private_key').notNull(),
  presharedKey: text('preshared_key'),
  allowedIps: text('allowed_ips', { mode: 'json' }).$type<string[]>().notNull(),
  persistentKeepalive: int('persistent_keepalive').default(25).notNull(),
  mtu: int().default(1420).notNull(),
  enabled: int({ mode: 'boolean' }).default(true).notNull(),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`)
    .$onUpdate(() => sql`(CURRENT_TIMESTAMP)`),
});

export const upstreamRelations = relations(upstreamServer, ({ many }) => ({
  clients: many(client),
}));
```

### 1.2 分流规则 Schema

```typescript
// src/server/database/repositories/splitRule/schema.ts
import { sql, relations } from 'drizzle-orm';
import { int, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { client } from '../client/schema';

export const splitRule = sqliteTable('split_rules', {
  id: int().primaryKey({ autoIncrement: true }),
  clientId: int('client_id')
    .notNull()
    .references(() => client.id, {
      onDelete: 'cascade',
      onUpdate: 'cascade',
    }),
  ruleType: text('rule_type').notNull(), // 'domain' | 'ip'
  ruleValue: text('rule_value').notNull(),
  action: text().default('proxy').notNull(), // 'proxy' | 'direct'
  enabled: int({ mode: 'boolean' }).default(true).notNull(),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`)
    .$onUpdate(() => sql`(CURRENT_TIMESTAMP)`),
});

export const splitRuleRelations = relations(splitRule, ({ one }) => ({
  client: one(client, {
    fields: [splitRule.clientId],
    references: [client.id],
  }),
}));
```

### 1.3 扩展客户端 Schema

```typescript
// src/server/database/repositories/client/schema.ts (添加字段)
export const client = sqliteTable('clients_table', {
  // ... 现有字段 ...
  
  // 新增分流相关字段
  upstreamEnabled: int('upstream_enabled', { mode: 'boolean' })
    .default(false)
    .notNull(),
  upstreamId: int('upstream_id').references(() => upstreamServer.id, {
    onDelete: 'set null',
    onUpdate: 'cascade',
  }),
});

// 添加关系
export const clientsRelations = relations(client, ({ one, many }) => ({
  // ... 现有关系 ...
  
  upstreamServer: one(upstreamServer, {
    fields: [client.upstreamId],
    references: [upstreamServer.id],
  }),
  splitRules: many(splitRule),
}));
```

### 1.4 TypeScript 类型定义

```typescript
// src/server/database/repositories/upstream/types.ts
import type { InferSelectModel } from 'drizzle-orm';
import z from 'zod';
import type { upstreamServer } from './schema';

export type UpstreamServerType = InferSelectModel<typeof upstreamServer>;

export type CreateUpstreamType = Omit<
  UpstreamServerType,
  'id' | 'createdAt' | 'updatedAt' | 'interfaceName'
>;

export type UpdateUpstreamType = Partial<
  Omit<CreateUpstreamType, 'privateKey' | 'publicKey'>
>;

export const UpstreamCreateSchema = z.object({
  name: z.string().min(1),
  endpoint: z.string().regex(/^[^:]+:\d+$/), // host:port
  publicKey: z.string().length(44), // Base64 WireGuard key
  privateKey: z.string().length(44),
  presharedKey: z.string().length(44).optional(),
  allowedIps: z.array(z.string()).min(1),
  persistentKeepalive: z.number().int().min(0).max(3600).default(25),
  mtu: z.number().int().min(1280).max(1500).default(1420),
  enabled: z.boolean().default(true),
});

// src/server/database/repositories/splitRule/types.ts
import type { InferSelectModel } from 'drizzle-orm';
import z from 'zod';
import type { splitRule } from './schema';

export type SplitRuleType = InferSelectModel<typeof splitRule>;

export type CreateSplitRuleType = Omit<
  SplitRuleType,
  'id' | 'createdAt' | 'updatedAt'
>;

export type UpdateSplitRuleType = Partial<
  Omit<CreateSplitRuleType, 'clientId'>
>;

export const SplitRuleCreateSchema = z.object({
  ruleType: z.enum(['domain', 'ip']),
  ruleValue: z.string().min(1),
  action: z.enum(['proxy', 'direct']).default('proxy'),
  enabled: z.boolean().default(true),
});
```

---

## 2. 核心业务逻辑

### 2.1 分流管理核心类

```typescript
// src/server/utils/SplitTunneling.ts
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
  
  /**
   * 初始化：确保必要的文件和目录存在
   */
  async initialize() {
    ST_DEBUG('Initializing Split Tunneling...');
    
    // 创建 dnsmasq 配置目录
    await exec(`mkdir -p ${this.DNSMASQ_CONF_DIR}`);
    
    // 确保路由表配置存在
    await this.ensureRouteTables();
    
    ST_DEBUG('Split Tunneling initialized.');
  }
  
  /**
   * 确保路由表配置
   */
  async ensureRouteTables() {
    try {
      const content = await fs.readFile(this.RT_TABLES_FILE, 'utf-8');
      const lines = content.split('\n');
      const existingTables = new Set(
        lines
          .filter(l => !l.startsWith('#') && l.trim())
          .map(l => l.split(/\s+/)[0])
      );
      
      // 添加客户端路由表 (100-199)
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
   * 应用所有配置
   */
  async applyAllConfigs() {
    ST_DEBUG('Applying all split tunneling configs...');
    
    try {
      // 1. 清理旧配置
      await this.cleanup();
      
      // 2. 获取所有数据
      const clients = await Database.clients.getAll();
      const upstreams = await Database.upstreams.getAll();
      
      // 3. 启动上游接口
      for (const upstream of upstreams) {
        if (upstream.enabled) {
          await this.startUpstreamInterface(upstream);
        }
      }
      
      // 4. 配置每个客户端
      const activeConfigs: ClientConfig[] = [];
      
      for (const client of clients) {
        if (!client.enabled || !client.upstreamEnabled || !client.upstreamId) {
          continue;
        }
        
        const upstream = upstreams.find(u => u.id === client.upstreamId);
        if (!upstream || !upstream.enabled) {
          ST_DEBUG(`Client ${client.id}: upstream not found or disabled`);
          continue;
        }
        
        const rules = await Database.splitRules.getByClientId(client.id);
        
        activeConfigs.push({ client, upstream, rules });
        await this.applyClientConfig({ client, upstream, rules });
      }
      
      // 5. 生成 dnsmasq 配置
      await this.generateDnsmasqConfig(activeConfigs);
      await this.reloadDnsmasq();
      
      ST_DEBUG('All configs applied successfully.');
    } catch (err) {
      ST_DEBUG('Error applying configs:', err);
      throw err;
    }
  }
  
  /**
   * 启动上游 WireGuard 接口
   */
  async startUpstreamInterface(upstream: UpstreamServerType) {
    ST_DEBUG(`Starting upstream interface ${upstream.interfaceName}...`);
    
    const config = this.generateUpstreamConfig(upstream);
    const confPath = `/etc/wireguard/${upstream.interfaceName}.conf`;
    
    await fs.writeFile(confPath, config, { mode: 0o600 });
    
    try {
      // 先尝试关闭（如果已存在）
      await exec(`wg-quick down ${upstream.interfaceName}`).catch(() => {});
      
      // 启动接口
      await exec(`wg-quick up ${upstream.interfaceName}`);
      
      ST_DEBUG(`Upstream interface ${upstream.interfaceName} started successfully.`);
    } catch (err) {
      ST_DEBUG(`Failed to start ${upstream.interfaceName}:`, err);
      throw new Error(`Failed to start upstream interface: ${err.message}`);
    }
  }
  
  /**
   * 生成上游接口 WireGuard 配置
   */
  generateUpstreamConfig(upstream: UpstreamServerType): string {
    const lines = [
      '# Auto-generated by wg-easy',
      '# Upstream WireGuard Interface',
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
   * 为单个客户端应用配置
   */
  async applyClientConfig({ client, upstream, rules }: ClientConfig) {
    const clientId = client.id;
    const clientIp = client.ipv4Address;
    const ipsetName = `client_${clientId}_proxy`;
    const fwmark = 100 + clientId;
    const routeTable = 100 + clientId;
    
    ST_DEBUG(`Configuring client ${clientId} (${clientIp})...`);
    
    try {
      // 1. 创建 ipset
      await exec(`ipset create ${ipsetName} hash:ip timeout 3600 -exist`);
      await exec(`ipset flush ${ipsetName}`);
      
      // 2. 添加 IP 规则到 ipset
      const ipRules = rules.filter(
        r => r.enabled && r.ruleType === 'ip' && r.action === 'proxy'
      );
      
      for (const rule of ipRules) {
        try {
          await exec(`ipset add ${ipsetName} ${rule.ruleValue} -exist`);
          ST_DEBUG(`  Added IP rule: ${rule.ruleValue}`);
        } catch (err) {
          ST_DEBUG(`  Failed to add IP rule ${rule.ruleValue}:`, err);
        }
      }
      
      // 3. 配置 iptables 标记
      await exec(
        `iptables -t mangle -A PREROUTING ` +
        `-s ${clientIp} ` +
        `-m set --match-set ${ipsetName} dst ` +
        `-j MARK --set-mark ${fwmark} ` +
        `-m comment --comment "wg-easy-client-${clientId}"`
      );
      
      // 4. 配置策略路由
      await exec(
        `ip rule add fwmark ${fwmark} table ${routeTable} prio ${1000 + clientId}`
      );
      
      await exec(
        `ip route add default dev ${upstream.interfaceName} table ${routeTable}`
      );
      
      // 5. 启用反向路径过滤（防止路由泄漏）
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
   * 生成 dnsmasq 配置
   */
  async generateDnsmasqConfig(configs: ClientConfig[]) {
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
        r => r.enabled && r.ruleType === 'domain' && r.action === 'proxy'
      );
      
      if (domainRules.length === 0) {
        continue;
      }
      
      lines.push(`# Client: ${client.name} (ID=${clientId})`);
      
      for (const rule of domainRules) {
        const domain = rule.ruleValue;
        // dnsmasq ipset 语法: ipset=/domain/ipset_name
        lines.push(`ipset=/${domain}/${ipsetName}`);
      }
      
      lines.push('');
    }
    
    await fs.writeFile(this.DNSMASQ_CONF_FILE, lines.join('\n'));
    
    ST_DEBUG(
      `dnsmasq config generated: ${configs.length} clients, ` +
      `${configs.reduce((sum, c) => sum + c.rules.filter(r => r.ruleType === 'domain').length, 0)} domain rules`
    );
  }
  
  /**
   * 重载 dnsmasq
   */
  async reloadDnsmasq() {
    ST_DEBUG('Reloading dnsmasq...');
    
    try {
      // 发送 HUP 信号重载配置
      await exec('killall -HUP dnsmasq');
      ST_DEBUG('dnsmasq reloaded successfully.');
    } catch (err) {
      ST_DEBUG('Failed to reload dnsmasq:', err);
      // 尝试启动 dnsmasq
      try {
        await exec('dnsmasq');
        ST_DEBUG('dnsmasq started.');
      } catch (startErr) {
        ST_DEBUG('Failed to start dnsmasq:', startErr);
      }
    }
  }
  
  /**
   * 停止上游接口
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
   * 清理单个客户端的配置
   */
  async cleanupClientConfig(clientId: number) {
    ST_DEBUG(`Cleaning up client ${clientId} config...`);
    
    const ipsetName = `client_${clientId}_proxy`;
    const fwmark = 100 + clientId;
    const routeTable = 100 + clientId;
    
    // 删除 iptables 规则
    await exec(
      `iptables -t mangle -D PREROUTING ` +
      `-m comment --comment "wg-easy-client-${clientId}" ` +
      `-j MARK --set-mark ${fwmark}`
    ).catch(() => {});
    
    // 删除策略路由
    await exec(`ip rule del fwmark ${fwmark} table ${routeTable}`).catch(() => {});
    await exec(`ip route flush table ${routeTable}`).catch(() => {});
    
    // 删除 ipset
    await exec(`ipset destroy ${ipsetName}`).catch(() => {});
  }
  
  /**
   * 清理所有配置
   */
  async cleanup() {
    ST_DEBUG('Cleaning up all split tunneling configs...');
    
    try {
      // 1. 停止所有上游接口
      const upstreams = await Database.upstreams.getAll();
      for (const upstream of upstreams) {
        await this.stopUpstreamInterface(upstream.interfaceName);
      }
      
      // 2. 清理 iptables mangle 表中的 wg-easy 规则
      const mangleRules = await exec('iptables -t mangle -S PREROUTING').catch(() => '');
      const wgEasyRules = mangleRules
        .split('\n')
        .filter(line => line.includes('wg-easy-client-'));
      
      for (const rule of wgEasyRules) {
        const deleteRule = rule.replace('-A', '-D');
        await exec(`iptables -t mangle ${deleteRule}`).catch(() => {});
      }
      
      // 3. 清理策略路由
      for (let i = 100; i < 200; i++) {
        await exec(`ip rule del table ${i}`).catch(() => {});
        await exec(`ip route flush table ${i}`).catch(() => {});
      }
      
      // 4. 清理所有 client_* ipset
      const ipsets = await exec('ipset list -n').catch(() => '');
      const clientIpsets = ipsets
        .split('\n')
        .filter(name => name.startsWith('client_') && name.endsWith('_proxy'));
      
      for (const ipset of clientIpsets) {
        await exec(`ipset destroy ${ipset}`).catch(() => {});
      }
      
      // 5. 清空 dnsmasq 配置
      await fs.writeFile(
        this.DNSMASQ_CONF_FILE,
        '# Split tunneling disabled\n'
      ).catch(() => {});
      
      ST_DEBUG('Cleanup completed.');
    } catch (err) {
      ST_DEBUG('Error during cleanup:', err);
    }
  }
  
  /**
   * 获取状态信息
   */
  async getStatus() {
    const clients = await Database.clients.getAll();
    const upstreams = await Database.upstreams.getAll();
    
    const activeClients = clients.filter(
      c => c.enabled && c.upstreamEnabled && c.upstreamId
    );
    
    const activeUpstreams = upstreams.filter(u => u.enabled);
    
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
}

export default new SplitTunneling();
```

---

## 3. API 端点实现

### 3.1 上游服务器 API

```typescript
// src/server/api/upstream/index.get.ts
export default definePermissionEventHandler(
  'upstream',
  'read',
  async () => {
    const upstreams = await Database.upstreams.getAll();
    
    // 不返回私钥
    const safeUpstreams = upstreams.map(({ privateKey, presharedKey, ...rest }) => ({
      ...rest,
      hasPrivateKey: !!privateKey,
      hasPresharedKey: !!presharedKey,
    }));
    
    return { upstreams: safeUpstreams };
  }
);

// src/server/api/upstream/index.post.ts
import { UpstreamCreateSchema } from '#db/repositories/upstream/types';

export default definePermissionEventHandler(
  'upstream',
  'create',
  async ({ event }) => {
    const data = await readValidatedBody(
      event,
      validateZod(UpstreamCreateSchema, event)
    );
    
    const result = await Database.upstreams.create(data);
    
    // 应用新配置
    await SplitTunneling.applyAllConfigs();
    
    return { 
      success: true, 
      upstreamId: result[0].id,
      interfaceName: result[0].interfaceName,
    };
  }
);

// src/server/api/upstream/[upstreamId]/index.get.ts
import { UpstreamGetSchema } from '#db/repositories/upstream/types';

export default definePermissionEventHandler(
  'upstream',
  'read',
  async ({ event }) => {
    const { upstreamId } = await getValidatedRouterParams(
      event,
      validateZod(UpstreamGetSchema, event)
    );
    
    const upstream = await Database.upstreams.get(upstreamId);
    
    if (!upstream) {
      throw createError({
        statusCode: 404,
        message: 'Upstream server not found',
      });
    }
    
    // 不返回敏感信息
    const { privateKey, presharedKey, ...safeUpstream } = upstream;
    
    return { 
      upstream: {
        ...safeUpstream,
        hasPrivateKey: !!privateKey,
        hasPresharedKey: !!presharedKey,
      }
    };
  }
);

// src/server/api/upstream/[upstreamId]/index.post.ts
import { UpstreamGetSchema, UpstreamUpdateSchema } from '#db/repositories/upstream/types';

export default definePermissionEventHandler(
  'upstream',
  'update',
  async ({ event }) => {
    const { upstreamId } = await getValidatedRouterParams(
      event,
      validateZod(UpstreamGetSchema, event)
    );
    
    const data = await readValidatedBody(
      event,
      validateZod(UpstreamUpdateSchema, event)
    );
    
    await Database.upstreams.update(upstreamId, data);
    await SplitTunneling.applyAllConfigs();
    
    return { success: true };
  }
);

// src/server/api/upstream/[upstreamId]/index.delete.ts
import { UpstreamGetSchema } from '#db/repositories/upstream/types';

export default definePermissionEventHandler(
  'upstream',
  'delete',
  async ({ event }) => {
    const { upstreamId } = await getValidatedRouterParams(
      event,
      validateZod(UpstreamGetSchema, event)
    );
    
    // 检查是否有客户端正在使用
    const clients = await Database.clients.getAll();
    const usingClients = clients.filter(c => c.upstreamId === upstreamId);
    
    if (usingClients.length > 0) {
      throw createError({
        statusCode: 400,
        message: `Cannot delete upstream: ${usingClients.length} client(s) are using it`,
      });
    }
    
    const upstream = await Database.upstreams.get(upstreamId);
    if (upstream) {
      await SplitTunneling.stopUpstreamInterface(upstream.interfaceName);
    }
    
    await Database.upstreams.delete(upstreamId);
    
    return { success: true };
  }
);
```

### 3.2 分流规则 API

```typescript
// src/server/api/splitRule/[clientId]/index.get.ts
import { ClientGetSchema } from '#db/repositories/client/types';

export default definePermissionEventHandler(
  'clients',
  'read',
  async ({ event, checkPermissions }) => {
    const { clientId } = await getValidatedRouterParams(
      event,
      validateZod(ClientGetSchema, event)
    );
    
    const client = await Database.clients.get(clientId);
    checkPermissions(client);
    
    const rules = await Database.splitRules.getByClientId(clientId);
    
    return { rules };
  }
);

// src/server/api/splitRule/[clientId]/index.post.ts
import { ClientGetSchema } from '#db/repositories/client/types';
import { SplitRuleCreateSchema } from '#db/repositories/splitRule/types';

export default definePermissionEventHandler(
  'clients',
  'update',
  async ({ event, checkPermissions }) => {
    const { clientId } = await getValidatedRouterParams(
      event,
      validateZod(ClientGetSchema, event)
    );
    
    const client = await Database.clients.get(clientId);
    checkPermissions(client);
    
    const data = await readValidatedBody(
      event,
      validateZod(SplitRuleCreateSchema, event)
    );
    
    const result = await Database.splitRules.create({
      ...data,
      clientId,
    });
    
    // 重新应用配置
    await SplitTunneling.applyAllConfigs();
    
    return { 
      success: true,
      ruleId: result[0].id,
    };
  }
);

// src/server/api/splitRule/[clientId]/[ruleId]/index.delete.ts
import { ClientGetSchema } from '#db/repositories/client/types';
import { SplitRuleGetSchema } from '#db/repositories/splitRule/types';

export default definePermissionEventHandler(
  'clients',
  'update',
  async ({ event, checkPermissions }) => {
    const { clientId, ruleId } = await getValidatedRouterParams(
      event,
      validateZod(ClientGetSchema.merge(SplitRuleGetSchema), event)
    );
    
    const client = await Database.clients.get(clientId);
    checkPermissions(client);
    
    await Database.splitRules.delete(ruleId);
    await SplitTunneling.applyAllConfigs();
    
    return { success: true };
  }
);
```

---

## 4. 前端组件实现

### 4.1 分流规则编辑组件

```vue
<!-- src/app/components/SplitTunneling/RuleEditor.vue -->
<template>
  <div class="space-y-4">
    <!-- 规则列表 -->
    <div v-if="rules.length > 0" class="space-y-2">
      <div
        v-for="rule in rules"
        :key="rule.id"
        class="flex items-center gap-3 p-3 bg-gray-50 dark:bg-gray-800 rounded-lg"
      >
        <div class="flex-1">
          <div class="flex items-center gap-2">
            <span
              :class="[
                'px-2 py-1 text-xs font-medium rounded',
                rule.ruleType === 'domain'
                  ? 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200'
                  : 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
              ]"
            >
              {{ rule.ruleType.toUpperCase() }}
            </span>
            <span
              :class="[
                'px-2 py-1 text-xs font-medium rounded',
                rule.action === 'proxy'
                  ? 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200'
                  : 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200',
              ]"
            >
              {{ rule.action.toUpperCase() }}
            </span>
          </div>
          <div class="mt-1 font-mono text-sm">
            {{ rule.ruleValue }}
          </div>
        </div>
        
        <div class="flex items-center gap-2">
          <button
            @click="toggleRule(rule.id, !rule.enabled)"
            :class="[
              'px-3 py-1 text-sm rounded',
              rule.enabled
                ? 'bg-green-500 text-white hover:bg-green-600'
                : 'bg-gray-300 text-gray-700 hover:bg-gray-400',
            ]"
          >
            {{ rule.enabled ? 'Enabled' : 'Disabled' }}
          </button>
          
          <button
            @click="deleteRule(rule.id)"
            class="px-3 py-1 text-sm bg-red-500 text-white rounded hover:bg-red-600"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
    
    <div v-else class="text-gray-500 text-sm">
      No rules configured. Add a rule below.
    </div>
    
    <!-- 添加规则表单 -->
    <form @submit.prevent="addRule" class="p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
      <h4 class="text-sm font-semibold mb-3">Add New Rule</h4>
      
      <div class="grid grid-cols-1 md:grid-cols-4 gap-3">
        <div>
          <label class="block text-xs font-medium mb-1">Type</label>
          <select
            v-model="newRule.ruleType"
            class="w-full px-3 py-2 border rounded-md"
            required
          >
            <option value="domain">Domain</option>
            <option value="ip">IP/CIDR</option>
          </select>
        </div>
        
        <div class="md:col-span-2">
          <label class="block text-xs font-medium mb-1">Value</label>
          <input
            v-model="newRule.ruleValue"
            type="text"
            :placeholder="
              newRule.ruleType === 'domain'
                ? 'google.com or *.google.com'
                : '8.8.8.8 or 8.8.8.0/24'
            "
            class="w-full px-3 py-2 border rounded-md"
            required
          />
        </div>
        
        <div>
          <label class="block text-xs font-medium mb-1">Action</label>
          <select
            v-model="newRule.action"
            class="w-full px-3 py-2 border rounded-md"
            required
          >
            <option value="proxy">Proxy</option>
            <option value="direct">Direct</option>
          </select>
        </div>
      </div>
      
      <div class="mt-3 flex gap-2">
        <button
          type="submit"
          :disabled="isSubmitting"
          class="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
        >
          {{ isSubmitting ? 'Adding...' : 'Add Rule' }}
        </button>
        
        <button
          type="button"
          @click="resetForm"
          class="px-4 py-2 bg-gray-200 text-gray-700 rounded-md hover:bg-gray-300"
        >
          Reset
        </button>
      </div>
    </form>
  </div>
</template>

<script lang="ts" setup>
const props = defineProps<{
  clientId: number;
}>();

const emit = defineEmits<{
  (e: 'rules-changed'): void;
}>();

// 获取规则列表
const { data: rulesData, refresh } = await useFetch(
  `/api/splitRule/${props.clientId}`,
  { method: 'get' }
);

const rules = computed(() => rulesData.value?.rules || []);

// 新规则表单
const newRule = ref({
  ruleType: 'domain' as 'domain' | 'ip',
  ruleValue: '',
  action: 'proxy' as 'proxy' | 'direct',
});

const isSubmitting = ref(false);

// 添加规则
async function addRule() {
  isSubmitting.value = true;
  
  try {
    await $fetch(`/api/splitRule/${props.clientId}`, {
      method: 'post',
      body: newRule.value,
    });
    
    resetForm();
    await refresh();
    emit('rules-changed');
    
    // 显示成功消息
    alert('Rule added successfully!');
  } catch (error) {
    console.error('Failed to add rule:', error);
    alert('Failed to add rule. Please check the format and try again.');
  } finally {
    isSubmitting.value = false;
  }
}

// 删除规则
async function deleteRule(ruleId: number) {
  if (!confirm('Are you sure you want to delete this rule?')) {
    return;
  }
  
  try {
    await $fetch(`/api/splitRule/${props.clientId}/${ruleId}`, {
      method: 'delete',
    });
    
    await refresh();
    emit('rules-changed');
  } catch (error) {
    console.error('Failed to delete rule:', error);
    alert('Failed to delete rule.');
  }
}

// 切换规则状态
async function toggleRule(ruleId: number, enabled: boolean) {
  try {
    await $fetch(`/api/splitRule/${props.clientId}/${ruleId}`, {
      method: 'post',
      body: { enabled },
    });
    
    await refresh();
    emit('rules-changed');
  } catch (error) {
    console.error('Failed to toggle rule:', error);
    alert('Failed to toggle rule.');
  }
}

// 重置表单
function resetForm() {
  newRule.value = {
    ruleType: 'domain',
    ruleValue: '',
    action: 'proxy',
  };
}
</script>
```

### 4.2 扩展客户端编辑页面

```vue
<!-- src/app/pages/clients/[id].vue (添加部分) -->
<template>
  <main v-if="data">
    <Panel>
      <!-- ... 现有字段 ... -->
      
      <!-- 新增：上游服务器配置 -->
      <FormGroup>
        <FormHeading>
          Split Tunneling
          <template #description>
            Configure upstream server and routing rules for this client
          </template>
        </FormHeading>
        
        <FormSwitchField
          id="upstreamEnabled"
          v-model="data.upstreamEnabled"
          label="Enable Split Tunneling"
          description="Route specific traffic through an upstream WireGuard server"
        />
        
        <FormSelectField
          v-if="data.upstreamEnabled"
          id="upstreamId"
          v-model="data.upstreamId"
          label="Upstream Server"
          :options="upstreamOptions"
          description="Select which upstream server to use"
          required
        />
        
        <div v-if="upstreamOptions.length === 0 && data.upstreamEnabled" class="text-amber-600 text-sm">
          ⚠️ No upstream servers available. Please create one first.
          <NuxtLink to="/upstream" class="underline">
            Go to Upstream Servers
          </NuxtLink>
        </div>
      </FormGroup>
      
      <!-- 新增：分流规则配置 -->
      <FormGroup v-if="data.upstreamEnabled && data.upstreamId">
        <FormHeading>
          Routing Rules
          <template #description>
            Define which domains or IPs should be routed through the upstream server
          </template>
        </FormHeading>
        
        <SplitTunnelingRuleEditor 
          :client-id="data.id"
          @rules-changed="onRulesChanged"
        />
      </FormGroup>
      
      <!-- ... 其余字段 ... -->
    </Panel>
  </main>
</template>

<script lang="ts" setup>
// ... 现有代码 ...

// 获取上游服务器列表
const { data: upstreamsData } = await useFetch('/api/upstream', {
  method: 'get',
});

const upstreamOptions = computed(() => {
  const upstreams = upstreamsData.value?.upstreams || [];
  return upstreams
    .filter(u => u.enabled)
    .map(u => ({
      label: `${u.name} (${u.interfaceName})`,
      value: u.id,
    }));
});

// 规则变更回调
function onRulesChanged() {
  // 可以在这里添加额外逻辑，如显示通知
  console.log('Split tunneling rules updated');
}

// ... 其余代码 ...
</script>
```

---

## 5. 数据库迁移脚本

```sql
-- src/server/database/migrations/0002_split_tunneling.sql
PRAGMA journal_mode=WAL;

--> statement-breakpoint
-- 创建上游服务器表
CREATE TABLE IF NOT EXISTS `upstream_servers` (
  `id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  `name` TEXT NOT NULL,
  `interface_name` TEXT NOT NULL UNIQUE,
  `endpoint` TEXT NOT NULL,
  `public_key` TEXT NOT NULL,
  `private_key` TEXT NOT NULL,
  `preshared_key` TEXT,
  `allowed_ips` TEXT NOT NULL,
  `persistent_keepalive` INTEGER DEFAULT 25 NOT NULL,
  `mtu` INTEGER DEFAULT 1420 NOT NULL,
  `enabled` INTEGER DEFAULT 1 NOT NULL,
  `created_at` TEXT DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
  `updated_at` TEXT DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);

--> statement-breakpoint
-- 创建分流规则表
CREATE TABLE IF NOT EXISTS `split_rules` (
  `id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  `client_id` INTEGER NOT NULL,
  `rule_type` TEXT NOT NULL,
  `rule_value` TEXT NOT NULL,
  `action` TEXT DEFAULT 'proxy' NOT NULL,
  `enabled` INTEGER DEFAULT 1 NOT NULL,
  `created_at` TEXT DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
  `updated_at` TEXT DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
  FOREIGN KEY (`client_id`) REFERENCES `clients_table`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
);

--> statement-breakpoint
-- 创建索引
CREATE INDEX IF NOT EXISTS `idx_split_rules_client_id` ON `split_rules`(`client_id`);
CREATE INDEX IF NOT EXISTS `idx_split_rules_enabled` ON `split_rules`(`enabled`);
CREATE INDEX IF NOT EXISTS `idx_split_rules_type` ON `split_rules`(`rule_type`);

--> statement-breakpoint
-- 扩展客户端表（添加上游相关字段）
ALTER TABLE `clients_table` ADD COLUMN `upstream_enabled` INTEGER DEFAULT 0 NOT NULL;
ALTER TABLE `clients_table` ADD COLUMN `upstream_id` INTEGER REFERENCES `upstream_servers`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

--> statement-breakpoint
-- 创建客户端-上游关系索引
CREATE INDEX IF NOT EXISTS `idx_clients_upstream_id` ON `clients_table`(`upstream_id`);
```

---

## 6. Dockerfile 修改

```dockerfile
# 在现有 Dockerfile 基础上添加

FROM docker.io/library/node:lts-alpine

# ... 现有内容 ...

# Install additional packages for split tunneling
RUN apk add --no-cache \
    dpkg \
    dumb-init \
    iptables \
    ip6tables \
    nftables \
    kmod \
    iptables-legacy \
    wireguard-tools \
    dnsmasq \
    ipset \
    iproute2 \
    bash

# Configure dnsmasq
RUN mkdir -p /etc/dnsmasq.d && \
    echo "conf-dir=/etc/dnsmasq.d/,*.conf" > /etc/dnsmasq.conf && \
    echo "no-resolv" >> /etc/dnsmasq.conf && \
    echo "server=1.1.1.1" >> /etc/dnsmasq.conf && \
    echo "server=8.8.8.8" >> /etc/dnsmasq.conf && \
    echo "cache-size=1000" >> /etc/dnsmasq.conf && \
    echo "log-queries" >> /etc/dnsmasq.conf && \
    echo "log-facility=/var/log/dnsmasq.log" >> /etc/dnsmasq.conf

# Enable IP forwarding and other kernel parameters
RUN echo "net.ipv4.ip_forward=1" >> /etc/sysctl.conf && \
    echo "net.ipv4.conf.all.rp_filter=2" >> /etc/sysctl.conf && \
    echo "net.ipv4.conf.default.rp_filter=2" >> /etc/sysctl.conf

# ... 其余内容 ...
```

---

## 7. 启动脚本集成

```typescript
// src/server/utils/WireGuard.ts (扩展)
import SplitTunneling from './SplitTunneling';

class WireGuard {
  // ... 现有方法 ...
  
  async Startup() {
    WG_DEBUG('Starting WireGuard...');
    
    // 1. 启动主 WireGuard 接口（现有逻辑）
    let wgInterface = await Database.interfaces.get();
    
    if (
      wgInterface.privateKey === '---default---' &&
      wgInterface.publicKey === '---default---'
    ) {
      WG_DEBUG('Generating new Wireguard Keys...');
      const privateKey = await wg.generatePrivateKey();
      const publicKey = await wg.getPublicKey(privateKey);
      
      await Database.interfaces.updateKeyPair(privateKey, publicKey);
      wgInterface = await Database.interfaces.get();
      WG_DEBUG('New Wireguard Keys generated successfully.');
    }
    
    WG_DEBUG(`Starting Wireguard Interface ${wgInterface.name}...`);
    await this.#saveWireguardConfig(wgInterface);
    await wg.down(wgInterface.name).catch(() => {});
    await wg.up(wgInterface.name);
    await this.#syncWireguardConfig(wgInterface);
    WG_DEBUG(`Wireguard Interface ${wgInterface.name} started successfully.`);
    
    // 2. 启动分流功能（新增）
    WG_DEBUG('Starting Split Tunneling...');
    try {
      await SplitTunneling.initialize();
      
      // 启动 dnsmasq
      await exec('dnsmasq').catch((err) => {
        WG_DEBUG('dnsmasq start warning:', err);
        // 可能已经在运行，忽略错误
      });
      
      // 应用分流配置
      await SplitTunneling.applyAllConfigs();
      WG_DEBUG('Split Tunneling started successfully.');
    } catch (err) {
      WG_DEBUG('Failed to start Split Tunneling:', err);
      console.error('Split Tunneling Error:', err);
      // 不阻塞主进程，继续运行
    }
    
    // 3. 启动定时任务
    WG_DEBUG('Starting Cron Job...');
    await this.startCronJob();
    WG_DEBUG('Cron Job started successfully.');
  }
  
  async Shutdown() {
    WG_DEBUG('Shutting down WireGuard...');
    
    // 1. 停止分流功能（新增）
    WG_DEBUG('Stopping Split Tunneling...');
    try {
      await SplitTunneling.cleanup();
      WG_DEBUG('Split Tunneling stopped.');
    } catch (err) {
      WG_DEBUG('Error stopping Split Tunneling:', err);
    }
    
    // 2. 停止主接口
    const wgInterface = await Database.interfaces.get();
    await wg.down(wgInterface.name).catch(() => {});
    
    WG_DEBUG('WireGuard shutdown complete.');
  }
  
  async Restart() {
    WG_DEBUG('Restarting WireGuard...');
    await this.Shutdown();
    await this.Startup();
  }
  
  // ... 其余方法 ...
}

export default new WireGuard();
```

---

## 8. 调试和测试脚本

```bash
#!/bin/bash
# scripts/test-split-tunneling.sh

set -e

echo "=== Split Tunneling Test Script ==="

# 1. 检查依赖
echo "Checking dependencies..."
command -v wg >/dev/null 2>&1 || { echo "wireguard-tools not found"; exit 1; }
command -v dnsmasq >/dev/null 2>&1 || { echo "dnsmasq not found"; exit 1; }
command -v ipset >/dev/null 2>&1 || { echo "ipset not found"; exit 1; }
echo "✓ All dependencies installed"

# 2. 检查主接口
echo "Checking main WireGuard interface..."
if ip link show wg0 >/dev/null 2>&1; then
  echo "✓ wg0 interface is up"
else
  echo "✗ wg0 interface not found"
  exit 1
fi

# 3. 检查上游接口
echo "Checking upstream interfaces..."
for iface in $(ip link show | grep -o 'wg-up-[0-9]*'); do
  echo "  Found: $iface"
done

# 4. 检查 ipset
echo "Checking ipsets..."
ipset list -n | grep 'client_.*_proxy' || echo "  No client ipsets found"

# 5. 检查 iptables 规则
echo "Checking iptables rules..."
iptables -t mangle -L PREROUTING -n | grep 'wg-easy-client' || echo "  No mangle rules found"

# 6. 检查策略路由
echo "Checking policy routing..."
ip rule list | grep -E 'fwmark 0x[0-9a-f]+' || echo "  No fwmark rules found"

# 7. 检查 dnsmasq
echo "Checking dnsmasq..."
if pgrep dnsmasq >/dev/null; then
  echo "✓ dnsmasq is running"
  if [ -f /etc/dnsmasq.d/split-tunneling.conf ]; then
    echo "  Config file exists ($(wc -l < /etc/dnsmasq.d/split-tunneling.conf) lines)"
  else
    echo "  ✗ Config file not found"
  fi
else
  echo "✗ dnsmasq is not running"
fi

# 8. 测试 DNS 解析
echo "Testing DNS resolution..."
if dig @127.0.0.1 google.com +short >/dev/null; then
  echo "✓ DNS resolution works"
else
  echo "✗ DNS resolution failed"
fi

echo "=== Test Complete ==="
```

```bash
# scripts/monitor-split-tunneling.sh
#!/bin/bash

# 实时监控分流状态

watch -n 1 '
echo "=== WireGuard Interfaces ==="
wg show all brief

echo ""
echo "=== Client IPSets ==="
for ipset in $(ipset list -n | grep client_.*_proxy); do
  count=$(ipset list $ipset | grep -c "Number of entries:")
  echo "$ipset: $(ipset list $ipset | tail -n +8 | wc -l) IPs"
done

echo ""
echo "=== Policy Routes ==="
ip rule list | grep fwmark

echo ""
echo "=== Mangle Rules ==="
iptables -t mangle -L PREROUTING -n -v | grep wg-easy
'
```

---

这些代码示例涵盖了分流功能的核心实现，可以直接参考进行开发。记得根据实际情况调整权限检查、错误处理和日志记录。
