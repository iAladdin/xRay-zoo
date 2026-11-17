# 成本模型与套餐定价

核验日期：2026-11-18。公开美元零售价用于估算，不代表用户的合同价、税费、折扣或容量保证。原始查询和 meter 信息见 [价格快照](research/azure-retail-snapshot.json)。

## 小节点固定费用

本次查询 Azure Retail Prices API，选择 Linux Consumption、`Virtual Machines Basv2 Series`，排除 Windows、Spot、Low Priority 和同名 Cloud Services 产品。按 730 小时/月计算。

| 地区 | B2ats_v2 每小时 | 仅计算资源每月 |
| --- | --- | --- |
| East US 2 | $0.0094 | $6.862 |
| Japan East | $0.0123 | $8.979 |
| Southeast Asia | $0.0118 | $8.614 |

East US 2 单台另计 Standard Static IPv4 $0.005/小时，约 $3.65/月；E4 LRS Standard SSD 磁盘容量费 $2.40/月。三项合计约 **$12.912/月**，不含磁盘操作、可能适用的附加磁盘费用、出网、备份、监控与控制服务。系统镜像最小磁盘大于所选档位时按实际档位重算；其他地区磁盘/IP 不能套用美国价格。[Retail Prices API](https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices)

B2ats_v2 是 1 GiB 验证规格，不作为商业容量承诺。正式节点至少比较 2 GiB 以上规格与非突发 CPU 方案的持续吞吐、并发和成本。控制服务器、数据库、OIDC、发信、日志和备份需要单列预算。

## 流量通常决定毛利

Azure 的 Microsoft Premium Global Network 公开 Internet Egress 价格，北美/欧洲下一档 10 TB 为 $0.087/GB，亚洲（中国除外）/澳洲/MEA 为 $0.12/GB，页面列有首 100 GB/月免费。免费额度的结算范围按实际账单核验，不能给每台 VM 或每个用户重复减免。[带宽价格](https://azure.microsoft.com/en-us/pricing/details/bandwidth/)

作为量级示例，若 100 位用户本月合计造成 5,000 GB 的 Azure 计费出网，且该结算范围只有一次可用的 100 GB 免费额度，那么全部按北美该档计价约为 `(5000 - 100) × 0.087 = $426.30`，按亚洲该档约为 `$588`。这还没有包含机器、支付手续费与支持成本。

套餐流量是代理上传+下载 payload；Azure 账单包含其具体计费口径、协议开销与可能的跨区域流量，二者不能直接等同。实测 `计费出网 GB / 套餐计量 GB` 的比例，并为重传、探测、控制通信与误差预留成本。

## 经营模型

```text
月成本 = 节点计算 + 磁盘 + 公网 IP + 计费出网
       + 控制面 + 数据库/备份 + 监控/邮件
       + 渠道手续费 + 退款/争议损失 + 运维支持

月净收入 = 实际收款 - 退款 - 税费
单用户贡献 = 单用户净收入 - 流量变动成本 - 支付变动成本
盈亏平衡用户数 ≈ 固定月成本 / 平均单用户贡献
```

单用户贡献必须大于零，才有讨论扩大用户数的意义。套餐价格需同时评估额度用满、50% 用量、低用量和地区偏向情形；不能只按平均轻度使用者定价。

MVP 先设计有明确额度的月付套餐。地区按成本和实际网络表现分池，保存每个套餐版本的地域与额度快照。国内支付、税费和退款的具体费率等商户账户确定后录入，当前不写入猜测值。

## 成本控制与展示

创建页面显示固定费用、预计流量费、假设、时间戳和未包含项目；首页展示预算、最新可用成本、预估毛利和数据延迟。Cloud Cost Snapshot 与业务 Usage Record 分别保存。

限制节点数、SKU、地区和扩容预算，拒绝超过计划的新增资源。Azure Budget 用于预警；官方文档明确预算告警不会自动停止资源，成本数据通常延后，无法作为实时用户限额。[预算行为](https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/tutorial-acm-create-budgets)

先用节点计量控制套餐，再用云账单校准实际出网与成本；每月对比资源清单，特别检查已停用 VM 的磁盘和公网 IP。仅在系统内点“删除集群”而没有确认 Azure 清理完成，不能视为停止付费。
