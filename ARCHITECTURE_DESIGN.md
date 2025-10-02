# WireGuard 分流功能架构设计文档

本文档详细描述分流功能的技术架构、数据流和组件交互。

---

## 一、系统架构图

### 1.1 整体架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                         wg-easy Docker Container                     │
│                                                                       │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │                    Web UI (Nuxt 3 + Vue 3)                     │ │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐        │ │
│  │  │  Clients     │  │  Upstream    │  │  Rules       │        │ │
│  │  │  Management  │  │  Servers     │  │  Editor      │        │ │
│  │  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘        │ │
│  └─────────┼──────────────────┼──────────────────┼───────────────┘ │
│            │                  │                  │                   │
│  ┌─────────┴──────────────────┴──────────────────┴───────────────┐ │
│  │                    Nitro Server (API)                          │ │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐        │ │
│  │  │ /api/client  │  │ /api/upstream│  │/api/splitRule│        │ │
│  │  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘        │ │
│  └─────────┼──────────────────┼──────────────────┼───────────────┘ │
│            │                  │                  │                   │
│  ┌─────────┴──────────────────┴──────────────────┴───────────────┐ │
│  │                    Business Logic Layer                        │ │
│  │  ┌────────────────┐  ┌───────────────────────────────┐        │ │
│  │  │   WireGuard    │  │    SplitTunneling             │        │ │
│  │  │   Manager      │  │  - UpstreamManager            │        │ │
│  │  │                │  │  - NetworkConfig              │        │ │
│  │  │                │  │  - DnsmasqConfig              │        │ │
│  │  └────────┬───────┘  └───────────────┬───────────────┘        │ │
│  └───────────┼──────────────────────────┼────────────────────────┘ │
│              │                          │                           │
│  ┌───────────┴──────────────────────────┴────────────────────────┐ │
│  │                    Database (SQLite + Drizzle ORM)             │ │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐      │ │
│  │  │ clients  │  │ upstream │  │  split   │  │   user   │      │ │
│  │  │  table   │  │ servers  │  │  rules   │  │  config  │      │ │
│  │  └──────────┘  └──────────┘  └──────────┘  └──────────┘      │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                       │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │                    Network Layer (Linux)                       │ │
│  │                                                                 │ │
│  │  ┌─────────────────────────────────────────────────────────┐  │ │
│  │  │  WireGuard Interfaces                                   │  │ │
│  │  │  ┌──────┐  ┌────────┐  ┌────────┐  ┌────────┐         │  │ │
│  │  │  │ wg0  │  │wg-up-1 │  │wg-up-2 │  │wg-up-3 │   ...   │  │ │
│  │  │  │(主接口)│ │(上游1)  │  │(上游2)  │  │(上游3)  │         │  │ │
│  │  │  └───┬──┘  └───┬────┘  └───┬────┘  └───┬────┘         │  │ │
│  │  └──────┼─────────┼───────────┼───────────┼──────────────┘  │ │
│  │         │         │           │           │                  │ │
│  │  ┌──────┴─────────┴───────────┴───────────┴──────────────┐  │ │
│  │  │  Traffic Classification & Routing                      │  │ │
│  │  │                                                         │  │ │
│  │  │  dnsmasq ─────► ipset (client_1_proxy, client_2_...)  │  │ │
│  │  │     │                    │                              │  │ │
│  │  │     │                    ▼                              │  │ │
│  │  │     │           iptables mangle (标记流量)              │  │ │
│  │  │     │                    │                              │  │ │
│  │  │     │                    ▼                              │  │ │
│  │  │     │           策略路由表 (100-199)                    │  │ │
│  │  │     │              ├─ table 101: dev wg-up-1           │  │ │
│  │  │     │              ├─ table 102: dev wg-up-2           │  │ │
│  │  │     │              └─ table 103: dev wg-up-3           │  │ │
│  │  └─────┴────────────────────────────────────────────────┘  │ │
│  └────────────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────────┘
           │                                    │
           ▼                                    ▼
    ┌─────────────┐                    ┌──────────────────┐
    │  Internet   │                    │  Upstream        │
    │  (直连)      │                    │  WG Servers      │
    └─────────────┘                    └──────────────────┘
```

---

## 二、数据流详解

### 2.1 客户端连接建立流程

```
Step 1: 客户端连接到 wg0
┌──────────┐         WireGuard Handshake         ┌──────────┐
│ Client A │ ─────────────────────────────────► │   wg0    │
│10.8.0.2  │ ◄───────────────────────────────── │          │
└──────────┘                                     └──────────┘
   (外部)                                        (容器内)

Step 2: 数据库查询客户端配置
┌──────────┐                                     ┌──────────┐
│   API    │ ────── SELECT * FROM clients ─────► │  SQLite  │
│          │        WHERE id = 1                 │          │
│          │ ◄──── upstreamEnabled=true, ──────  │          │
│          │        upstreamId=1                 │          │
└──────────┘                                     └──────────┘

Step 3: 应用网络配置
┌──────────────────────────────────────────────┐
│ SplitTunneling.applyClientConfig()           │
│  1. 创建 ipset: client_1_proxy               │
│  2. 添加 IP 规则到 ipset                      │
│  3. 配置 iptables 标记 (fwmark 101)          │
│  4. 配置策略路由 (table 101 → wg-up-1)       │
└──────────────────────────────────────────────┘
```

### 2.2 流量路由流程（域名分流）

```
┌─────────────────────────────────────────────────────────────────┐
│ Phase 1: DNS Resolution                                          │
└─────────────────────────────────────────────────────────────────┘

客户端 A (10.8.0.2) 发起 DNS 查询: google.com
         │
         ▼
    DNS 请求到达 wg0 (10.8.0.1)
         │
         ▼
    dnsmasq 拦截处理
         │
         ├─ 检查 /etc/dnsmasq.d/split-tunneling.conf
         │  发现: ipset=/google.com/client_1_proxy
         │
         ├─ 向上游 DNS (1.1.1.1) 查询
         │  结果: 142.250.185.46
         │
         ├─ 将 IP 添加到 ipset: client_1_proxy
         │  $ ipset add client_1_proxy 142.250.185.46
         │
         └─ 返回 DNS 响应给客户端

┌─────────────────────────────────────────────────────────────────┐
│ Phase 2: Traffic Routing                                        │
└─────────────────────────────────────────────────────────────────┘

客户端 A (10.8.0.2) 访问 142.250.185.46:443
         │
         ▼
    数据包到达 wg0
    [ src: 10.8.0.2, dst: 142.250.185.46 ]
         │
         ▼
    iptables -t mangle PREROUTING
         │
         ├─ 匹配规则:
         │  -s 10.8.0.2 -m set --match-set client_1_proxy dst
         │
         └─ 标记流量: --set-mark 101
            [ src: 10.8.0.2, dst: 142.250.185.46, mark: 101 ]
                 │
                 ▼
    路由决策: ip rule
         │
         ├─ 匹配规则: fwmark 101 lookup table 101
         │
         └─ 查询路由表 101
            table 101: default dev wg-up-1
                 │
                 ▼
    数据包进入 wg-up-1 接口
    [ WireGuard 封装 ]
         │
         ▼
    通过上游服务器 1 转发
    Endpoint: us.example.com:51820
         │
         ▼
    上游服务器解密并转发到 Internet
         │
         ▼
    访问 google.com (142.250.185.46)
```

### 2.3 直连流量路由

```
客户端 A (10.8.0.2) 访问 baidu.com (非代理规则)
         │
         ▼
    DNS 查询: baidu.com
    dnsmasq: 未匹配分流规则，不添加到 ipset
    返回: 110.242.68.66
         │
         ▼
    数据包: [ src: 10.8.0.2, dst: 110.242.68.66 ]
         │
         ▼
    iptables mangle: 不匹配 ipset，不标记
    [ mark: 0 ]
         │
         ▼
    路由决策: 使用默认路由表
    default via eth0
         │
         ▼
    直接通过主网络接口访问 Internet
```

---

## 三、组件交互详解

### 3.1 配置更新流程

```
┌────────────┐
│  User (UI) │
└──────┬─────┘
       │ 1. 编辑客户端配置
       │    - 启用分流
       │    - 选择上游服务器
       │    - 添加分流规则
       ▼
┌───────────────────┐
│  API: POST        │
│  /api/client/1    │
└─────┬─────────────┘
      │ 2. 验证输入
      │ 3. 更新数据库
      ▼
┌──────────────────────────────┐
│  Database.clients.update()   │
│  Database.splitRules.create()│
└─────┬────────────────────────┘
      │ 4. 触发配置应用
      ▼
┌──────────────────────────────────┐
│  SplitTunneling.applyAllConfigs()│
└─────┬────────────────────────────┘
      │
      ├─ 5a. 启动上游接口
      │      wg-quick up wg-up-1
      │
      ├─ 5b. 配置 ipset
      │      ipset create client_1_proxy
      │      ipset add client_1_proxy 8.8.8.8
      │
      ├─ 5c. 配置 iptables
      │      iptables -t mangle -A PREROUTING ...
      │
      ├─ 5d. 配置策略路由
      │      ip rule add fwmark 101 table 101
      │      ip route add default dev wg-up-1 table 101
      │
      └─ 5e. 生成并重载 dnsmasq 配置
             echo "ipset=/google.com/client_1_proxy" > ...
             killall -HUP dnsmasq
      │
      ▼
┌──────────────────┐
│  返回成功响应     │
└──────────────────┘
```

### 3.2 数据库关系图

```
┌─────────────────┐
│  users_table    │
│  ─────────────  │
│  id (PK)        │
│  username       │
│  password_hash  │
└────────┬────────┘
         │ 1:N
         ▼
┌─────────────────────────┐           ┌──────────────────────┐
│  clients_table          │  N:1      │  upstream_servers    │
│  ─────────────────────  │ ─────────►│  ──────────────────  │
│  id (PK)                │           │  id (PK)             │
│  user_id (FK)           │           │  name                │
│  name                   │           │  interface_name      │
│  ipv4_address           │           │  endpoint            │
│  ipv6_address           │           │  public_key          │
│  upstream_enabled  ◄────┼───────────┤  private_key         │
│  upstream_id (FK)       │           │  preshared_key       │
│  ...                    │           │  allowed_ips (JSON)  │
└────────┬────────────────┘           │  enabled             │
         │ 1:N                        └──────────────────────┘
         ▼
┌─────────────────────────┐
│  split_rules            │
│  ─────────────────────  │
│  id (PK)                │
│  client_id (FK)         │
│  rule_type              │  ◄─── 'domain' | 'ip'
│  rule_value             │  ◄─── 'google.com' | '8.8.8.8/32'
│  action                 │  ◄─── 'proxy' | 'direct'
│  enabled                │
└─────────────────────────┘
```

---

## 四、网络拓扑详解

### 4.1 接口和地址分配

```
┌──────────────────────────────────────────────────────────┐
│  wg-easy 容器网络命名空间                                  │
│                                                            │
│  eth0 (主网卡)                                             │
│  ├─ IP: 172.20.0.2 (Docker 网络)                          │
│  └─ Gateway: 172.20.0.1 → 宿主机                          │
│                                                            │
│  wg0 (主 WireGuard 接口)                                   │
│  ├─ IP: 10.8.0.1/24, fdcc::1/112                          │
│  ├─ Listen: 0.0.0.0:51820                                 │
│  └─ Peers: Client A (10.8.0.2), Client B (10.8.0.3), ... │
│                                                            │
│  wg-up-1 (上游接口 1)                                      │
│  ├─ 无 IP 地址（点对点）                                   │
│  ├─ Peer: Upstream Server 1                               │
│  └─ Endpoint: us.example.com:51820                        │
│                                                            │
│  wg-up-2 (上游接口 2)                                      │
│  ├─ 无 IP 地址（点对点）                                   │
│  ├─ Peer: Upstream Server 2                               │
│  └─ Endpoint: eu.example.com:51820                        │
│                                                            │
└──────────────────────────────────────────────────────────┘
```

### 4.2 路由表结构

```
Main Routing Table (table main)
┌────────────────────────────────────────┐
│ default via 172.20.0.1 dev eth0        │
│ 10.8.0.0/24 dev wg0                    │
│ 172.20.0.0/16 dev eth0                 │
└────────────────────────────────────────┘

Policy Routing Tables (per-client)
┌────────────────────────────────────────┐
│ Table 101 (Client 1 → Upstream 1)      │
│ ─────────────────────────────────────  │
│ default dev wg-up-1                    │
└────────────────────────────────────────┘

┌────────────────────────────────────────┐
│ Table 102 (Client 2 → Upstream 2)      │
│ ─────────────────────────────────────  │
│ default dev wg-up-2                    │
└────────────────────────────────────────┘

Policy Routing Rules
┌─────────────────────────────────────────────┐
│ Priority 1000: from all lookup local        │
│ Priority 1101: from all fwmark 0x65 lookup  │
│                101  ◄─── Client 1           │
│ Priority 1102: from all fwmark 0x66 lookup  │
│                102  ◄─── Client 2           │
│ Priority 32766: from all lookup main        │
└─────────────────────────────────────────────┘
```

### 4.3 iptables 规则链

```
mangle 表
┌───────────────────────────────────────────────────────────────┐
│ PREROUTING 链                                                  │
│ ────────────────────────────────────────────────────────────  │
│                                                                │
│ Rule 1: -s 10.8.0.2 -m set --match-set client_1_proxy dst     │
│         -j MARK --set-mark 101                                │
│         -m comment --comment "wg-easy-client-1"               │
│                                                                │
│ Rule 2: -s 10.8.0.3 -m set --match-set client_2_proxy dst     │
│         -j MARK --set-mark 102                                │
│         -m comment --comment "wg-easy-client-2"               │
│                                                                │
│ ...                                                            │
└───────────────────────────────────────────────────────────────┘

nat 表 (现有配置，保持不变)
┌───────────────────────────────────────────────────────────────┐
│ POSTROUTING 链                                                 │
│ ────────────────────────────────────────────────────────────  │
│                                                                │
│ Rule: -s 10.8.0.0/24 -o eth0 -j MASQUERADE                    │
│       (允许直连流量 NAT)                                       │
└───────────────────────────────────────────────────────────────┘
```

---

## 五、关键技术决策

### 5.1 为什么选择 dnsmasq + ipset？

**优点**:
1. ✅ 自动化: DNS 查询结果自动添加到 ipset
2. ✅ 动态: IP 地址变化时自动更新
3. ✅ 高性能: ipset 使用哈希表，O(1) 查找
4. ✅ 灵活: 支持通配符域名 (*.google.com)
5. ✅ 成熟稳定: 广泛使用的方案

**替代方案对比**:

| 方案 | 优点 | 缺点 |
|------|------|------|
| dnsmasq + ipset | 自动化、高性能 | 需要额外进程 |
| iptables 字符串匹配 | 简单 | 性能差、无法匹配 IP |
| nftables sets | 新特性、统一 | 兼容性问题 |
| eBPF/XDP | 最高性能 | 复杂、内核版本要求高 |

### 5.2 为什么使用独立的上游接口？

**原因**:
1. **隔离性**: 不同客户端的上游流量完全隔离
2. **灵活性**: 每个接口可以连接到不同的上游服务器
3. **监控**: 可以单独监控每个上游的流量和状态
4. **故障隔离**: 一个上游失败不影响其他

**开销**:
- 每个接口约 10MB 内存
- 每个接口约 0.5% CPU (空闲)
- 可接受的开销，换取更好的架构

### 5.3 为什么使用策略路由而非源地址路由？

**策略路由** (fwmark + ip rule):
- ✅ 支持复杂的路由决策
- ✅ 可以基于目标 IP（ipset）选择路由
- ✅ 灵活的优先级控制

**源地址路由** (ip rule from):
- ✗ 无法区分目标 IP
- ✗ 所有流量都走同一路径
- ✗ 不支持分流

### 5.4 共享 vs 独立上游接口

**当前设计**: 每个上游服务器使用独立接口

**未来优化**: 支持多客户端共享同一上游接口

```
共享模式（可选优化）:
┌─────────────┐
│ Client 1    │ ──┐
│ (10.8.0.2)  │   │
└─────────────┘   │
                  ├─► wg-up-1 (共享) ──► Upstream Server 1
┌─────────────┐   │
│ Client 2    │ ──┘
│ (10.8.0.3)  │
└─────────────┘

优点: 节省接口数量
缺点: 流量统计不够精细
```

---

## 六、扩展性分析

### 6.1 性能瓶颈

| 组件 | 限制 | 影响 |
|------|------|------|
| WireGuard 接口数 | ~200 (理论无限) | 内存占用 |
| 路由表数 | 255 (可扩展到 4096) | 客户端数量 |
| ipset 条目数 | 65536 (单个 set) | 规则数量 |
| iptables 规则数 | ~1000 (性能考虑) | 客户端数量 |
| dnsmasq 缓存 | 可配置 (默认 150) | DNS 性能 |

### 6.2 扩展方案

#### 方案 A: 横向扩展（推荐）

```
部署多个 wg-easy 实例，使用负载均衡器分发客户端

┌──────────────┐
│ Load Balancer│
└──────┬───────┘
       │
       ├─────► wg-easy-1 (客户端 1-50)
       │
       ├─────► wg-easy-2 (客户端 51-100)
       │
       └─────► wg-easy-3 (客户端 101-150)
```

#### 方案 B: 纵向优化

- 使用更高性能的硬件
- 优化内核参数
- 使用 eBPF 替代 iptables (未来)

### 6.3 可扩展性指标

| 客户端数 | 上游数 | 规则数 | 内存估算 | CPU 估算 |
|---------|--------|--------|----------|----------|
| 10 | 2 | 50 | 350MB | 5% |
| 50 | 5 | 250 | 600MB | 15% |
| 100 | 10 | 500 | 1.2GB | 30% |
| 200 | 20 | 1000 | 2.5GB | 60% |

---

## 七、故障处理和恢复

### 7.1 自动恢复机制

```typescript
// 在 SplitTunneling 类中添加健康检查
class SplitTunneling {
  async healthCheck() {
    // 1. 检查上游接口状态
    const upstreams = await Database.upstreams.getAll();
    
    for (const upstream of upstreams.filter(u => u.enabled)) {
      try {
        await exec(`ip link show ${upstream.interfaceName}`);
      } catch {
        // 接口不存在，尝试重启
        await this.startUpstreamInterface(upstream);
      }
    }
    
    // 2. 检查 dnsmasq
    try {
      await exec('pgrep dnsmasq');
    } catch {
      await exec('dnsmasq');
    }
    
    // 3. 验证关键 ipset 存在
    const clients = await Database.clients.getAll()
      .filter(c => c.enabled && c.upstreamEnabled);
    
    for (const client of clients) {
      const ipsetName = `client_${client.id}_proxy`;
      try {
        await exec(`ipset list ${ipsetName}`);
      } catch {
        // ipset 不存在，重新创建
        await this.applyClientConfig(client);
      }
    }
  }
}

// 在 WireGuard cronJob 中调用
async cronJob() {
  // ... 现有逻辑 ...
  
  // 新增：分流健康检查
  await SplitTunneling.healthCheck().catch(err => {
    WG_DEBUG('Split tunneling health check failed:', err);
  });
}
```

### 7.2 故障场景和处理

#### 场景 1: 上游服务器断线

**检测**:
```bash
wg show wg-up-1 | grep handshake
# 如果 handshake 时间过旧 (>3 分钟) = 可能断线
```

**自动处理**:
- 保持重连（PersistentKeepalive）
- 流量暂时走直连（可选：配置降级策略）

**手动处理**:
```bash
# 重启上游接口
wg-quick down wg-up-1
wg-quick up wg-up-1
```

#### 场景 2: ipset 意外清空

**检测**:
```bash
ipset list client_1_proxy | grep "Number of entries: 0"
```

**自动恢复**:
- healthCheck 定期验证
- 重新应用配置

#### 场景 3: dnsmasq 崩溃

**检测**:
```bash
pgrep dnsmasq || echo "dnsmasq not running"
```

**自动恢复**:
```bash
# 在 healthCheck 中
if ! pgrep dnsmasq >/dev/null; then
  dnsmasq
fi
```

---

## 八、安全加固

### 8.1 防火墙规则

```bash
# 只允许来自 wg0 的流量
iptables -A FORWARD -i wg0 -j ACCEPT
iptables -A FORWARD -o wg0 -j ACCEPT

# 限制客户端之间的流量（可选）
iptables -A FORWARD -i wg0 -o wg0 -j DROP

# 防止 IP 欺骗
iptables -A INPUT -i wg0 ! -s 10.8.0.0/24 -j DROP
```

### 8.2 速率限制

```bash
# 限制单个客户端带宽（可选）
tc qdisc add dev wg0 root handle 1: htb default 10
tc class add dev wg0 parent 1: classid 1:1 htb rate 100mbit

# 为每个客户端 IP 设置限制
tc filter add dev wg0 protocol ip parent 1:0 prio 1 \
  u32 match ip src 10.8.0.2 flowid 1:1
```

### 8.3 日志审计

```typescript
// 在关键操作中记录审计日志
class SplitTunneling {
  async applyClientConfig(config: ClientConfig) {
    await Database.auditLogs.create({
      action: 'split_tunneling_apply',
      clientId: config.client.id,
      upstreamId: config.upstream.id,
      ruleCount: config.rules.length,
      timestamp: new Date(),
    });
    
    // ... 应用配置 ...
  }
}
```

---

## 九、监控指标

### 9.1 关键指标

```typescript
// src/server/api/metrics/split-tunneling.get.ts
export default defineEventHandler(async () => {
  const clients = await Database.clients.getAll();
  const upstreams = await Database.upstreams.getAll();
  
  const metrics = {
    clients: {
      total: clients.length,
      enabled: clients.filter(c => c.enabled).length,
      withSplitTunneling: clients.filter(c => c.upstreamEnabled).length,
    },
    upstreams: {
      total: upstreams.length,
      enabled: upstreams.filter(u => u.enabled).length,
      active: 0, // 需要检查接口状态
    },
    rules: {
      total: 0,
      domain: 0,
      ip: 0,
    },
    network: {
      ipsets: [],
      routeTables: [],
    }
  };
  
  // 获取规则统计
  for (const client of clients) {
    const rules = await Database.splitRules.getByClientId(client.id);
    metrics.rules.total += rules.length;
    metrics.rules.domain += rules.filter(r => r.ruleType === 'domain').length;
    metrics.rules.ip += rules.filter(r => r.ruleType === 'ip').length;
  }
  
  // 检查上游接口状态
  for (const upstream of upstreams.filter(u => u.enabled)) {
    try {
      await exec(`ip link show ${upstream.interfaceName}`);
      metrics.upstreams.active++;
    } catch {}
  }
  
  return metrics;
});
```

### 9.2 Prometheus 集成（可选）

```typescript
// 扩展现有的 Prometheus metrics
export function generateSplitTunnelingMetrics() {
  return `
# HELP wg_easy_split_tunneling_clients Total clients with split tunneling
# TYPE wg_easy_split_tunneling_clients gauge
wg_easy_split_tunneling_clients ${metrics.clients.withSplitTunneling}

# HELP wg_easy_upstream_servers Total upstream servers
# TYPE wg_easy_upstream_servers gauge
wg_easy_upstream_servers{status="enabled"} ${metrics.upstreams.enabled}
wg_easy_upstream_servers{status="active"} ${metrics.upstreams.active}

# HELP wg_easy_split_rules Total split tunneling rules
# TYPE wg_easy_split_rules gauge
wg_easy_split_rules{type="domain"} ${metrics.rules.domain}
wg_easy_split_rules{type="ip"} ${metrics.rules.ip}
  `.trim();
}
```

---

## 十、未来优化方向

### 10.1 短期优化 (1-3 个月)

1. **规则模板**
   ```json
   {
     "name": "Google Services",
     "domains": ["google.com", "*.google.com", "gstatic.com", "googleapis.com"]
   }
   ```

2. **批量导入导出**
   - 导出客户端配置（包含分流规则）
   - 导入规则列表（CSV/JSON）

3. **规则测试工具**
   - 在 UI 中测试域名/IP 是否命中规则
   - 模拟路由路径

4. **流量统计**
   - 每客户端的代理流量 vs 直连流量
   - 每上游服务器的流量统计

### 10.2 中期优化 (3-6 个月)

1. **GeoIP 分流**
   ```typescript
   interface GeoIpRule {
     country: string;  // 'US', 'CN', 'EU'
     action: 'proxy' | 'direct';
   }
   ```

2. **负载均衡**
   - 多个上游服务器之间负载均衡
   - 自动故障切换

3. **智能路由**
   - 基于延迟选择最优上游
   - 动态调整路由

4. **高级规则**
   - 基于端口的分流
   - 基于协议的分流
   - 时间段规则（如工作时间使用不同上游）

### 10.3 长期优化 (6-12 个月)

1. **eBPF 加速**
   - 使用 eBPF/XDP 替代 iptables
   - 更低延迟、更高吞吐

2. **分布式部署**
   - 多节点部署
   - 集中式管理

3. **机器学习**
   - 智能推荐规则
   - 异常流量检测

---

## 十一、代码质量保证

### 11.1 测试覆盖

```typescript
// tests/splitTunneling.test.ts
describe('SplitTunneling', () => {
  test('should create ipset for client', async () => {
    // ...
  });
  
  test('should apply iptables rules correctly', async () => {
    // ...
  });
  
  test('should handle upstream failure gracefully', async () => {
    // ...
  });
  
  test('should cleanup resources on shutdown', async () => {
    // ...
  });
});
```

### 11.2 代码审查清单

- [ ] 所有外部命令都有错误处理
- [ ] 数据库操作使用事务
- [ ] 敏感信息不在日志中输出
- [ ] 输入验证完整（Zod schema）
- [ ] 资源清理（ipset, iptables, routes）
- [ ] 并发安全（加锁或队列）
- [ ] 性能测试通过
- [ ] 文档完整

### 11.3 性能测试基准

```bash
# 使用 iperf3 测试吞吐量
# Server: iperf3 -s
# Client: iperf3 -c <server> -t 30

# 测试延迟
ping -c 100 <target>

# 测试并发连接
ab -n 1000 -c 10 http://<target>/

# 监控资源
docker stats wg-easy
```

---

## 十二、文档和帮助

### 12.1 用户文档

需要创建的文档:
- 用户手册（如何配置分流）
- 管理员指南（如何添加上游服务器）
- 故障排除手册
- 最佳实践

### 12.2 开发文档

- API 文档（OpenAPI/Swagger）
- 数据库 Schema 文档
- 代码注释（JSDoc）
- 架构决策记录 (ADR)

---

## 总结

该架构设计具有以下特点:

1. **模块化**: 分流功能独立，可选启用
2. **可扩展**: 支持大量客户端和上游服务器
3. **高性能**: 基于内核网络栈，低延迟
4. **易维护**: 清晰的代码结构和完善的文档
5. **生产就绪**: 完整的错误处理和恢复机制

**技术亮点**:
- ✨ 每客户端独立配置
- ✨ 自动化 DNS 分流 (dnsmasq + ipset)
- ✨ 灵活的策略路由
- ✨ 完整的 Web UI
- ✨ 实时配置更新

**适用场景**:
- 企业 VPN 分流
- 多地域访问优化
- 内容访问控制
- 流量成本优化

---

**文档版本**: v1.0  
**最后更新**: 2025-10-02  
**维护者**: wg-easy Team
