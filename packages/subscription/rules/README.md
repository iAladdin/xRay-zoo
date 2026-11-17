# tc split 分流基线

从用户指定的 tc-hk-split 配置提取基础设置、DNS 和规则；不包含原节点、接入凭证或管理接口。渲染器在此基础上绑定地区分组，AI 仅允许 JP/SG/US，Telegram 仅允许 HK/TW。

输出保持原有规则顺序，将 GEOSITE 分流条目转换为 MetaCubeX 同名 MRS 规则集，避免客户端旧 GeoSite 缺少较新的 AI 分类。DNS 的 CN / 非 CN 分类保持不变。规则集首次使用需联网下载，并按 24 小时周期更新。

REALITY 输出显式启用 `support-x25519mlkem768`，已用 Mihomo 1.19.33 和 Xray 26.11.9 联网验证；不加入 `skip-cert-verify`。
