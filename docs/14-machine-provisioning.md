# 后台上机器

2026-11-18，本地管理后台支持单台 Azure 节点的异步创建。入口：`http://localhost:3100/admin` → 区域节点 → 上机器。仅 ADMIN 可调用全部相关 API；普通用户 403，未登录 401，写请求校验 Origin。

## 操作流程

1. 搜索并选择当前 Azure 订阅的物理区域。区域来自订阅 Locations 和 Compute Provider 元数据；不支持 VM 的区域显示禁用。此次真实查询返回 65 个物理区域、51 个支持 Compute，数量可能变化。
2. 选择规格。实时读取 Resource SKUs、区域/规格族 vCPU 使用量，过滤订阅限制、架构、镜像代际及最低 1 GiB 内存。关闭“仅显示当前可用规格”可看不可用原因。区域元数据缓存 15 分钟，SKU 5 分钟，配额每次实时查询。
3. 点击“检查规格与费用”：再次检查 SKU、vCPU、公网 IP 配额、Ubuntu 24.04 镜像和资源组所有权。保存 15 分钟有效、绑定管理员的不可变预览。显示 1 台 VM、32 GiB Standard HDD、Standard IPv4 和专属网络。Azure Retail Prices 的金额**仅为 Linux 按需计算费用**，按 730 小时/月估算，磁盘、IP、流量、磁盘操作、备份、税另计；查询失败不会伪造零价。
4. 点击“上机器”：以 planId 和幂等键落库任务。创建后每 3 秒读取进度，关闭窗口或刷新页面不会丢失任务。重试原请求/同一预览始终返回原任务；重新预览并提交才代表另一台机器。
5. 后台持续显示：等待创建 → 创建 Azure 资源 → 自动安装节点 → 接入控制引擎 → 验证真实连接 → 更新订阅节点池 → 已上线。进度按实际阶段更新，不估算剩余秒数。

## 节点发布与用户权益

- 创建 Ubuntu VM、磁盘、NIC、Standard IPv4、VNet/Subnet/NSG。每台使用独立网络资源，单个节点名跨重试不变。
- cloud-init 只安装 Docker 等基础依赖。固定 digest 的 Remnawave Node 镜像由 Azure Custom Script 扩展安装；Node 管理信任材料仅通过 `protectedSettings` 传递，不写入 customData、前端、事件或命令参数。当前沿用 P0 引擎的 Node 信任材料，尚未实现按节点独立轮换。
- 从通过认证的 ARM 扩展执行结果取得 SSH host key，固定到项目 known_hosts。只通过既有受限管理出口建立 SSH 转发，保留主机密钥校验和引擎 mTLS。
- 注册配置、区域 squad、engine node 和 host；REALITY 私钥加密保存，管理列表仅投影公开字段。
- 使用 15 分钟、10 MB 的临时用户运行真实 Mihomo/REALITY 请求，验证出口 IP 与 VM 公网地址一致；结束后禁用该身份。绑定现有管理代理使用的物理网卡，或显式设置 `PROBE_INTERFACE`。控制连通并不代替真实客户端验证。
- 发布前 Node 的 `publishedAt=null`，即使控制引擎已连通也不进入用户订阅。发布与订阅 desiredVersion/outbox 更新在同一个数据库事务中完成；全部目标订阅同步完成后任务显示“已上线”。用户刷新原订阅 URL 即可拉到新的 YAML，URL 和访问身份不会因扩容而旋转。
- 默认环球套餐及原 P0 套餐使用 `globalPool=true`，自动包含今后上线节点。自定义套餐默认保留地区限制，可在套餐编辑中明确勾选全局池。Order 冻结 globalPool，与价格/流量/地区一样，修改套餐仅影响新订单。
- 通用组接受所有授权的新区域；AI 严格限定 JP / SG / US，Telegram 严格限定 HK / TW，缺少对应区域时 REJECT。支持同一国家/区域多台节点。

## 任务恢复和失败

PostgreSQL 保存计划、operation、阶段 checkpoint、事件、加密私钥和租约；BullMQ 的独立机器队列一次执行一个阶段。worker 每 5 秒从数据库重建未完成任务，Redis 丢失队列或服务重启不丢任务。5 分钟租约、30 秒续租，防止同一任务同时运行；阶段超过 45 分钟暂停并提示重试。

ARM 名称绑定 operation。提交超时先回读原 deployment；重试不会换名字新建。资源组必须带 `managed-by=xray-zoo`，已有同名 deployment、VM、网络或磁盘必须归本次 operation。安装失败由管理员重试，重新执行扩展；控制/验证阶段重试保留既有资源和引擎身份。预览后模板或 Azure 连接范围变化时拒绝部署，需重新预览。

**失败不自动删资源，费用可能继续产生。** UI 显示失败阶段和脱敏错误码，保留事件便于在 Azure 关联同名 deployment 检查。尚无取消/删除云资源界面；停用节点也不会停止 Azure 费用。任务未发布的节点维护按钮禁用。

## 当前连接与运行依赖

当前支持项目已完成 P0 初始化的控制面：PostgreSQL、Redis、Remnawave、API、worker、Azure CLI/Bicep、项目 SSH 密钥、Mihomo 和管理出口均须可用。新机器沿用项目隔离的 Azure CLI 登录 `.local/azure`，不会读取 OpenAI key 或修改全局 Azure 配置。

默认从 `.local/azure-plan.json` 读取连接范围（仅 subscription/resourceGroup/managementSourceCidr，忽略旧 P0 批次过期时间），从 `.local/stack.env` 读取 `P0_HOST_GATEWAY`。可用私有 `.local/azure-provisioning.json` 显式配置：

```json
{
  "subscription": "<Azure subscription UUID>",
  "resourceGroup": "<专用资源组>",
  "managementSourceCidr": "<既有管理出口 IPv4>/32",
  "controlAddress": "<引擎容器可达的控制宿主机地址>"
}
```

后端只接受服务端配置的作用域，前端不能提交任意资源组、订阅、脚本或镜像。管理入口 TCP 22/2222 仅允许上述 /32，客户端 443 对公网开放。项目 HTTP/SOCKS mixed relay 若已配置，则 Azure 请求复用该出口，保持 TLS 验证。

新增机器 SSH 转发保存在 `.local/provisioned-tunnels.json`，使用 22300–22999 独占本机端口。引擎连接使用配置的宿主机网关地址，不要求为每个新节点重建 Docker extra_hosts。`.local/` 必须保留并备份，与数据库一起用于恢复；网页录入 Azure service principal/证书、托管身份初始化接口、公网控制面仍属于后续能力。

## API

| 方法 | 路径                         | 行为                                      |
| ---- | ---------------------------- | ----------------------------------------- |
| GET  | `/admin/azure/locations`     | 区域目录与当前连接范围                    |
| GET  | `/admin/azure/skus?region=…` | 规格、不可用原因及配额                    |
| POST | `/admin/machines/preview`    | `{region,size}`；只预检，无 VM 创建       |
| POST | `/admin/machines`            | `{planId,idempotencyKey}`；持久化任务     |
| GET  | `/admin/machines`            | 所有未完成/失败任务及最近 30 个已上线任务 |
| GET  | `/admin/machines/:id`        | 阶段、公开事件、错误码，无凭证            |
| POST | `/admin/machines/:id/retry`  | 仅重试失败任务，保留资源身份              |

## 验证记录与边界

- `pnpm test`：路由边界、未知区域/同区多节点、缺失区域 fail closed、节点健康语义。
- `pnpm test:azure`：无云写入的适配器契约测试，覆盖资源所有权、范围/模板变更、已接受部署恢复、扩展 protectedSettings、SSH 主机固定、配额/架构/订阅限制。
- `pnpm test:provisioning`：随机独立数据库 schema，云驱动替身，覆盖双击幂等、预览权限/过期、端口分配、租约、Azure/安装/验证失败重试、发布事务 outbox、套餐范围、链接保持与敏感字段过滤。结束仅删除本次测试 schema，不触碰现有支付数据，也不会启动真实 Azure 部署。
- `pnpm test:provisioning --live-probe`：上述用例外，真实使用现有 JP 节点验证 Mihomo 出口 IP，随后禁用并删除临时测试身份。
- 管理端权限及普通用户 revoke/regenerate 回归、TypeScript 检查、Next.js 构建已通过。
- 真实 Azure East US 2 / Standard_B2ats_v2 预检和 ARM `/validate` 已通过，无资源 PUT。浏览器验证区域、规格、费用预览与取消。
- 修正规格目录对区域代码的大小写匹配：Azure 的 `KoreaCentral`、`KoreaSouth`、`UAENorth` 与小写请求代码按同一区域处理，订阅限制也同步忽略大小写。三个区域的真实规格查询已验证；空列表、配额过滤和搜索无结果均显示对应提示。

本次没有创建第六台收费 VM；完整的新 VM 扩展安装、注册、发布链路仍需首次实际部署时验证。现有五台 P0 节点保持运行。Azure 配额与预检不能保证最终容量。

参考：[Locations](https://learn.microsoft.com/rest/api/resources/subscriptions/list-locations)、[Resource SKUs](https://learn.microsoft.com/en-us/rest/api/compute/resource-skus/list)、[Custom Script Linux](https://learn.microsoft.com/en-us/azure/virtual-machines/extensions/custom-script-linux)。

默认操作入口已升级为[按区域批量启动与回收](17-disposable-nodes.md)；本页的单台自选规格入口保留在“高级部署”中。
