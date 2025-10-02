# 快速参考卡片 (Quick Reference Card)

一页纸速查表，涵盖最常用的命令、配置和故障排查。

---

## 🎯 核心概念（30 秒理解）

```
客户端 → wg0 → dnsmasq (DNS分流) → ipset (IP集合)
                  ↓
             iptables (流量标记) → ip rule (策略路由)
                  ↓                      ↓
              直接转发              wg-up-X (上游)
```

**关键点**: 
- 每客户端独立配置
- 自动 DNS 分流
- 基于规则的智能路由

---

## 📁 关键文件位置

| 文件 | 路径 | 用途 |
|------|------|------|
| 主接口配置 | `/etc/wireguard/wg0.conf` | wg-easy 主接口 |
| 上游接口配置 | `/etc/wireguard/wg-up-1.conf` | 上游 WireGuard |
| dnsmasq 主配置 | `/etc/dnsmasq.conf` | DNS 服务器 |
| 分流规则配置 | `/etc/dnsmasq.d/split-tunneling.conf` | 域名分流 |
| 路由表定义 | `/etc/iproute2/rt_tables` | 路由表 ID |
| 数据库 | `/etc/wireguard/db.sqlite` | 配置存储 |

---

## ⚡ 常用命令速查

### WireGuard 接口管理

```bash
# 查看所有接口
wg show all brief

# 查看特定接口
wg show wg-up-1

# 启动接口
wg-quick up wg-up-1

# 停止接口
wg-quick down wg-up-1

# 重载配置（不断开连接）
wg syncconf wg-up-1 <(wg-quick strip wg-up-1)
```

### ipset 管理

```bash
# 列出所有 ipset
ipset list -n

# 查看 ipset 内容
ipset list client_1_proxy

# 创建 ipset
ipset create client_1_proxy hash:ip timeout 3600

# 添加 IP
ipset add client_1_proxy 8.8.8.8

# 测试 IP 是否在集合中
ipset test client_1_proxy 8.8.8.8

# 删除 ipset
ipset destroy client_1_proxy

# 清空 ipset
ipset flush client_1_proxy
```

### iptables 管理

```bash
# 查看 mangle 表
iptables -t mangle -L PREROUTING -n -v

# 添加标记规则
iptables -t mangle -A PREROUTING \
  -s 10.8.0.2 \
  -m set --match-set client_1_proxy dst \
  -j MARK --set-mark 101

# 删除规则
iptables -t mangle -D PREROUTING \
  -s 10.8.0.2 \
  -m set --match-set client_1_proxy dst \
  -j MARK --set-mark 101

# 保存规则
iptables-save > /tmp/iptables.rules

# 恢复规则
iptables-restore < /tmp/iptables.rules

# 清空 mangle 表
iptables -t mangle -F PREROUTING
```

### 策略路由管理

```bash
# 查看所有路由规则
ip rule list

# 添加策略路由规则
ip rule add fwmark 101 table 101 prio 1101

# 删除规则
ip rule del fwmark 101 table 101

# 查看路由表内容
ip route show table 101

# 添加默认路由
ip route add default dev wg-up-1 table 101

# 清空路由表
ip route flush table 101

# 测试路由决策
ip route get 8.8.8.8 from 10.8.0.2
```

### dnsmasq 管理

```bash
# 启动 dnsmasq
dnsmasq

# 重载配置（不中断服务）
killall -HUP dnsmasq

# 查看统计信息
killall -USR1 dnsmasq

# 停止 dnsmasq
killall dnsmasq

# 测试 DNS 解析
dig @127.0.0.1 google.com

# 查看缓存统计
dig @127.0.0.1 chaos txt cachesize.bind
```

---

## 🔍 调试命令速查

### 问题: 流量不走代理

```bash
# 1. 检查 DNS
dig @127.0.0.1 google.com
└─ 如果失败 → dnsmasq 问题

# 2. 检查 ipset
ipset list client_1_proxy
└─ 如果为空 → dnsmasq ipset 配置问题

# 3. 检查 iptables 计数
iptables -t mangle -L PREROUTING -n -v
└─ 如果计数不增加 → 规则不匹配

# 4. 检查路由
ip route get <IP> from <client_ip>
└─ 如果不是 wg-up-X → 路由配置问题

# 5. 检查上游连接
wg show wg-up-1 | grep handshake
└─ 如果超过 3 分钟 → 上游连接问题
```

### 问题: DNS 解析失败

```bash
# 1. 检查 dnsmasq 进程
pgrep dnsmasq
└─ 如果无输出 → dnsmasq 未运行

# 2. 检查配置文件
cat /etc/dnsmasq.conf
cat /etc/dnsmasq.d/split-tunneling.conf

# 3. 测试上游 DNS
dig @1.1.1.1 google.com
└─ 验证网络连通性

# 4. 查看日志（如果启用）
tail -f /var/log/dnsmasq.log
```

### 问题: 上游接口无法启动

```bash
# 1. 检查配置文件
cat /etc/wireguard/wg-up-1.conf

# 2. 尝试手动启动
wg-quick up wg-up-1
└─ 查看具体错误信息

# 3. 检查密钥格式
wg pubkey <<< "<private_key>"
└─ 应该输出 44 字符的公钥

# 4. 检查网络连通性
ping <upstream_host>
nc -zvu <upstream_host> 51820
```

---

## 📋 配置模板

### 上游接口配置

```ini
# /etc/wireguard/wg-up-1.conf
[Interface]
PrivateKey = <local_private_key>
MTU = 1360

[Peer]
PublicKey = <upstream_public_key>
Endpoint = upstream.server.com:51820
AllowedIPs = 0.0.0.0/0
PersistentKeepalive = 25
```

### dnsmasq 分流配置

```conf
# /etc/dnsmasq.d/split-tunneling.conf
# 客户端 1 的规则
ipset=/google.com/client_1_proxy
ipset=/youtube.com/client_1_proxy

# 客户端 2 的规则
ipset=/twitter.com/client_2_proxy
```

### iptables 规则模板

```bash
# 为客户端 1 配置
iptables -t mangle -A PREROUTING \
  -s 10.8.0.2 \
  -m set --match-set client_1_proxy dst \
  -j MARK --set-mark 101 \
  -m comment --comment "wg-easy-split-client-1"
```

### 策略路由模板

```bash
# 路由表定义
echo "101 client_1" >> /etc/iproute2/rt_tables

# 策略规则
ip rule add fwmark 101 table 101 prio 1101

# 默认路由
ip route add default dev wg-up-1 table 101
```

---

## 🔢 编号规范

### 客户端编号

| 客户端 ID | IP 地址 | ipset 名称 | fwmark | 路由表 |
|-----------|---------|-----------|--------|--------|
| 1 | 10.8.0.2 | client_1_proxy | 101 | 101 |
| 2 | 10.8.0.3 | client_2_proxy | 102 | 102 |
| 3 | 10.8.0.4 | client_3_proxy | 103 | 103 |
| N | 10.8.0.(N+1) | client_N_proxy | 100+N | 100+N |

### 上游接口编号

| 上游 ID | 接口名 | 说明 |
|---------|--------|------|
| 1 | wg-up-1 | 第一个上游 |
| 2 | wg-up-2 | 第二个上游 |
| N | wg-up-N | 第 N 个上游 |

---

## 🎨 配置示例

### 示例 1: Google 服务走美国代理

```bash
# 客户端 IP: 10.8.0.2
# 上游: us.example.com:51820

# 1. 创建 ipset
ipset create client_1_proxy hash:ip timeout 3600

# 2. dnsmasq 规则
cat >> /etc/dnsmasq.d/split-tunneling.conf <<EOF
ipset=/google.com/client_1_proxy
ipset=/gstatic.com/client_1_proxy
ipset=/googleapis.com/client_1_proxy
EOF

# 3. iptables + 路由
iptables -t mangle -A PREROUTING -s 10.8.0.2 \
  -m set --match-set client_1_proxy dst -j MARK --set-mark 101
ip rule add fwmark 101 table 101 prio 1101
ip route add default dev wg-up-1 table 101

# 4. 重载 dnsmasq
killall -HUP dnsmasq
```

### 示例 2: 特定 IP 段走代理

```bash
# 客户端 IP: 10.8.0.3
# 目标: 8.8.8.0/24 走代理

# 1. 创建 ipset
ipset create client_2_proxy hash:net

# 2. 添加 IP 段
ipset add client_2_proxy 8.8.8.0/24
ipset add client_2_proxy 1.1.1.0/24

# 3. iptables + 路由
iptables -t mangle -A PREROUTING -s 10.8.0.3 \
  -m set --match-set client_2_proxy dst -j MARK --set-mark 102
ip rule add fwmark 102 table 102 prio 1102
ip route add default dev wg-up-2 table 102
```

---

## 📊 状态检查一行命令

```bash
# 全面状态检查
echo "=== WireGuard ===" && wg show all brief && \
echo "=== ipsets ===" && ipset list -n | grep client && \
echo "=== iptables ===" && iptables -t mangle -S | grep wg-easy && \
echo "=== Routes ===" && ip rule list | grep fwmark && \
echo "=== dnsmasq ===" && pgrep dnsmasq && echo "Running" || echo "Stopped"
```

---

## 🆘 紧急故障处理

### 完全重置（谨慎使用）

```bash
#!/bin/bash
# emergency-reset.sh - 重置所有分流配置

# 停止所有上游接口
for i in {1..10}; do
  wg-quick down wg-up-${i} 2>/dev/null
done

# 清理 ipset
for ipset in $(ipset list -n | grep client_.*_proxy); do
  ipset destroy ${ipset}
done

# 清理 iptables
iptables -t mangle -F PREROUTING

# 清理路由
for i in {101..200}; do
  ip rule del table ${i} 2>/dev/null
  ip route flush table ${i} 2>/dev/null
done

# 重启 dnsmasq
killall dnsmasq
dnsmasq

echo "Reset complete. Please reconfigure."
```

### 快速恢复（从备份）

```bash
# 1. 停止服务
docker stop wg-easy

# 2. 恢复数据库
docker run --rm -v wg-easy:/etc/wireguard alpine \
  sh -c "cp /etc/wireguard/db.sqlite.backup /etc/wireguard/db.sqlite"

# 3. 重启服务
docker start wg-easy
```

---

## 🧪 快速测试命令

### 测试 DNS 分流

```bash
# 1. 解析域名
IP=$(dig @127.0.0.1 google.com +short | head -n1)

# 2. 检查是否添加到 ipset
sleep 1 && ipset test client_1_proxy ${IP} && echo "✓ 在ipset中" || echo "✗ 不在ipset中"
```

### 测试路由

```bash
# 检查特定 IP 的路由
ip route get 8.8.8.8 from 10.8.0.2

# 预期输出包含: dev wg-up-1 (如果走代理)
```

### 测试连通性

```bash
# 从客户端测试
ping -c 1 8.8.8.8                    # 应该通
curl ipinfo.io/ip                    # 查看出口 IP
traceroute google.com                # 查看路由路径
```

---

## 📐 计算公式

### fwmark 计算

```
fwmark = 100 + client_id
```

### 路由表 ID 计算

```
table_id = 100 + client_id
```

### 优先级计算

```
priority = 1000 + client_id
```

### ipset 命名

```
ipset_name = "client_" + client_id + "_proxy"
```

---

## 🎨 配置模板变量

```bash
# 变量定义
CLIENT_ID=1
CLIENT_IP="10.8.0.2"
IPSET_NAME="client_${CLIENT_ID}_proxy"
FWMARK=$((100 + CLIENT_ID))
ROUTE_TABLE=$((100 + CLIENT_ID))
UPSTREAM_IFACE="wg-up-1"
SPLIT_DOMAIN="google.com"

# 使用变量的完整配置
ipset create ${IPSET_NAME} hash:ip timeout 3600
echo "ipset=/${SPLIT_DOMAIN}/${IPSET_NAME}" >> /etc/dnsmasq.d/split.conf
iptables -t mangle -A PREROUTING -s ${CLIENT_IP} \
  -m set --match-set ${IPSET_NAME} dst -j MARK --set-mark ${FWMARK}
ip rule add fwmark ${FWMARK} table ${ROUTE_TABLE} prio $((1000 + CLIENT_ID))
ip route add default dev ${UPSTREAM_IFACE} table ${ROUTE_TABLE}
```

---

## 🔧 一键操作脚本

### 快速添加客户端分流

```bash
#!/bin/bash
# 快速为客户端添加分流

CLIENT_ID=$1
CLIENT_IP=$2
UPSTREAM_IFACE=$3
DOMAIN=$4

IPSET_NAME="client_${CLIENT_ID}_proxy"
FWMARK=$((100 + CLIENT_ID))
TABLE=$((100 + CLIENT_ID))

ipset create ${IPSET_NAME} hash:ip timeout 3600 -exist
echo "ipset=/${DOMAIN}/${IPSET_NAME}" >> /etc/dnsmasq.d/split.conf
iptables -t mangle -A PREROUTING -s ${CLIENT_IP} \
  -m set --match-set ${IPSET_NAME} dst -j MARK --set-mark ${FWMARK}
ip rule add fwmark ${FWMARK} table ${TABLE} prio $((1000 + CLIENT_ID))
ip route add default dev ${UPSTREAM_IFACE} table ${TABLE}
killall -HUP dnsmasq

echo "✓ Client ${CLIENT_ID} configured"
```

**使用**:
```bash
./quick-add.sh 1 10.8.0.2 wg-up-1 google.com
```

---

## 📱 客户端配置要点

### 必须配置的 DNS

```ini
[Interface]
PrivateKey = ...
Address = 10.8.0.2/24
DNS = 10.8.0.1          ← 必须指向 wg-easy 服务器
```

**重要**: 如果不设置 DNS，分流不会工作！

---

## 🔍 监控命令

### 实时监控（单行）

```bash
# 方式 1: watch 命令
watch -n 1 'wg show all brief; echo ""; ipset list -n | grep client'

# 方式 2: 循环监控
while true; do clear; wg show wg-up-1; sleep 1; done
```

### 流量统计

```bash
# 上游接口流量
wg show wg-up-1 transfer

# 主接口流量
wg show wg0 transfer

# 网卡流量
ip -s link show wg-up-1
```

---

## 🎯 性能优化速查

```bash
# 1. 调整 MTU（减少分片）
# 主接口: 1420, 上游接口: 1360

# 2. 调整 ipset 超时
ipset create client_1_proxy hash:ip timeout 7200  # 2小时

# 3. 调整 dnsmasq 缓存
echo "cache-size=10000" >> /etc/dnsmasq.conf

# 4. 启用 BBR
sysctl -w net.ipv4.tcp_congestion_control=bbr

# 5. 调整连接跟踪
sysctl -w net.netfilter.nf_conntrack_max=1000000
```

---

## 🆘 应急处理清单

### 服务无法访问

```bash
□ 检查主接口: wg show wg0
□ 检查上游接口: wg show wg-up-1
□ 检查 dnsmasq: pgrep dnsmasq
□ 重启 wg-easy: docker restart wg-easy
```

### 分流不工作

```bash
□ 检查客户端 DNS 配置
□ 测试 DNS: dig @127.0.0.1 google.com
□ 检查 ipset: ipset list client_1_proxy
□ 检查 iptables: iptables -t mangle -L -n -v
□ 运行测试脚本: /tmp/test-split-tunneling.sh
```

### 性能下降

```bash
□ 检查 CPU: top
□ 检查内存: free -h
□ 检查连接数: wg show all | grep peer | wc -l
□ 检查 MTU 设置
□ 优化 ipset 和 iptables 规则数量
```

---

## 📞 获取帮助

| 问题类型 | 查看文档 | 章节 |
|---------|---------|------|
| 不理解原理 | ARCHITECTURE_DESIGN.md | 第 2 章 |
| 不知道怎么配置 | MINIMAL_WORKING_EXAMPLE.md | 第 2 章 |
| 配置不工作 | QUICK_START_GUIDE.md | 第 4 章 |
| 性能问题 | QUICK_START_GUIDE.md | 第 5 章 |
| 想看代码 | IMPLEMENTATION_EXAMPLES.md | 全部 |

---

## 🎓 记忆技巧

### 核心流程记忆法

```
DNS → ipset → iptables → ip rule → 上游
 解    析    标  记     路由表    转发
```

### 命令记忆法

```
ipset → 管理 IP 集合 (create, add, list, destroy)
iptables -t mangle → 标记流量 (MARK)
ip rule → 路由规则 (fwmark → table)
ip route → 路由表 (default dev)
```

---

## 💡 最佳实践

### DO ✅

- ✅ 为每个客户端使用描述性名称
- ✅ 定期备份配置
- ✅ 监控上游连接状态
- ✅ 使用合理的 ipset 超时时间
- ✅ 记录配置变更

### DON'T ❌

- ❌ 直接编辑自动生成的配置文件
- ❌ 使用过大的 CIDR (如 0.0.0.0/0 作为规则)
- ❌ 忘记设置客户端 DNS
- ❌ 在生产环境直接测试
- ❌ 跳过备份步骤

---

## 🔗 快速链接

| 链接 | 用途 |
|------|------|
| [完整文档索引](./INDEX.md) | 查找详细文档 |
| [最小示例](./MINIMAL_WORKING_EXAMPLE.md) | 快速开始 |
| [部署脚本](./scripts/deploy-split-tunneling-poc.sh) | 一键部署 |

---

## 📝 速记清单

### 配置分流的 5 个步骤

```
1. 启动上游接口 (wg-quick up wg-up-1)
2. 创建 ipset (ipset create)
3. 配置 iptables (iptables -t mangle)
4. 配置路由 (ip rule + ip route)
5. 配置 DNS (dnsmasq)
```

### 验证分流的 5 个检查

```
1. 上游接口状态 (wg show wg-up-1)
2. ipset 内容 (ipset list)
3. iptables 计数 (iptables -t mangle -L -v)
4. 路由规则 (ip rule list)
5. DNS 解析 (dig @127.0.0.1)
```

---

**打印此页，随时查阅！** 📄

---

**版本**: v1.0.0 | **更新**: 2025-10-02
