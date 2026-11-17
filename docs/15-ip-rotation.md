# 节点公网 IP 轮换

2026-11-18，本地后台入口：`http://localhost:3100/admin` → 区域节点 → 连接与维护 → **轮换 IP**。为现有 Azure VM 更换公网 IPv4，保留机器、区域、REALITY 配置、用户权限和原订阅 URL。

## 操作与进度

1. 打开窗口时只预检：核对项目资源组、VM/NIC/IP 所有权、当前绑定、公网 IP 配额和已固定的 SSH 主机公钥。预览绑定当前管理员与节点，10 分钟有效；取消不创建云资源。
2. 点击“开始轮换 IP”才提交持久化任务。分配新 IP 期间原 IP 仍绑定；窗口每 3 秒显示真实阶段与事件，关闭或刷新不会取消任务。
3. 分配新 IP → 切换网卡绑定 → 恢复控制连接 → Mihomo 真实客户端验证新出口 → 更新订阅配置 → 释放旧 IP → 完成。
4. 客户端刷新原订阅链接获取新地址。已下载 YAML 不会自行改写，现有连接可能中断。AI 仍限定 JP/SG/US，Telegram 仍限定 HK/TW。

切换网卡前，节点进入 `addressChanging=true`，暂时从新下载的 YAML 中移除；健康检查不能提前将其加入。真实连接验证成功后，更新引擎 Host 与数据库地址，恢复订阅输出，再删除已解除绑定的旧 IP。用户的 token、访问 UUID、服务期、流量和 squad 权限保持不变。

## 失败、重试与回滚

| 状态 | 可执行操作 | 资源处理 |
| --- | --- | --- |
| 分配/切换/重连/验证/发布失败 | 重试当前阶段，或回滚原 IP | 旧 IP 保留；回滚须验证原入口后才释放本次新 IP |
| 新 IP 已发布，旧 IP 清理失败 | 重试清理 | 新 IP 继续服务；不再提供回滚，避免使用可能已释放的旧地址 |
| 回滚中失败 | 重试当前回滚阶段 | 不另建轮换任务，不释放仍在使用的地址 |

新旧 IP 在过渡期间同时计费；失败保留的空闲 IP 也可能继续计费。每个阶段等待超过 30 分钟暂停，管理员从后台重试或回滚。操作尚未完成时，节点的停用、重启、重连与另一轮 IP 轮换互斥；失败任务也保留互斥锁，完成或回滚后解除。

PostgreSQL 保存任务、阶段、事件与租约。worker 每约 5 秒恢复未完成任务，与上机器共用单并发云任务队列；5 分钟租约、30 秒续租，过期 worker 不能写回新状态。重复点击或提交同一预览返回同一个任务。新 IP 名称和 `rotation-id` 标签绑定任务，丢失 ARM 响应后先回读原资源。

## 支持范围与恢复文件

- 当前项目管理的、已发布且启用的节点；单 VM、单 NIC、单 IPv4，Standard / Regional / Static 公网 IP。
- 不支持独立公网 DNS、负载均衡器、应用网关、多个 IP 配置等复杂拓扑；预检会拒绝，不猜测修改网络关系。
- 后端固定 Azure subscription/resourceGroup；前端不能提交资源 ID、新地址、脚本或 SSH 密钥。仅 ADMIN 可使用，写请求校验 Origin；公开事件不包含凭证。
- 迁移公网地址时复用原 VM 已固定的 SSH 公钥，拒绝覆盖冲突的 host key。保留现有管理出口、防火墙范围、私网地址、SSH 验证和引擎 mTLS。
- `.local/ip-address-overrides.json` 保存当前控制通道目标，SSH 进程按地址变化重连；`seed.ts` 优先使用此地址，避免重新写回 P0 旧地址。此文件、known_hosts、SSH 密钥与数据库需要一起备份。
- 原 `.local/azure-inventory.json` / P0 模板是初次部署快照，轮换后不能直接重新套用固定旧 Public IP 绑定。数据库和地址覆盖文件用于当前运行状态；重建基础设施前先核对 ARM 现状。
- `subscription:render` 是读取指定快照的离线工具，不自动查询当前地址；轮换后应从用户中心或原订阅 URL 下载配置，旧的离线 inventory 和已导出文件不会自动更新。

## API

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| POST | `/admin/nodes/:id/ip-rotation/preview` | 真实 Azure 只读检查，生成不可变预览 |
| POST | `/admin/nodes/:id/ip-rotation` | `{planId,idempotencyKey}`，提交任务 |
| GET | `/admin/ip-rotations/:id` | 公开阶段、事件、错误、原/新 IP |
| POST | `/admin/ip-rotations/:id/retry` | 重试失败阶段 |
| POST | `/admin/ip-rotations/:id/rollback` | 发布前请求恢复旧 IP |

节点列表同时返回最近一次轮换与当前任务 ID，运行中/失败的任务可重新打开查看。

## 验证范围

- `pnpm test:azure`：内存 ARM 替身验证 IP 分配幂等、网卡字段与 ETag 保留、所有权/作用域、绑定冲突、解除绑定的最终一致性、只删除空闲 IP、SSH 主机固定和回滚清理。
- `pnpm test:ip-rotation`：独立数据库 schema 验证预览权限/过期/类型、双击幂等、节点互斥、worker 租约接管、绑定响应丢失、探测失败不发布、清理失败重试、订阅身份不变及回滚；实际调用订阅渲染确认切换中拒绝输出、发布新地址及回滚恢复原地址。
- `pnpm test:admin`：轮换读写端点 401/403、输入严格校验、未知任务处理及既有订阅管理回归。
- 日本 P0 节点和已上线韩国节点的真实 Azure 预检、浏览器预览及取消通过；没有点击开始轮换。既有 JP 节点的 Mihomo 出口探测通过，共用验证器回归成功。
- TypeScript、Next.js 生产构建和普通用户访问撤销/重新生成配置回归通过。重启控制服务后曾遇到节点连接尚未恢复导致检查失败，控制连接恢复后重跑通过；最终 6/6 节点控制就绪。

本次实现没有实际分配新公网 IP、切换实机绑定或删除旧 IP。云写入完整链路仍需第一次实际轮换验证；预检不能保证 Azure 最终容量和切换耗时。

参考：[VM 公网 IP 关联](https://learn.microsoft.com/en-us/azure/virtual-network/ip-services/associate-public-ip-address-vm)、[NIC 更新接口](https://learn.microsoft.com/en-us/rest/api/virtualnetwork/network-interfaces/create-or-update?view=rest-virtualnetwork-2025-05-01)、[Azure 公网 IP](https://learn.microsoft.com/en-us/azure/virtual-network/ip-services/virtual-network-public-ip-address)。
