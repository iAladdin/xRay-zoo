# 参考项目与选型依据

核验日期：2026-11-17。核验范围是上游仓库、README、部分接口契约、许可文件和官方文档；未部署或压测这些项目。推荐是针对本项目需求的判断，功能可用性仍需 P0 验证。

## 项目比较

| 项目 | 已核验的参考价值 | 本项目采用方式 | 约束 |
| --- | --- | --- | --- |
| [Remnawave backend](https://github.com/remnawave/backend) / [node](https://github.com/remnawave/node) | 独立面板与节点、TypeScript/NestJS、用户额度/到期/分组契约、订阅模板 | 首选节点管理引擎，经 API 适配器接入 | AGPL-3.0；自有 RBAC、订单、Azure 编排仍需实现 |
| [Marzban](https://github.com/Gozargah/Marzban) / [Marzban-node](https://github.com/Gozargah/Marzban-node) | Python 面板，多节点、用户限额和多种订阅输出 | Remnawave 验证不通过时的备选 | AGPL-3.0；须单独验证计量、失联、权限语义 |
| [Xboard](https://github.com/cedar2025/Xboard) | 套餐商业面板；仓库有订单服务、支付接口、支付控制器与流量任务 | 参考商品、订单和支付模块划分 | MIT；README 声明轻维护，PHP 技术栈不同，不直接作为整个产品底座 |
| [3x-ui](https://github.com/MHSanaei/3x-ui) | 当前支持多节点、用户额度、到期与订阅输出 | 参考运维页面及配置体验 | GPL-3.0；README 明示个人用途、不要用于生产，不选作商业依赖 |
| [Xray-core](https://github.com/XTLS/Xray-core) | 实际协议与数据转发核心 | 经节点引擎使用固定版本 | MPL-2.0；自身不负责商城、支付、Azure 或 SaaS 权限 |
| [Mihomo 配置文档](https://wiki.metacubex.one/en/config/proxies/vless/) | VLESS、REALITY、公钥与 short-id 的客户端字段 | 作为订阅输出兼容基线 | 兼容性按实际客户端和版本测试，不宣称兼容所有名为 Clash 的程序 |
| [XrayR](https://github.com/XrayR-project/XrayR) | 历史上常见的面板到节点桥接方案 | 仅记录，不纳入首版依赖 | 本次 GitHub API 的仓库描述为“项目已废弃”，当前分支无可复用实现清单 |

Xboard 的支付参考可追溯到 [PaymentInterface](https://github.com/cedar2025/Xboard/blob/master/app/Contracts/PaymentInterface.php)、[OrderService](https://github.com/cedar2025/Xboard/blob/master/app/Services/OrderService.php)。本次不复制这些实现。

Remnawave 官方 [组件说明](https://docs.rw/overview/components/) 与 [用户更新契约](https://github.com/remnawave/backend/blob/main/libs/contract/commands/users/update-user.command.ts) 支持初步适配判断。官方 TypeScript SDK 提供 REST 类型契约，需要自行实现 HTTP 客户端，且契约版本须匹配后端版本，不能当成完整开箱即用客户端。[SDK 说明](https://docs.rw/sdk/typescript-sdk/)

## 三条实施路线

| 路线 | 优点 | 代价 | 判断 |
| --- | --- | --- | --- |
| 整体改造 Xboard | 商业面板已有大量流程 | PHP 底座、轻维护状态、Azure 编排仍要建，深度 fork 升级成本高 | 适合已有 Xboard 团队，当前不优先 |
| 自建商业控制面 + Remnawave API | 明确控制业务数据，复用节点管理，TypeScript 协作方便 | 双系统状态需对账，上游接口与许可需要跟踪 | 首版推荐 |
| 自建控制面 + 自建 Go agent + Xray | 最强控制、节点有望更轻 | 用量、断线恢复、原子更新、撤销权限都要自行验证 | 有规模或必要能力缺口后考虑 |

采用适配器不能消除工程工作。首版需验证创建用户的幂等性、节点池映射、流量计数重置、到期停用、缓存配置失效、节点失联和已建立连接撤销。任何一项关键能力缺失，都要缩小产品承诺或替换适配器，不能仅改网页文案。

## 资源规格影响

上游建议 Panel 最低 2 GB RAM / 2 核，推荐 4 GB RAM / 4 核；Node 最低 1 GB RAM / 1 核。xRay-zoo 的网页、数据库与任务会增加控制服务器负载。[硬件要求](https://docs.rw/install/requirements/)

因此 512 MiB 的 B1ls 不作为本方案的地区节点基线。B2ats_v2 的 1 GiB 仅作为小流量验证规格，生产候选从至少 2 GiB 开始压测；控制服务合并部署先以 4 vCPU / 8 GiB 作为待测起点。后一项是我们的估算，不是上游最低要求。

## 许可与复用边界

上游仓库显示 Remnawave / Marzban 为 AGPL-3.0，3x-ui 为 GPL-3.0，Xboard 为 MIT，Xray-core 为 MPL-2.0。以锁定版本中的许可正文为准，不能只依赖 GitHub 的自动标签。

AGPL 软件若被修改并通过网络向用户提供交互，需评估对应源代码提供义务。独立进程或 HTTP 连接不是自动免责结论。首版使用独立、固定版本的上游镜像，保留版权与许可说明；若需要修改上游，把补丁和源码交付路径单独记录。采用官方类型包也要核对该包的许可。xRay-zoo 本身的发布许可尚未决定。

## 版本与证据

[仓库元数据快照](research/upstream-snapshot.json) 保存本次查阅的仓库地址、主分支、维护时间和许可标识。维护时间不等于稳定性，调研未依据 stars 排名作决定。正式接入时记录镜像 digest、核心版本、契约版本、数据库版本和测试结果，再更新本文件。
