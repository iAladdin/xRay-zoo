# 配置示例

这些是设计阶段的输入/输出形状，不是能直接运行的部署包。仓库还没有蓝图执行器、Bicep 模块或订阅渲染程序。

| 文件 | 用途 | 秘密边界 |
| --- | --- | --- |
| [cluster.blueprint.example.json](cluster.blueprint.example.json) | 指定地区、规格、资源组和节点数 | 只引用 cloudConnectionRef，不含 Azure 凭证 |
| [plan.example.json](plan.example.json) | 套餐版本、计量单位和周期规则 | 示例价格不代表正式售价 |
| [mihomo.template.yaml](mihomo.template.yaml) | 完整客户端 YAML 输出结构 | 渲染后含用户接入身份，仅提供给订阅本人 |

## 蓝图导出

蓝图必须能重新导入向导，显示计划差异并重新做地区、容量和预算预检。它不保证同样的资源名称或公网 IP，也不自动迁移历史支付、客户和活动连接。

占位符如 `${CLOUD_CONNECTION_REF}` 和 `${CONTROL_PLANE_IPV4_CIDR}` 由受控表单填写。蓝图中的私钥、secret、password、原始订阅 token 字段应在导入校验时拒绝；所有 SecretRef 必须属于本运营商和对应环境。

例子使用 3 个候选地区和 B2ats_v2 验证规格；`monthlyInfrastructureCeilingUsd` 是“拒绝新增”的计划约束示例，不能限制真实出网费用。`maxNodes` 为数量上限。计划必须列出控制服务器、监控、流量等未计入项。

## Mihomo 模板渲染

模板含一台美国示例节点，真实渲染器按客户授权节点池扩展代理和分组。仅支持经验证的 Mihomo / Clash Meta VLESS + REALITY；原版 Clash 不在首版兼容承诺内。

`${ACCESS_UUID}`、`${NODE_ADDRESS}`、`${REALITY_PUBLIC_KEY}`、`${REALITY_SHORT_ID}`、`${REALITY_SERVER_NAME}`、`${HEALTHCHECK_URL}` 需要替换。公钥与 short ID 来自节点配置，客户端不接收 REALITY 私钥。健康检测 URL 应为运营商控制、可用的 HTTPS 小响应端点。

订阅内容必须经结构化 YAML 序列化，禁止用用户输入做任意模板代码执行。拒绝换行注入与不符合 schema 的字段。示例不启用 TUN，不改系统路由，也没有远程规则供应商；后续规则产品化另行版本管理。

配置下载属于敏感输出，放在受控响应或 `exports/`，不能提交到 Git。链接被废止后客户端仍可能缓存接入信息，必须依靠节点侧撤销才能阻止继续联网。
