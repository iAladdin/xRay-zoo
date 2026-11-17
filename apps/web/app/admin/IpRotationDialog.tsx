"use client";
import { useEffect, useRef, useState } from "react";
export type IpRotation = {
  id: string;
  oldAddress: string;
  newAddress: string | null;
  phase: string;
  phaseLabel: string;
  status: string;
  error: string | null;
  canRollback: boolean;
  events: { at: string; message: string }[];
};
type NodeInput = {
  id: string;
  name: string;
  address: string;
  region: string;
  activeIpRotationId: string | null;
  ipRotation: IpRotation | null;
};
type Preview = {
  planId: string;
  expiresAt: string;
  nodeName: string;
  oldAddress: string;
  region: string;
  resourceGroup: string;
};
async function request<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch("http://localhost:3101/admin/" + path, {
    credentials: "include",
    cache: "no-store",
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error ?? "请求失败，请重试");
  return data;
}
export default function IpRotationDialog({
  node,
  onClose,
}: {
  node: NodeInput;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [key, setKey] = useState("");
  const [id, setId] = useState(node.activeIpRotationId);
  const [operation, setOperation] = useState<IpRotation | null>(
    node.activeIpRotationId ? node.ipRotation : null,
  );
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(!node.activeIpRotationId);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  useEffect(() => {
    if (id) return;
    let canceled = false;
    setLoading(true);
    setError("");
    setPreview(null);
    request<Preview>(
      `nodes/${encodeURIComponent(node.id)}/ip-rotation/preview`,
      {},
    )
      .then((p) => {
        if (!canceled) {
          setPreview(p);
          setKey(crypto.randomUUID());
        }
      })
      .catch((e) => {
        if (!canceled) setError(e.message);
      })
      .finally(() => {
        if (!canceled) setLoading(false);
      });
    return () => {
      canceled = true;
    };
  }, [id, reload, node.id]);
  useEffect(() => {
    if (!id) return;
    let canceled = false,
      fetching = false;
    async function load() {
      if (fetching) return;
      fetching = true;
      try {
        const op = await request<IpRotation>(`ip-rotations/${id}`);
        if (!canceled) {
          setOperation(op);
          setError("");
        }
      } catch (e) {
        if (!canceled) setError((e as Error).message);
      } finally {
        fetching = false;
      }
    }
    load();
    const timer = setInterval(load, 3000);
    return () => {
      canceled = true;
      clearInterval(timer);
    };
  }, [id]);
  async function create() {
    if (!preview || busy) return;
    if (new Date(preview.expiresAt) <= new Date()) {
      setReload((x) => x + 1);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await request<{ id: string }>(
        `nodes/${encodeURIComponent(node.id)}/ip-rotation`,
        { planId: preview.planId, idempotencyKey: key },
      );
      setId(result.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function action(action: "retry" | "rollback") {
    setBusy(true);
    setError("");
    try {
      await request(`ip-rotations/${id}/${action}`, {});
      setOperation(await request<IpRotation>(`ip-rotations/${id}`));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const phaseIndex = [
    "queued",
    "allocating",
    "switching",
    "reconnecting",
    "verifying",
    "publishing",
    "cleanup",
    "ready",
  ].indexOf(operation?.phase ?? "queued");
  return (
    <dialog
      ref={dialog}
      className="az-dialog az-machine-dialog"
      aria-labelledby="ip-rotation-title"
      onCancel={(e) => {
        if (busy) e.preventDefault();
        else onClose();
      }}
    >
      <div className="az-dialog-head">
        <div>
          <div className="az-kicker">NODE / PUBLIC IP</div>
          <h2 id="ip-rotation-title">
            {id ? "IP 轮换进度" : "轮换节点公网 IP"}
          </h2>
        </div>
        <button
          className="az-light"
          aria-label="关闭 IP 轮换"
          disabled={busy}
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <p className="az-machine-intro">
        {node.name} · {node.region}
      </p>
      {loading && !id && (
        <p role="status">正在核验 Azure 网卡、公网 IP 配额和控制连接配置…</p>
      )}
      {!id && preview && (
        <>
          <div className="az-machine-estimate">
            <span>当前公网 IP</span>
            <strong>{preview.oldAddress}</strong>
            <small>
              {preview.resourceGroup} · {preview.region}
            </small>
            <p>
              为同一台机器分配新的 Standard IPv4，保持现有服务配置和用户权限。
            </p>
          </div>
          <div className="az-alert warning">
            <span>
              切换时现有连接可能中断，客户端需要刷新订阅。新旧 IP
              在轮换期间同时计费；新 IP 验证通过后自动释放旧 IP。
            </span>
          </div>
          <div className="az-machine-policy">
            <b>验证成功后更新原订阅链接中的节点地址</b>
            <p>
              分配新 IP → 切换绑定 → 重连控制通道 → 真实客户端验证 → 更新配置 →
              释放旧 IP。发布前失败可重试或回滚，旧 IP 保留到验证完成。
            </p>
          </div>
        </>
      )}
      {id && operation && (
        <>
          <div className="az-machine-title">
            <div>
              <strong>
                {operation.oldAddress} → {operation.newAddress ?? "待分配"}
              </strong>
              <small>原订阅链接与访问身份保持不变</small>
            </div>
            <span
              className={
                "az-badge " +
                (operation.status === "ready"
                  ? "good"
                  : operation.status === "failed"
                    ? "warn"
                    : "neutral")
              }
            >
              {operation.status === "failed"
                ? "操作暂停"
                : operation.phaseLabel}
            </span>
          </div>
          {phaseIndex >= 0 && (
            <div
              className="az-machine-progress"
              role="progressbar"
              aria-label="IP 轮换进度"
              aria-valuenow={Math.round((phaseIndex / 7) * 100)}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <i style={{ width: (phaseIndex / 7) * 100 + "%" }} />
            </div>
          )}
          <p className="az-machine-intro">
            当前阶段：{operation.phaseLabel}。进度每 3
            秒更新，关闭窗口后任务继续执行。
          </p>
          {operation.error && (
            <div className="az-alert error">
              <span>
                {operation.error}
                <p>
                  已分配的 IP 会保留并可能继续计费；根据当前阶段选择重试或回滚。
                </p>
              </span>
            </div>
          )}
          {operation.status === "ready" && (
            <div className="az-alert success">
              新 IP 已验证并发布，旧 IP 已释放。客户端刷新原订阅即可使用。
            </div>
          )}
          {operation.status === "rolled_back" && (
            <div className="az-alert success">
              已恢复原 IP，并释放本次申请的新 IP。
            </div>
          )}
          <div className="az-ip-events">
            {operation.events
              .slice()
              .reverse()
              .map((event, i) => (
                <p key={event.at + "-" + i}>
                  <time>
                    {new Date(event.at).toLocaleString("zh-CN", {
                      hour12: false,
                    })}
                  </time>
                  <span>{event.message}</span>
                </p>
              ))}
          </div>
        </>
      )}
      {error && (
        <div className="az-alert error" role="alert">
          <span>{error}</span>
          {!id && (
            <button disabled={busy} onClick={() => setReload((x) => x + 1)}>
              重新检查
            </button>
          )}
        </div>
      )}
      <div className="az-dialog-actions">
        <button className="az-light" disabled={busy} onClick={onClose}>
          {id ? "关闭" : "取消"}
        </button>
        {!id && (
          <button disabled={busy || loading || !preview} onClick={create}>
            {busy ? "提交中…" : "开始轮换 IP"}
          </button>
        )}
        {operation?.status === "failed" && (
          <>
            {operation.canRollback && (
              <button
                className="az-light"
                disabled={busy}
                onClick={() => action("rollback")}
              >
                回滚原 IP
              </button>
            )}
            <button disabled={busy} onClick={() => action("retry")}>
              {busy ? "提交中…" : "重试当前阶段"}
            </button>
          </>
        )}
      </div>
    </dialog>
  );
}
