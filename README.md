# xRay-zoo

面向自营订阅业务的 Xray 集群控制台。管理员连接 Azure、选择地区并创建节点，用户购买套餐后获得可导入 Mihomo / Clash Meta 客户端的订阅链接。

**当前阶段：P0 节点验证、本地购买闭环、用户中心与管理员后台。** 已部署 Azure JP / SG / US / HK / TW 五台节点，完成 Mihomo 实际出站、Stripe Sandbox 付款回调、自动开通与订阅链接生成。网页和控制面运行在本机；正式收款、公网 SaaS 和完整运营能力尚未发布。

- [普通用户中心与访问撤销](docs/13-customer-account.md)
- 默认月套餐：50 / 150 / 300 GB，按足额 Azure 亚洲出网成本 × 10 为 US$60 / US$180 / US$360；[计价假设与市场对照](docs/09-unit-economics.md)。
- [后台上机器：区域、规格、进度与自动订阅池](docs/14-machine-provisioning.md)
- [节点 IP 轮换：进度、自动订阅更新、失败重试与回滚](docs/15-ip-rotation.md)
- [批量节点维护：多选、后台任务与逐项结果](docs/16-batch-maintenance.md)
- [管理员后台与节点状态说明](docs/12-admin-console.md)
- [实际验证结果与限制](docs/10-p0-results.md)
- [本地运行、Azure 部署与恢复](docs/11-local-runbook.md)
- 网页：`http://localhost:3100`；用户中心：`http://localhost:3100/account`；管理员：`http://localhost:3100/admin`；API：`http://localhost:3101`。管理员登录后自动进入后台，可新增 Azure 节点、查看区域状态、用户、套餐、订单、用量并管理订阅。
- 私有节点状态、Azure/Stripe 凭证和导出访问身份均在被 Git 忽略的 `.local/`；不得提交。

## 首版目标

- 一个运营商自营节点，向终端用户销售订阅；支持运营团队多个管理角色。
- Azure 服务主体凭证接入，支持 client secret 或证书；在专用资源组内创建多地区节点。
- 先展示资源变更与费用估算，再异步创建、检测、发布节点，并导出不含秘密的集群模板。
- 套餐包含地区权限、有效期与流量额度，支付确认后自动开通，续费、到期、退款和额度耗尽均有明确处理。
- 自有订阅域名，支持链接重置、节点变更和客户端配置导出。

## 推荐技术方案

| 部分       | 首版选择                                                               |
| ---------- | ---------------------------------------------------------------------- |
| 网页       | Next.js + TypeScript + Tailwind / shadcn/ui                            |
| 业务服务   | NestJS 模块化单体，REST / OpenAPI                                      |
| 数据与任务 | PostgreSQL + Prisma，Redis + BullMQ，事务 outbox                       |
| Xray 管理  | Remnawave 独立部署，经适配器接入；业务账本属于 xRay-zoo                |
| Azure 编排 | Azure Identity / ARM SDK + Bicep + cloud-init                          |
| 支付       | PaymentProvider 接口，优先 Stripe Checkout / Billing / Customer Portal |
| 配置       | 首版明确支持 Mihomo 的 VLESS + REALITY；不承诺旧版 Clash 兼容          |
| 初期部署   | 独立控制服务器的 Docker Compose，地区节点使用 Azure Linux VM           |

表格是目标架构。当前网页使用 Next.js 与普通 CSS，P0 登录使用仅限本机的邮箱/密码；Azure 通过隔离的 CLI 登录和 ARM REST 编排。OIDC/MFA、完整 RBAC、网页配置 Azure 凭证和 Customer Portal 属于后续阶段。

## 文档导航

1. [产品范围与页面流程](docs/01-product.md)
2. [参考项目与选型依据](docs/02-research.md)
3. [系统架构与运行方式](docs/03-architecture.md)
4. [数据模型与 RBAC](docs/04-data-and-rbac.md)
5. [Azure 接入与集群编排](docs/05-azure-provisioning.md)
6. [支付、额度与订阅交付](docs/06-billing-and-subscriptions.md)
7. [API 与适配器契约](docs/07-api-contracts.md)
8. [交付顺序与验收](docs/08-delivery-plan.md)
9. [成本模型与套餐定价](docs/09-unit-economics.md)

领域用语见 [CONTEXT.md](CONTEXT.md)，关键取舍见 [架构决策](docs/adr/0001-control-plane-and-engine.md)。

## 配置示例

- [Azure 多地区集群蓝图](examples/cluster.blueprint.example.json)
- [套餐版本示例](examples/plan.example.json)
- [Mihomo 配置模板](examples/mihomo.template.yaml)
- [配置说明与导出边界](examples/README.md)
- [未来应用环境变量](.env.example)

这些 example 文件用于说明目标输入和输出形状，`${...}` 是占位符。实际 P0 部署和订阅渲染命令见运行手册，渲染结果包含访问凭证，不能提交。

## 当前代码布局

```text
apps/web/                  # 商城、账户与管理员后台
apps/api/                  # 登录、RBAC、订单、订阅和管理员 API
apps/worker/               # 支付、授权同步、流量采集与节点控制重连
packages/core/             # 账本、授权、加密、节点检测
packages/engine-remnawave/ # 引擎适配器
packages/subscription/     # tc split Mihomo 配置渲染
prisma/                    # PostgreSQL 数据模型与迁移
scripts/                   # P0 Azure 编排、本地启动与验证
infra/azure/               # Bicep 节点资源
infra/local/               # 本地 Docker Compose
```

## 项目与依赖许可

本仓库包含原创业务代码、设计文档和配置模板；Remnawave 与 Mihomo 通过独立服务或客户端使用。项目尚未选定开源许可证。上游许可和复用边界记录在 [调研文档](docs/02-research.md)，独立部署与 API 调用不应被当成自动免除上游许可义务的保证。
