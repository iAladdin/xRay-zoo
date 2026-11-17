"use client";
import { useEffect, useRef, useState } from "react";
type Location = {
  name: string;
  displayName: string;
  country: string | null;
  available: boolean;
};
type Node = {
  id: string;
  name: string;
  region: string;
  resourceState: string;
  busy: boolean;
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
  if (!r.ok) throw new Error(data.error ?? "请求未完成");
  return data;
}
const defaults = [
  "japaneast",
  "southeastasia",
  "eastus2",
  "eastasia",
  "taiwannorth",
];
const route = (country: string | null) =>
  ["JP", "SG", "US"].includes(country ?? "")
    ? "AI + 通用流量"
    : ["HK", "TW"].includes(country ?? "")
      ? "Telegram + 通用流量"
      : "通用流量";
export default function RegionFleet({
  nodes,
  onRefresh,
}: {
  nodes: Node[];
  onRefresh: () => void;
}) {
  const [mode, setMode] = useState<"start" | "release" | null>(null),
    [locations, setLocations] = useState<Location[]>([]),
    [selected, setSelected] = useState<string[]>([]),
    [search, setSearch] = useState(""),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [sending, setSending] = useState(false),
    [key, setKey] = useState("");
  const dialog = useRef<HTMLDialogElement>(null),
    inFlight = useRef(false);
  const releasable = nodes.filter((n) => n.resourceState !== "released");
  useEffect(() => {
    if (!mode) return;
    dialog.current?.showModal();
    setError("");
    if (mode !== "start") setLoading(false);
    let canceled = false;
    if (mode === "start") {
      setLoading(true);
      request<{ locations: Location[] }>("azure/locations")
        .then((data) => {
          if (!canceled) setLocations(data.locations);
        })
        .catch((e) => {
          if (!canceled) setError(e.message);
        })
        .finally(() => {
          if (!canceled) setLoading(false);
        });
    }
    return () => {
      canceled = true;
      dialog.current?.close();
    };
  }, [mode]);
  function open(value: "start" | "release") {
    setKey(crypto.randomUUID());
    setSelected([]);
    setSearch("");
    setMode(value);
  }
  async function submit() {
    if (inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    setError("");
    try {
      const batch = await request<{
        id: string;
        counts: { total: number; skipped: number };
      }>(
        "node-maintenance",
        mode === "start"
          ? { action: "rebuild", regions: selected, idempotencyKey: key }
          : { action: "release", all: true, idempotencyKey: key },
      );
      setNotice(
        `已提交 ${batch.counts.total} 台节点，${batch.counts.skipped} 台跳过。下方批量记录持续显示进度，关闭页面后仍会继续。`,
      );
      setMode(null);
      onRefresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
      inFlight.current = false;
    }
  }
  const visible = locations.filter((l) =>
    (l.name + " " + l.displayName + " " + l.country)
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  return (
    <section className="az-section az-fleet">
      <div className="az-section-head">
        <div>
          <h2>按区域启动与回收</h2>
          <p>Standard B2ats_v2 · 2 vCPU / 1 GiB · 32 GiB Standard HDD</p>
        </div>
        <div className="az-fleet-actions">
          <button onClick={() => open("start")}>＋ 选择区域启动</button>
          <button
            className="az-light"
            disabled={!releasable.length}
            onClick={() => open("release")}
          >
            回收全部机器（{releasable.length}）
          </button>
        </div>
      </div>
      <p className="az-section-note">
        AI 固定走日本 / 新加坡 / 美国；Telegram 固定走香港 /
        台湾。其他地区用于通用流量。回收后保留配置，重建验证成功后自动加入原订阅。
      </p>
      {notice && (
        <p role="status" className="az-machine-success">
          {notice}
        </p>
      )}
      {mode && (
        <dialog
          className={`az-dialog az-machine-dialog${mode === "start" ? " az-region-dialog" : ""}`}
          ref={dialog}
          aria-labelledby="fleet-title"
          onCancel={(e) => {
            if (sending) e.preventDefault();
            else setMode(null);
          }}
        >
          <div className="az-dialog-head">
            <div>
              <div className="az-kicker">AZURE / REGIONS</div>
              <h2 id="fleet-title">
                {mode === "start" ? "选择启动区域" : "回收全部已启动机器"}
              </h2>
            </div>
            <button
              className="az-light"
              aria-label="关闭区域操作"
              disabled={sending}
              onClick={() => setMode(null)}
            >
              ×
            </button>
          </div>
          {mode === "start" ? (
            <>
              <p className="az-region-intro">
                默认 B2ats_v2 + 32 GiB
                HDD，按区域计费。每区一台，已有机器跳过，已回收节点沿用配置重建。
              </p>
              <div className="az-fleet-filter">
                <input
                  aria-label="搜索 Azure 区域"
                  placeholder="搜索区域名称、代码、国家…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <button
                  className="az-light"
                  disabled={loading}
                  onClick={() => {
                    setKey(crypto.randomUUID());
                    setSelected(
                      defaults.filter((r) =>
                        locations.some(
                          (l) => l.name === r && l.available && l.country,
                        ),
                      ),
                    );
                  }}
                >
                  选择 JP / SG / US / HK / TW
                </button>
                <button
                  className="az-light"
                  onClick={() => {
                    setKey(crypto.randomUUID());
                    setSelected([]);
                  }}
                >
                  清空
                </button>
              </div>
              <p role="status" className="az-region-count">
                {loading
                  ? "正在读取 Azure 订阅可选区域…"
                  : `已选 ${selected.length} 个区域 · 最多 50 个`}
              </p>
              <div className="az-region-grid">
                {visible.map((l) => {
                  const current = nodes.find(
                    (n) =>
                      n.region === l.name && n.resourceState !== "released",
                  );
                  return (
                    <label
                      key={l.name}
                      className={
                        "az-region-option" +
                        (!l.available || !l.country ? " unavailable" : "")
                      }
                    >
                      <input
                        type="checkbox"
                        checked={selected.includes(l.name)}
                        disabled={
                          sending ||
                          !l.available ||
                          !l.country ||
                          (!selected.includes(l.name) && selected.length >= 50)
                        }
                        onChange={(e) => {
                          setKey(crypto.randomUUID());
                          setSelected((v) =>
                            e.target.checked
                              ? [...v, l.name]
                              : v.filter((x) => x !== l.name),
                          );
                        }}
                      />
                      <span>
                        <strong>{l.displayName}</strong>
                        <small>
                          {l.name} · {l.country ?? "国家信息不可用"}
                        </small>
                        <small>
                          {route(l.country)}
                          {current
                            ? " · 已有机器，将跳过"
                            : !l.available
                              ? " · 当前订阅不可用"
                              : ""}
                        </small>
                      </span>
                    </label>
                  );
                })}
              </div>
              <p className="az-region-note">
                启动前逐区核验规格、配额和镜像；单区失败不影响其他区域。
              </p>
            </>
          ) : (
            <>
              <p>
                停止以下节点的代理服务，结算已上报用量，释放
                VM、系统盘、网卡和公网
                IP。保留区域、规格、接入配置和用户权益；以后可按区域重新拉起。
              </p>
              <ul className="az-bulk-preview">
                {releasable.map((n) => (
                  <li key={n.id}>
                    <strong>{n.name}</strong>
                    <span>{n.region}</span>
                    <small>
                      {n.busy
                        ? "有任务进行中，冲突操作会跳过"
                        : "回收后当前连接会断开"}
                    </small>
                  </li>
                ))}
              </ul>
              <p>
                全部回收后，订阅暂时没有可用节点。重建通常需要数分钟，公网 IP
                会重新分配；用户刷新原订阅链接即可获取新地址。
              </p>
            </>
          )}
          {error && (
            <p className="az-failure" role="alert">
              {error}
            </p>
          )}
          <div className="az-dialog-actions">
            <button
              className="az-light"
              disabled={sending}
              onClick={() => setMode(null)}
            >
              取消
            </button>
            <button
              disabled={
                sending || loading || (mode === "start" && !selected.length)
              }
              onClick={submit}
            >
              {sending
                ? "正在提交…"
                : mode === "start"
                  ? `启动所选 ${selected.length} 个区域`
                  : `确认回收 ${releasable.length} 台机器`}
            </button>
          </div>
        </dialog>
      )}
    </section>
  );
}
