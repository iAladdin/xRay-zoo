# xRay-zoo

面向自营订阅业务的 Xray 集群控制台。管理员连接 Azure、选择地区并创建节点，用户购买套餐后获得可导入 Mihomo / Clash Meta 客户端的订阅链接。

**当前阶段：P0 节点验证与本地最小购买闭环。** 已部署 Azure JP / SG / US / HK / TW 五台节点，完成 Mihomo 实际出站、Stripe Sandbox 付款回调、自动开通与订阅链接生成。网页和控制面运行在本机；正式收款、公网 SaaS 和完整运营能力尚未发布。

- [实际验证结果与限制](docs/10-p0-results.md)
- [本地运行、Azure 部署与恢复](docs/11-local-runbook.md)
- 网页：`http://localhost:3100`；API：`http://localhost:3101`。
- 私有节点状态、Azure/Stripe 凭证和导出访问身份均在被 Git 忽略的 `.local/`；不得提交。

## 首版目标

- 一个运营商自营节点，向终端用户销售订阅；支持运营团队多个管理角色。
- Azure 服务主体凭证接入，支持 client secret 或证书；在专用资源组内创建多地区节点。
- 先展示资源变更与费用估算，再异步创建、检测、发布节点，并导出不含秘密的集群模板。
- 套餐包含地区权限、有效期与流量额度，支付确认后自动开通，续费、到期、退款和额度耗尽均有明确处理。
- 自有订阅域名，支持链接重置、节点变更和客户端配置导出。

## 推荐技术方案

| 部分 | 首版选择 |
| --- | --- |
| 网页 | Next.js + TypeScript + Tailwind / shadcn/ui |
| 业务服务 | NestJS 模块化单体，REST / OpenAPI |
| 数据与任务 | PostgreSQL + Prisma，Redis + BullMQ，事务 outbox |
| Xray 管理 | Remnawave 独立部署，经适配器接入；业务账本属于 xRay-zoo |
| Azure 编排 | Azure Identity / ARM SDK + Bicep + cloud-init |
| 支付 | PaymentProvider 接口，优先 Stripe Checkout / Billing / Customer Portal |
| 配置 | 首版明确支持 Mihomo 的 VLESS + REALITY；不承诺旧版 Clash 兼容 |
| 初期部署 | 独立控制服务器的 Docker Compose，地区节点使用 Azure Linux VM |

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

这些文件用于明确输入和输出形状；当前没有模板渲染器或部署命令。`${...}` 均为占位符，不能直接用于生产。

## 代码布局规划

```text
apps/web/                   # 商城、用户中心、管理员控制台
apps/api/                   # 权限、套餐、订单、订阅和云连接
apps/worker/                # 支付事件、节点编排、对账和周期任务
packages/domain/            # 领域约束与共享类型
packages/engine-remnawave/  # 唯一的节点管理系统边界
packages/cloud-azure/       # Azure 资源编排
packages/subscription/      # Mihomo 配置渲染
infra/azure/                # Bicep 资源模块
infra/control-plane/        # 控制服务部署与备份
```

目录按实际开发创建，本次提交不放空壳应用。开始实现时先完成 [P0 技术验证](docs/08-delivery-plan.md)，再实现一条真实的购买到联网链路。

## 项目与依赖许可

本次只提交原创文档和占位模板，未复制上游实现代码。项目尚未选定开源许可证。上游许可和复用边界记录在 [调研文档](docs/02-research.md)，独立部署与 API 调用不应被当成自动免除上游许可义务的保证。
