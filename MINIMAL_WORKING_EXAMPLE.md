# 最小可工作示例 (Minimal Working Example)

本文档提供一个简化的、可立即测试的分流功能实现，用于概念验证（PoC）。

---

## 一、概念验证目标

验证以下核心功能：
1. ✅ 单个客户端启用分流
2. ✅ 配置一个上游 WireGuard 服务器
3. ✅ 添加一条域名分流规则
4. ✅ 流量正确路由到上游或直连

---

## 二、手动配置步骤（无需代码修改）

### 前提条件

1. 已运行 wg-easy 容器
2. 已创建至少一个客户端（假设 IP 为 10.8.0.2）
3. 拥有一个可用的上游 WireGuard 服务器

### 步骤 1: 进入容器

```bash
docker exec -it wg-easy bash
```

### 步骤 2: 安装必需工具

```bash
apk add dnsmasq ipset iproute2
```

### 步骤 3: 配置上游 WireGuard 接口

```bash
# 创建上游配置文件
cat > /etc/wireguard/wg-up-1.conf <<'EOF'
[Interface]
PrivateKey = <your_private_key>
MTU = 1360

[Peer]
PublicKey = <upstream_server_public_key>
Endpoint = <upstream_server_ip>:51820
AllowedIPs = 0.0.0.0/0
PersistentKeepalive = 25
EOF

# 启动上游接口
wg-quick up wg-up-1

# 验证
wg show wg-up-1
```

### 步骤 4: 创建 ipset

```bash
# 创建 ipset 存储需要代理的 IP
ipset create client_1_proxy hash:ip timeout 3600
```

### 步骤 5: 配置 iptables 标记

```bash
# 标记来自客户端且目标在 ipset 中的流量
CLIENT_IP="10.8.0.2"
IPSET_NAME="client_1_proxy"
FWMARK="101"

iptables -t mangle -A PREROUTING \
  -s ${CLIENT_IP} \
  -m set --match-set ${IPSET_NAME} dst \
  -j MARK --set-mark ${FWMARK} \
  -m comment --comment "wg-easy-split-client-1"
```

### 步骤 6: 配置策略路由

```bash
# 添加路由表（如果不存在）
echo "101 client_1" >> /etc/iproute2/rt_tables

# 添加策略路由规则
ip rule add fwmark 101 table 101 prio 1101

# 添加默认路由到上游接口
ip route add default dev wg-up-1 table 101
```

### 步骤 7: 配置 dnsmasq

```bash
# 创建配置目录
mkdir -p /etc/dnsmasq.d

# 创建 dnsmasq 主配置
cat > /etc/dnsmasq.conf <<'EOF'
# Basic config
no-resolv
server=1.1.1.1
server=8.8.8.8
cache-size=1000

# Include split tunneling config
conf-dir=/etc/dnsmasq.d/,*.conf

# Log (optional)
log-queries
EOF

# 创建分流配置
cat > /etc/dnsmasq.d/split-tunneling.conf <<'EOF'
# Client 1 split tunneling rules
# Route google.com through proxy
ipset=/google.com/client_1_proxy
ipset=/www.google.com/client_1_proxy
EOF

# 启动 dnsmasq
dnsmasq
```

### 步骤 8: 更新客户端 DNS

编辑客户端配置，确保 DNS 指向 wg-easy 服务器：

```ini
[Interface]
Address = 10.8.0.2/24
PrivateKey = <client_private_key>
DNS = 10.8.0.1   # ← 关键：指向 wg0 的 IP

[Peer]
PublicKey = <server_public_key>
Endpoint = <server_ip>:51820
AllowedIPs = 0.0.0.0/0
```

### 步骤 9: 测试

在客户端设备上：

```bash
# 1. 连接 WireGuard
wg-quick up client

# 2. 测试 DNS 解析（应该通过 dnsmasq）
nslookup google.com
# 应该返回 10.8.0.1 作为 DNS 服务器

# 3. 访问 google.com（应该走代理）
curl -v https://google.com

# 4. 访问其他网站（应该直连）
curl ipinfo.io
# 应该显示本地 IP，而非上游 IP
```

在服务器上验证：

```bash
# 检查 ipset 是否有 IP
ipset list client_1_proxy
# 应该看到 google.com 解析的 IP

# 检查 iptables 计数器
iptables -t mangle -L PREROUTING -n -v
# 应该看到匹配的包数增加

# 检查上游接口流量
wg show wg-up-1 transfer
# 应该看到发送/接收字节数增加
```

---

## 三、验证脚本

### 自动化测试脚本

```bash
#!/bin/bash
# test-split-tunneling.sh

set -e

echo "=== Split Tunneling Quick Test ==="

CLIENT_IP="10.8.0.2"
UPSTREAM_IFACE="wg-up-1"
TEST_DOMAIN="google.com"

# 1. 检查上游接口
echo "1. Checking upstream interface..."
if ip link show ${UPSTREAM_IFACE} >/dev/null 2>&1; then
  echo "✓ Upstream interface ${UPSTREAM_IFACE} is up"
else
  echo "✗ Upstream interface not found"
  exit 1
fi

# 2. 检查 ipset
echo "2. Checking ipset..."
if ipset list client_1_proxy >/dev/null 2>&1; then
  COUNT=$(ipset list client_1_proxy | grep -E '^[0-9]' | wc -l)
  echo "✓ ipset exists with ${COUNT} entries"
else
  echo "✗ ipset not found"
  exit 1
fi

# 3. 检查 iptables 规则
echo "3. Checking iptables rules..."
if iptables -t mangle -S | grep -q "wg-easy-split"; then
  echo "✓ iptables rules configured"
else
  echo "✗ iptables rules not found"
  exit 1
fi

# 4. 检查策略路由
echo "4. Checking policy routing..."
if ip rule list | grep -q "fwmark 0x65"; then
  echo "✓ Policy routing configured"
else
  echo "✗ Policy routing not found"
  exit 1
fi

# 5. 检查 dnsmasq
echo "5. Checking dnsmasq..."
if pgrep dnsmasq >/dev/null; then
  echo "✓ dnsmasq is running"
else
  echo "✗ dnsmasq not running"
  exit 1
fi

# 6. 测试 DNS 解析
echo "6. Testing DNS resolution..."
IP=$(dig @127.0.0.1 ${TEST_DOMAIN} +short | head -n1)
if [ -n "$IP" ]; then
  echo "✓ DNS resolved ${TEST_DOMAIN} to ${IP}"
  
  # 检查是否添加到 ipset
  sleep 1
  if ipset test client_1_proxy ${IP} 2>/dev/null; then
    echo "✓ IP ${IP} added to ipset"
  else
    echo "⚠ IP not in ipset (may take a moment)"
  fi
else
  echo "✗ DNS resolution failed"
  exit 1
fi

# 7. 测试路由
echo "7. Testing routing..."
ROUTE=$(ip route get ${IP} from ${CLIENT_IP} 2>/dev/null | head -n1)
if echo "${ROUTE}" | grep -q "${UPSTREAM_IFACE}"; then
  echo "✓ Traffic routes through ${UPSTREAM_IFACE}"
else
  echo "⚠ Traffic may not route correctly: ${ROUTE}"
fi

echo ""
echo "=== Test Summary ==="
echo "✓ All checks passed!"
echo ""
echo "Next steps:"
echo "1. Connect a WireGuard client with IP ${CLIENT_IP}"
echo "2. Set DNS to 10.8.0.1 in client config"
echo "3. Visit ${TEST_DOMAIN} and verify proxy works"
```

---

## 四、调试技巧

### 实时监控流量路径

```bash
#!/bin/bash
# monitor-traffic.sh

# 监控特定客户端的流量

CLIENT_IP="10.8.0.2"

echo "Monitoring traffic from ${CLIENT_IP}..."
echo "Press Ctrl+C to stop"
echo ""

# 使用 tcpdump 监控
tcpdump -i wg0 -n "src ${CLIENT_IP}" &
PID1=$!

tcpdump -i wg-up-1 -n &
PID2=$!

# 清理
trap "kill $PID1 $PID2 2>/dev/null" EXIT

wait
```

### 测试单个规则

```bash
#!/bin/bash
# test-rule.sh

DOMAIN="$1"
CLIENT_IP="10.8.0.2"
IPSET="client_1_proxy"

if [ -z "$DOMAIN" ]; then
  echo "Usage: $0 <domain>"
  exit 1
fi

echo "Testing rule for domain: ${DOMAIN}"

# 1. DNS 查询
echo "1. Resolving ${DOMAIN}..."
IP=$(dig @127.0.0.1 ${DOMAIN} +short | head -n1)
echo "   → ${IP}"

# 2. 检查 ipset
sleep 1
echo "2. Checking ipset..."
if ipset test ${IPSET} ${IP} 2>/dev/null; then
  echo "   ✓ IP in ipset"
else
  echo "   ✗ IP NOT in ipset"
  exit 1
fi

# 3. 测试路由
echo "3. Testing routing..."
ROUTE=$(ip route get ${IP} from ${CLIENT_IP} 2>&1)
echo "   Route: ${ROUTE}"

if echo "${ROUTE}" | grep -q "wg-up"; then
  echo "   ✓ Will route through upstream"
else
  echo "   ✗ Will route directly"
fi

echo ""
echo "Test complete!"
```

### 清理脚本

```bash
#!/bin/bash
# cleanup-split-tunneling.sh

echo "Cleaning up split tunneling configuration..."

# 1. 停止上游接口
for iface in $(ip link show | grep -o 'wg-up-[0-9]*'); do
  echo "Stopping ${iface}..."
  wg-quick down ${iface} 2>/dev/null || true
done

# 2. 清理 ipset
echo "Cleaning ipsets..."
for ipset in $(ipset list -n | grep 'client_.*_proxy'); do
  ipset destroy ${ipset}
done

# 3. 清理 iptables
echo "Cleaning iptables rules..."
iptables -t mangle -S PREROUTING | grep 'wg-easy-split' | while read line; do
  rule=$(echo $line | sed 's/-A/-D/')
  iptables -t mangle $rule
done

# 4. 清理策略路由
echo "Cleaning policy routes..."
for i in {101..150}; do
  ip rule del table $i 2>/dev/null || true
  ip route flush table $i 2>/dev/null || true
done

# 5. 停止 dnsmasq
echo "Stopping dnsmasq..."
killall dnsmasq 2>/dev/null || true

echo "Cleanup complete!"
```

---

## 五、快速部署脚本

### 一键部署脚本

```bash
#!/bin/bash
# deploy-split-tunneling.sh

set -e

cat <<'BANNER'
╔════════════════════════════════════════════════════════╗
║   wg-easy Split Tunneling - Quick Deployment          ║
╚════════════════════════════════════════════════════════╝
BANNER

# 配置变量
CLIENT_IP="${1:-10.8.0.2}"
UPSTREAM_ENDPOINT="${2}"
UPSTREAM_PUBLIC_KEY="${3}"
SPLIT_DOMAIN="${4:-google.com}"

if [ -z "$UPSTREAM_ENDPOINT" ] || [ -z "$UPSTREAM_PUBLIC_KEY" ]; then
  echo "Usage: $0 <client_ip> <upstream_endpoint> <upstream_public_key> [split_domain]"
  echo "Example: $0 10.8.0.2 us.example.com:51820 xxx google.com"
  exit 1
fi

echo "Configuration:"
echo "  Client IP: ${CLIENT_IP}"
echo "  Upstream: ${UPSTREAM_ENDPOINT}"
echo "  Split Domain: ${SPLIT_DOMAIN}"
echo ""

# 1. 安装依赖
echo "Step 1: Installing dependencies..."
apk add --no-cache dnsmasq ipset iproute2 2>/dev/null || echo "Packages already installed"

# 2. 生成密钥
echo "Step 2: Generating keys..."
PRIVATE_KEY=$(wg genkey)
PUBLIC_KEY=$(echo ${PRIVATE_KEY} | wg pubkey)
echo "  Generated keys (save these!):"
echo "  Private: ${PRIVATE_KEY}"
echo "  Public: ${PUBLIC_KEY}"

# 3. 创建上游接口
echo "Step 3: Creating upstream interface..."
cat > /etc/wireguard/wg-up-1.conf <<EOF
[Interface]
PrivateKey = ${PRIVATE_KEY}
MTU = 1360

[Peer]
PublicKey = ${UPSTREAM_PUBLIC_KEY}
Endpoint = ${UPSTREAM_ENDPOINT}
AllowedIPs = 0.0.0.0/0
PersistentKeepalive = 25
EOF

wg-quick down wg-up-1 2>/dev/null || true
wg-quick up wg-up-1
echo "  ✓ Upstream interface wg-up-1 started"

# 4. 创建 ipset
echo "Step 4: Creating ipset..."
ipset create client_1_proxy hash:ip timeout 3600 -exist
ipset flush client_1_proxy
echo "  ✓ ipset created"

# 5. 配置 iptables
echo "Step 5: Configuring iptables..."
iptables -t mangle -D PREROUTING -s ${CLIENT_IP} -m set --match-set client_1_proxy dst -j MARK --set-mark 101 2>/dev/null || true
iptables -t mangle -A PREROUTING \
  -s ${CLIENT_IP} \
  -m set --match-set client_1_proxy dst \
  -j MARK --set-mark 101 \
  -m comment --comment "wg-easy-split-client-1"
echo "  ✓ iptables configured"

# 6. 配置策略路由
echo "Step 6: Configuring policy routing..."
grep -q "^101" /etc/iproute2/rt_tables || echo "101 client_1" >> /etc/iproute2/rt_tables
ip rule del fwmark 101 table 101 2>/dev/null || true
ip route flush table 101 2>/dev/null || true
ip rule add fwmark 101 table 101 prio 1101
ip route add default dev wg-up-1 table 101
echo "  ✓ Policy routing configured"

# 7. 配置 dnsmasq
echo "Step 7: Configuring dnsmasq..."
mkdir -p /etc/dnsmasq.d

cat > /etc/dnsmasq.conf <<'EOF'
no-resolv
server=1.1.1.1
server=8.8.8.8
cache-size=1000
conf-dir=/etc/dnsmasq.d/,*.conf
EOF

cat > /etc/dnsmasq.d/split-tunneling.conf <<EOF
# Split tunneling for ${SPLIT_DOMAIN}
ipset=/${SPLIT_DOMAIN}/client_1_proxy
EOF

# 重启 dnsmasq
killall dnsmasq 2>/dev/null || true
dnsmasq
echo "  ✓ dnsmasq configured and started"

# 8. 验证配置
echo ""
echo "Step 8: Verifying configuration..."

# 等待 DNS 生效
sleep 2

# 测试 DNS
TEST_IP=$(dig @127.0.0.1 ${SPLIT_DOMAIN} +short | head -n1)
if [ -n "$TEST_IP" ]; then
  echo "  ✓ DNS resolution works: ${SPLIT_DOMAIN} → ${TEST_IP}"
  
  # 等待 ipset 更新
  sleep 1
  
  if ipset test client_1_proxy ${TEST_IP} 2>/dev/null; then
    echo "  ✓ IP added to ipset"
  else
    echo "  ⚠ IP not yet in ipset (may take a moment)"
  fi
else
  echo "  ✗ DNS resolution failed"
fi

# 显示状态
echo ""
echo "=== Configuration Complete ==="
echo ""
echo "Status:"
wg show wg-up-1 2>/dev/null | head -n 5 || echo "  Upstream interface: ERROR"
echo ""
echo "ipset entries:"
ipset list client_1_proxy | grep "Number of entries" || true
echo ""
echo "Next steps:"
echo "1. Update client DNS to 10.8.0.1"
echo "2. Reconnect WireGuard client"
echo "3. Visit ${SPLIT_DOMAIN} to test"
echo ""
echo "To verify routing:"
echo "  ip route get ${TEST_IP} from ${CLIENT_IP}"
echo ""
echo "To cleanup:"
echo "  bash cleanup-split-tunneling.sh"
```

---

## 六、完整测试流程

### 准备工作

1. **准备上游 WireGuard 服务器**

在另一台服务器上配置 WireGuard:

```bash
# 上游服务器配置
wg genkey | tee privatekey | wg pubkey > publickey

cat > /etc/wireguard/wg0.conf <<EOF
[Interface]
PrivateKey = $(cat privatekey)
Address = 10.10.0.1/24
ListenPort = 51820

# 允许客户端连接
PostUp = iptables -A FORWARD -i wg0 -j ACCEPT
PostUp = iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE
EOF

wg-quick up wg0
```

记录上游服务器的：
- 公钥: `cat publickey`
- 端点: `<服务器公网IP>:51820`

2. **配置 wg-easy 客户端**

创建一个测试客户端，记录其 IP（如 10.8.0.2）

### 执行部署

```bash
# 1. 下载部署脚本
cd /workspace
curl -O https://raw.githubusercontent.com/.../deploy-split-tunneling.sh
chmod +x deploy-split-tunneling.sh

# 2. 进入容器
docker exec -it wg-easy bash

# 3. 运行部署脚本
./deploy-split-tunneling.sh \
  10.8.0.2 \
  us.example.com:51820 \
  <upstream_public_key> \
  google.com
```

### 客户端测试

在客户端设备上：

```bash
# 1. 下载客户端配置
# 从 wg-easy UI 下载或使用 CLI

# 2. 修改 DNS 设置
# 编辑 .conf 文件，确保 DNS = 10.8.0.1

# 3. 连接
sudo wg-quick up client_a

# 4. 测试直连
curl ipinfo.io/ip
# 应该显示你的本地公网 IP

# 5. 测试代理
curl https://google.com -I
# 检查是否通过上游

# 或者查看外部 IP
curl --resolve google.com:443:$(dig +short google.com | head -n1) \
  https://google.com/search?q=my+ip
```

### 服务端监控

```bash
# 在 wg-easy 容器中运行

# 1. 监控 DNS 查询
tail -f /var/log/dnsmasq.log | grep google.com

# 2. 监控 ipset 变化
watch -n 1 'ipset list client_1_proxy'

# 3. 监控 iptables 计数
watch -n 1 'iptables -t mangle -L PREROUTING -n -v'

# 4. 监控上游流量
watch -n 1 'wg show wg-up-1'

# 5. 综合监控
watch -n 1 '
echo "=== WireGuard Interfaces ==="
wg show all brief
echo ""
echo "=== ipset Entries ==="
ipset list client_1_proxy | head -n 10
echo ""
echo "=== iptables Counters ==="
iptables -t mangle -L PREROUTING -n -v | grep wg-easy
'
```

---

## 七、故障排查流程

### 问题: 流量不走代理

```bash
# 调试步骤 1: 检查 DNS
dig @127.0.0.1 google.com +short
# 如果无结果 → dnsmasq 未运行或配置错误

# 调试步骤 2: 检查 ipset
ipset list client_1_proxy
# 如果为空 → dnsmasq ipset 配置错误

# 调试步骤 3: 手动添加测试
ipset add client_1_proxy 8.8.8.8
ping -c 1 8.8.8.8  # 从客户端 ping
# 检查是否通过上游

# 调试步骤 4: 检查 iptables 匹配
iptables -t mangle -L PREROUTING -n -v
# 查看 pkts 列是否增加

# 调试步骤 5: 检查路由决策
ip route get 8.8.8.8 from 10.8.0.2
# 应该显示 dev wg-up-1

# 调试步骤 6: 检查上游连接
wg show wg-up-1
# 查看 latest handshake（应该在 2 分钟内）
```

### 问题: DNS 解析失败

```bash
# 检查 dnsmasq 状态
pgrep dnsmasq || echo "dnsmasq not running"

# 检查配置文件
cat /etc/dnsmasq.conf
cat /etc/dnsmasq.d/split-tunneling.conf

# 手动测试 DNS
dig @127.0.0.1 google.com

# 检查上游 DNS 可达性
ping -c 1 1.1.1.1
```

### 问题: 上游接口无法启动

```bash
# 检查配置
cat /etc/wireguard/wg-up-1.conf

# 检查密钥格式
wg pubkey <<< "$(grep PrivateKey /etc/wireguard/wg-up-1.conf | cut -d' ' -f3)"

# 手动启动查看错误
wg-quick up wg-up-1

# 检查防火墙
iptables -L -n | grep 51820
```

---

## 八、性能基准测试

### 测试脚本

```bash
#!/bin/bash
# benchmark.sh

CLIENT_IP="10.8.0.2"
TARGET="8.8.8.8"

echo "=== Performance Benchmark ==="

# 1. 添加测试 IP 到 ipset
ipset add client_1_proxy ${TARGET} -exist

# 2. 测试延迟
echo "1. Latency test (from client ${CLIENT_IP})..."
# 需要在客户端执行
# ping -c 100 ${TARGET}

# 3. 测试吞吐量
echo "2. Throughput test..."
# 在目标服务器: iperf3 -s
# 在客户端: iperf3 -c ${TARGET} -t 30

# 4. 测试路由决策性能
echo "3. Routing decision performance..."
time for i in {1..1000}; do
  ip route get ${TARGET} from ${CLIENT_IP} >/dev/null
done

# 5. 测试 ipset 查找性能
echo "4. ipset lookup performance..."
time for i in {1..10000}; do
  ipset test client_1_proxy ${TARGET} >/dev/null 2>&1
done

# 6. 测试 DNS 性能
echo "5. DNS resolution performance..."
time for i in {1..100}; do
  dig @127.0.0.1 google.com +short >/dev/null
done

echo "Benchmark complete!"
```

---

## 九、从 PoC 到生产

### PoC 阶段（1-2 周）

**目标**: 验证核心概念

```bash
# 手动配置
✓ 1 个客户端
✓ 1 个上游服务器
✓ 3-5 条规则
✓ 基础测试
```

**交付物**:
- 工作的手动配置
- 测试报告
- 性能数据

### MVP 阶段（4-6 周）

**目标**: 基础自动化

```
✓ 数据库设计
✓ 核心 API
✓ 基础 UI
✓ 5-10 个客户端测试
```

**交付物**:
- 可运行的代码
- 基本的 Web UI
- 用户文档

### 生产阶段（8-10 周）

**目标**: 完整功能

```
✓ 完整的 CRUD 操作
✓ 高级规则（端口、时间等）
✓ 监控和告警
✓ 100+ 客户端测试
✓ 性能优化
```

**交付物**:
- 生产就绪代码
- 完整文档
- 运维手册

---

## 十、成本估算

### 开发成本

| 阶段 | 时间 | 人力 | 备注 |
|------|------|------|------|
| PoC | 1-2 周 | 1 人 | 验证可行性 |
| MVP | 4-6 周 | 1-2 人 | 基础功能 |
| 生产 | 8-10 周 | 2 人 | 完整功能 |
| 维护 | 持续 | 0.5 人 | 日常维护 |

### 硬件成本（示例）

| 规模 | CPU | 内存 | 带宽 | 月成本 (云服务) |
|------|-----|------|------|----------------|
| 小型 (10 客户端) | 2 核 | 2GB | 100GB | $10-20 |
| 中型 (50 客户端) | 4 核 | 4GB | 500GB | $40-60 |
| 大型 (100 客户端) | 8 核 | 8GB | 1TB | $100-150 |

---

## 十一、实战案例

### 案例 1: 企业员工 VPN 分流

**场景**:
- 50 名员工
- 国际办公，需要访问 Google Workspace
- 本地访问走直连

**配置**:

```javascript
// 上游服务器: 美国节点
{
  name: "US-Office",
  endpoint: "us-vpn.company.com:51820",
  // ...
}

// 为每个员工配置相同的规则模板
const googleServices = [
  'google.com',
  'gmail.com',
  'drive.google.com',
  'docs.google.com',
  'meet.google.com',
  'calendar.google.com',
];

// 批量添加规则
googleServices.forEach(domain => {
  addSplitRule(clientId, 'domain', domain, 'proxy');
});
```

**效果**:
- ✅ 访问 Google 服务无障碍
- ✅ 本地网站快速直连
- ✅ 流量成本降低 60%

### 案例 2: 开发者多环境测试

**场景**:
- 开发者需要测试不同地区的服务
- 客户端 A: 模拟美国用户
- 客户端 B: 模拟欧洲用户
- 客户端 C: 本地测试

**配置**:

```javascript
// 客户端 A → 美国上游
{
  clientId: 1,
  upstreamId: 1, // US Server
  rules: [
    { domain: '*', action: 'proxy' }  // 所有流量走代理
  ]
}

// 客户端 B → 欧洲上游
{
  clientId: 2,
  upstreamId: 2, // EU Server
  rules: [
    { domain: '*', action: 'proxy' }
  ]
}

// 客户端 C → 直连
{
  clientId: 3,
  upstreamEnabled: false  // 禁用分流
}
```

**效果**:
- ✅ 快速切换测试环境
- ✅ 真实模拟不同地区用户
- ✅ 无需多个 VPN 账号

### 案例 3: 家庭网络优化

**场景**:
- 家庭成员共享 VPN
- 孩子: 仅特定教育网站走代理
- 成人: 工作相关网站走代理
- 智能设备: 全部直连

**配置**:

```javascript
// 孩子的客户端
{
  clientId: 1,
  rules: [
    { domain: 'youtube.com', action: 'proxy' },  // 教育视频
    { domain: 'wikipedia.org', action: 'proxy' },
    // 游戏和社交网站直连（家长控制）
  ]
}

// 成人的客户端
{
  clientId: 2,
  rules: [
    { domain: 'company-vpn.com', action: 'proxy' },
    { domain: 'google.com', action: 'proxy' },
    // 其余直连
  ]
}

// 智能设备
{
  clientId: 3,
  upstreamEnabled: false  // 完全直连
}
```

---

## 十二、脚本工具集

### 备份配置

```bash
#!/bin/bash
# backup-config.sh

BACKUP_DIR="/backup/$(date +%Y%m%d_%H%M%S)"
mkdir -p ${BACKUP_DIR}

# 备份数据库
cp /etc/wireguard/db.sqlite ${BACKUP_DIR}/

# 备份 WireGuard 配置
cp -r /etc/wireguard/*.conf ${BACKUP_DIR}/

# 备份 dnsmasq 配置
cp -r /etc/dnsmasq.d ${BACKUP_DIR}/

# 导出网络配置
iptables-save > ${BACKUP_DIR}/iptables.rules
ip rule list > ${BACKUP_DIR}/ip_rules.txt
ipset list > ${BACKUP_DIR}/ipsets.txt

echo "Backup created: ${BACKUP_DIR}"
```

### 恢复配置

```bash
#!/bin/bash
# restore-config.sh

BACKUP_DIR="${1}"

if [ -z "$BACKUP_DIR" ] || [ ! -d "$BACKUP_DIR" ]; then
  echo "Usage: $0 <backup_directory>"
  exit 1
fi

echo "Restoring from ${BACKUP_DIR}..."

# 停止服务
killall dnsmasq 2>/dev/null || true
for iface in $(ip link show | grep -o 'wg-up-[0-9]*'); do
  wg-quick down ${iface} 2>/dev/null || true
done

# 恢复数据库
cp ${BACKUP_DIR}/db.sqlite /etc/wireguard/

# 恢复配置
cp ${BACKUP_DIR}/*.conf /etc/wireguard/
cp -r ${BACKUP_DIR}/dnsmasq.d /etc/

# 恢复 iptables
iptables-restore < ${BACKUP_DIR}/iptables.rules

echo "Restore complete. Restart wg-easy to apply."
```

### 批量操作脚本

```bash
#!/bin/bash
# batch-add-rules.sh

# 为所有客户端添加相同的规则

RULE_TYPE="${1:-domain}"
RULE_VALUE="${2}"
ACTION="${3:-proxy}"

if [ -z "$RULE_VALUE" ]; then
  echo "Usage: $0 <type> <value> [action]"
  echo "Example: $0 domain google.com proxy"
  exit 1
fi

# 获取所有客户端（需要 sqlite3）
CLIENT_IDS=$(sqlite3 /etc/wireguard/db.sqlite \
  "SELECT id FROM clients_table WHERE enabled=1 AND upstream_enabled=1")

for CLIENT_ID in ${CLIENT_IDS}; do
  echo "Adding rule to client ${CLIENT_ID}..."
  
  sqlite3 /etc/wireguard/db.sqlite <<EOF
INSERT INTO split_rules (client_id, rule_type, rule_value, action, enabled)
VALUES (${CLIENT_ID}, '${RULE_TYPE}', '${RULE_VALUE}', '${ACTION}', 1);
EOF
done

echo "Rules added to ${#CLIENT_IDS[@]} clients"
echo "Reapplying configuration..."

# 触发配置重新应用（需要调用 API 或重启）
curl -X POST http://localhost:51821/api/admin/interface/restart \
  -H "Cookie: session=xxx"
```

---

## 十三、常见问题 FAQ

### Q1: 可以为不同规则使用不同上游吗？

**A**: 当前设计中，每个客户端只能配置一个上游服务器。如需支持多上游，需要扩展 `split_rules` 表添加 `upstream_id` 字段，并修改路由逻辑。

**扩展实现**:

```sql
ALTER TABLE split_rules ADD COLUMN upstream_id INTEGER;

-- 规则关联到特定上游
INSERT INTO split_rules (client_id, rule_type, rule_value, upstream_id)
VALUES (1, 'domain', 'google.com', 1);  -- 上游 1

INSERT INTO split_rules (client_id, rule_type, rule_value, upstream_id)
VALUES (1, 'domain', 'youtube.com', 2);  -- 上游 2
```

### Q2: 如何处理 IPv6？

**A**: 需要同时配置 IPv6 的 ipset 和 ip6tables:

```bash
# 创建 IPv6 ipset
ipset create client_1_proxy6 hash:ip family inet6 timeout 3600

# 配置 ip6tables
ip6tables -t mangle -A PREROUTING \
  -s fdcc::2 \
  -m set --match-set client_1_proxy6 dst \
  -j MARK --set-mark 101

# dnsmasq 自动处理 AAAA 记录
ipset=/google.com/client_1_proxy,client_1_proxy6
```

### Q3: 能否实现自动故障切换？

**A**: 可以通过健康检查实现:

```typescript
async function healthCheckUpstream(upstreamId: number) {
  const upstream = await Database.upstreams.get(upstreamId);
  
  try {
    const dump = await wg.dump(upstream.interfaceName);
    const lastHandshake = dump[0]?.latestHandshakeAt;
    
    if (!lastHandshake || Date.now() - lastHandshake.getTime() > 180000) {
      // 超过 3 分钟无握手 = 故障
      throw new Error('Upstream connection lost');
    }
  } catch (err) {
    // 切换到备用上游
    await switchToBackupUpstream(upstreamId);
  }
}
```

### Q4: 如何限制单个客户端的代理流量？

**A**: 使用 tc (traffic control):

```bash
# 为客户端 1 限制通过 wg-up-1 的流量
tc qdisc add dev wg-up-1 root handle 1: htb default 10
tc class add dev wg-up-1 parent 1: classid 1:1 htb rate 50mbit

# 或者在 iptables 中限制
iptables -A FORWARD -s 10.8.0.2 -o wg-up-1 \
  -m hashlimit --hashlimit-above 50mb/s \
  --hashlimit-name client_1_limit \
  -j DROP
```

### Q5: 能否实现"国内直连，国外代理"？

**A**: 需要 GeoIP 数据库:

```bash
# 1. 安装 GeoIP
apk add geoip geoip-dev

# 2. 下载 IP 库
# CN IP list: https://github.com/17mon/china_ip_list

# 3. 添加国内 IP 到 ipset（直连）
ipset create china_ip hash:net
while read cidr; do
  ipset add china_ip ${cidr}
done < china_ip_list.txt

# 4. iptables 规则（国外走代理）
iptables -t mangle -A PREROUTING \
  -s 10.8.0.2 \
  -m set ! --match-set china_ip dst \
  -j MARK --set-mark 101
```

---

## 十四、Docker Compose 快速测试

### 完整测试环境

```yaml
# docker-compose.test.yml
version: '3.8'

services:
  wg-easy:
    build: .
    container_name: wg-easy-split-test
    cap_add:
      - NET_ADMIN
      - SYS_MODULE
      - NET_RAW
    sysctls:
      - net.ipv4.ip_forward=1
      - net.ipv4.conf.all.src_valid_mark=1
      - net.ipv4.conf.all.rp_filter=2
    environment:
      - WG_HOST=192.168.1.100
      - PASSWORD=test123
      - DEBUG=*
    ports:
      - "51820:51820/udp"
      - "51821:51821/tcp"
    volumes:
      - ./test-data:/etc/wireguard
      - ./test-scripts:/scripts:ro
    networks:
      - wg-test

  # 模拟上游服务器（用于测试）
  upstream-server:
    image: linuxserver/wireguard
    container_name: upstream-wg
    cap_add:
      - NET_ADMIN
      - SYS_MODULE
    environment:
      - PUID=1000
      - PGID=1000
      - SERVERPORT=51820
      - PEERS=1
    ports:
      - "51820:51820/udp"
    volumes:
      - ./upstream-data:/config
    networks:
      - wg-test

networks:
  wg-test:
    driver: bridge
```

### 启动测试环境

```bash
# 1. 构建镜像
docker compose -f docker-compose.test.yml build

# 2. 启动服务
docker compose -f docker-compose.test.yml up -d

# 3. 等待初始化
sleep 10

# 4. 进入 wg-easy 容器
docker exec -it wg-easy-split-test bash

# 5. 运行部署脚本
./scripts/deploy-split-tunneling.sh 10.8.0.2 upstream-server:51820 <public_key>

# 6. 运行测试
./scripts/test-split-tunneling.sh

# 7. 查看日志
docker logs -f wg-easy-split-test
```

---

## 十五、最小代码实现（纯 Shell 版本）

如果不想修改 wg-easy 代码，可以使用外部脚本：

```bash
#!/bin/bash
# split-tunneling-standalone.sh
# 独立的分流脚本，可在 PostUp 中调用

CONFIG_FILE="/etc/wireguard/split-config.json"

# 读取配置（JSON 格式）
# {
#   "clients": [
#     {
#       "id": 1,
#       "ip": "10.8.0.2",
#       "upstream": "wg-up-1",
#       "domains": ["google.com", "youtube.com"],
#       "ips": ["8.8.8.8/32"]
#     }
#   ]
# }

# 解析 JSON（使用 jq）
CLIENTS=$(jq -r '.clients[]' ${CONFIG_FILE})

# 为每个客户端配置
echo "$CLIENTS" | while read -r client; do
  CLIENT_ID=$(echo $client | jq -r .id)
  CLIENT_IP=$(echo $client | jq -r .ip)
  UPSTREAM=$(echo $client | jq -r .upstream)
  
  IPSET_NAME="client_${CLIENT_ID}_proxy"
  FWMARK=$((100 + CLIENT_ID))
  ROUTE_TABLE=$((100 + CLIENT_ID))
  
  # 创建 ipset
  ipset create ${IPSET_NAME} hash:ip timeout 3600 -exist
  ipset flush ${IPSET_NAME}
  
  # 添加 IP 规则
  echo $client | jq -r '.ips[]' | while read ip; do
    ipset add ${IPSET_NAME} ${ip} -exist
  done
  
  # iptables
  iptables -t mangle -A PREROUTING \
    -s ${CLIENT_IP} \
    -m set --match-set ${IPSET_NAME} dst \
    -j MARK --set-mark ${FWMARK}
  
  # 策略路由
  ip rule add fwmark ${FWMARK} table ${ROUTE_TABLE} prio $((1000 + CLIENT_ID))
  ip route add default dev ${UPSTREAM} table ${ROUTE_TABLE}
  
  # dnsmasq 配置
  echo $client | jq -r '.domains[]' | while read domain; do
    echo "ipset=/${domain}/${IPSET_NAME}" >> /etc/dnsmasq.d/split.conf
  done
done

# 重载 dnsmasq
killall -HUP dnsmasq

echo "Split tunneling configured for $(echo "$CLIENTS" | wc -l) clients"
```

**使用方式**:

```bash
# 在 wg0 的 PostUp 中调用
PostUp = /scripts/split-tunneling-standalone.sh
```

---

## 总结

### 最小实现清单

✅ **必需组件**:
- [ ] dnsmasq (DNS 分流)
- [ ] ipset (IP 集合管理)
- [ ] iptables (流量标记)
- [ ] iproute2 (策略路由)
- [ ] WireGuard (上游连接)

✅ **核心文件**:
- [ ] `/etc/wireguard/wg-up-1.conf` (上游接口配置)
- [ ] `/etc/dnsmasq.d/split-tunneling.conf` (DNS 分流规则)
- [ ] `/etc/iproute2/rt_tables` (路由表定义)

✅ **关键命令**:
- [ ] `ipset create/add` (管理 IP 集合)
- [ ] `iptables -t mangle` (标记流量)
- [ ] `ip rule/route` (策略路由)
- [ ] `wg-quick up` (启动接口)

### 从手动到自动化

1. **手动阶段**: 使用本文档的命令手动配置，验证可行性
2. **脚本阶段**: 编写 Shell 脚本自动化配置
3. **集成阶段**: 将逻辑集成到 wg-easy 代码中
4. **UI 阶段**: 添加 Web 界面管理

### 预计时间线

- PoC (手动): 1-2 天
- 脚本自动化: 3-5 天
- 代码集成: 2-3 周
- 完整 UI: 4-6 周

**建议**: 先完成 PoC 验证，再进行完整开发。

---

**开始你的第一个测试**: 

```bash
docker exec -it wg-easy bash
wget https://raw.githubusercontent.com/.../deploy-split-tunneling.sh
chmod +x deploy-split-tunneling.sh
./deploy-split-tunneling.sh 10.8.0.2 <your_upstream>:51820 <public_key> google.com
```

**祝测试顺利！** 🚀
