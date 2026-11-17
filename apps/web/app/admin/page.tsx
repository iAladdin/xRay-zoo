"use client";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import "./admin.css";
import MachineProvisioner from "./MachineProvisioner";
import IpRotationDialog, { type IpRotation } from "./IpRotationDialog";
const API = "http://localhost:3101";
const tabs = [
  ["overview", "运营概览", "◫"],
  ["nodes", "区域节点", "◎"],
  ["users", "用户", "♙"],
  ["subscriptions", "订阅管理", "↗"],
  ["plans", "套餐", "▤"],
  ["orders", "订单", "▣"],
  ["usage", "流量用量", "▥"],
  ["audit", "操作记录", "≡"],
] as const;
type Tab = (typeof tabs)[number][0];
type NodeRow = {
  id: string;
  name: string;
  country: string;
  region: string;
  address: string;
  port: number;
  enabled: boolean;
  ready: boolean;
  state: string;
  transportConnected: boolean | null;
  engineConnected: boolean;
  engineDisabled: boolean;
  checkedAt: string | null;
  lastHealthyAt: string | null;
  usageBytes: string;
  usageUpdatedAt: string | null;
  xrayVersion: string | null;
  busy: boolean;
  publishedAt: string | null;
  vmSize: string | null;
  activeIpRotationId: string | null;
  ipRotation: IpRotation | null;
};
type Sub = {
  id: string;
  user: { email: string };
  status: string;
  desiredVersion: number;
  appliedVersion: number;
  validUntil: string | null;
  quotaBytes: string;
  usedBytes: string;
  regions: string[];
  lastUsageAt: string | null;
  lastError: string | null;
  createdAt: string;
};
type Plan = {
  id: string;
  name: string;
  amountMinor: number;
  currency: string;
  quotaBytes: string;
  regions: string[];
  active: boolean;
  globalPool: boolean;
  _count: { orders: number };
};
type User = {
  id: string;
  email: string;
  role: string;
  createdAt: string;
  _count: { orders: number };
  subscription: Sub | null;
};
type Order = {
  id: string;
  user: { email: string };
  plan: { name: string };
  status: string;
  provider: string;
  amountMinor: number;
  currency: string;
  createdAt: string;
  periods: { startAt: string; endAt: string; status: string }[];
};
type Audit = {
  id: string;
  action: string;
  actor?: string;
  targetId: string;
  createdAt: string;
  detail?: { reason?: string };
};
type Overview = {
  asOf: string;
  paymentMode: string;
  nodes: { total: number; ready: number };
  users: number;
  subscriptions: { status: string; _count: number }[];
  orders: { status: string; _count: number }[];
  pendingEvents: number;
  usage: { usedBytes: string; quotaBytes: string; lastUsageAt: string | null };
  receipts: Record<string, number>;
  audit: Audit[];
};
type Row = User | Order | Sub | Audit;
type List = { page: number; pageSize: number; total: number; items: Row[] };
const countries: Record<string, string> = {
  JP: "日本",
  SG: "新加坡",
  US: "美国",
  HK: "香港",
  TW: "台湾",
};
const labels: Record<string, string> = {
  ROTATING_IP: "IP 切换中",
  PROVISIONING: "部署验证中",
  READY: "控制就绪",
  DISABLED: "已停用",
  DISABLE_PENDING: "停用待确认",
  "on-sale": "已上架",
  "off-sale": "已下架",
  STALE: "检测已过期",
  CONTROL_DISCONNECTED: "控制隧道断开",
  ENGINE_UNAVAILABLE: "引擎不可达",
  ENGINE_DISABLED: "引擎已停用",
  NODE_DISCONNECTED: "节点未连接",
  NODE_MISSING: "引擎缺少节点",
  active: "已开通",
  pending: "等待处理",
  paid: "已付款",
  suspended: "已暂停",
  expired: "已到期",
  revoked: "用户已撤销",
  regenerating: "重新生成中",
  exhausted: "流量耗尽",
  CUSTOMER: "订阅用户",
  ADMIN: "管理员",
};
const regionName = (code: string) =>
  countries[code] ??
  new Intl.DisplayNames(["zh-CN"], { type: "region" }).of(code) ??
  code;
const actionLabel: Record<string, string> = {
  enable: "启用节点",
  disable: "停用节点",
  restart: "重启节点服务",
  reconnect: "重连控制隧道",
  suspend: "暂停订阅",
  resume: "恢复订阅",
  retry: "重试同步",
  "rotate-link": "重置订阅链接",
};
const auditLabels: Record<string, string> = {
  "ip-rotation.create": "提交 IP 轮换",
  "ip-rotation.retry": "重试 IP 轮换",
  "ip-rotation.rollback": "请求回滚 IP",
  "ip-rotation.published": "发布新 IP",
  "ip-rotation.restored": "恢复原 IP",
  "subscription.customer-revoke": "用户撤销访问",
  "subscription.customer-regenerate": "用户重新生成配置",
  "subscription.suspend": "暂停订阅",
  "subscription.resume": "恢复订阅",
  "subscription.retry": "重新同步订阅",
  "subscription.rotate-link": "重置订阅链接",
  "subscription.copy-link": "复制订阅链接",
  "machine.create": "提交机器部署",
  "machine.retry": "重试机器部署",
  "machine.publish": "节点加入订阅池",
  "plan.create": "创建套餐",
  "plan.update": "编辑套餐",
};
function auditTitle(action: string) {
  if (auditLabels[action]) return auditLabels[action];
  const [kind, verb, state] = action.split(".");
  if (kind === "node")
    return (
      (actionLabel[verb] ?? verb) +
      " · " +
      ({ requested: "已提交", accepted: "已接受", failed: "失败" }[state] ??
        state)
    );
  return action;
}
const reasonLabel: Record<string, string> = {
  NO_ENABLED_NODES: "所有授权区域已停用",
  NO_READY_NODES: "等待节点就绪",
  ENGINE_REVOCATION_PENDING: "撤销授权仍在同步",
  ENTITLEMENT_BUSY: "订阅正在同步",
  ENGINE_USAGE_UNAVAILABLE: "暂时无法读取流量",
  ENGINE_COUNTER_RESET_REQUIRES_RECONCILIATION: "流量计数器重置，需要核对",
};
function date(v: string | null | undefined) {
  return v
    ? new Date(v).toLocaleString("zh-CN", { hour12: false })
    : "尚无记录";
}
function bytes(v: string | number) {
  const n = Number(v);
  return n >= 1000 ** 3
    ? (n / 1000 ** 3).toFixed(2) + " GB"
    : n >= 1000 ** 2
      ? (n / 1000 ** 2).toFixed(2) + " MB"
      : n >= 1000
        ? (n / 1000).toFixed(1) + " KB"
        : n + " B";
}
function money(n: number, c = "USD") {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: c,
  }).format(n / 100);
}
function Badge({ value }: { value: string }) {
  return (
    <span
      className={
        "az-badge " +
        (["READY", "active", "paid", "on-sale"].includes(value)
          ? "good"
          : ["pending", "STALE"].includes(value)
            ? "warn"
            : "neutral")
      }
    >
      {labels[value] ?? value}
    </span>
  );
}
class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
async function api(path: string, body?: unknown) {
  const r = await fetch(API + path, {
    credentials: "include",
    cache: "no-store",
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw new ApiError(r.status, data.error ?? "请求失败");
  return data;
}
function Dialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog className="az-dialog" ref={ref} onCancel={onClose}>
      <div className="az-dialog-head">
        <h2>{title}</h2>
        <button aria-label="关闭对话框" onClick={onClose} className="az-light">
          ×
        </button>
      </div>
      {children}
    </dialog>
  );
}
function Table({
  headers,
  children,
  empty,
}: {
  headers: string[];
  children: ReactNode;
  empty: boolean;
}) {
  return (
    <div className="az-table-scroll">
      <table>
        <thead>
          <tr>
            {headers.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {empty ? (
            <tr>
              <td colSpan={headers.length} className="az-empty">
                暂无符合条件的记录
              </td>
            </tr>
          ) : (
            children
          )}
        </tbody>
      </table>
    </div>
  );
}
function Meter({ sub }: { sub: { usedBytes: string; quotaBytes: string } }) {
  const ratio =
    Number(sub.quotaBytes) > 0
      ? Math.min(100, (100 * Number(sub.usedBytes)) / Number(sub.quotaBytes))
      : 0;
  return (
    <div className="az-usage">
      <span>
        {bytes(sub.usedBytes)} <small>/ {bytes(sub.quotaBytes)}</small>
      </span>
      <div className="az-meter">
        <i style={{ width: ratio + "%" }} />
      </div>
    </div>
  );
}

export default function Admin() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [tab, setTab] = useState<Tab>("overview");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [nodes, setNodes] = useState<NodeRow[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [list, setList] = useState<List>({
    page: 1,
    pageSize: 20,
    total: 0,
    items: [],
  });
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirm, setConfirm] = useState<{
    kind: "nodes" | "subscriptions";
    id: string;
    name: string;
    action: string;
    version?: number;
  } | null>(null);
  const [editing, setEditing] = useState<Plan | "new" | null>(null);
  const [rotating, setRotating] = useState<NodeRow | null>(null);
  const requestId = useRef(0);
  function fail(e: unknown) {
    if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
      router.replace("/?login=1#account");
      return;
    }
    setError(e instanceof Error ? e.message : "连接失败，请重试");
  }
  async function load(spinner = false) {
    const rid = ++requestId.current;
    if (spinner) setLoading(true);
    try {
      const path = tab === "usage" ? "subscriptions" : tab;
      const [stats, ns, detail] = await Promise.all([
        api("/admin/overview"),
        api("/admin/nodes"),
        ["overview", "nodes"].includes(tab)
          ? Promise.resolve(null)
          : api(
              "/admin/" +
                path +
                (path === "plans"
                  ? ""
                  : `?page=${page}&q=${encodeURIComponent(search)}`),
            ),
      ]);
      if (rid !== requestId.current) return;
      setOverview(stats);
      setNodes(ns);
      if (tab === "plans") setPlans(detail);
      else if (detail) setList(detail);
      setError("");
    } catch (e) {
      if (rid === requestId.current) fail(e);
    } finally {
      if (rid === requestId.current) setLoading(false);
    }
  }
  useEffect(() => {
    api("/me")
      .then((v) => {
        if (v.user.role !== "ADMIN") router.replace("/");
        else setEmail(v.user.email);
      })
      .catch(fail);
  }, []);
  useEffect(() => {
    if (!email) return;
    load(true);
    const timer = setInterval(() => load(), 10000);
    return () => {
      clearInterval(timer);
      requestId.current++;
    };
  }, [email, tab, page, search]);
  function choose(next: Tab) {
    setTab(next);
    setPage(1);
    setQuery("");
    setSearch("");
    setNotice("");
    setError("");
    setList({ page: 1, pageSize: 20, total: 0, items: [] });
  }
  async function perform(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      await load();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  function submitAction(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    if (!confirm) return;
    const selected = confirm;
    perform(async () => {
      const r = await api(`/admin/${selected.kind}/${selected.id}/action`, {
        action: selected.action,
        ...(selected.kind === "subscriptions"
          ? { expectedVersion: selected.version, reason: data.get("reason") }
          : {}),
      });
      setConfirm(null);
      setNotice(r.message ?? "操作已提交");
    });
  }
  function savePlan(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    perform(async () => {
      await api("/admin/plans", {
        id: data.get("id"),
        name: data.get("name"),
        amountMinor: Math.round(Number(data.get("price")) * 100),
        currency: "USD",
        quotaGB: Number(data.get("quota")),
        regions: data.getAll("regions"),
        active: data.get("active") === "on",
        globalPool: data.get("globalPool") === "on",
      });
      setEditing(null);
      setNotice("套餐已保存。已生成订单与续费合约保留原价格和权益。");
    });
  }
  const active =
    overview?.subscriptions.find((s) => s.status === "active")?._count ?? 0;
  const subActions = (s: Sub) => (
    <div className="az-row-actions">
      <button
        disabled={
          busy || s.status !== "active" || s.desiredVersion !== s.appliedVersion
        }
        onClick={() =>
          perform(async () => {
            const result = await api(`/admin/subscriptions/${s.id}/link`, {});
            await navigator.clipboard.writeText(result.url);
            setNotice("订阅链接已复制，请仅交付给对应用户。");
          })
        }
      >
        复制链接
      </button>
      <button
        disabled={busy}
        onClick={() =>
          setConfirm({
            kind: "subscriptions",
            id: s.id,
            name: s.user.email,
            action: s.status === "suspended" ? "resume" : "suspend",
            version: s.desiredVersion,
          })
        }
      >
        {s.status === "suspended" ? "恢复" : "暂停"}
      </button>
      <button
        disabled={busy}
        onClick={() =>
          setConfirm({
            kind: "subscriptions",
            id: s.id,
            name: s.user.email,
            action: "retry",
            version: s.desiredVersion,
          })
        }
      >
        同步
      </button>
      <button
        disabled={busy}
        onClick={() =>
          setConfirm({
            kind: "subscriptions",
            id: s.id,
            name: s.user.email,
            action: "rotate-link",
            version: s.desiredVersion,
          })
        }
      >
        重置链接
      </button>
    </div>
  );
  if (!email)
    return (
      <div className="az-loading" role="status">
        正在验证管理员身份…
      </div>
    );
  return (
    <div className="az-shell">
      <aside className="az-sidebar">
        <a className="brand" href="/admin">
          <span className="brandmark">x</span>xRay-zoo
        </a>
        <div className="az-side-label">OPERATOR CONSOLE</div>
        <nav aria-label="管理员导航">
          {tabs.map(([key, label, icon]) => (
            <button
              key={key}
              aria-current={tab === key ? "page" : undefined}
              className={tab === key ? "selected" : ""}
              onClick={() => choose(key)}
            >
              <span aria-hidden="true">{icon}</span>
              {label}
              {key === "nodes" && (
                <small>
                  {nodes.filter((n) => n.ready).length}/{nodes.length || 5}
                </small>
              )}
            </button>
          ))}
        </nav>
        <div className="az-side-bottom">
          <span className="az-pulse" /> 本地控制台
          <small>
            {new Set(nodes.map((n) => n.region)).size} 个区域 · {nodes.length}{" "}
            台节点
          </small>
        </div>
      </aside>
      <div className="az-workspace">
        <header className="az-topbar">
          <span>
            工作空间 <b>/</b> 管理员后台
          </span>
          <div>
            <span className="az-environment">
              {overview?.paymentMode ?? "测试环境"}
            </span>
            <a href="/account" className="az-link">
              用户中心 ↗
            </a>
            <span className="az-avatar">A</span>
            <span className="az-email">{email}</span>
            <button
              className="az-light"
              disabled={busy}
              onClick={() =>
                perform(async () => {
                  await api("/auth/logout", {});
                  router.replace("/?login=1#account");
                })
              }
            >
              退出
            </button>
          </div>
        </header>
        <main className="az-main">
          <div className="az-page-heading">
            <div>
              <div className="az-kicker">XRAY-ZOO / OPERATIONS</div>
              <h1>{tabs.find((t) => t[0] === tab)?.[1]}</h1>
              <p>
                {tab === "overview"
                  ? "掌握区域连接、订阅与服务交付的当前状态。"
                  : tab === "nodes"
                    ? "AI 使用 JP / SG / US；Telegram 使用 HK / TW。"
                    : tab === "usage"
                      ? "按用户查看本服务期用量，按区域查看引擎报告的节点计数。"
                      : "管理你的订阅业务，每一次操作都有记录。"}
              </p>
            </div>
            <button
              className="az-light az-refresh"
              disabled={busy || loading}
              onClick={() =>
                perform(async () => {
                  if (tab === "nodes" || tab === "overview")
                    await api("/admin/nodes/refresh", {});
                  setNotice("已刷新检测结果");
                })
              }
            >
              {busy ? "处理中…" : "↻ 刷新" + (tab === "nodes" ? "并重连" : "")}
            </button>
          </div>
          {error && (
            <div role="alert" className="az-alert error">
              {error}
              <button onClick={() => load(true)}>重试</button>
            </div>
          )}
          {notice && (
            <div role="status" className="az-alert success">
              {notice}
              <button aria-label="关闭提示" onClick={() => setNotice("")}>
                ×
              </button>
            </div>
          )}
          <div className="az-timestamp">
            {loading
              ? "正在读取数据…"
              : `数据更新于 ${date(overview?.asOf)} · 每 10 秒刷新`}
          </div>
          {(tab === "overview" || tab === "usage") && (
            <div className="az-stats">
              <article>
                <span>控制就绪节点</span>
                <strong>
                  {overview?.nodes.ready ?? "—"}
                  <small>/ {overview?.nodes.total ?? 5}</small>
                </strong>
                <p>基于控制连接 · 非端到端测速</p>
              </article>
              <article>
                <span>注册用户</span>
                <strong>{overview?.users ?? "—"}</strong>
                <p>订阅用户，不含管理员</p>
              </article>
              <article>
                <span>已开通订阅</span>
                <strong>{active}</strong>
                <p>
                  {overview?.subscriptions.reduce((n, s) => n + s._count, 0) ??
                    0}{" "}
                  份订阅记录
                </p>
              </article>
              <article>
                <span>本服务期用量合计</span>
                <strong className="az-stat-bytes">
                  {bytes(overview?.usage.usedBytes ?? 0)}
                </strong>
                <p>最近采集 {date(overview?.usage.lastUsageAt)}</p>
              </article>
            </div>
          )}
          {tab === "nodes" && <MachineProvisioner />}
          {(tab === "overview" || tab === "nodes") && (
            <>
              {nodes.some((n) => !n.ready) && (
                <div className="az-alert warning">
                  <div>
                    <strong>
                      {nodes.filter((n) => !n.ready).length} 台节点需要关注
                    </strong>
                    <p>
                      “控制未就绪”不等于 Azure
                      虚拟机关机。先检查控制隧道及引擎连接；超过 2
                      分钟的检测会标为过期。
                    </p>
                  </div>
                </div>
              )}
              <section className="az-section">
                <div className="az-section-head">
                  <h2>
                    区域网络{" "}
                    <span>
                      {new Set(nodes.map((n) => n.region)).size} REGIONS ·{" "}
                      {nodes.length} NODES
                    </span>
                  </h2>
                  {tab === "overview" && (
                    <button className="az-link" onClick={() => choose("nodes")}>
                      管理节点 ↗
                    </button>
                  )}
                </div>
                <div className="az-regions">
                  {nodes.map((n) => (
                    <article
                      key={n.id}
                      className={n.ready ? "online" : "offline"}
                    >
                      <div className="az-region-top">
                        <b>{n.country}</b>
                        <span
                          className={"az-dot " + (n.ready ? "on" : "off")}
                        />
                      </div>
                      <h3>{regionName(n.country)}</h3>
                      <p>{n.region}</p>
                      <Badge value={n.state} />
                      <div className="az-region-footer">
                        {["JP", "SG", "US"].includes(n.country)
                          ? "AI 路由"
                          : ["HK", "TW"].includes(n.country)
                            ? "Telegram 路由"
                            : "通用路由"}
                        <small>{n.address}</small>
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            </>
          )}
          {tab === "overview" && (
            <div className="az-overview-bottom">
              <section className="az-section">
                <div className="az-section-head">
                  <h2>订单与交付</h2>
                  <button className="az-link" onClick={() => choose("orders")}>
                    查看订单 ↗
                  </button>
                </div>
                <div className="az-receipts">
                  <span>测试收款累计</span>
                  <strong>
                    {Object.entries(overview?.receipts ?? {})
                      .filter(([k]) => k.startsWith("stripe:"))
                      .map(([k, n]) => money(n, k.split(":")[1]))
                      .join(" / ") || money(0)}
                  </strong>
                  <p>
                    Stripe Sandbox 金额，不是实际营业收入。按已付服务期统计。
                  </p>
                </div>
                <div className="az-mini-stats">
                  <div>
                    <strong>
                      {overview?.orders.find((o) => o.status === "paid")
                        ?._count ?? 0}
                    </strong>
                    <span>已付订单</span>
                  </div>
                  <div>
                    <strong>
                      {overview?.orders.find((o) => o.status === "pending")
                        ?._count ?? 0}
                    </strong>
                    <span>待支付</span>
                  </div>
                  <div>
                    <strong>{overview?.pendingEvents ?? 0}</strong>
                    <span>待处理支付事件</span>
                  </div>
                </div>
              </section>
              <section className="az-section">
                <div className="az-section-head">
                  <h2>最近操作</h2>
                  <button className="az-link" onClick={() => choose("audit")}>
                    全部记录 ↗
                  </button>
                </div>
                <div className="az-activity">
                  {overview?.audit.length ? (
                    overview.audit.slice(0, 5).map((a) => (
                      <div key={a.id}>
                        <span className="az-activity-dot" />
                        <div>
                          <strong>{auditTitle(a.action)}</strong>
                          <small>{a.targetId}</small>
                        </div>
                        <time>{date(a.createdAt)}</time>
                      </div>
                    ))
                  ) : (
                    <div className="az-empty">
                      还没有管理操作，操作后会在这里留存记录。
                    </div>
                  )}
                </div>
              </section>
            </div>
          )}
          {tab === "nodes" && (
            <section className="az-section">
              <div className="az-section-head">
                <h2>连接与维护</h2>
                <small>
                  停用会阻止该节点继续提供服务，不会释放 Azure 资源。
                </small>
              </div>
              <Table
                headers={["节点 / 公网地址", "控制状态", "最近检测", "操作"]}
                empty={!nodes.length}
              >
                {nodes.map((n) => (
                  <tr key={n.id}>
                    <td>
                      <strong>{n.name}</strong>
                      <small>
                        {n.address}:{n.port}
                      </small>
                      <small>
                        {n.xrayVersion ? `Xray ${n.xrayVersion}` : "版本未获取"}
                      </small>
                    </td>
                    <td>
                      <Badge value={n.state} />
                      <small>
                        SSH 隧道：
                        {n.transportConnected === null
                          ? "未知"
                          : n.transportConnected
                            ? "已连接"
                            : "断开"}{" "}
                        · 引擎：{n.engineConnected ? "已连接" : "未连接"}
                      </small>
                      <small>最后就绪：{date(n.lastHealthyAt)}</small>
                      {n.ipRotation && (
                        <small>
                          IP 轮换：
                          {n.ipRotation.status === "failed" ? "暂停 · " : ""}
                          {n.ipRotation.phaseLabel}
                        </small>
                      )}
                    </td>
                    <td>
                      {date(n.checkedAt)}
                      <small>
                        {n.enabled ? "期望状态：启用" : "期望状态：停用"}
                      </small>
                    </td>
                    <td>
                      <div className="az-row-actions">
                        <button
                          disabled={
                            busy ||
                            !n.publishedAt ||
                            (!n.activeIpRotationId && (n.busy || !n.enabled))
                          }
                          onClick={() => setRotating(n)}
                        >
                          {n.activeIpRotationId ? "查看 IP 轮换" : "轮换 IP"}
                        </button>
                        {[
                          n.enabled ? "disable" : "enable",
                          "reconnect",
                          "restart",
                        ].map((action) => (
                          <button
                            key={action}
                            disabled={busy || n.busy || !n.publishedAt}
                            onClick={() =>
                              setConfirm({
                                kind: "nodes",
                                id: n.id,
                                name: n.name,
                                action,
                              })
                            }
                          >
                            {actionLabel[action]}
                          </button>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </Table>
            </section>
          )}
          {tab === "plans" && (
            <section className="az-section">
              <div className="az-section-head">
                <h2>可售套餐</h2>
                <button disabled={busy} onClick={() => setEditing("new")}>
                  ＋ 新建套餐
                </button>
              </div>
              <p className="az-section-note">
                修改只影响新订单。既有订单和 Stripe
                续费合约保留原价格、流量及区域。
              </p>
              <Table
                headers={["套餐", "月费", "流量 / 区域", "状态", "操作"]}
                empty={!plans.length}
              >
                {plans.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <strong>{p.name}</strong>
                      <small>
                        {p.id} · {p._count.orders} 笔订单
                      </small>
                    </td>
                    <td>{money(p.amountMinor, p.currency)}</td>
                    <td>
                      {bytes(p.quotaBytes)}
                      <small>
                        {p.globalPool
                          ? "全局节点池 · 自动包含新增区域"
                          : p.regions.join(" / ")}
                      </small>
                    </td>
                    <td>
                      <Badge value={p.active ? "on-sale" : "off-sale"} />
                    </td>
                    <td>
                      <button
                        className="az-light"
                        onClick={() => setEditing(p)}
                      >
                        编辑套餐
                      </button>
                    </td>
                  </tr>
                ))}
              </Table>
            </section>
          )}
          {tab === "usage" && (
            <section className="az-section">
              <div className="az-section-head">
                <h2>区域节点计数</h2>
                <small>节点计数可能含 P0 测试流量；与用户用量不可相加。</small>
              </div>
              <div className="az-node-usage">
                {nodes.map((n) => (
                  <div key={n.id}>
                    <span>
                      {n.country} · {regionName(n.country)}
                    </span>
                    <strong>
                      {n.usageUpdatedAt ? bytes(n.usageBytes) : "未采集"}
                    </strong>
                    <small>{date(n.usageUpdatedAt)}</small>
                  </div>
                ))}
              </div>
              <p className="az-section-note">
                显示引擎当前累计计数；尚未建立按日历史账本，也不代表 Azure
                计费流量。
              </p>
            </section>
          )}
          {["users", "orders", "subscriptions", "usage", "audit"].includes(
            tab,
          ) && (
            <section className="az-section">
              <div className="az-section-head">
                <h2>
                  {tab === "usage" ? "用户服务期用量" : "记录列表"}{" "}
                  <span>{list.total} 条</span>
                </h2>
                {tab !== "audit" && (
                  <form
                    className="az-search"
                    onSubmit={(e) => {
                      e.preventDefault();
                      setPage(1);
                      setSearch(query);
                    }}
                  >
                    <input
                      aria-label="按邮箱或记录 ID 搜索"
                      placeholder={
                        tab === "users" ? "搜索用户邮箱" : "搜索邮箱或记录 ID"
                      }
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                    <button type="submit" className="az-light">
                      搜索
                    </button>
                  </form>
                )}
              </div>
              {tab === "users" && (
                <Table
                  headers={["用户", "身份", "订阅", "订单", "注册时间"]}
                  empty={!list.items.length}
                >
                  {(list.items as User[]).map((u) => (
                    <tr key={u.id}>
                      <td>
                        <strong>{u.email}</strong>
                        <small>{u.id}</small>
                      </td>
                      <td>
                        <Badge value={u.role} />
                      </td>
                      <td>
                        {u.subscription ? (
                          <>
                            <Badge value={u.subscription.status} />
                            <button
                              className="az-link"
                              onClick={() => {
                                choose("subscriptions");
                                setQuery(u.email);
                                setSearch(u.email);
                              }}
                            >
                              管理订阅 ↗
                            </button>
                          </>
                        ) : (
                          <small>尚未购买</small>
                        )}
                      </td>
                      <td>{u._count.orders}</td>
                      <td>{date(u.createdAt)}</td>
                    </tr>
                  ))}
                </Table>
              )}
              {tab === "orders" && (
                <Table
                  headers={[
                    "订单 / 用户",
                    "套餐 / 金额",
                    "状态",
                    "服务期",
                    "创建时间",
                  ]}
                  empty={!list.items.length}
                >
                  {(list.items as Order[]).map((o) => (
                    <tr key={o.id}>
                      <td>
                        <strong>{o.user.email}</strong>
                        <small>{o.id}</small>
                      </td>
                      <td>
                        {o.plan.name}
                        <small>
                          {money(o.amountMinor, o.currency)} ·{" "}
                          {o.provider === "stripe" ? "Stripe 测试" : "模拟支付"}
                        </small>
                      </td>
                      <td>
                        <Badge value={o.status} />
                      </td>
                      <td>
                        {o.periods.length
                          ? o.periods.map((p, i) => (
                              <small key={i}>
                                {date(p.startAt)}
                                <br />至 {date(p.endAt)}
                              </small>
                            ))
                          : "尚未开通"}
                      </td>
                      <td>{date(o.createdAt)}</td>
                    </tr>
                  ))}
                </Table>
              )}
              {(tab === "subscriptions" || tab === "usage") && (
                <Table
                  headers={[
                    "用户 / 订阅",
                    "状态",
                    "服务期用量",
                    "到期 / 采集时间",
                    ...(tab === "subscriptions" ? ["操作"] : []),
                  ]}
                  empty={!list.items.length}
                >
                  {(list.items as Sub[]).map((s) => (
                    <tr key={s.id}>
                      <td>
                        <strong>{s.user.email}</strong>
                        <small>{s.id}</small>
                        <small>{s.regions.join(" / ")}</small>
                      </td>
                      <td>
                        <Badge value={s.status} />
                        {s.desiredVersion !== s.appliedVersion && (
                          <small className="az-pending">
                            等待同步 v{s.appliedVersion} → v{s.desiredVersion}
                          </small>
                        )}
                        {s.lastError && (
                          <small className="az-failure">
                            {reasonLabel[s.lastError] ?? s.lastError}
                          </small>
                        )}
                      </td>
                      <td>
                        <Meter sub={s} />
                      </td>
                      <td>
                        {date(s.validUntil)}
                        <small>采集：{date(s.lastUsageAt)}</small>
                      </td>
                      {tab === "subscriptions" && <td>{subActions(s)}</td>}
                    </tr>
                  ))}
                </Table>
              )}
              {tab === "audit" && (
                <Table
                  headers={["操作", "管理员", "对象 / 原因", "时间"]}
                  empty={!list.items.length}
                >
                  {(list.items as Audit[]).map((a) => (
                    <tr key={a.id}>
                      <td>{auditTitle(a.action)}</td>
                      <td>{a.actor}</td>
                      <td>
                        {a.targetId}
                        {a.detail?.reason && <small>{a.detail.reason}</small>}
                      </td>
                      <td>{date(a.createdAt)}</td>
                    </tr>
                  ))}
                </Table>
              )}
              <div className="az-pagination">
                <span>
                  共 {list.total} 条 · 第 {page} /{" "}
                  {Math.max(1, Math.ceil(list.total / 20))} 页
                </span>
                <div>
                  <button
                    className="az-light"
                    disabled={page <= 1 || loading}
                    onClick={() => setPage((p) => p - 1)}
                  >
                    上一页
                  </button>
                  <button
                    className="az-light"
                    disabled={page * 20 >= list.total || loading}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    下一页
                  </button>
                </div>
              </div>
            </section>
          )}
          <footer className="az-footer">
            <span>xRay-zoo · Operator Console</span>
            <span>本地 P0 / P1 · 测试支付 · 真实 Azure 节点</span>
          </footer>
        </main>
      </div>
      {confirm && (
        <Dialog
          title={actionLabel[confirm.action]}
          onClose={() => !busy && setConfirm(null)}
        >
          <form onSubmit={submitAction}>
            <p>
              操作对象：<strong>{confirm.name}</strong>
            </p>
            <p>
              {confirm.action === "disable"
                ? "将停止该区域节点服务，并从新订阅配置中移除。现有连接可能中断；Azure 资源仍继续计费。"
                : confirm.action === "restart"
                  ? "将重启该节点的代理服务，当前连接可能短暂中断。"
                  : confirm.action === "rotate-link"
                    ? "旧链接立即失效，新链接由用户在账户页获取。已下载的 YAML 仍可使用；如需停止访问，请暂停订阅。"
                    : confirm.action === "suspend"
                      ? "暂停后立即停止提供订阅下载，并向节点同步撤销授权。此操作不会取消 Stripe 自动续费。"
                      : confirm.action === "resume"
                        ? "仅恢复仍在已付服务期内的订阅，保留原到期时间和已用流量。"
                        : confirm.action === "reconnect"
                          ? "尝试重建本机到此节点的 SSH 控制隧道，完成后重新检测连接。"
                          : "提交操作并等待引擎同步，最终结果以检测状态为准。"}
            </p>
            {confirm.kind === "subscriptions" && (
              <label>
                操作原因
                <input
                  name="reason"
                  required
                  minLength={2}
                  maxLength={240}
                  placeholder="例如：用户申请暂停服务"
                  autoFocus
                />
              </label>
            )}
            {error && (
              <p className="az-failure" role="alert">
                {error}
              </p>
            )}
            <div className="az-dialog-actions">
              <button
                type="button"
                className="az-light"
                disabled={busy}
                onClick={() => setConfirm(null)}
              >
                取消
              </button>
              <button disabled={busy}>
                {busy ? "处理中…" : "确认" + actionLabel[confirm.action]}
              </button>
            </div>
          </form>
        </Dialog>
      )}
      {rotating && (
        <IpRotationDialog
          node={rotating}
          onClose={() => {
            setRotating(null);
            load();
          }}
        />
      )}
      {editing && (
        <Dialog
          title={editing === "new" ? "新建套餐" : "编辑套餐"}
          onClose={() => !busy && setEditing(null)}
        >
          <form onSubmit={savePlan}>
            <label>
              套餐 ID
              <input
                name="id"
                required
                pattern="[a-z0-9][a-z0-9-]{1,48}"
                defaultValue={editing === "new" ? "" : editing.id}
                readOnly={editing !== "new"}
                placeholder="例如 standard-100gb"
              />
            </label>
            <label>
              套餐名称
              <input
                name="name"
                required
                minLength={2}
                maxLength={80}
                defaultValue={editing === "new" ? "" : editing.name}
              />
            </label>
            <div className="az-form-grid">
              <label>
                月费（USD）
                <input
                  name="price"
                  type="number"
                  min="0.5"
                  max="100000"
                  step="0.01"
                  required
                  defaultValue={
                    editing === "new" ? "9.99" : editing.amountMinor / 100
                  }
                />
              </label>
              <label>
                每服务期流量（GB）
                <input
                  name="quota"
                  type="number"
                  min="1"
                  max="100000"
                  step="1"
                  required
                  defaultValue={
                    editing === "new"
                      ? 20
                      : Number(editing.quotaBytes) / 1000 ** 3
                  }
                />
              </label>
            </div>
            <fieldset>
              <legend>可用区域（至少一个）</legend>
              <div className="az-checks">
                {Array.from(
                  new Set([
                    ...Object.keys(countries),
                    ...nodes.map((n) => n.country),
                    ...(editing === "new" ? [] : editing.regions),
                  ]),
                ).map((code) => (
                  <label key={code}>
                    <input
                      type="checkbox"
                      name="regions"
                      value={code}
                      defaultChecked={
                        editing === "new" || editing.regions.includes(code)
                      }
                    />
                    {code}
                  </label>
                ))}
              </div>
            </fieldset>
            <label className="az-checkbox">
              <input
                type="checkbox"
                name="globalPool"
                defaultChecked={editing === "new" || editing.globalPool}
              />
              自动加入全局节点池（包含以后上线的区域）
            </label>
            <label className="az-checkbox">
              <input
                type="checkbox"
                name="active"
                defaultChecked={editing === "new" || editing.active}
              />{" "}
              上架，对新用户开放购买
            </label>
            {error && (
              <p className="az-failure" role="alert">
                {error}
              </p>
            )}
            <div className="az-dialog-actions">
              <button
                type="button"
                className="az-light"
                disabled={busy}
                onClick={() => setEditing(null)}
              >
                取消
              </button>
              <button disabled={busy}>{busy ? "保存中…" : "保存套餐"}</button>
            </div>
          </form>
        </Dialog>
      )}
    </div>
  );
}
