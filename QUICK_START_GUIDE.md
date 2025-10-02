# WireGuard 分流功能快速开始指南

本文档提供快速实施步骤和常见问题解决方案。

---

## 一、准备工作检查清单

### 系统要求

- [x] Linux 内核支持 WireGuard (>= 5.6)
- [x] Docker 和 Docker Compose
- [x] 系统开启 IP 转发
- [x] 防火墙规则配置正确

### 必需工具

```bash
# 检查工具是否安装
command -v wg && echo "✓ wireguard-tools" || echo "✗ wireguard-tools"
command -v dnsmasq && echo "✓ dnsmasq" || echo "✗ dnsmasq"
command -v ipset && echo "✓ ipset" || echo "✗ ipset"
command -v iptables && echo "✓ iptables" || echo "✗ iptables"
command -v ip && echo "✓ iproute2" || echo "✗ iproute2"
```

---

## 二、分步实施指南

### 阶段 1: 数据库扩展 (预计 2-3 天)

#### 步骤 1.1: 创建迁移文件

```bash
cd /workspace/src/server/database/migrations
```

创建 `0002_split_tunneling.sql`（参考 IMPLEMENTATION_EXAMPLES.md 第 6 节）

#### 步骤 1.2: 创建 Schema 定义

```bash
mkdir -p src/server/database/repositories/upstream
mkdir -p src/server/database/repositories/splitRule
```

创建以下文件：
- `upstream/schema.ts`
- `upstream/types.ts`
- `upstream/service.ts`
- `splitRule/schema.ts`
- `splitRule/types.ts`
- `splitRule/service.ts`

#### 步骤 1.3: 更新主 Schema

编辑 `src/server/database/schema.ts`:

```typescript
// 添加导出
export * from './repositories/upstream/schema';
export * from './repositories/splitRule/schema';
```

#### 步骤 1.4: 注册到 Database 类

编辑 `src/server/utils/Database.ts`:

```typescript
import { UpstreamService } from '#db/repositories/upstream/service';
import { SplitRuleService } from '#db/repositories/splitRule/service';

class Database {
  // ... 现有代码 ...
  
  upstreams: UpstreamService;
  splitRules: SplitRuleService;
  
  constructor() {
    // ... 现有初始化 ...
    
    this.upstreams = new UpstreamService(this.#db);
    this.splitRules = new SplitRuleService(this.#db);
  }
}
```

#### 步骤 1.5: 测试数据库

```bash
# 重建容器以应用迁移
docker compose -f docker-compose.dev.yml up --build
```

---

### 阶段 2: 核心逻辑实现 (预计 5-7 天)

#### 步骤 2.1: 创建 SplitTunneling 类

```bash
touch src/server/utils/SplitTunneling.ts
```

实现核心功能（参考 IMPLEMENTATION_EXAMPLES.md 第 2.1 节）

#### 步骤 2.2: 集成到 WireGuard 启动流程

编辑 `src/server/utils/WireGuard.ts`，在 `Startup()` 和 `Shutdown()` 方法中添加分流功能调用。

#### 步骤 2.3: 测试核心功能

创建测试脚本:

```bash
mkdir -p scripts
touch scripts/test-split-tunneling.sh
chmod +x scripts/test-split-tunneling.sh
```

运行测试:

```bash
docker exec -it wg-easy bash
/app/scripts/test-split-tunneling.sh
```

---

### 阶段 3: API 端点 (预计 3-4 天)

#### 步骤 3.1: 创建上游服务器 API

```bash
mkdir -p src/server/api/upstream
mkdir -p src/server/api/upstream/[upstreamId]
```

创建文件：
- `upstream/index.get.ts` - 列表
- `upstream/index.post.ts` - 创建
- `upstream/[upstreamId]/index.get.ts` - 详情
- `upstream/[upstreamId]/index.post.ts` - 更新
- `upstream/[upstreamId]/index.delete.ts` - 删除

#### 步骤 3.2: 创建分流规则 API

```bash
mkdir -p src/server/api/splitRule/[clientId]
mkdir -p src/server/api/splitRule/[clientId]/[ruleId]
```

创建文件：
- `splitRule/[clientId]/index.get.ts` - 获取客户端规则
- `splitRule/[clientId]/index.post.ts` - 创建规则
- `splitRule/[clientId]/[ruleId]/index.delete.ts` - 删除规则
- `splitRule/[clientId]/[ruleId]/index.post.ts` - 更新规则

#### 步骤 3.3: 扩展客户端 API

编辑 `src/server/api/client/[clientId]/index.post.ts`，添加对 `upstreamEnabled` 和 `upstreamId` 的支持。

#### 步骤 3.4: 测试 API

```bash
# 测试创建上游服务器
curl -X POST http://localhost:51821/api/upstream \
  -H "Content-Type: application/json" \
  -H "Cookie: session=xxx" \
  -d '{
    "name": "Test Upstream",
    "endpoint": "example.com:51820",
    "publicKey": "xxxx",
    "privateKey": "yyyy",
    "allowedIps": ["0.0.0.0/0"]
  }'

# 测试创建分流规则
curl -X POST http://localhost:51821/api/splitRule/1 \
  -H "Content-Type: application/json" \
  -H "Cookie: session=xxx" \
  -d '{
    "ruleType": "domain",
    "ruleValue": "google.com",
    "action": "proxy"
  }'
```

---

### 阶段 4: 前端界面 (预计 5-6 天)

#### 步骤 4.1: 创建上游服务器管理页面

```bash
mkdir -p src/app/pages/upstream
touch src/app/pages/upstream/index.vue
touch src/app/pages/upstream/[id].vue
```

#### 步骤 4.2: 创建分流组件

```bash
mkdir -p src/app/components/SplitTunneling
touch src/app/components/SplitTunneling/RuleEditor.vue
touch src/app/components/SplitTunneling/UpstreamSelector.vue
```

实现 RuleEditor（参考 IMPLEMENTATION_EXAMPLES.md 第 4.1 节）

#### 步骤 4.3: 扩展客户端编辑页面

编辑 `src/app/pages/clients/[id].vue`，添加分流配置区域（参考 IMPLEMENTATION_EXAMPLES.md 第 4.2 节）

#### 步骤 4.4: 添加国际化翻译

编辑 `src/i18n/locales/en.json`:

```json
{
  "splitTunneling": {
    "title": "Split Tunneling",
    "upstream": "Upstream Server",
    "enableUpstream": "Enable Split Tunneling",
    "enableUpstreamDesc": "Route specific traffic through an upstream WireGuard server",
    "upstreamServer": "Upstream Server",
    "rules": "Routing Rules",
    "rulesDesc": "Define which domains or IPs should be routed through the upstream",
    "ruleType": "Rule Type",
    "ruleValue": "Value",
    "action": "Action",
    "domain": "Domain",
    "ip": "IP/CIDR",
    "proxy": "Proxy",
    "direct": "Direct"
  }
}
```

同样添加中文翻译 `zh-CN.json`。

---

### 阶段 5: Docker 和部署 (预计 2 天)

#### 步骤 5.1: 更新 Dockerfile

编辑 `Dockerfile`，添加必需的软件包（参考 IMPLEMENTATION_EXAMPLES.md 第 6 节）

#### 步骤 5.2: 更新 docker-compose.yml

```yaml
services:
  wg-easy:
    # ... 现有配置 ...
    cap_add:
      - NET_ADMIN
      - SYS_MODULE
      - NET_RAW  # 新增：ipset 需要
    sysctls:
      - net.ipv4.ip_forward=1
      - net.ipv4.conf.all.src_valid_mark=1
      - net.ipv4.conf.all.rp_filter=2  # 新增：反向路径过滤
    volumes:
      - /lib/modules:/lib/modules:ro
      - ./data:/etc/wireguard
```

#### 步骤 5.3: 构建和测试

```bash
# 构建镜像
docker compose build

# 启动服务
docker compose up -d

# 查看日志
docker compose logs -f

# 进入容器测试
docker compose exec wg-easy bash
```

---

## 三、功能测试流程

### 测试场景 1: 单客户端域名分流

#### 1. 创建上游服务器

通过 Web UI 或 API:
- 名称: "US Server"
- 端点: "us.example.com:51820"
- 公钥: (你的上游服务器公钥)
- 私钥: (本地生成的私钥)

#### 2. 配置客户端

编辑客户端 "Client A":
- 启用分流: ✓
- 上游服务器: "US Server"

#### 3. 添加分流规则

为 "Client A" 添加规则:
- 类型: Domain
- 值: google.com
- 动作: Proxy

#### 4. 客户端测试

在客户端设备上:

```bash
# 连接到 WireGuard
wg-quick up client_a

# 测试直连（应该显示本地 IP）
curl ipinfo.io

# 测试代理（应该显示上游服务器 IP）
curl google.com -I | grep -i via

# 或者检查 IP
nslookup google.com
# 然后访问解析的 IP，检查是否通过上游
```

#### 5. 服务端验证

在 wg-easy 服务器上:

```bash
# 检查 ipset
ipset list client_1_proxy

# 检查 iptables 规则
iptables -t mangle -L PREROUTING -n -v

# 检查策略路由
ip rule list
ip route show table 101

# 检查上游接口状态
wg show wg-up-1

# 检查流量统计
wg show wg-up-1 transfer
```

---

### 测试场景 2: 多客户端独立分流

#### 1. 创建第二个上游服务器

- 名称: "EU Server"
- 端点: "eu.example.com:51820"

#### 2. 配置第二个客户端

编辑客户端 "Client B":
- 启用分流: ✓
- 上游服务器: "EU Server"

#### 3. 添加不同的规则

为 "Client B" 添加规则:
- 类型: Domain
- 值: youtube.com
- 动作: Proxy

#### 4. 验证隔离

- Client A 访问 google.com → 通过 US Server
- Client A 访问 youtube.com → 直连
- Client B 访问 google.com → 直连
- Client B 访问 youtube.com → 通过 EU Server

---

## 四、常见问题排查

### 问题 1: dnsmasq 无法启动

**症状**: 日志显示 "dnsmasq: failed to create listening socket for port 53"

**原因**: 端口 53 被占用（可能是 systemd-resolved）

**解决**:

```bash
# 方法 1: 修改 dnsmasq 监听端口
echo "port=5353" >> /etc/dnsmasq.conf

# 方法 2: 禁用 systemd-resolved
systemctl stop systemd-resolved
systemctl disable systemd-resolved
```

### 问题 2: 上游接口无法启动

**症状**: "Cannot find device wg-up-1"

**原因**: WireGuard 内核模块未加载

**解决**:

```bash
# 加载模块
modprobe wireguard

# 检查模块
lsmod | grep wireguard

# 或使用 amneziawg（如果安装了）
modprobe amneziawg
```

### 问题 3: 流量不经过上游

**症状**: 所有流量都直连，不走代理

**排查步骤**:

```bash
# 1. 检查 ipset 是否有内容
ipset list client_1_proxy
# 应该看到解析的 IP

# 2. 检查 DNS 是否通过 dnsmasq
dig @127.0.0.1 google.com
# 检查是否返回结果

# 3. 检查 iptables 规则
iptables -t mangle -L PREROUTING -n -v
# 应该看到匹配的包计数增加

# 4. 检查策略路由
ip rule list
ip route show table 101

# 5. 测试路由
ip route get 8.8.8.8 from 10.8.0.2
```

**常见原因**:
- DNS 未指向本地（客户端配置中 DNS 应为 wg0 的 IP，如 10.8.0.1）
- dnsmasq 配置未生效
- ipset 超时已过期

### 问题 4: 客户端无法连接

**症状**: 启用分流后客户端无法访问任何网站

**排查**:

```bash
# 检查上游接口状态
wg show wg-up-1

# 检查上游连接
ping -I wg-up-1 8.8.8.8

# 检查路由表
ip route show table 101

# 检查防火墙规则
iptables -L FORWARD -n -v
```

**解决**:
- 确保上游服务器配置正确
- 检查上游服务器的 AllowedIPs 设置
- 验证上游服务器的防火墙规则

### 问题 5: 性能下降

**症状**: 启用分流后速度明显下降

**原因**: 双重封装开销

**优化**:

```bash
# 1. 调整 MTU
# 上游接口 MTU 应比主接口小 60-80 字节
# 主接口: 1420, 上游接口: 1360

# 2. 启用 BBR
sysctl -w net.ipv4.tcp_congestion_control=bbr

# 3. 检查 CPU 使用率
top -p $(pgrep wg-easy)
```

### 问题 6: 规则不生效

**症状**: 添加规则后没有效果

**排查**:

```bash
# 1. 检查规则是否保存到数据库
sqlite3 /etc/wireguard/db.sqlite "SELECT * FROM split_rules WHERE client_id=1;"

# 2. 检查 dnsmasq 配置是否生成
cat /etc/dnsmasq.d/split-tunneling.conf

# 3. 手动测试 DNS
dig @127.0.0.1 google.com +short

# 4. 检查 ipset 是否添加
ipset test client_1_proxy 142.250.185.46
```

**解决**:
- 重新应用配置: 重启 wg-easy 或调用 API 更新配置
- 检查域名格式（不要包含协议，如 `http://`）
- 检查 IP/CIDR 格式

---

## 五、性能调优建议

### 1. 系统参数优化

```bash
# /etc/sysctl.conf 添加

# 网络缓冲区
net.core.rmem_max = 134217728
net.core.wmem_max = 134217728
net.ipv4.tcp_rmem = 4096 87380 67108864
net.ipv4.tcp_wmem = 4096 65536 67108864

# 连接跟踪
net.netfilter.nf_conntrack_max = 1000000
net.netfilter.nf_conntrack_tcp_timeout_established = 7200

# IP 转发优化
net.ipv4.ip_forward = 1
net.ipv4.conf.all.forwarding = 1

# 应用配置
sysctl -p
```

### 2. iptables 优化

```bash
# 使用 ipset 而非大量 iptables 规则
# 已在实现中采用

# 将常用规则放在前面
# 在 mangle 表中尽早标记流量
```

### 3. dnsmasq 优化

```bash
# /etc/dnsmasq.conf

# 增大缓存
cache-size=10000

# 并行查询
dns-forward-max=1000

# 禁用不需要的功能
no-dhcp-interface=*
```

### 4. WireGuard 优化

```bash
# 调整 MTU（根据网络环境）
# 上游接口: 1360-1380
# 主接口: 1420

# 调整 PersistentKeepalive（节省带宽）
# NAT 后面的客户端: 25秒
# 公网客户端: 0（禁用）
```

---

## 六、监控和日志

### 启用详细日志

```bash
# 环境变量
DEBUG=Server,WireGuard,SplitTunneling,Database,CMD

# dnsmasq 查询日志
echo "log-queries" >> /etc/dnsmasq.conf
echo "log-facility=/var/log/dnsmasq.log" >> /etc/dnsmasq.conf

# 实时查看
tail -f /var/log/dnsmasq.log
```

### 监控脚本

```bash
# scripts/monitor.sh
#!/bin/bash

while true; do
  clear
  echo "=== WireGuard Split Tunneling Monitor ==="
  date
  echo ""
  
  echo "Interfaces:"
  ip -br link show | grep wg
  echo ""
  
  echo "Active Clients:"
  wg show wg0 | grep peer | wc -l
  echo ""
  
  echo "Upstream Connections:"
  for iface in $(ip link show | grep -o 'wg-up-[0-9]*'); do
    echo "  $iface: $(wg show $iface | grep -c 'peer')"
  done
  echo ""
  
  echo "IPSet Entries:"
  for ipset in $(ipset list -n | grep client_.*_proxy); do
    count=$(ipset list $ipset | grep -E '^[0-9]' | wc -l)
    echo "  $ipset: $count IPs"
  done
  
  sleep 5
done
```

---

## 七、生产环境部署清单

### 部署前检查

- [ ] 数据库已备份
- [ ] 上游服务器配置已测试
- [ ] 防火墙规则已配置
- [ ] DNS 服务器已指向正确
- [ ] MTU 值已优化
- [ ] 监控和告警已配置
- [ ] 回滚计划已准备

### 部署步骤

1. **备份数据**
   ```bash
   docker exec wg-easy cp /etc/wireguard/db.sqlite /etc/wireguard/db.sqlite.backup
   ```

2. **更新镜像**
   ```bash
   docker compose pull
   docker compose up -d
   ```

3. **验证功能**
   - 测试客户端连接
   - 验证分流规则
   - 检查日志

4. **性能监控**
   - CPU 使用率 < 50%
   - 内存使用 < 80%
   - 网络延迟 < 50ms

### 回滚计划

如果出现问题:

```bash
# 1. 停止服务
docker compose down

# 2. 恢复备份
docker run --rm -v wg-easy:/etc/wireguard alpine sh -c \
  "cp /etc/wireguard/db.sqlite.backup /etc/wireguard/db.sqlite"

# 3. 使用旧镜像
docker compose up -d --no-deps wg-easy:old-version

# 4. 验证
curl http://localhost:51821/api/health
```

---

## 八、最佳实践

### 1. 上游服务器管理

- 为每个上游服务器使用描述性名称（如 "US-West-1", "EU-Frankfurt"）
- 定期测试上游连接（ping, MTR）
- 为关键服务准备备用上游服务器
- 监控上游流量和连接数

### 2. 分流规则设计

- 使用域名规则而非 IP（IP 可能变化）
- 组织规则为逻辑组（如 "Google Services", "Social Media"）
- 定期审查和清理无用规则
- 避免过于宽泛的规则（如 `*.com`）

### 3. 客户端配置

- 为每个客户端设置合理的过期时间
- 使用描述性名称标识客户端用途
- 记录每个客户端的分流配置变更
- 定期审查未使用的客户端

### 4. 安全考虑

- 定期更新 WireGuard 密钥
- 限制管理员权限
- 启用 2FA
- 审计配置变更日志
- 使用 HTTPS 访问 Web UI

---

## 九、参考命令速查

```bash
# === WireGuard ===
wg show                              # 显示所有接口
wg show wg0                          # 显示主接口
wg show wg-up-1                      # 显示上游接口
wg-quick up wg-up-1                  # 启动接口
wg-quick down wg-up-1                # 停止接口

# === ipset ===
ipset list                           # 列出所有 ipset
ipset list client_1_proxy            # 显示特定 ipset
ipset add client_1_proxy 8.8.8.8     # 添加 IP
ipset test client_1_proxy 8.8.8.8    # 测试 IP 是否在集合中
ipset destroy client_1_proxy         # 删除 ipset

# === iptables ===
iptables -t mangle -L -n -v          # 查看 mangle 表
iptables -t mangle -L PREROUTING -n  # 查看 PREROUTING 链
iptables-save                        # 保存规则
iptables-restore                     # 恢复规则

# === 路由 ===
ip rule list                         # 查看策略路由规则
ip route show table 101              # 查看特定路由表
ip route get 8.8.8.8 from 10.8.0.2   # 测试路由
ip -s link show wg-up-1              # 查看接口统计

# === dnsmasq ===
killall -HUP dnsmasq                 # 重载配置
killall -USR1 dnsmasq                # 输出统计信息到日志
dig @127.0.0.1 google.com            # 测试 DNS 解析

# === 系统 ===
sysctl net.ipv4.ip_forward           # 检查 IP 转发
lsmod | grep wireguard               # 检查内核模块
cat /proc/sys/net/ipv4/ip_forward    # 检查转发状态
```

---

## 十、获取帮助

### 日志位置

- wg-easy 日志: `docker compose logs wg-easy`
- dnsmasq 日志: `/var/log/dnsmasq.log`
- 系统日志: `journalctl -u docker`

### 调试模式

```bash
# 启用所有调试日志
docker compose down
docker compose up -e DEBUG=*
```

### 社区支持

- GitHub Issues: https://github.com/wg-easy/wg-easy/issues
- WireGuard 官方文档: https://www.wireguard.com/
- Linux 网络调试: https://www.kernel.org/doc/Documentation/networking/

---

**祝实施顺利！** 🎉

如有问题，请参考 `SPLIT_TUNNELING_IMPLEMENTATION_PLAN.md` 获取详细技术方案，或参考 `IMPLEMENTATION_EXAMPLES.md` 获取完整代码示例。
