"use client";
import { useEffect, useRef, useState } from "react";

type Location = {
  name: string;
  displayName: string;
  country: string | null;
  physicalLocation: string;
  available: boolean;
};
type Sku = {
  name: string;
  vcpus: number;
  memoryGiB: number;
  available: boolean;
  reasons: string[];
};
type Preview = {
  planId: string;
  expiresAt: string;
  subscription: string;
  resourceGroup: string;
  regionName: string;
  country: string;
  size: string;
  vcpus: number;
  memoryGiB: number;
  cost: {
    computeMonthly: number | null;
    computeHourly: number | null;
    excludes: string[];
  };
};
type Operation = {
  id: string;
  nodeName: string;
  region: string;
  country: string;
  size: string;
  phase: string;
  phaseLabel: string;
  status: string;
  progress: number;
  azureState: string | null;
  error: string | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
  events: { id: string; message: string; createdAt: string }[];
};
const stages = [
  "等待创建",
  "创建 Azure 资源",
  "自动安装节点",
  "接入控制引擎",
  "验证真实连接",
  "更新订阅节点池",
  "已上线",
];
async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch("http://localhost:3101/admin/" + path, {
    credentials: "include",
    cache: "no-store",
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "请求未完成，请重试");
  return data;
}
const date = (value: string) =>
  new Date(value).toLocaleString("zh-CN", { hour12: false });
const money = (value: number, precision = 2) =>
  new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: precision,
  }).format(value);

export default function MachineProvisioner() {
  const [open, setOpen] = useState(false);
  const [operations, setOperations] = useState<Operation[]>([]);
  const [listError, setListError] = useState("");
  const [retrying, setRetrying] = useState("");
  const [listLoaded, setListLoaded] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    let fetching = false;
    async function load() {
      if (fetching) return;
      fetching = true;
      try {
        const rows = await request<Operation[]>("machines");
        if (alive.current) {
          setOperations(rows);
          setListError("");
          setListLoaded(true);
        }
      } catch (e) {
        if (alive.current) setListError((e as Error).message);
      } finally {
        fetching = false;
      }
    }
    load();
    const timer = setInterval(load, 3000);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, []);
  async function retry(id: string) {
    setRetrying(id);
    try {
      await request(`machines/${id}/retry`, {});
      setOperations(await request<Operation[]>("machines"));
      setListError("");
    } catch (e) {
      setListError((e as Error).message);
    } finally {
      setRetrying("");
    }
  }
  return (
    <section className="az-section az-machines">
      <div className="az-section-head">
        <div>
          <h2>
            上机器 <span>AZURE</span>
          </h2>
          <p>
            选择区域与规格，默认 B2ats_v2 + 32 GiB
            HDD，验证成功后加入订阅节点池。
          </p>
        </div>
        <button onClick={() => setOpen(true)}>＋ 上机器</button>
      </div>
      {listError && (
        <div className="az-alert error" role="alert">
          {listError} · 将自动重试获取状态
        </div>
      )}
      {!operations.length && (
        <p className="az-section-note">
          {listLoaded
            ? "暂无部署任务。当前已有节点保持运行，新增任务的进度会持续显示在这里。"
            : "正在读取部署任务…"}
        </p>
      )}
      {operations.map((op) => (
        <article className="az-machine-task" key={op.id}>
          <div className="az-machine-title">
            <div>
              <strong>{op.nodeName}</strong>
              <small>
                {op.country} · {op.region} · {op.size}
              </small>
            </div>
            <span
              className={
                "az-badge " +
                (op.status === "ready"
                  ? "good"
                  : op.status === "failed"
                    ? "warn"
                    : "neutral")
              }
            >
              {op.status === "failed" ? "部署暂停" : op.phaseLabel}
            </span>
          </div>
          <div
            className="az-machine-progress"
            role="progressbar"
            aria-label={op.nodeName + " 部署进度"}
            aria-valuenow={op.progress}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <i style={{ width: op.progress + "%" }} />
          </div>
          <ol className="az-machine-stages">
            {stages.map((label, i) => (
              <li
                key={label}
                className={
                  i <= Math.round((op.progress / 100) * 6) ? "reached" : ""
                }
              >
                {label}
              </li>
            ))}
          </ol>
          {op.error && (
            <div className="az-alert error">
              <span>
                {op.error}
                <small>
                  失败阶段：{op.phaseLabel} · {op.errorCode}
                  。已创建的资源会保留，可能继续计费。
                </small>
              </span>
              <button disabled={!!retrying} onClick={() => retry(op.id)}>
                {retrying === op.id ? "提交中…" : "重试当前任务"}
              </button>
            </div>
          )}
          {op.status === "ready" && (
            <p className="az-machine-success">
              本次部署已完成验证和订阅同步。当前机器是否已回收，以节点列表状态为准。
            </p>
          )}
          <details>
            <summary>
              部署记录 · {date(op.updatedAt)}
              {op.azureState ? " · Azure " + op.azureState : ""}
            </summary>
            <ul>
              {op.events.map((event) => (
                <li key={event.id}>
                  <time>{date(event.createdAt)}</time>
                  {event.message}
                </li>
              ))}
            </ul>
          </details>
        </article>
      ))}
      {open && (
        <CreateMachine
          onClose={() => setOpen(false)}
          onCreated={async () => {
            setOpen(false);
            try {
              setOperations(await request<Operation[]>("machines"));
            } catch {
              setListError("任务已提交，正在重新获取进度");
            }
          }}
        />
      )}
    </section>
  );
}

function CreateMachine({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [region, setRegion] = useState("");
  const [regionSearch, setRegionSearch] = useState("");
  const [skus, setSkus] = useState<Sku[]>([]);
  const [size, setSize] = useState("");
  const [sizeSearch, setSizeSearch] = useState("");
  const [onlyAvailable, setOnlyAvailable] = useState(true);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [skusLoading, setSkusLoading] = useState(false);
  const [skusLoaded, setSkusLoaded] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [key, setKey] = useState("");
  const [reload, setReload] = useState(0);
  const generation = useRef(0);
  useEffect(() => {
    dialog.current?.showModal();
    return () => {
      generation.current++;
      dialog.current?.close();
    };
  }, []);
  useEffect(() => {
    let canceled = false;
    setCatalogLoading(true);
    setError("");
    request<{ locations: Location[] }>("azure/locations")
      .then((data) => {
        if (!canceled) setLocations(data.locations);
      })
      .catch((e) => {
        if (!canceled) setError(e.message);
      })
      .finally(() => {
        if (!canceled) setCatalogLoading(false);
      });
    return () => {
      canceled = true;
    };
  }, [reload]);
  useEffect(() => {
    setSkus([]);
    setSkusLoaded(false);
    setSize("");
    setPreview(null);
    setSizeSearch("");
    setPreviewing(false);
    const current = ++generation.current;
    if (!region) {
      setSkusLoading(false);
      return;
    }
    setSkusLoading(true);
    setError("");
    request<{ items: Sku[] }>("azure/skus?region=" + encodeURIComponent(region))
      .then((data) => {
        if (generation.current === current) {
          setSkus(data.items);
          if (
            data.items.some(
              (s) => s.name === "Standard_B2ats_v2" && s.available,
            )
          )
            setSize("Standard_B2ats_v2");
          setSkusLoaded(true);
        }
      })
      .catch((e) => {
        if (generation.current === current) setError(e.message);
      })
      .finally(() => {
        if (generation.current === current) setSkusLoading(false);
      });
    return () => {
      generation.current++;
    };
  }, [region, reload]);
  function changeSize(value: string) {
    generation.current++;
    setSize(value);
    setPreview(null);
    setPreviewing(false);
    setError("");
  }
  async function inspect() {
    const current = ++generation.current;
    setPreviewing(true);
    setError("");
    setPreview(null);
    try {
      const data = await request<Preview>("machines/preview", { region, size });
      if (current === generation.current) {
        setPreview(data);
        setKey(crypto.randomUUID());
      }
    } catch (e) {
      if (current === generation.current) setError((e as Error).message);
    } finally {
      if (current === generation.current) setPreviewing(false);
    }
  }
  async function create() {
    if (!preview || submitting) return;
    if (new Date(preview.expiresAt) <= new Date()) {
      setPreview(null);
      setError("预览已过期，请重新检查规格与费用");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      await request("machines", {
        planId: preview.planId,
        idempotencyKey: key,
      });
      onCreated();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }
  const visibleRegions = locations.filter(
    (x) =>
      `${x.name} ${x.displayName} ${x.country} ${x.physicalLocation}`
        .toLowerCase()
        .includes(regionSearch.toLowerCase()) || x.name === region,
  );
  const visibleSkus = skus.filter(
    (x) =>
      (!onlyAvailable || x.available || x.name === size) &&
      (x.name.toLowerCase().includes(sizeSearch.toLowerCase()) ||
        x.name === size),
  );
  const availableSkus = skus.filter((x) => x.available).length;
  const busy = submitting;
  return (
    <dialog
      ref={dialog}
      className="az-dialog az-machine-dialog"
      aria-labelledby="az-create-title"
      onCancel={(e) => {
        if (busy) e.preventDefault();
        else onClose();
      }}
    >
      <div className="az-dialog-head">
        <div>
          <div className="az-kicker">AZURE / NEW NODE</div>
          <h2 id="az-create-title">部署一台新节点</h2>
        </div>
        <button
          className="az-light"
          aria-label="关闭上机器"
          disabled={busy}
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <p className="az-machine-intro">
        从当前 Azure
        订阅读取区域和规格。上线前会完成安装、控制连接及真实客户端验证。
      </p>
      <div className="az-machine-fields">
        <fieldset disabled={busy}>
          <legend>
            <b>01</b> 选择区域
          </legend>
          <input
            aria-label="搜索 Azure 区域"
            placeholder="搜索区域、城市或地区代码，如 JP"
            value={regionSearch}
            onChange={(e) => setRegionSearch(e.target.value)}
          />
          <select
            aria-label="Azure 区域"
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            disabled={catalogLoading || busy}
          >
            <option value="">
              {catalogLoading ? "正在读取 Azure 区域…" : "请选择 Azure 区域"}
            </option>
            {visibleRegions.map((x) => (
              <option
                key={x.name}
                value={x.name}
                disabled={!x.available || !x.country}
              >
                {x.country ?? "—"} · {x.displayName} ({x.name})
                {!x.available
                  ? " · 当前订阅不支持 VM"
                  : !x.country
                    ? " · 暂无地区映射"
                    : ""}
              </option>
            ))}
          </select>
          <small>
            {locations.length
              ? `${locations.length} 个物理区域 · ${locations.filter((x) => x.available).length} 个支持虚拟机`
              : "区域范围取决于当前 Azure 订阅"}
          </small>
        </fieldset>
        <fieldset disabled={busy}>
          <legend>
            <b>02</b> 选择规格
          </legend>
          <input
            aria-label="搜索机器规格"
            placeholder="搜索规格，如 B2ats"
            value={sizeSearch}
            onChange={(e) => setSizeSearch(e.target.value)}
            disabled={!region || skusLoading}
          />
          <select
            aria-label="机器规格"
            value={size}
            onChange={(e) => changeSize(e.target.value)}
            disabled={!region || skusLoading || busy}
          >
            <option value="">
              {skusLoading
                ? "正在核验规格和 vCPU 配额…"
                : skusLoaded && !visibleSkus.length
                  ? "没有符合条件的规格"
                  : "请选择机器规格"}
            </option>
            {visibleSkus.map((x) => (
              <option key={x.name} value={x.name} disabled={!x.available}>
                {x.name} · {x.vcpus} vCPU / {x.memoryGiB} GiB
                {!x.available ? " · " + x.reasons.join("；") : ""}
              </option>
            ))}
          </select>
          <label className="az-checkbox">
            <input
              type="checkbox"
              checked={onlyAvailable}
              onChange={(e) => setOnlyAvailable(e.target.checked)}
            />
            仅显示当前可用规格
          </label>
          {skus.length > 0 && (
            <small>
              {availableSkus} / {skus.length}{" "}
              个规格通过限制、配额与镜像检查。Azure 最终分配仍以实时容量为准。
            </small>
          )}
          {skusLoaded && !visibleSkus.length && (
            <div className="az-alert warning" role="status">
              <span>
                {!skus.length
                  ? "Azure 未返回该区域的机器规格，可重新加载或选择其他区域。"
                  : !availableSkus && onlyAvailable
                    ? "当前区域没有通过配额与订阅检查的规格，可查看不可用原因。"
                    : "没有匹配当前搜索条件的规格。"}
              </span>
              <button
                type="button"
                onClick={() => {
                  if (!skus.length) setReload((x) => x + 1);
                  else {
                    setSizeSearch("");
                    if (!availableSkus) setOnlyAvailable(false);
                  }
                }}
              >
                {!skus.length
                  ? "重新加载"
                  : !availableSkus && onlyAvailable
                    ? "查看原因"
                    : "清除筛选"}
              </button>
            </div>
          )}
        </fieldset>
      </div>
      {error && (
        <div className="az-alert error" role="alert">
          <span>{error}</span>
          {!submitting && (
            <button
              onClick={() => {
                setPreview(null);
                setReload((x) => x + 1);
              }}
            >
              重新加载
            </button>
          )}
        </div>
      )}
      {preview && (
        <div className="az-machine-estimate">
          <div>
            <span>计算费用估算</span>
            <strong>
              {preview.cost.computeMonthly === null
                ? "暂时无法获取"
                : money(preview.cost.computeMonthly)}
              {preview.cost.computeMonthly !== null && <small>/ 月</small>}
            </strong>
            <small>
              {preview.cost.computeHourly !== null
                ? `${money(preview.cost.computeHourly, 5)} / 小时，按每月 730 小时估算`
                : "Azure 仍会按实际使用量计费"}
            </small>
          </div>
          <dl>
            <div>
              <dt>部署位置</dt>
              <dd>
                {preview.regionName} · {preview.resourceGroup}
              </dd>
            </div>
            <div>
              <dt>机器配置</dt>
              <dd>
                {preview.size} · {preview.vcpus} vCPU / {preview.memoryGiB} GiB
              </dd>
            </div>
            <div>
              <dt>另行计费</dt>
              <dd>{preview.cost.excludes.join("、")}</dd>
            </div>
          </dl>
          <p>
            本次创建 1 台虚拟机、1 个公网 IP、32 GiB
            系统盘和配套网络。点击“上机器”开始产生 Azure
            费用，失败时已创建的资源会保留。
          </p>
        </div>
      )}
      <div className="az-machine-policy">
        <b>上线后自动更新订阅池</b>
        <p>
          全局套餐自动包含新节点。AI 仅走 JP / SG / US，Telegram 仅走 HK /
          TW；其他区域供通用流量使用。原订阅链接保持不变。
        </p>
      </div>
      <div className="az-dialog-actions">
        <button className="az-light" disabled={busy} onClick={onClose}>
          取消
        </button>
        {preview ? (
          <button disabled={busy} onClick={create}>
            {submitting ? "提交部署任务…" : "上机器"}
          </button>
        ) : (
          <button
            disabled={!region || !size || previewing || skusLoading}
            onClick={inspect}
          >
            {previewing ? "核验配额与费用…" : "检查规格与费用"}
          </button>
        )}
      </div>
    </dialog>
  );
}
