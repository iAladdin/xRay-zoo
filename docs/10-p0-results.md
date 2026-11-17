# P0 实测与本地购买闭环

日期：2026-11-18（Asia/Shanghai）。这份记录区分真实云资源、Stripe 测试交易与未验证的生产能力。

## 已部署资源

Azure 订阅 AAL-Dev，专用资源组 `xray-zoo-p0`。没有在既有模型资源组中创建节点。

| 节点 | Azure 区域 | 出口 IPv4 | 探测地区 | 分流用途 |
| --- | --- | --- | --- | --- |
| xz-p0-jp | japaneast | 20.48.88.99 | JP | AI |
| xz-p0-sg | southeastasia | 20.24.138.24 | SG | AI |
| xz-p0-us | eastus2 | 40.75.25.189 | US | AI |
| xz-p0-hk | eastasia | 20.24.220.254 | HK | Telegram |
| xz-p0-tw | taiwannorth | 51.53.93.169 | TW | Telegram |

每台为 `Standard_B2ats_v2`（2 vCPU / 1 GiB），Ubuntu 24.04 固定镜像 `24.04.202610250`，32 GiB Standard SSD，独立静态 Standard IPv4。每区域配额与 SKU 限制均实际预检后创建。

计算费用按当次零售价格与 730 小时估算约 **42 美元/月**；加五个公网 IP 和磁盘，固定费用估算 **75–85 美元/月**，另外计公网流出、税费。不是实际账单或有保证的报价。控制面目前在本机，没有额外云控制 VM。

## 技术栈和边界

- Next.js 16.4.6 / React 19.3.1，NestJS 12.5.1，PostgreSQL 18.4，Prisma 6.19.0，Redis 8.2.2 / BullMQ 6.7.7。
- Remnawave backend 3.4.11、Node 3.4.6，节点镜像固定 digest；Xray 26.11.9；客户端验证使用 Mihomo 1.19.33。
- Azure CLI 使用项目内独立认证目录，没有切换用户全局 Azure 默认订阅。云初始化不包含节点私钥；节点信任凭证通过 VM 扩展 protectedSettings 下发。
- 管理入口 22 / 2222 限制为本次操作出口 `/32`；443 对客户端开放。VM 系统身份没有分配 Azure 管理角色。
- 本地网络会重置引擎派生 SNI 的 TLS 握手。P0 控制链路通过每台 VM 的 SSH 隧道承载原有 mTLS；没有关闭证书验证。正式控制面应迁至稳定服务器，按新的管理出口调整 NSG。

## 通过的验证

1. **五区域实际创建与配置**：ARM 部署全部 Succeeded；cloud-init 安装 Docker，受保护扩展启动 Node；五个独立 profile / squad / host 建立，节点全部连通。
2. **真实客户端联网**：Mihomo 分别连接每台 VM 的公网 443 REALITY 入口，请求 Cloudflare trace，五个出口 IP 和国家/地区逐一匹配。为排除本机已存在代理的干扰，探测套接字经日本 VM 的 SSH SOCKS 中转；配置交付中不含这个测试中转。不能将该结果描述为本机任意网络直连已验证。
3. **协议兼容**：Xray 新版要求的 ClientHello 由 `reality-opts.support-x25519mlkem768: true` 满足。诊断期间调整过 `minClientVer`，最终配置已移除该调整；没有降级服务端或跳过 TLS 校验。
4. **tc 分流**：保留 tc-hk-split 的 DNS 与规则顺序。AI 组的所有可达叶节点仅 JP / SG / US；Telegram 仅 HK / TW；对应区域不可用时该组 REJECT。旧 GeoSite 缺少 AI 类别，因此将分流规则中的 GEOSITE 替换为同名 MetaCubeX MRS 规则集，20 个规则集 URL 均已验证返回 200。DNS 所需 CN / 非 CN 分类保留。
5. **真实 Stripe Sandbox 流程**：浏览器注册 → 选择 20 GB、9.99 USD/月测试套餐 → Stripe 托管 Checkout → 官方测试卡成功付款 → 签名 Webhook → 数据库 inbox/outbox → BullMQ worker → 引擎开通 → 网页显示可下载的专属 Clash 订阅。此流程没有真实扣款。
6. **幂等与基础权限**：并发重复 invoice 只生成一份服务期；金额不匹配拒绝；重复同步保留同一访问 UUID；跨站 Origin 拒绝；管理接口未登录拒绝；随机订阅 token 拒绝；错误 Stripe 签名返回 400。
7. **停用的实际效果**：临时集成测试账号先用已缓存 YAML 成功联网，再停用账号。保持同一份 YAML，后续新连接在本次观察的 342 ms 窗口内失败。这个单次观察不是传播时间 SLO，也没有覆盖已建立长连接。
8. **构建与配置**：TypeScript、Next.js 生产构建、订阅单元测试、真实数据库/引擎集成测试通过；最终导出 YAML 通过 Mihomo 配置校验。引擎已观察到跨节点探测的累计流量。

浏览器测试账号和集成测试记录保留用于审计；集成测试访问身份最终处于 suspended。

补充验证：Stripe 测试购买身份在全部五个节点成功联网，用量已被业务页面的后台计量任务读取；取消到期续费返回成功，Stripe 回读 `cancel_at_period_end=true`、`livemode=false`。专属订阅 HTTP 返回 200，包含五个节点，UUID 与该购买身份逐一匹配。日本 Node 容器重启后重新连上控制面并恢复服务。

浏览器自动化下载事件被取消，因此没有把“浏览器保存文件”算作通过项；订阅 HTTP 内容与独立交付 YAML 均已校验，交付目录中提供可直接导入的文件。

## 尚未完成的阶段门槛

- 不是完整 P0 风险矩阵验收：严格全局额度的超用窗口、跨周期流量边界、计数器重置与崩溃恢复、控制面失联时本地到期/额度执行、长连接回收、吞吐与 CPU credits 压测均未完成。
- 目前节点 ready 定时刷新来自引擎连接状态；端到端合成探测已经执行，但尚未做持续探测门禁。
- 登录仅本机邮箱/密码，ADMIN / CUSTOMER 为最小服务端权限。OIDC、MFA、邮箱验证、完整运营角色、审计查询和公网安全配置待实现，代码显式阻止非 local 环境启动。
- Stripe 仅支持当前固定金额月订阅与签名 invoice.paid，支持取消到期续费。税费、优惠、升级降级、退款/争议、自动支付对账和更完整的乱序事件场景未实现，不适合正式收费。
- Azure 当前为可审阅计划 + CLI / Bicep 自动化。网页上传服务主体 secret/证书、最小自定义 Azure role 验证、专用密钥库与机器身份领取机制尚未实现。
- 本机 API、worker、数据库、Remnawave、SSH 控制隧道与 Stripe CLI listener 必须运行，才能继续付款开通、计量同步和订阅刷新。节点失联时可能保留已下发的访问配置，不能承诺自动停服。
- 单独交付的 P0 YAML 使用专用测试身份，五区域共享 20 GB，创建时有效期 30 天；与网站的 Stripe 测试购买身份分离。不得当作商业套餐 SLA。

## 参考

- [Xray / Mihomo 兼容问题及维护者说明](https://github.com/XTLS/Xray-core/issues/6477)
- [Mihomo TLS 与 MLKEM 配置](https://wiki.metacubex.one/config/proxies/tls/)
- [Stripe 测试支付](https://docs.stripe.com/testing)
- [Stripe Webhook 签名与本地监听](https://docs.stripe.com/webhooks)

详细私有探测结果保存在 `.local/probe-results.json`、`.local/revocation-result.json`、`.local/ruleset-check.json` 和本地验证日志。凭证和用户访问配置不提交到仓库。
