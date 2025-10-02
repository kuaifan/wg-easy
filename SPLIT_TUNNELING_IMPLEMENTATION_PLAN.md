# WireGuard 分流功能实施方案

## 项目概述

基于 wg-easy 实现每客户端独立的 WireGuard 分流功能，支持为每个客户端配置专属的上游服务器和分流规则。

---

## 一、架构设计

### 1.1 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                      wg-easy Server                          │
│  ┌───────────────────────────────────────────────────────┐  │
│  │         WireGuard Interface (wg0)                     │  │
│  │  - 接收所有客户端连接                                  │  │
│  │  - 10.8.0.0/24 (IPv4), fdcc::/112 (IPv6)            │  │
│  └───────────────────────────────────────────────────────┘  │
│                         │                                     │
│  ┌──────────────────────┴──────────────────────┐            │
│  │   Traffic Classification Engine             │            │
│  │  - 基于源IP识别客户端                        │            │
│  │  - 查询客户端专属分流规则                    │            │
│  │  - 路由决策：直连 vs 上游代理                │            │
│  └──────────────────────┬──────────────────────┘            │
│                         │                                     │
│         ┌───────────────┴───────────────┐                    │
│         │                               │                    │
│    ┌────▼─────┐                   ┌────▼─────┐             │
│    │  直连流量 │                   │  代理流量 │             │
│    └────┬─────┘                   └────┬─────┘             │
│         │                               │                    │
│         │                    ┌──────────┴──────────┐        │
│         │                    │ Upstream Interfaces │        │
│         │                    │  - wg-up-1, wg-up-2 │        │
│         │                    │  - 每客户端独立接口  │        │
│         │                    └──────────┬──────────┘        │
└─────────┼───────────────────────────────┼──────────────────┘
          │                               │
          ▼                               ▼
    ┌──────────┐                  ┌──────────────┐
    │ Internet │                  │ Upstream WG  │
    └──────────┘                  │   Servers    │
                                  └──────────────┘
```

### 1.2 核心技术栈

1. **数据存储**: SQLite (Drizzle ORM) - 存储客户端配置、上游服务器、分流规则
2. **WireGuard 管理**: wg/awg 命令行工具 - 管理主接口和上游接口
3. **流量分类**: dnsmasq + ipset - DNS 域名解析和 IP 集合管理
4. **流量路由**: iptables + iproute2 - 策略路由和流量标记
5. **Web UI**: Nuxt 3 + Vue 3 - 客户端配置界面

### 1.3 工作流程

```
客户端 A 流量 → wg0 (10.8.0.2)
    ↓
识别源 IP: 10.8.0.2
    ↓
查询客户端 A 的分流规则和上游配置
    ↓
DNS 查询 (例如 google.com)
    ↓
dnsmasq 检查域名是否在客户端 A 的分流列表
    ↓
    ├─ 命中: 添加解析的 IP 到 ipset (client_a_proxy)
    │   ↓
    │   iptables 标记流量 (fwmark 100)
    │   ↓
    │   策略路由表: 通过 wg-up-1 (客户端 A 的上游接口) 转发
    │   ↓
    │   上游 WireGuard 服务器 1
    │
    └─ 未命中: 直接通过默认路由转发
        ↓
        Internet (直连)
```

---

## 二、数据库设计

### 2.1 扩展 clients_table

在现有的 `clients_table` 基础上添加分流相关字段：

```sql
-- 新增字段
ALTER TABLE clients_table ADD COLUMN upstream_enabled INTEGER DEFAULT 0 NOT NULL;  -- 是否启用上游
ALTER TABLE clients_table ADD COLUMN upstream_id INTEGER REFERENCES upstream_servers(id);  -- 关联上游服务器
```

### 2.2 新建 upstream_servers 表

存储上游 WireGuard 服务器配置：

```sql
CREATE TABLE upstream_servers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,                      -- 上游服务器名称
  interface_name TEXT NOT NULL UNIQUE,     -- WireGuard 接口名 (wg-up-1, wg-up-2...)
  endpoint TEXT NOT NULL,                  -- 上游服务器地址:端口
  public_key TEXT NOT NULL,                -- 上游服务器公钥
  private_key TEXT NOT NULL,               -- 本地私钥（连接上游用）
  preshared_key TEXT,                      -- 预共享密钥（可选）
  allowed_ips TEXT NOT NULL,               -- JSON 数组: ["0.0.0.0/0"]
  persistent_keepalive INTEGER DEFAULT 25, -- 保持连接
  mtu INTEGER DEFAULT 1420,
  enabled INTEGER DEFAULT 1,               -- 是否启用
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
```

### 2.3 新建 split_rules 表

存储每客户端的分流规则：

```sql
CREATE TABLE split_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients_table(id) ON DELETE CASCADE,
  rule_type TEXT NOT NULL,                 -- 'domain' 或 'ip'
  rule_value TEXT NOT NULL,                -- 域名或IP/CIDR
  action TEXT DEFAULT 'proxy' NOT NULL,    -- 'proxy' 或 'direct'
  enabled INTEGER DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX idx_split_rules_client_id ON split_rules(client_id);
CREATE INDEX idx_split_rules_enabled ON split_rules(enabled);
```

### 2.4 数据库 Schema TypeScript 定义

```typescript
// src/server/database/repositories/upstream/schema.ts
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
  createdAt: text('created_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
  updatedAt: text('updated_at').notNull().default(sql`(CURRENT_TIMESTAMP)`)
    .$onUpdate(() => sql`(CURRENT_TIMESTAMP)`),
});

// src/server/database/repositories/splitRule/schema.ts
export const splitRule = sqliteTable('split_rules', {
  id: int().primaryKey({ autoIncrement: true }),
  clientId: int('client_id').notNull().references(() => client.id, {
    onDelete: 'cascade',
  }),
  ruleType: text('rule_type').notNull(), // 'domain' | 'ip'
  ruleValue: text('rule_value').notNull(),
  action: text().default('proxy').notNull(), // 'proxy' | 'direct'
  enabled: int({ mode: 'boolean' }).default(true).notNull(),
  createdAt: text('created_at').notNull().default(sql`(CURRENT_TIMESTAMP)`),
  updatedAt: text('updated_at').notNull().default(sql`(CURRENT_TIMESTAMP)`)
    .$onUpdate(() => sql`(CURRENT_TIMESTAMP)`),
});
```

---

## 三、网络配置方案

### 3.1 策略路由表设计

为每个客户端分配独立的路由表：

```bash
# /etc/iproute2/rt_tables
# 预留 100-200 给客户端使用
100 client_1
101 client_2
102 client_3
...
```

### 3.2 上游 WireGuard 接口管理

每个上游服务器使用独立的 WireGuard 接口：

```bash
# 上游接口命名: wg-up-{upstream_id}
# 例如: wg-up-1, wg-up-2

# 接口配置示例 (/etc/wireguard/wg-up-1.conf)
[Interface]
PrivateKey = <client_private_key>
Address = 10.10.0.2/32  # 上游分配的地址
MTU = 1420

[Peer]
PublicKey = <upstream_public_key>
PresharedKey = <preshared_key>
Endpoint = upstream.server.com:51820
AllowedIPs = 0.0.0.0/0
PersistentKeepalive = 25
```

### 3.3 dnsmasq 配置

```bash
# /etc/dnsmasq.d/split-tunneling.conf

# 为每个客户端生成专属配置
# 客户端 A (ID=1, IP=10.8.0.2)
# 域名分流规则: google.com, youtube.com

# 将特定域名的解析结果添加到 ipset
server=/google.com/1.1.1.1
server=/youtube.com/1.1.1.1
ipset=/google.com/client_1_proxy
ipset=/youtube.com/client_1_proxy

# 客户端 B (ID=2, IP=10.8.0.3)
# 域名分流规则: twitter.com
ipset=/twitter.com/client_2_proxy
```

### 3.4 iptables 规则

```bash
#!/bin/bash
# 为客户端配置流量标记和路由

CLIENT_ID=1
CLIENT_IP="10.8.0.2"
IPSET_NAME="client_${CLIENT_ID}_proxy"
FWMARK=$((100 + CLIENT_ID))
ROUTE_TABLE=$((100 + CLIENT_ID))
UPSTREAM_INTERFACE="wg-up-1"

# 创建 ipset（存储需要代理的 IP）
ipset create ${IPSET_NAME} hash:ip timeout 3600 -exist

# 标记来自该客户端且目标 IP 在 ipset 中的流量
iptables -t mangle -A PREROUTING \
  -s ${CLIENT_IP} \
  -m set --match-set ${IPSET_NAME} dst \
  -j MARK --set-mark ${FWMARK}

# 策略路由：标记的流量通过上游接口
ip rule add fwmark ${FWMARK} table ${ROUTE_TABLE} prio $((1000 + CLIENT_ID))
ip route add default dev ${UPSTREAM_INTERFACE} table ${ROUTE_TABLE}

# 对于 IP 规则（直接添加到 ipset）
# 例如: 8.8.8.8, 1.1.1.0/24
ipset add ${IPSET_NAME} 8.8.8.8
ipset add ${IPSET_NAME} 1.1.1.0/24
```

### 3.5 完整的路由链路

```
1. 客户端发起 DNS 查询 (google.com)
   ↓
2. dnsmasq 拦截查询
   - 检查是否命中客户端的分流域名
   - 解析域名获得 IP (例如 142.250.185.46)
   - 将 IP 添加到 ipset: client_1_proxy
   ↓
3. 客户端访问 142.250.185.46
   ↓
4. iptables mangle 表 PREROUTING 链
   - 匹配源 IP: 10.8.0.2
   - 匹配目标 IP 在 ipset: client_1_proxy
   - 标记流量: fwmark 101
   ↓
5. 路由决策
   - ip rule 匹配 fwmark 101
   - 查询路由表 101
   - 使用路由: default dev wg-up-1
   ↓
6. 流量通过 wg-up-1 发送到上游 WireGuard 服务器
```

---

## 四、代码实现

### 4.1 文件结构

```
src/server/
├── database/
│   ├── repositories/
│   │   ├── upstream/
│   │   │   ├── schema.ts          # 上游服务器表定义
│   │   │   ├── types.ts           # TypeScript 类型定义
│   │   │   └── service.ts         # CRUD 操作
│   │   └── splitRule/
│   │       ├── schema.ts          # 分流规则表定义
│   │       ├── types.ts
│   │       └── service.ts
│   └── migrations/
│       └── 0002_split_tunneling.sql  # 新增表的迁移脚本
├── utils/
│   ├── SplitTunneling.ts          # 分流管理核心类
│   ├── UpstreamManager.ts         # 上游接口管理
│   └── NetworkConfig.ts           # 网络配置（iptables/ipset/routing）
└── api/
    ├── upstream/
    │   ├── index.get.ts           # 获取上游服务器列表
    │   ├── index.post.ts          # 创建上游服务器
    │   └── [upstreamId]/
    │       ├── index.get.ts       # 获取单个上游服务器
    │       ├── index.post.ts      # 更新上游服务器
    │       ├── index.delete.ts    # 删除上游服务器
    │       └── toggle.post.ts     # 启用/禁用上游服务器
    └── splitRule/
        ├── [clientId]/
        │   ├── index.get.ts       # 获取客户端的分流规则
        │   ├── index.post.ts      # 创建分流规则
        │   └── [ruleId]/
        │       ├── index.delete.ts  # 删除规则
        │       └── index.post.ts    # 更新规则

src/app/
├── pages/
│   ├── clients/
│   │   └── [id].vue              # 扩展：添加上游和分流配置
│   └── upstream/
│       ├── index.vue             # 上游服务器列表
│       └── [id].vue              # 上游服务器详情/编辑
└── components/
    ├── SplitTunneling/
    │   ├── UpstreamSelector.vue   # 上游服务器选择器
    │   ├── RuleEditor.vue         # 分流规则编辑器
    │   └── RuleList.vue           # 分流规则列表
```

### 4.2 核心类实现

#### 4.2.1 SplitTunneling 管理类

```typescript
// src/server/utils/SplitTunneling.ts
import debug from 'debug';
import fs from 'node:fs/promises';

const ST_DEBUG = debug('SplitTunneling');

class SplitTunneling {
  /**
   * 为所有启用分流的客户端应用配置
   */
  async applyAllConfigs() {
    ST_DEBUG('Applying split tunneling configs for all clients...');
    
    const clients = await Database.clients.getAll();
    const upstreams = await Database.upstreams.getAll();
    
    // 1. 启动所有启用的上游接口
    for (const upstream of upstreams) {
      if (upstream.enabled) {
        await this.startUpstreamInterface(upstream);
      }
    }
    
    // 2. 为每个客户端配置分流
    for (const client of clients) {
      if (client.enabled && client.upstreamEnabled && client.upstreamId) {
        await this.applyClientConfig(client);
      }
    }
    
    // 3. 重新生成 dnsmasq 配置
    await this.generateDnsmasqConfig();
    await this.reloadDnsmasq();
    
    ST_DEBUG('Split tunneling configs applied successfully.');
  }
  
  /**
   * 启动上游 WireGuard 接口
   */
  async startUpstreamInterface(upstream: UpstreamServerType) {
    ST_DEBUG(`Starting upstream interface ${upstream.interfaceName}...`);
    
    // 生成 WireGuard 配置
    const config = this.generateUpstreamConfig(upstream);
    await fs.writeFile(
      `/etc/wireguard/${upstream.interfaceName}.conf`,
      config,
      { mode: 0o600 }
    );
    
    // 启动接口
    try {
      await exec(`wg-quick down ${upstream.interfaceName}`).catch(() => {});
      await exec(`wg-quick up ${upstream.interfaceName}`);
      ST_DEBUG(`Upstream interface ${upstream.interfaceName} started.`);
    } catch (err) {
      ST_DEBUG(`Failed to start ${upstream.interfaceName}:`, err);
      throw err;
    }
  }
  
  /**
   * 生成上游接口配置
   */
  generateUpstreamConfig(upstream: UpstreamServerType): string {
    const pskLine = upstream.presharedKey 
      ? `PresharedKey = ${upstream.presharedKey}` 
      : '';
    
    return `# Upstream: ${upstream.name}
[Interface]
PrivateKey = ${upstream.privateKey}
MTU = ${upstream.mtu}

[Peer]
PublicKey = ${upstream.publicKey}
${pskLine}
Endpoint = ${upstream.endpoint}
AllowedIPs = ${upstream.allowedIps.join(', ')}
PersistentKeepalive = ${upstream.persistentKeepalive}`;
  }
  
  /**
   * 为单个客户端应用分流配置
   */
  async applyClientConfig(client: ClientType) {
    const clientId = client.id;
    const clientIp = client.ipv4Address;
    const upstream = await Database.upstreams.get(client.upstreamId!);
    
    if (!upstream) {
      throw new Error(`Upstream ${client.upstreamId} not found`);
    }
    
    ST_DEBUG(`Applying split config for client ${clientId} (${clientIp})...`);
    
    // 获取分流规则
    const rules = await Database.splitRules.getByClientId(clientId);
    
    // 创建 ipset
    const ipsetName = `client_${clientId}_proxy`;
    await exec(`ipset create ${ipsetName} hash:ip timeout 3600 -exist`);
    await exec(`ipset flush ${ipsetName}`);
    
    // 添加 IP 规则到 ipset
    for (const rule of rules) {
      if (rule.enabled && rule.ruleType === 'ip' && rule.action === 'proxy') {
        await exec(`ipset add ${ipsetName} ${rule.ruleValue} -exist`);
      }
    }
    
    // 配置 iptables 标记
    const fwmark = 100 + clientId;
    const routeTable = 100 + clientId;
    
    // 清理旧规则
    await this.cleanupClientRules(clientId);
    
    // 添加新规则
    await exec(
      `iptables -t mangle -A PREROUTING ` +
      `-s ${clientIp} ` +
      `-m set --match-set ${ipsetName} dst ` +
      `-j MARK --set-mark ${fwmark}`
    );
    
    // 配置策略路由
    await exec(`ip rule add fwmark ${fwmark} table ${routeTable} prio ${1000 + clientId}`);
    await exec(`ip route add default dev ${upstream.interfaceName} table ${routeTable}`);
    
    ST_DEBUG(`Client ${clientId} config applied.`);
  }
  
  /**
   * 清理客户端的路由规则
   */
  async cleanupClientRules(clientId: number) {
    const ipsetName = `client_${clientId}_proxy`;
    const fwmark = 100 + clientId;
    const routeTable = 100 + clientId;
    
    // 删除 iptables 规则
    await exec(
      `iptables -t mangle -D PREROUTING ` +
      `-m set --match-set ${ipsetName} dst ` +
      `-j MARK --set-mark ${fwmark}`
    ).catch(() => {});
    
    // 删除策略路由
    await exec(`ip rule del fwmark ${fwmark} table ${routeTable}`).catch(() => {});
    await exec(`ip route flush table ${routeTable}`).catch(() => {});
  }
  
  /**
   * 生成 dnsmasq 配置
   */
  async generateDnsmasqConfig() {
    ST_DEBUG('Generating dnsmasq configuration...');
    
    const clients = await Database.clients.getAll();
    const lines: string[] = [
      '# Auto-generated by wg-easy split tunneling',
      '# Do not edit manually',
      '',
    ];
    
    for (const client of clients) {
      if (!client.enabled || !client.upstreamEnabled) continue;
      
      const rules = await Database.splitRules.getByClientId(client.id);
      const ipsetName = `client_${client.id}_proxy`;
      
      lines.push(`# Client: ${client.name} (ID=${client.id})`);
      
      for (const rule of rules) {
        if (rule.enabled && rule.ruleType === 'domain' && rule.action === 'proxy') {
          const domain = rule.ruleValue;
          lines.push(`ipset=/${domain}/${ipsetName}`);
        }
      }
      
      lines.push('');
    }
    
    await fs.writeFile('/etc/dnsmasq.d/split-tunneling.conf', lines.join('\n'));
    ST_DEBUG('dnsmasq configuration generated.');
  }
  
  /**
   * 重载 dnsmasq
   */
  async reloadDnsmasq() {
    ST_DEBUG('Reloading dnsmasq...');
    await exec('killall -HUP dnsmasq').catch(() => {
      ST_DEBUG('dnsmasq not running, starting it...');
      // 如果 dnsmasq 未运行，这里可以启动它
      // 或者在 Dockerfile 中确保 dnsmasq 作为服务运行
    });
  }
  
  /**
   * 停止上游接口
   */
  async stopUpstreamInterface(interfaceName: string) {
    ST_DEBUG(`Stopping upstream interface ${interfaceName}...`);
    await exec(`wg-quick down ${interfaceName}`).catch(() => {});
  }
  
  /**
   * 清理所有分流配置
   */
  async cleanup() {
    ST_DEBUG('Cleaning up split tunneling configs...');
    
    const upstreams = await Database.upstreams.getAll();
    for (const upstream of upstreams) {
      await this.stopUpstreamInterface(upstream.interfaceName);
    }
    
    // 清理所有 ipset
    await exec('ipset destroy').catch(() => {});
    
    // 清理 iptables mangle 表
    await exec('iptables -t mangle -F').catch(() => {});
    
    // 清理策略路由
    for (let i = 100; i < 200; i++) {
      await exec(`ip rule del table ${i}`).catch(() => {});
      await exec(`ip route flush table ${i}`).catch(() => {});
    }
  }
}

export default new SplitTunneling();
```

#### 4.2.2 数据库 Service 实现

```typescript
// src/server/database/repositories/upstream/service.ts
import { eq } from 'drizzle-orm';
import { upstreamServer } from './schema';
import type { CreateUpstreamType, UpdateUpstreamType } from './types';
import type { DBType } from '#db/sqlite';

export class UpstreamService {
  #db: DBType;
  
  constructor(db: DBType) {
    this.#db = db;
  }
  
  async getAll() {
    return await this.#db.query.upstreamServer.findMany();
  }
  
  async get(id: ID) {
    return await this.#db.query.upstreamServer.findFirst({
      where: eq(upstreamServer.id, id)
    });
  }
  
  async create(data: CreateUpstreamType) {
    // 自动生成接口名
    const upstreams = await this.getAll();
    const interfaceName = `wg-up-${upstreams.length + 1}`;
    
    return await this.#db.insert(upstreamServer).values({
      ...data,
      interfaceName,
    }).returning();
  }
  
  async update(id: ID, data: UpdateUpstreamType) {
    return await this.#db.update(upstreamServer)
      .set(data)
      .where(eq(upstreamServer.id, id));
  }
  
  async delete(id: ID) {
    return await this.#db.delete(upstreamServer)
      .where(eq(upstreamServer.id, id));
  }
  
  async toggle(id: ID, enabled: boolean) {
    return await this.#db.update(upstreamServer)
      .set({ enabled })
      .where(eq(upstreamServer.id, id));
  }
}

// src/server/database/repositories/splitRule/service.ts
import { eq, and } from 'drizzle-orm';
import { splitRule } from './schema';
import type { CreateSplitRuleType, UpdateSplitRuleType } from './types';
import type { DBType } from '#db/sqlite';

export class SplitRuleService {
  #db: DBType;
  
  constructor(db: DBType) {
    this.#db = db;
  }
  
  async getByClientId(clientId: ID) {
    return await this.#db.query.splitRule.findMany({
      where: eq(splitRule.clientId, clientId)
    });
  }
  
  async create(data: CreateSplitRuleType) {
    return await this.#db.insert(splitRule).values(data).returning();
  }
  
  async update(id: ID, data: UpdateSplitRuleType) {
    return await this.#db.update(splitRule)
      .set(data)
      .where(eq(splitRule.id, id));
  }
  
  async delete(id: ID) {
    return await this.#db.delete(splitRule)
      .where(eq(splitRule.id, id));
  }
  
  async toggle(id: ID, enabled: boolean) {
    return await this.#db.update(splitRule)
      .set({ enabled })
      .where(eq(splitRule.id, id));
  }
}
```

#### 4.2.3 API 端点实现示例

```typescript
// src/server/api/upstream/index.get.ts
export default definePermissionEventHandler(
  'upstream',
  'read',
  async () => {
    const upstreams = await Database.upstreams.getAll();
    return { upstreams };
  }
);

// src/server/api/upstream/index.post.ts
export default definePermissionEventHandler(
  'upstream',
  'create',
  async ({ event }) => {
    const data = await readValidatedBody(
      event,
      validateZod(UpstreamCreateSchema, event)
    );
    
    const result = await Database.upstreams.create(data);
    await SplitTunneling.applyAllConfigs();
    
    return { success: true, upstreamId: result[0].id };
  }
);

// src/server/api/splitRule/[clientId]/index.post.ts
export default definePermissionEventHandler(
  'splitRules',
  'create',
  async ({ event }) => {
    const { clientId } = await getValidatedRouterParams(
      event,
      validateZod(ClientGetSchema, event)
    );
    
    const data = await readValidatedBody(
      event,
      validateZod(SplitRuleCreateSchema, event)
    );
    
    await Database.splitRules.create({
      ...data,
      clientId,
    });
    
    await SplitTunneling.applyAllConfigs();
    
    return { success: true };
  }
);
```

### 4.3 前端 UI 实现

#### 4.3.1 扩展客户端编辑页面

```vue
<!-- src/app/pages/clients/[id].vue -->
<template>
  <main v-if="data">
    <Panel>
      <!-- 现有字段... -->
      
      <!-- 新增：上游服务器配置 -->
      <FormGroup>
        <FormHeading>{{ $t('splitTunneling.upstream') }}</FormHeading>
        <FormSwitchField
          id="upstreamEnabled"
          v-model="data.upstreamEnabled"
          :label="$t('splitTunneling.enableUpstream')"
          :description="$t('splitTunneling.enableUpstreamDesc')"
        />
        <FormSelectField
          v-if="data.upstreamEnabled"
          id="upstreamId"
          v-model="data.upstreamId"
          :label="$t('splitTunneling.upstreamServer')"
          :options="upstreamOptions"
        />
      </FormGroup>
      
      <!-- 新增：分流规则配置 -->
      <FormGroup v-if="data.upstreamEnabled">
        <FormHeading :description="$t('splitTunneling.rulesDesc')">
          {{ $t('splitTunneling.rules') }}
        </FormHeading>
        <SplitTunnelingRuleList 
          :client-id="data.id"
          @rules-changed="refreshRules"
        />
      </FormGroup>
    </Panel>
  </main>
</template>

<script lang="ts" setup>
// 获取上游服务器列表
const { data: upstreamsData } = await useFetch('/api/upstream', {
  method: 'get',
});

const upstreamOptions = computed(() => {
  return upstreamsData.value?.upstreams.map(u => ({
    label: u.name,
    value: u.id,
  })) || [];
});

// 现有代码...
</script>
```

#### 4.3.2 分流规则编辑组件

```vue
<!-- src/app/components/SplitTunneling/RuleList.vue -->
<template>
  <div class="space-y-4">
    <!-- 规则列表 -->
    <div v-for="rule in rules" :key="rule.id" class="flex items-center gap-2">
      <Badge :variant="rule.ruleType === 'domain' ? 'blue' : 'green'">
        {{ rule.ruleType }}
      </Badge>
      <span>{{ rule.ruleValue }}</span>
      <Badge :variant="rule.action === 'proxy' ? 'purple' : 'gray'">
        {{ rule.action }}
      </Badge>
      <Button @click="deleteRule(rule.id)" variant="danger" size="sm">
        Delete
      </Button>
    </div>
    
    <!-- 添加规则表单 -->
    <form @submit.prevent="addRule" class="flex gap-2">
      <select v-model="newRule.ruleType">
        <option value="domain">Domain</option>
        <option value="ip">IP/CIDR</option>
      </select>
      <input 
        v-model="newRule.ruleValue" 
        :placeholder="newRule.ruleType === 'domain' ? 'google.com' : '8.8.8.8/32'"
        class="flex-1"
      />
      <select v-model="newRule.action">
        <option value="proxy">Proxy</option>
        <option value="direct">Direct</option>
      </select>
      <Button type="submit">Add</Button>
    </form>
  </div>
</template>

<script lang="ts" setup>
const props = defineProps<{
  clientId: number;
}>();

const { data: rulesData, refresh } = await useFetch(
  `/api/splitRule/${props.clientId}`,
  { method: 'get' }
);

const rules = computed(() => rulesData.value?.rules || []);

const newRule = ref({
  ruleType: 'domain',
  ruleValue: '',
  action: 'proxy',
});

async function addRule() {
  await $fetch(`/api/splitRule/${props.clientId}`, {
    method: 'post',
    body: newRule.value,
  });
  
  newRule.value.ruleValue = '';
  await refresh();
}

async function deleteRule(ruleId: number) {
  await $fetch(`/api/splitRule/${props.clientId}/${ruleId}`, {
    method: 'delete',
  });
  await refresh();
}
</script>
```

#### 4.3.3 上游服务器管理页面

```vue
<!-- src/app/pages/upstream/index.vue -->
<template>
  <main>
    <Panel>
      <PanelHead>
        <PanelHeadTitle text="Upstream Servers" />
        <Button @click="showCreateDialog = true">Add Upstream</Button>
      </PanelHead>
      <PanelBody>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Interface</th>
              <th>Endpoint</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="upstream in upstreams" :key="upstream.id">
              <td>{{ upstream.name }}</td>
              <td>{{ upstream.interfaceName }}</td>
              <td>{{ upstream.endpoint }}</td>
              <td>
                <Badge :variant="upstream.enabled ? 'success' : 'gray'">
                  {{ upstream.enabled ? 'Enabled' : 'Disabled' }}
                </Badge>
              </td>
              <td>
                <Button @click="editUpstream(upstream.id)">Edit</Button>
                <Button @click="deleteUpstream(upstream.id)" variant="danger">
                  Delete
                </Button>
              </td>
            </tr>
          </tbody>
        </table>
      </PanelBody>
    </Panel>
  </main>
</template>

<script lang="ts" setup>
const { data, refresh } = await useFetch('/api/upstream', {
  method: 'get',
});

const upstreams = computed(() => data.value?.upstreams || []);

// 实现 CRUD 操作...
</script>
```

---

## 五、Dockerfile 扩展

需要在容器中安装 dnsmasq 和 ipset：

```dockerfile
# Dockerfile (在现有基础上添加)
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
    dnsmasq \           # 添加
    ipset \             # 添加
    iproute2            # 添加（通常已包含）

# Configure dnsmasq
RUN mkdir -p /etc/dnsmasq.d && \
    echo "conf-dir=/etc/dnsmasq.d/,*.conf" > /etc/dnsmasq.conf && \
    echo "no-resolv" >> /etc/dnsmasq.conf && \
    echo "server=1.1.1.1" >> /etc/dnsmasq.conf && \
    echo "server=8.8.8.8" >> /etc/dnsmasq.conf

# ... 其余内容 ...
```

---

## 六、数据库迁移脚本

```sql
-- src/server/database/migrations/0002_split_tunneling.sql

-- 创建上游服务器表
CREATE TABLE `upstream_servers` (
  `id` INTEGER PRIMARY KEY AUTOINCREMENT,
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

-- 创建分流规则表
CREATE TABLE `split_rules` (
  `id` INTEGER PRIMARY KEY AUTOINCREMENT,
  `client_id` INTEGER NOT NULL,
  `rule_type` TEXT NOT NULL,
  `rule_value` TEXT NOT NULL,
  `action` TEXT DEFAULT 'proxy' NOT NULL,
  `enabled` INTEGER DEFAULT 1 NOT NULL,
  `created_at` TEXT DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
  `updated_at` TEXT DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
  FOREIGN KEY (`client_id`) REFERENCES `clients_table`(`id`) ON DELETE CASCADE
);

-- 创建索引
CREATE INDEX `idx_split_rules_client_id` ON `split_rules`(`client_id`);
CREATE INDEX `idx_split_rules_enabled` ON `split_rules`(`enabled`);

-- 扩展客户端表
ALTER TABLE `clients_table` ADD COLUMN `upstream_enabled` INTEGER DEFAULT 0 NOT NULL;
ALTER TABLE `clients_table` ADD COLUMN `upstream_id` INTEGER REFERENCES `upstream_servers`(`id`) ON DELETE SET NULL;
```

---

## 七、启动集成

需要在应用启动时初始化分流功能：

```typescript
// src/server/utils/WireGuard.ts (扩展 Startup 方法)
async Startup() {
  WG_DEBUG('Starting WireGuard...');
  
  // 现有 WireGuard 启动逻辑...
  
  // 新增：启动分流功能
  WG_DEBUG('Starting Split Tunneling...');
  try {
    // 启动 dnsmasq
    await exec('dnsmasq').catch(() => {
      WG_DEBUG('dnsmasq already running or failed to start');
    });
    
    // 应用分流配置
    await SplitTunneling.applyAllConfigs();
    WG_DEBUG('Split Tunneling started successfully.');
  } catch (err) {
    WG_DEBUG('Failed to start Split Tunneling:', err);
    // 不阻塞主进程
  }
  
  // ... 其余启动逻辑
}

async Shutdown() {
  const wgInterface = await Database.interfaces.get();
  await wg.down(wgInterface.name).catch(() => {});
  
  // 新增：清理分流配置
  await SplitTunneling.cleanup();
}
```

---

## 八、实施步骤

### 第一阶段：数据库和基础结构 (第 1-2 周)

1. ✅ 创建数据库迁移脚本
2. ✅ 定义 TypeScript 类型和 Schema
3. ✅ 实现 Service 层（CRUD 操作）
4. ✅ 扩展 `clients_table` 添加上游相关字段

### 第二阶段：网络配置核心 (第 3-4 周)

5. ✅ 实现 `SplitTunneling` 类
   - 上游接口管理
   - ipset 管理
   - iptables 规则管理
   - 策略路由配置
6. ✅ 实现 dnsmasq 配置生成和管理
7. ✅ 集成到 WireGuard 启动流程
8. ✅ 测试单客户端分流功能

### 第三阶段：API 端点 (第 5 周)

9. ✅ 实现上游服务器 CRUD API
10. ✅ 实现分流规则 CRUD API
11. ✅ 扩展客户端 API（添加上游配置）
12. ✅ API 测试和调试

### 第四阶段：前端 UI (第 6-7 周)

13. ✅ 创建上游服务器管理页面
14. ✅ 创建分流规则编辑组件
15. ✅ 扩展客户端编辑页面
16. ✅ 国际化 (i18n) 翻译
17. ✅ UI/UX 优化

### 第五阶段：测试和优化 (第 8 周)

18. ✅ 多客户端并发测试
19. ✅ 性能测试和优化
20. ✅ 边界条件测试
21. ✅ 文档编写

---

## 九、技术难点和解决方案

### 9.1 多客户端流量隔离

**难点**: 如何准确识别和隔离不同客户端的流量？

**解决方案**:
- 使用源 IP 地址（客户端在 wg0 的 IP）作为唯一标识
- 每个客户端独立的 ipset 存储其需要代理的目标 IP
- iptables mangle 表通过 `-s <client_ip> -m set --match-set <ipset> dst` 精确匹配

### 9.2 动态 DNS 解析和 IP 映射

**难点**: 域名可能解析到多个 IP，且 IP 会变化

**解决方案**:
- dnsmasq 的 `ipset` 功能自动将 DNS 查询结果添加到 ipset
- ipset 设置超时时间（如 3600 秒），过期自动清理
- DNS 缓存刷新时自动更新 ipset

### 9.3 路由表数量限制

**难点**: Linux 默认路由表数量有限（0-255）

**解决方案**:
- 为客户端分配路由表 100-200（支持 100 个客户端）
- 如需更多，可扩展到 200-300
- 实际场景中 100 个客户端已足够

### 9.4 性能优化

**难点**: 大量客户端和规则可能影响性能

**解决方案**:
1. **ipset 优化**: 使用 hash:ip 而非 list，O(1) 查找
2. **iptables 规则优化**: 
   - 只为启用分流的客户端添加规则
   - 使用 ipset 而非多条 iptables 规则
3. **dnsmasq 缓存**: 减少上游 DNS 查询
4. **批量更新**: 配置变更时批量应用，而非逐条更新

### 9.5 上游接口数量管理

**难点**: 每个上游服务器需要独立的 WireGuard 接口

**解决方案**:
- 接口名格式: `wg-up-{id}` (wg-up-1, wg-up-2...)
- 支持多个客户端共享同一个上游服务器（共享接口）
- 删除上游服务器时检查是否有客户端在使用

### 9.6 配置持久化

**难点**: 重启后需要恢复所有配置

**解决方案**:
- 所有配置存储在 SQLite 数据库
- 启动时从数据库重建所有网络配置
- dnsmasq 配置文件自动生成

---

## 十、监控和调试

### 10.1 日志记录

```typescript
// 在 SplitTunneling 类中添加详细日志
ST_DEBUG(`Client ${clientId}: Applied ${rules.length} rules`);
ST_DEBUG(`Upstream ${upstreamId}: Interface ${interfaceName} started`);
ST_DEBUG(`ipset ${ipsetName}: Added ${ipCount} IPs`);
```

### 10.2 调试命令

```bash
# 查看 ipset 内容
ipset list client_1_proxy

# 查看 iptables mangle 表
iptables -t mangle -L -n -v

# 查看策略路由
ip rule list
ip route show table 101

# 查看 WireGuard 接口状态
wg show wg-up-1

# 测试 DNS 解析
dig @127.0.0.1 google.com

# 查看 dnsmasq 日志
tail -f /var/log/dnsmasq.log  # 需要配置日志
```

### 10.3 健康检查

添加 API 端点检查分流状态：

```typescript
// src/server/api/splitTunneling/status.get.ts
export default definePermissionEventHandler(
  'splitTunneling',
  'read',
  async () => {
    const clients = await Database.clients.getAll();
    const upstreams = await Database.upstreams.getAll();
    
    const status = {
      totalClients: clients.length,
      activeClients: clients.filter(c => c.enabled && c.upstreamEnabled).length,
      totalUpstreams: upstreams.length,
      activeUpstreams: upstreams.filter(u => u.enabled).length,
      upstreamInterfaces: [],
    };
    
    for (const upstream of upstreams.filter(u => u.enabled)) {
      try {
        const dump = await wg.dump(upstream.interfaceName);
        status.upstreamInterfaces.push({
          name: upstream.interfaceName,
          status: 'up',
          peers: dump.length,
        });
      } catch {
        status.upstreamInterfaces.push({
          name: upstream.interfaceName,
          status: 'down',
        });
      }
    }
    
    return status;
  }
);
```

---

## 十一、安全考虑

### 11.1 权限管理

- 限制普通用户只能查看/编辑自己的客户端
- 上游服务器管理仅限管理员
- 敏感信息（私钥）不在 API 中返回

### 11.2 输入验证

```typescript
// 域名验证
const DomainSchema = z.string().regex(
  /^([a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/,
  'Invalid domain format'
);

// IP/CIDR 验证
const IpCidrSchema = z.string().refine(
  (val) => {
    try {
      parseCidr(val);
      return true;
    } catch {
      return false;
    }
  },
  'Invalid IP or CIDR format'
);
```

### 11.3 防止路由泄漏

确保未匹配的流量不会意外进入上游通道：

```bash
# 默认拒绝来自 wg0 的未标记流量
iptables -A FORWARD -i wg0 -m mark --mark 0 -j ACCEPT  # 允许未标记流量（直连）
# 如果需要更严格的控制，可以设置白名单
```

---

## 十二、性能基准

### 预期性能指标

| 指标 | 目标值 |
|------|--------|
| 单客户端吞吐量 | >500 Mbps |
| 并发客户端数 | 100+ |
| 路由决策延迟 | <1ms |
| DNS 查询延迟 | <10ms |
| 规则更新延迟 | <2s |

### 资源占用

| 资源 | 基础 | 每客户端增量 | 每上游增量 |
|------|------|--------------|------------|
| 内存 | 200MB | +5MB | +10MB |
| CPU (空闲) | 2% | +0.1% | +0.5% |
| 带宽 (开销) | - | +2% | +5% (封装) |

---

## 十三、扩展功能（可选）

### 13.1 智能分流

- 根据流量统计自动优化路由
- GeoIP 分流（根据目标国家）
- 应用层协议识别（HTTP/HTTPS/DNS）

### 13.2 负载均衡

- 多个上游服务器之间负载均衡
- 故障自动切换

### 13.3 流量统计

- 每客户端的代理流量 vs 直连流量统计
- 每个上游服务器的流量统计
- 实时图表显示

### 13.4 规则模板

- 预定义规则集（如"Google 服务"、"社交媒体"）
- 一键应用规则模板

---

## 十四、总结

该方案通过以下技术栈实现每客户端独立的 WireGuard 分流：

1. **数据层**: SQLite 存储配置（上游服务器、分流规则）
2. **网络层**: 
   - WireGuard 多接口（wg0 + wg-up-*）
   - dnsmasq + ipset（域名分流）
   - iptables + iproute2（流量标记和策略路由）
3. **应用层**: Nuxt 3 Web UI + RESTful API
4. **管理层**: 自动化配置生成和应用

**核心优势**:
- ✅ 完全独立的客户端配置
- ✅ 动态规则更新
- ✅ 高性能（基于内核网络栈）
- ✅ 易于管理（Web UI）
- ✅ 可扩展架构

**实施时间**: 约 8 周（包含测试和优化）

**技术风险**: 
- 中等：需要深入理解 Linux 网络栈
- 需要充分测试边界条件
- 文档和调试工具很重要

---

## 附录：参考资料

1. WireGuard 官方文档: https://www.wireguard.com/
2. iptables 手册: https://linux.die.net/man/8/iptables
3. ipset 文档: https://ipset.netfilter.org/
4. dnsmasq 手册: http://www.thekelleys.org.uk/dnsmasq/doc.html
5. iproute2 策略路由: https://lartc.org/howto/

---

## 附录：快速开始示例

### 手动测试流程

```bash
# 1. 创建上游服务器
curl -X POST http://localhost:51821/api/upstream \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Upstream US",
    "endpoint": "us.example.com:51820",
    "publicKey": "xxx",
    "privateKey": "yyy",
    "allowedIps": ["0.0.0.0/0"]
  }'

# 2. 为客户端启用上游和分流
curl -X POST http://localhost:51821/api/client/1 \
  -H "Content-Type: application/json" \
  -d '{
    "upstreamEnabled": true,
    "upstreamId": 1
  }'

# 3. 添加分流规则
curl -X POST http://localhost:51821/api/splitRule/1 \
  -H "Content-Type: application/json" \
  -d '{
    "ruleType": "domain",
    "ruleValue": "google.com",
    "action": "proxy"
  }'

# 4. 验证配置
ipset list client_1_proxy
iptables -t mangle -L -n
ip rule list
```

### 客户端测试

```bash
# 在客户端设备上
# 1. 连接到 wg-easy
wg-quick up client_a

# 2. 测试直连（应该显示本地 IP）
curl ipinfo.io

# 3. 测试代理（访问 google.com，应该通过上游服务器）
curl -H "Host: google.com" http://142.250.185.46/
# 检查响应头中的服务器信息

# 4. 检查路由
traceroute google.com
```

---

**文档版本**: v1.0  
**最后更新**: 2025-10-02  
**作者**: AI Assistant  
**项目**: wg-easy Split Tunneling Feature
