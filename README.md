# xRay-zoo

面向自营订阅业务的 Xray 集群控制台。管理员连接 Azure、选择地区并创建节点，用户购买套餐后获得可导入 Mihomo / Clash Meta 客户端的订阅链接。

**当前阶段：仓库初始化与设计。** 已完成方案调研、领域词汇、架构、RBAC、支付与订阅流程、Azure 编排方案和示例配置；应用、自动开机、真实收款与节点部署尚未实现。

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

以上是设计选择，不代表依赖已安装或集成已验证。支付渠道正式启用取决于运营主体、结算地区和账户可用性。

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
