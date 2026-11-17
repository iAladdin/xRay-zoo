"use client";
import { useEffect, useRef, useState } from "react";

type Node = {
  id: string;
  name: string;
  address: string;
  enabled: boolean;
  busy: boolean;
  publishedAt: string | null;
};
type Action = "enable" | "disable" | "restart" | "reconnect" | "rotate-ip";
type Item = {
  nodeId: string;
  name: string;
  status: string;
  message: string;
  rotationId?: string;
};
type Batch = {
  id: string;
  action: Action;
  status: string;
  items: Item[];
  createdAt: string;
  counts: {
    total: number;
    pending: number;
    succeeded: number;
    failed: number;
    skipped: number;
  };
};
type Preview = {
  nodeId: string;
  planId?: string;
  expiresAt?: string;
  message: string;
};
const actions: Record<Action, string> = {
  enable: "批量启用",
  disable: "批量停用",
  restart: "批量重启",
  reconnect: "批量重连",
  "rotate-ip": "批量轮换 IP",
};
const states: Record<string, string> = {
  queued: "等待执行",
  running: "执行中",
  accepted: "已提交",
  ready: "已完成",
  failed: "失败",
  skipped: "已跳过",
  unknown: "结果待核实",
};
const description: Record<Action, string> = {
  enable: "启用所选节点，完成后以最新检测状态为准。",
  disable:
    "停止所选节点服务，并从新下载的订阅配置中移除；连接可能中断，Azure 资源继续计费。",
  restart: "逐台提交服务重启，当前连接可能中断。已提交不代表节点已经恢复就绪。",
  reconnect: "逐台检查并恢复 SSH 控制隧道，完成后重新检测节点状态。",
  "rotate-ip":
    "为通过预检的节点分配新公网 IP，切换后验证并更新原订阅内容，再释放旧 IP。客户端需刷新订阅，过渡期间新旧 IP 同时计费。",
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
  if (!r.ok) throw new Error(data.error ?? "操作未完成，请重试");
  return data;
}
export default function NodeMaintenance({
  nodes,
  selected,
  onSelect,
  onRefresh,
  onRotation,
}: {
  nodes: Node[];
  selected: string[];
  onSelect: (ids: string[]) => void;
  onRefresh: () => void;
  onRotation: (nodeId: string, rotationId: string) => void;
}) {
  const [action, setAction] = useState<Action>("reconnect");
  const [draft, setDraft] = useState<{
    action: Action;
    nodes: Node[];
    key: string;
  } | null>(null);
  const [previews, setPreviews] = useState<Preview[]>([]);
  const [preparing, setPreparing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [listError, setListError] = useState("");
  const [batches, setBatches] = useState<Batch[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const sending = useRef(false);
  const candidates = nodes.filter((n) => n.publishedAt && !n.busy);
  const chosen = nodes.filter((n) => selected.includes(n.id));
  useEffect(() => {
    let canceled = false,
      inFlight = false;
    async function load() {
      if (inFlight) return;
      inFlight = true;
      try {
        const next = await request<Batch[]>("node-maintenance");
        if (!canceled) {
          setBatches(next);
          setListError("");
        }
      } catch (e) {
        if (!canceled) setListError((e as Error).message);
      } finally {
        inFlight = false;
      }
    }
    load();
    const timer = setInterval(load, 3000);
    return () => {
      canceled = true;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (!draft) return;
    dialog.current?.showModal();
    setError("");
    setPreviews([]);
    if (draft.action !== "rotate-ip") {
      setPreparing(false);
      return () => dialog.current?.close();
    }
    let canceled = false,
      cursor = 0;
    setPreparing(true);
    async function check() {
      while (cursor < draft!.nodes.length && !canceled) {
        const node = draft!.nodes[cursor++];
        let preview: Preview;
        try {
          if (!node.enabled) throw new Error("节点已停用，请先启用");
          const p = await request<{ planId: string; expiresAt: string }>(
            `nodes/${encodeURIComponent(node.id)}/ip-rotation/preview`,
            {},
          );
          preview = { nodeId: node.id, ...p, message: "预检通过" };
        } catch (e) {
          preview = { nodeId: node.id, message: (e as Error).message };
        }
        if (!canceled) setPreviews((current) => [...current, preview]);
      }
    }
    Promise.all([check(), check()]).finally(() => {
      if (!canceled) setPreparing(false);
    });
    return () => {
      canceled = true;
      dialog.current?.close();
    };
  }, [draft]);
  function begin(ids = selected, nextAction = action) {
    const picked = nodes.filter((n) => ids.includes(n.id));
    if (!picked.length) return;
    setDraft({ action: nextAction, nodes: picked, key: crypto.randomUUID() });
  }
  async function submit() {
    if (!draft || sending.current) return;
    if (
      draft.action === "rotate-ip" &&
      previews.some((p) => p.expiresAt && new Date(p.expiresAt) <= new Date())
    ) {
      setError("预检已过期，请重新检查后提交");
      return;
    }
    sending.current = true;
    setSubmitting(true);
    setError("");
    try {
      const batch = await request<Batch>("node-maintenance", {
        action: draft.action,
        nodeIds: draft.nodes.map((n) => n.id),
        idempotencyKey: draft.key,
        ...(draft.action === "rotate-ip"
          ? {
              plans: previews
                .filter((p) => p.planId)
                .map((p) => ({ nodeId: p.nodeId, planId: p.planId })),
            }
          : {}),
      });
      setBatches((old) => [batch, ...old.filter((b) => b.id !== batch.id)]);
      setExpanded(batch.id);
      setDraft(null);
      onSelect([]);
      onRefresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      sending.current = false;
      setSubmitting(false);
    }
  }
  const selectedCount = chosen.length;
  const previewPassed = previews.filter((p) => p.planId).length;
  return (
    <div className="az-maintenance">
      <div className="az-bulk-toolbar" role="group" aria-label="批量节点维护">
        <label className="az-checkbox">
          <input
            type="checkbox"
            aria-label="全选可维护节点"
            disabled={!candidates.length}
            checked={
              !!candidates.length &&
              candidates.every((n) => selected.includes(n.id))
            }
            ref={(el) => {
              if (el)
                el.indeterminate =
                  candidates.some((n) => selected.includes(n.id)) &&
                  !candidates.every((n) => selected.includes(n.id));
            }}
            onChange={(e) =>
              onSelect(e.target.checked ? candidates.map((n) => n.id) : [])
            }
          />
          全选可维护节点
        </label>
        <span>
          已选 <strong>{selectedCount}</strong> 台
        </span>
        <select
          aria-label="批量维护操作"
          value={action}
          onChange={(e) => setAction(e.target.value as Action)}
        >
          {Object.entries(actions).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <button
          disabled={!selectedCount || selectedCount > 50}
          onClick={() => begin()}
        >
          执行批量操作
        </button>
        {!!selectedCount && (
          <button className="az-light" onClick={() => onSelect([])}>
            清空选择
          </button>
        )}
      </div>
      <p className="az-section-note">
        每批最多 50
        台。任务在后台逐台执行，关闭页面后继续；忙碌或未上线的节点将跳过。
      </p>
      {listError && (
        <p className="az-failure" role="alert">
          任务记录读取失败：{listError}
        </p>
      )}
      {!!batches.length && (
        <div className="az-bulk-history">
          <h3>批量维护记录</h3>
          {batches.map((batch) => {
            const retry = batch.items
              .filter(
                (i) =>
                  ["failed", "skipped", "unknown"].includes(i.status) &&
                  !i.rotationId,
              )
              .map((i) => i.nodeId)
              .filter((id) => nodes.some((n) => n.id === id));
            return (
              <article key={batch.id} className="az-bulk-task">
                <button
                  className="az-bulk-summary"
                  aria-expanded={expanded === batch.id}
                  onClick={() =>
                    setExpanded(expanded === batch.id ? null : batch.id)
                  }
                >
                  <strong>
                    {actions[batch.action]} · {batch.counts.total} 台
                  </strong>
                  <span>
                    {batch.status === "running" ? "执行中" : "处理结束"} ·
                    待处理 {batch.counts.pending} ·{" "}
                    {batch.action === "rotate-ip" ? "完成" : "已提交"}{" "}
                    {batch.counts.succeeded} · 失败/待核实 {batch.counts.failed}{" "}
                    · 跳过 {batch.counts.skipped}
                  </span>
                  <small>
                    {new Date(batch.createdAt).toLocaleString("zh-CN", {
                      hour12: false,
                    })}{" "}
                    {expanded === batch.id ? "▴" : "▾"}
                  </small>
                </button>
                {expanded === batch.id && (
                  <>
                    <ul className="az-bulk-results">
                      {batch.items.map((item) => (
                        <li key={item.nodeId}>
                          <strong>{item.name}</strong>
                          <span
                            className={
                              "az-badge " +
                              (["accepted", "ready"].includes(item.status)
                                ? "good"
                                : ["failed", "unknown"].includes(item.status)
                                  ? "warn"
                                  : "neutral")
                            }
                          >
                            {states[item.status]}
                          </span>
                          <span>{item.message}</span>
                          {item.rotationId && (
                            <button
                              className="az-light"
                              onClick={() =>
                                onRotation(item.nodeId, item.rotationId!)
                              }
                            >
                              查看 IP 轮换
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                    {batch.status !== "running" && !!retry.length && (
                      <button
                        className="az-light"
                        onClick={() => begin(retry, batch.action)}
                      >
                        重新处理未完成节点（{retry.length}）
                      </button>
                    )}
                  </>
                )}
              </article>
            );
          })}
        </div>
      )}
      {draft && (
        <dialog
          className="az-dialog az-machine-dialog"
          ref={dialog}
          aria-labelledby="batch-maintenance-title"
          onCancel={(e) => {
            if (submitting) e.preventDefault();
            else setDraft(null);
          }}
        >
          <div className="az-dialog-head">
            <div>
              <div className="az-kicker">NODES / MAINTENANCE</div>
              <h2 id="batch-maintenance-title">
                {actions[draft.action]} · {draft.nodes.length} 台
              </h2>
            </div>
            <button
              aria-label="关闭批量维护"
              className="az-light"
              disabled={submitting}
              onClick={() => setDraft(null)}
            >
              ×
            </button>
          </div>
          <p>{description[draft.action]}</p>
          {draft.action === "rotate-ip" && (
            <p role="status">
              {preparing
                ? `正在核验 ${previews.length} / ${draft.nodes.length} 台…`
                : `预检通过 ${previewPassed} 台，其余节点将跳过。`}
            </p>
          )}
          <ul className="az-bulk-preview">
            {draft.nodes.map((node) => {
              const preview = previews.find((p) => p.nodeId === node.id);
              return (
                <li key={node.id}>
                  <strong>{node.name}</strong>
                  <span>{node.address}</span>
                  <small>
                    {draft.action === "rotate-ip"
                      ? (preview?.message ?? "等待预检")
                      : node.busy
                        ? "节点忙碌，执行时会跳过"
                        : "执行时再次检查节点状态"}
                  </small>
                </li>
              );
            })}
          </ul>
          <p>
            每台节点独立记录结果，失败不会阻断其他节点。未确认的操作不会自动重放，请先核实节点状态。
          </p>
          {error && (
            <p className="az-failure" role="alert">
              {error}
            </p>
          )}
          <div className="az-dialog-actions">
            <button
              className="az-light"
              disabled={submitting}
              onClick={() => setDraft(null)}
            >
              取消
            </button>
            {draft.action === "rotate-ip" && (
              <button
                className="az-light"
                disabled={submitting || preparing}
                onClick={() => setDraft({ ...draft, key: crypto.randomUUID() })}
              >
                重新预检
              </button>
            )}
            <button
              disabled={
                submitting ||
                preparing ||
                (draft.action === "rotate-ip" && !previewPassed)
              }
              onClick={submit}
            >
              {submitting ? "正在提交…" : "确认" + actions[draft.action]}
            </button>
          </div>
        </dialog>
      )}
    </div>
  );
}
