---
status: proposed
---
# Azure 首版使用 Bicep 和 ARM 资源账本

首版云供应商限定 Azure，采用 Bicep 描述资源，ARM 长任务 API 执行，并由业务数据库记录实际资源 ID、所有权与操作步骤。相比同时维护 Terraform/OpenTofu state、provider 与用户凭证，当前方案更贴近单云范围且便于使用 what-if；代价是后续多云需要另建 provider 实现。

增量部署不会自动清理所有被删除的蓝图项，因此显式销毁和孤儿资源核对是必需流程。Worker 仅获专用资源组权限，不承担租户管理员或 Azure RBAC 授权职责。
