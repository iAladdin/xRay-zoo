# API 与适配器契约

状态：接口草案，URL 和类型用于后续实现，当前仓库没有 HTTP 服务。

## 通用约定

REST JSON，版本前缀 `/api/v1`。用户身份与 operator scope 由已验证会话获取。金额用最小货币单位整数，流量用整数 bytes，时间为 UTC RFC 3339，长任务返回 `202 + operationId`。分页使用 cursor；错误包含 `code`、可显示的 `message`、`requestId` 和安全的 `details`。

写入命令支持 `Idempotency-Key`。服务端在 actor + route + key 范围保存请求哈希与结果；同 key 不同请求体返回 409。并发资源变更携带 `expectedVersion`，版本冲突要求重新读取。价格、node pool、云作用域和客户归属均需服务端验证。

## HTTP 端点

| 方法与路径 | 目的 | 权限与语义 |
| --- | --- | --- |
| GET /catalog/plans | 获取已发布套餐版本 | 公开；不含云成本与内部资源 ID |
| GET /me | 当前身份、客户/管理角色 | 已登录 |
| POST /checkout-sessions | 创建付款意图 | Customer，本人；服务端读取套餐价格 |
| POST /billing-portal-sessions | 打开自助账单门户 | Customer，本人；返回短期 URL |
| GET /me/subscription | 服务、权益、交付状态 | Customer，本人 |
| GET /me/usage | 分周期用量与更新时间 | Customer，本人 |
| POST /me/subscription/link | 首次签发或读取本人链接 | Customer，本人，响应禁止缓存 |
| POST /me/subscription/link/rotate | 废止并替换获取配置的 token | Customer，本人，幂等且限频 |
| POST /me/subscription/access-identity/rotate | 轮换已缓存的联网身份 | Customer，本人，返回 operationId |
| POST /admin/cloud-connections | 保存云连接和秘密引用 | Owner，写入后不回显秘密 |
| POST /admin/cloud-connections/:id/validate | 检查授权、区域与配额 | Owner / Admin / Operator，scope 受限 |
| POST /admin/clusters/plans | 蓝图预检、what-if 与费用估算 | 已授权管理角色，返回 planId/hash/expiry |
| POST /admin/clusters | 执行具体部署计划 | 校验 plan hash、版本、上限与范围，202 |
| GET /admin/operations/:id | 查询长任务与地区子步骤 | 资源 scope 内可读 |
| POST /admin/operations/:id/retry | 从失败步骤恢复 | 重新校验计划和授权 |
| POST /admin/nodes/:id/drain | 摘流并停止新分配 | 运维角色，202 |
| DELETE /admin/nodes/:id | 清理所属云资源 | Owner / Admin，先摘流，202 |
| GET /admin/clusters/:id/blueprint | 导出不含秘密的蓝图 | 管理范围内可读 |
| POST /admin/plan-versions | 创建套餐版本 | Owner / Admin |
| POST /admin/refunds | 申请渠道退款并跟踪结果 | Owner / Finance，金额与权限校验，202 |
| POST /admin/customers/:id/suspension | 暂停/恢复权益并审计 | Owner / Admin，必填原因 |
| GET /admin/audit-events | 按权限查看审计 | 脱敏、分页、范围过滤 |
| POST /webhooks/stripe | 收取原始签名事件 | 无网页登录，必须验签和去重 |

订阅下载使用独立域名 `GET /s/:token/mihomo.yaml`，以 token 校验，不能复用管理员 cookie 作为访问条件。初始化使用 `POST /internal/nodes/:nodeId/bootstrap`，采用验证过的机器身份，与普通用户鉴权完全分离。

## 长任务示例

```json
{
  "operationId": "op_example",
  "state": "running",
  "resourceId": "cluster_example",
  "desiredRevision": 1,
  "steps": [
    { "region": "eastus2", "step": "verify", "state": "succeeded" },
    { "region": "japaneast", "step": "provision", "state": "failed", "code": "AZURE_QUOTA_EXCEEDED" }
  ],
  "retryable": true
}
```

错误代码至少覆盖 `CLOUD_CREDENTIAL_EXPIRED`、`CLOUD_SCOPE_DENIED`、`AZURE_SKU_UNAVAILABLE`、`AZURE_QUOTA_EXCEEDED`、`PLAN_EXPIRED`、`VERSION_CONFLICT`、`ENGINE_UNAVAILABLE`、`PAYMENT_PENDING`、`ENTITLEMENT_EXPIRED`、`QUOTA_EXHAUSTED`。公开响应不返回 ARM token、私钥或完整上游错误体。

## EngineAdapter

下面是领域接口草图，不是已有 SDK。实现需固定上游契约版本。

```typescript
interface EngineAdapter {
  capabilities(): Promise<EngineCapabilities>;
  registerNode(input: NodeRegistration): Promise<EngineNodeRef>;
  inspectNode(ref: EngineNodeRef): Promise<NodeObservation>;
  ensureIdentity(input: StableIdentityInput): Promise<EngineIdentityRef>;
  applyEntitlement(input: EntitlementSnapshot): Promise<ApplyReceipt>;
  inspectIdentity(ref: EngineIdentityRef): Promise<IdentityObservation>;
  collectUsage(cursor?: string): Promise<UsageBatch>;
  readConnectionMaterial(ref: EngineIdentityRef): Promise<ConnectionMaterial>;
  revokeIdentity(input: RevocationRequest): Promise<ApplyReceipt>;
}
```

`StableIdentityInput` 包含内部 externalRef 与 credentialVersion；`EntitlementSnapshot` 包含 version、enabled、validUntil、总剩余额度、allowedPools。adapter 负责转换上游的额度累计基准与分组 ID，业务端不依赖 Remnawave 的内部字段形状。

`ApplyReceipt` 区分 accepted、verified 和部分节点未确认，不将“面板 HTTP 200”直接当成所有节点生效。上游不支持版本 CAS 时，worker 使用每身份持久化锁和最新状态重读实现收敛；锁失效时用 fencing 防止旧 worker 提交本地完成状态。上游没有 CAS 时，这不能阻止已发出的旧 HTTP 写请求，因此必须回读并按最新权益重新收敛；暂停/撤销优先，远端写入状态不确定时显示 degraded，不能宣称强一致或即时撤销。

`UsageBatch` 表明是累计快照还是区间增量，并携带 stable source/epoch/sample 标识。不得由调用方猜测 reset 行为。`ConnectionMaterial` 只进入受控渲染过程，不写普通日志或管理端通用 DTO。

## CloudProvider

```typescript
interface CloudProvider {
  validateConnection(ref: SecretRef): Promise<CloudValidation>;
  inspectCapacity(input: CapacityRequest): Promise<CapacityReport>;
  plan(blueprint: ClusterBlueprint): Promise<DeploymentPlan>;
  apply(plan: DeploymentPlan, operationId: string): Promise<CloudOperationRef>;
  inspect(ref: CloudOperationRef): Promise<CloudOperationObservation>;
  inventory(clusterId: string): Promise<OwnedResource[]>;
  destroy(input: ApprovedResourceInventory): Promise<CloudOperationRef>;
}
```

plan 保存价格来源、抓取时间、币种、估算时长和不计入项目。destroy 接受数据库确认拥有的资源 ID 列表，不接受浏览器传入任意 ARM ID。API 密钥和证书上传是写入 SecretStore 的受控操作，不能把用户内容直接拼进命令行执行。

## PaymentProvider

```typescript
interface PaymentProvider {
  createCheckout(input: FrozenOrder, idempotencyKey: string): Promise<CheckoutRef>;
  verifyEvent(rawBody: Uint8Array, headers: SafeHeaders): VerifiedEvent;
  fetchInvoice(ref: InvoiceRef): Promise<InvoiceSnapshot>;
  fetchSubscription(ref: BillingSubscriptionRef): Promise<BillingSnapshot>;
  createPortal(input: CustomerBillingRef): Promise<PortalSession>;
  refund(input: RefundRequest, idempotencyKey: string): Promise<RefundRef>;
}
```

内部事件表达资金和周期事实，不能用不同支付渠道相同名称的 `success` 状态替代语义转换。退款请求创建后即有审计和 operation；超时先查询渠道结果，禁止无条件再发一笔。
