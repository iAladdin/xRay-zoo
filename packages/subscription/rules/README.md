# tc split 分流基线

从用户指定的 tc-hk-split 配置提取基础设置、DNS 和规则；不包含原节点、接入凭证或管理接口。渲染器在此基础上绑定地区分组，AI 仅允许 JP/SG/US，Telegram 仅允许 HK/TW。

输出保持原有规则顺序，将 GEOSITE 分流条目转换为 MetaCubeX 同名 MRS 规则集，避免客户端旧 GeoSite 缺少较新的 AI 分类。DNS 的 CN / 非 CN 分类保持不变。规则集首次使用需联网下载，并按 24 小时周期更新。

REALITY 输出显式启用 `support-x25519mlkem768`，已用 Mihomo 1.19.33 和 Xray 26.11.9 联网验证；不加入 `skip-cert-verify`。

## 上游合并策略

- [MetaCubeX/meta-rules-dat](https://github.com/MetaCubeX/meta-rules-dat)：保留 tc split 的 AI、Google、媒体、Apple、Microsoft、游戏等域名分类，使用 MRS 格式。
- [Loyalsoldier/clash-rules](https://github.com/Loyalsoldier/clash-rules)：补充 `release/telegramcidr.txt` 的 Telegram IP 段，使用 `ipcidr` YAML provider，覆盖直接连接 IP 的 Telegram 客户端。
- 顺序：本地网络与节点地址直连 → AI 专用规则 → Telegram 域名及 IP → 通用服务 → 国内直连 → 默认代理。所有相同文本规则去重，上游只提供匹配内容，策略组和地区绑定由本项目固定。
- AI 只允许 JP/SG/US；Telegram 只允许 HK/TW。对应地区缺席时使用 REJECT，不会自动改用其他地区或直连。
- 两套规则均由客户端每 24 小时更新，本项目不复制第三方规则数据。各上游的数据来源和许可证见其仓库；仅引用公开 HTTPS 发布地址。
