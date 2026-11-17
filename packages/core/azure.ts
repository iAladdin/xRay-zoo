import { execFile } from "node:child_process";
import { root } from "./config.js";

export type AzurePlanSnapshot = {
  subscription: string;
  resourceGroup: string;
  managementSourceCidr: string;
  controlAddress: string;
  region: string;
  country: string;
  regionName: string;
  size: string;
  vcpus: number;
  memoryGiB: number;
  imageVersion: string;
  templateHash: string;
  cloudInitHash: string;
  nodeImage: string;
  cost: {
    currency: string;
    computeHourly: number | null;
    computeMonthly: number | null;
    excludes: string[];
  };
};
export async function azure<T>(
  command: string,
  input: unknown = {},
): Promise<T> {
  return runAzure<T>("azure-node.py", command, input);
}
export async function azureIp<T>(
  command: string,
  input: unknown = {},
): Promise<T> {
  return runAzure<T>("azure-ip.py", command, input);
}
async function runAzure<T>(
  script: string,
  command: string,
  input: unknown,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "python3",
      [root + "/scripts/" + script, command],
      { cwd: root, timeout: 240_000, maxBuffer: 12 * 1024 * 1024 },
      (error, stdout) => {
        try {
          const answer = JSON.parse(stdout);
          if (!answer.ok)
            throw new Error(
              /^[A-Za-z0-9_]{1,100}$/.test(answer.error)
                ? answer.error
                : "AZURE_REQUEST_FAILED",
            );
          if (error) throw new Error("AZURE_REQUEST_FAILED");
          resolve(answer.result);
        } catch (e) {
          reject(
            e instanceof SyntaxError
              ? new Error(
                  error?.killed
                    ? "AZURE_REQUEST_TIMEOUT"
                    : "AZURE_REQUEST_FAILED",
                )
              : e,
          );
        }
      },
    );
    child.stdin?.end(JSON.stringify(input));
  });
}
export const provisionMessages: Record<string, string> = {
  IP_RESOURCE_SCOPE_CONFLICT: "IP 资源不在项目配置的 Azure 作用域内",
  IP_RESOURCE_OWNERSHIP_CONFLICT: "IP 或网络资源不属于该节点，已停止轮换",
  IP_BINDING_CONFLICT: "Azure 网卡绑定已变化，已停止操作，请核对当前 IP",
  IP_NETWORK_NOT_SUPPORTED:
    "当前仅支持单网卡、单 IPv4、无独立 DNS 的 Standard 公网 IP 节点",
  IP_VM_MISMATCH: "Azure VM 与网卡不匹配，已停止操作",
  IP_PINNED_HOST_KEY_MISSING:
    "缺少该节点已验证的 SSH 主机公钥，请先恢复控制连接",
  IP_ALLOCATION_INVALID: "Azure 未分配有效的新公网 IP",
  IP_ALLOCATION_NOT_READY: "新公网 IP 尚未就绪，可重试当前阶段",
  IP_ALLOCATION_FAILED: "Azure 公网 IP 分配失败，可重试或回滚",
  IP_STILL_ATTACHED: "待释放的 IP 仍被占用，保留资源并等待核对",
  IP_ROTATION_TIMEOUT: "轮换阶段等待超时，可重试；发布前也可回滚原 IP",
  IP_HOST_MISMATCH: "引擎节点地址与轮换记录不一致，已停止发布",
  AZURE_CONNECTION_OR_REQUEST_FAILED:
    "无法连接 Azure，请检查项目登录和管理出口后重试",
  AZURE_REQUEST_TIMEOUT: "Azure 请求超时，可重试；不会自动重复创建新资源",
  REGION_UNAVAILABLE: "当前订阅不能在该区域创建虚拟机",
  SKU_OR_QUOTA_UNAVAILABLE: "规格不可用或 vCPU 配额不足，请选择其他规格或区域",
  PUBLIC_IP_QUOTA_UNVERIFIED: "暂时无法核验公网 IP 配额",
  PUBLIC_IP_QUOTA_EXCEEDED: "该区域公网 IP 配额不足",
  UBUNTU_IMAGE_UNAVAILABLE: "该区域没有当前支持的 Ubuntu 镜像",
  RESOURCE_GROUP_NOT_OWNED: "资源组未标记为 xRay-zoo 管理，已停止部署",
  CONNECTION_CHANGED: "Azure 连接范围已变化，请重新预览",
  TEMPLATE_CHANGED: "部署模板已更新，请重新预览",
  SSH_HOST_KEY_MISMATCH: "SSH 主机密钥与已登记信息不符，需要管理员核验",
  DEPLOYMENT_OWNERSHIP_CONFLICT: "同名部署不属于本次任务，已停止",
  VM_OWNERSHIP_CONFLICT: "同名虚拟机不属于本次任务，已停止",
  REALITY_CLIENT_PROBE_FAILED: "真实客户端连通验证失败，节点尚未发布",
  PROVISION_PHASE_TIMEOUT: "当前阶段超过等待时限；资源会保留，可检查后重试",
  DeploymentFailed: "Azure 部署失败，请在 Azure 查看资源部署错误后重试",
  AllocationFailed: "Azure 当前容量不足，可换区域或规格",
  SkuNotAvailable: "Azure 当前没有此规格的可分配容量",
  OperationNotAllowed: "Azure 拒绝操作，请检查配额或订阅限制",
  AuthorizationFailed: "Azure 身份权限不足，请检查项目连接",
};
export function provisionError(error: unknown) {
  const raw = error instanceof Error ? error.message : "PROVISIONING_FAILED";
  const code = /^[A-Za-z0-9_]{1,100}$/.test(raw) ? raw : "PROVISIONING_FAILED";
  return {
    code,
    message:
      provisionMessages[code] ?? "操作未完成（" + code + "），可检查后重试",
  };
}
