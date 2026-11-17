"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import "./account.css";
const API = "http://localhost:3101";
type Subscription = {
  status: string;
  planName: string;
  validUntil: string | null;
  quotaBytes: string;
  usedBytes: string;
  regions: string[];
  globalPool: boolean;
  lastUsageAt: string | null;
  revokedAt: string | null;
  pending: boolean;
  version: number;
  syncFailed: boolean;
  canRegenerate: boolean;
  url: string | null;
};
type Account = {
  user: { id: string; email: string; role: string };
  paymentProvider: string;
  asOf: string;
  subscription: Subscription | null;
  nodes: {
    name: string;
    country: string;
    region: string;
    ready: boolean;
    checkedAt: string | null;
  }[];
  orders: {
    id: string;
    planId: string;
    status: string;
    createdAt: string;
    amountMinor: number;
    currency: string;
    provider: string;
    plan: { name: string };
    periods: { startAt: string; endAt: string }[];
  }[];
};
type Plan = {
  id: string;
  name: string;
  amountMinor: number;
  currency: string;
  quotaBytes: string;
  regions: string[];
  globalPool: boolean;
};
type Billing = {
  subscriptions: {
    status: string;
    cancelAtPeriodEnd: boolean;
    endsAt: string | null;
  }[];
  checkedAt: string;
};
class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
async function request(path: string, body?: unknown) {
  const r = await fetch(API + path, {
    credentials: "include",
    cache: "no-store",
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    throw new ApiError(r.status, data.error ?? "暂时无法连接，请重试");
  }
  return r;
}
async function json(path: string, body?: unknown) {
  return (await request(path, body)).json();
}
function date(v: string | null | undefined, short = false) {
  return v
    ? new Date(v).toLocaleString(
        "zh-CN",
        short
          ? { year: "numeric", month: "2-digit", day: "2-digit" }
          : { hour12: false },
      )
    : "—";
}
function gb(v: string | number) {
  return (Number(v) / 1e9).toLocaleString("zh-CN", {
    maximumFractionDigits: 2,
  });
}
function money(v: number, c: string) {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: c,
  }).format(v / 100);
}
const regions: Record<string, string> = {
  JP: "日本",
  SG: "新加坡",
  US: "美国",
  HK: "香港",
  TW: "台湾",
};
const labels: Record<string, string> = {
  active: "使用中",
  pending: "等待开通",
  suspended: "管理员已暂停",
  revoked: "访问已撤销",
  regenerating: "正在生成新配置",
  expired: "已到期",
  exhausted: "流量已用完",
  paid: "已付款",
};
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
    <dialog
      ref={ref}
      className="uc-dialog"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <h2>{title}</h2>
      {children}
    </dialog>
  );
}
export default function AccountPage() {
  const router = useRouter();
  const [account, setAccount] = useState<Account | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [billing, setBilling] = useState<Billing | null>(null);
  const [billingError, setBillingError] = useState(false);
  const [section, setSection] = useState<"subscription" | "plans" | "guide">(
    "subscription",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [modal, setModal] = useState<"revoke" | "regenerate" | "cancel" | null>(
    null,
  );
  const [devCheckout, setDevCheckout] = useState("");
  const sequence = useRef(0),
    mutating = useRef(false);
  function fail(e: unknown) {
    if (e instanceof ApiError && e.status === 401) {
      router.replace("/?login=1#account");
      return;
    }
    setError(e instanceof Error ? e.message : "请求失败，请重试");
  }
  async function load() {
    const n = ++sequence.current;
    try {
      const data = await json("/account");
      if (n !== sequence.current) return;
      setAccount(data);
      setError("");
    } catch (e) {
      if (n === sequence.current) fail(e);
    }
  }
  async function loadBilling() {
    try {
      const data = await json("/account/billing");
      setBilling(data);
      setBillingError(false);
    } catch {
      setBillingError(true);
    }
  }
  useEffect(() => {
    load();
    loadBilling();
    json("/plans")
      .then((v) => setPlans(v.plans))
      .catch(fail);
    const params = new URLSearchParams(window.location.search);
    setDevCheckout(params.get("devCheckout") ?? "");
    if (params.get("checkout") === "returned")
      setNotice("已返回用户中心，支付结果确认后会自动开通。");
    if (params.get("checkout") === "cancelled")
      setNotice("已离开支付页面，可在套餐与订单中继续支付。");
    const timer = setInterval(() => {
      if (!mutating.current) load();
    }, 5000);
    const bt = setInterval(() => {
      if (!mutating.current) loadBilling();
    }, 60000);
    return () => {
      sequence.current++;
      clearInterval(timer);
      clearInterval(bt);
    };
  }, []);
  async function perform(work: () => Promise<void>) {
    mutating.current = true;
    sequence.current++;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
      await load();
    } catch (e) {
      fail(e);
    } finally {
      mutating.current = false;
      setBusy(false);
    }
  }
  function closeModal() {
    if (!mutating.current) {
      setModal(null);
      setError("");
    }
  }
  async function confirm() {
    if (!modal || !account?.subscription) return;
    const action = modal;
    await perform(async () => {
      if (action === "cancel") {
        await json("/billing/cancel-renewal", {});
        await loadBilling();
        setNotice("已取消自动续费，当前已付服务期和访问权限保留。");
      } else {
        await json("/account/subscription/" + action, {
          expectedVersion: account.subscription!.version,
        });
        setNotice(
          action === "revoke"
            ? "旧订阅链接已失效，正在向节点同步撤销访问。"
            : "正在生成新的访问凭证，完成后请重新导入配置。",
        );
      }
      setModal(null);
    });
  }
  async function getYaml() {
    return (await request("/account/config")).text();
  }
  function download() {
    perform(async () => {
      const yaml = await getYaml();
      const url = URL.createObjectURL(
        new Blob([yaml], { type: "text/yaml;charset=utf-8" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = "xray-zoo.yaml";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice("已发起 YAML 配置下载。");
    });
  }
  function copyYaml() {
    perform(async () => {
      const yaml = await getYaml();
      await navigator.clipboard.writeText(yaml);
      setNotice("YAML 配置内容已复制，请仅粘贴到你自己的客户端。");
    });
  }
  function buy(planId: string) {
    perform(async () => {
      const r = await json("/checkout", {
        planId,
        idempotencyKey: crypto.randomUUID(),
      });
      window.location.href = r.url;
    });
  }
  if (!account)
    return (
      <main className="uc-loading">
        <h1>用户中心</h1>
        <p>{error || "正在读取你的订阅…"}</p>
        {error && <button onClick={load}>重新加载</button>}
      </main>
    );
  const sub = account.subscription;
  const liveBilling =
    billing?.subscriptions.filter(
      (s) => !["canceled", "incomplete_expired"].includes(s.status),
    ) ?? [];
  const renewalOn = liveBilling.some((s) => !s.cancelAtPeriodEnd);
  const hasPeriod = !!sub?.validUntil && new Date(sub.validUntil) > new Date();
  const remaining = sub
    ? Math.max(0, Number(sub.quotaBytes) - Number(sub.usedBytes))
    : 0;
  const usageRatio =
    sub && Number(sub.quotaBytes) > 0
      ? Math.min(100, (100 * Number(sub.usedBytes)) / Number(sub.quotaBytes))
      : 0;
  const readyNodes = account.nodes.filter((n) => n.ready).length;
  const accessRevoked = !!sub?.revokedAt && sub.status !== "regenerating";
  const status = sub
    ? sub.status === "regenerating"
      ? "正在生成新配置"
      : sub.pending && sub.revokedAt
        ? "正在撤销访问"
        : sub.pending
          ? "正在同步"
          : (labels[sub.status] ?? sub.status)
    : "尚未购买";
  return (
    <div className="uc-shell">
      <div className="uc-wrap">
        <header className="uc-header">
          <Link href="/account" className="brand">
            <span className="brandmark">x</span>xRay-zoo
          </Link>
          <div className="uc-header-right">
            {account.user.role === "ADMIN" && (
              <Link href="/admin" className="uc-admin-link">
                管理员后台 ↗
              </Link>
            )}
            <span className="uc-avatar">
              {account.user.email[0].toUpperCase()}
            </span>
            <span className="uc-email">{account.user.email}</span>
            <button
              className="uc-quiet"
              disabled={busy}
              onClick={() =>
                perform(async () => {
                  await json("/auth/logout", {});
                  router.replace("/?login=1#account");
                })
              }
            >
              退出
            </button>
          </div>
        </header>
        <main className="uc-main">
          <div className="uc-title">
            <div>
              <div className="uc-kicker">YOUR CONNECTION SPACE</div>
              <h1>用户中心</h1>
              <p>你的套餐、配置与连接，都在这里。</p>
            </div>
            <span className="uc-environment">
              {account.paymentProvider === "stripe"
                ? "Stripe Sandbox · 测试支付"
                : "本地验证 · 模拟支付"}
            </span>
          </div>
          <nav className="uc-tabs" aria-label="用户中心导航">
            {(
              [
                ["subscription", "我的订阅"],
                ["plans", "套餐与订单"],
                ["guide", "使用指南"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                aria-current={section === key ? "page" : undefined}
                className={section === key ? "selected" : ""}
                onClick={() => {
                  setSection(key);
                  setNotice("");
                }}
              >
                {label}
              </button>
            ))}
          </nav>
          {error && (
            <div className="uc-message error" role="alert">
              {error}
              <button onClick={load}>刷新</button>
            </div>
          )}
          {notice && (
            <div className="uc-message" role="status">
              {notice}
              <button aria-label="关闭提示" onClick={() => setNotice("")}>
                ×
              </button>
            </div>
          )}
          {section === "subscription" && (
            <>
              <div className="uc-stats">
                <article>
                  <span>订阅状态</span>
                  <strong className="uc-status">{status}</strong>
                  <small>{sub?.planName ?? "选择一个适合你的套餐"}</small>
                </article>
                <article>
                  <span>剩余流量</span>
                  <strong>
                    {sub ? gb(remaining) : "—"}
                    <em>{sub ? "GB" : ""}</em>
                  </strong>
                  <small>
                    {sub
                      ? `本服务期共 ${gb(sub.quotaBytes)} GB`
                      : "付款后自动开通"}
                  </small>
                </article>
                <article>
                  <span>服务到期</span>
                  <strong className="uc-date">
                    {date(sub?.validUntil, true)}
                  </strong>
                  <small>
                    {hasPeriod ? "已付服务期仍然有效" : "到期后可购买新的套餐"}
                  </small>
                </article>
                <article>
                  <span>可用区域</span>
                  <strong>
                    {sub ? readyNodes : "—"}
                    <em>{sub ? `/ ${account.nodes.length}` : ""}</em>
                  </strong>
                  <small>基于最新节点控制状态</small>
                </article>
              </div>
              {sub?.pending && (
                <div className="uc-state-note" role="status">
                  <span className="uc-spinner" />{" "}
                  {sub.status === "regenerating"
                    ? "正在更新访问凭证，请稍后下载新配置。"
                    : sub.revokedAt
                      ? "旧链接已失效，正在向节点同步停用旧配置。"
                      : "正在同步订阅，请稍候。"}
                  {sub.syncFailed ? " 当前同步遇到问题，系统会自动重试。" : ""}{" "}
                  离线节点会在恢复连接后接收变更。
                </div>
              )}
              <div className="uc-grid">
                <section className="uc-card uc-plan-card">
                  <div className="uc-card-head">
                    <h2>当前套餐</h2>
                    <span
                      className={
                        "uc-badge " +
                        (sub?.status === "active" && !sub.pending ? "good" : "")
                      }
                    >
                      {status}
                    </span>
                  </div>
                  {sub ? (
                    <>
                      <h3 className="uc-plan-name">{sub.planName}</h3>
                      <div className="uc-usage-number">
                        {gb(sub.usedBytes)}
                        <small>/ {gb(sub.quotaBytes)} GB 已使用</small>
                      </div>
                      <div
                        className="uc-meter"
                        role="meter"
                        aria-label="服务期流量使用比例"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(usageRatio)}
                      >
                        <i style={{ width: usageRatio + "%" }} />
                      </div>
                      <div className="uc-usage-caption">
                        <span>剩余 {gb(remaining)} GB</span>
                        <span>最近采集 {date(sub.lastUsageAt)}</span>
                      </div>
                      <div className="uc-plan-details">
                        <div>
                          <span>有效期至</span>
                          <strong>{date(sub.validUntil)}</strong>
                        </div>
                        <div>
                          <span>已含区域</span>
                          <strong>
                            {sub.globalPool
                              ? "全局节点池 · 自动扩充"
                              : sub.regions.join(" / ")}
                          </strong>
                        </div>
                        <div>
                          <span>自动续费</span>
                          <strong>
                            {billingError
                              ? "暂时无法读取"
                              : !billing
                                ? "读取中…"
                                : !liveBilling.length
                                  ? "无自动续费"
                                  : renewalOn
                                    ? "已开启"
                                    : "已取消，到期不再续费"}
                          </strong>
                        </div>
                      </div>
                      {billingError && (
                        <button
                          className="uc-text-button"
                          onClick={loadBilling}
                        >
                          重新读取账单状态
                        </button>
                      )}
                      {!billingError && renewalOn && (
                        <button
                          className="uc-text-button"
                          disabled={busy}
                          onClick={() => setModal("cancel")}
                        >
                          取消自动续费
                        </button>
                      )}
                    </>
                  ) : (
                    <div className="uc-empty">
                      <div className="uc-empty-symbol">↗</div>
                      <h3>还没有订阅</h3>
                      <p>选好套餐并完成付款，就能获得专属链接和配置。</p>
                      <button onClick={() => setSection("plans")}>
                        查看可选套餐
                      </button>
                    </div>
                  )}
                </section>
                <section className="uc-card uc-access-card">
                  <div className="uc-card-head">
                    <h2>连接你的设备</h2>
                    <span className="uc-format">CLASH / MIHOMO</span>
                  </div>
                  {sub?.url ? (
                    <>
                      <p>推荐导入订阅链接，客户端可自动获取配置更新。</p>
                      <label>
                        专属订阅链接
                        <input
                          type="password"
                          value={sub.url}
                          readOnly
                          aria-label="专属订阅链接"
                          autoComplete="off"
                        />
                      </label>
                      <button
                        className="uc-primary"
                        disabled={busy}
                        onClick={() =>
                          perform(async () => {
                            const fresh: Account = await json("/account");
                            if (!fresh.subscription?.url)
                              throw new Error(
                                "当前订阅链接不可用，请刷新后重试",
                              );
                            await navigator.clipboard.writeText(
                              fresh.subscription.url,
                            );
                            setNotice("订阅链接已复制。");
                          })
                        }
                      >
                        复制订阅链接 <span>↗</span>
                      </button>
                      <div className="uc-config-buttons">
                        <button
                          disabled={busy}
                          className="uc-secondary"
                          onClick={download}
                        >
                          ↓ 下载 YAML 配置
                        </button>
                        <button
                          disabled={busy}
                          className="uc-secondary"
                          onClick={copyYaml}
                        >
                          ▤ 复制 YAML 内容
                        </button>
                      </div>
                      <small className="uc-private-note">
                        链接和配置均包含访问凭证，请仅在自己的设备使用。
                      </small>
                    </>
                  ) : (
                    <div className="uc-access-empty">
                      <span className="uc-lock">⌁</span>
                      <h3>
                        {sub?.status === "regenerating"
                          ? "正在生成新配置"
                          : sub?.status === "suspended"
                            ? "订阅已被管理员暂停"
                            : sub?.revokedAt
                              ? "当前访问已撤销"
                              : sub?.pending
                                ? "正在准备你的配置"
                                : sub
                                  ? "当前订阅不可用"
                                  : "购买后即可获取配置"}
                      </h3>
                      <p>
                        {sub?.status === "regenerating"
                          ? "新的访问凭证正在同步到节点，完成后即可下载。"
                          : sub?.status === "suspended"
                            ? "请联系管理员处理，用户中心无法解除管理员的暂停。"
                            : sub?.revokedAt
                              ? "旧链接不能再下载配置。重新生成后，请把新的链接或 YAML 导入客户端。"
                              : sub?.pending
                                ? "支付确认和节点同步完成后，这里会显示专属订阅链接。"
                                : "有效的订阅开通后，可以在这里复制链接、下载或复制 YAML。"}
                      </p>
                      {sub?.canRegenerate && (
                        <button
                          disabled={busy}
                          className="uc-primary"
                          onClick={() => setModal("regenerate")}
                        >
                          生成新配置并启用 ↗
                        </button>
                      )}
                      {sub?.revokedAt && !hasPeriod && (
                        <button
                          className="uc-secondary"
                          onClick={() => setSection("plans")}
                        >
                          查看套餐
                        </button>
                      )}
                    </div>
                  )}
                </section>
              </div>
              {sub && (
                <section className="uc-card uc-network">
                  <div className="uc-card-head">
                    <h2>你的区域网络</h2>
                    <span>AI → JP / SG / US · Telegram → HK / TW</span>
                  </div>
                  <div className="uc-region-grid">
                    {account.nodes.map((n) => (
                      <article key={n.name}>
                        <div>
                          <b>{n.country}</b>
                          <i className={n.ready ? "on" : ""} />
                        </div>
                        <h3>
                          {regions[n.country] ??
                            new Intl.DisplayNames(["zh-CN"], {
                              type: "region",
                            }).of(n.country)}
                        </h3>
                        <span>{n.region}</span>
                        <small>
                          {n.ready ? "节点控制就绪" : "节点暂未就绪"}
                        </small>
                      </article>
                    ))}
                  </div>
                  <p>
                    节点状态不代表账户访问权限；已撤销、暂停或到期的订阅不能使用节点。
                  </p>
                </section>
              )}
              {sub && (
                <section className="uc-security">
                  <div>
                    <h2>撤销当前订阅访问</h2>
                    <p>
                      旧链接立即失效，旧配置随节点同步停用。保留套餐、剩余流量与到期时间；之后可重新生成配置。
                    </p>
                    <small>
                      撤销访问不会取消自动续费。需要停止续费时，请使用“取消自动续费”。
                    </small>
                  </div>
                  <button
                    className="uc-danger"
                    disabled={busy || accessRevoked}
                    onClick={() => setModal("revoke")}
                  >
                    {accessRevoked ? "访问已撤销" : "撤销访问（Revoke）"}
                  </button>
                </section>
              )}
            </>
          )}
          {section === "plans" && (
            <>
              <div className="uc-section-heading">
                <h2>选择你的套餐</h2>
                <p>
                  {hasPeriod
                    ? "当前已付服务期内无需重复购买。撤销访问后可在“我的订阅”重新生成配置。"
                    : "付款确认后自动开通，当前页面每 5 秒更新。"}
                </p>
              </div>
              <div className="uc-sale-plans">
                {plans.map((p) => (
                  <article className="uc-card" key={p.id}>
                    <span className="uc-kicker">GLOBAL CONNECTION</span>
                    <h3>{p.name}</h3>
                    <strong className="uc-price">
                      {money(p.amountMinor, p.currency)}
                      <small>
                        /{" "}
                        {account.paymentProvider === "stripe" ? "月" : "30 天"}
                      </small>
                    </strong>
                    <ul>
                      <li>{gb(p.quotaBytes)} GB 共享流量</li>
                      <li>
                        {p.globalPool
                          ? "全局节点池 · 自动包含新增区域"
                          : p.regions.map((r) => regions[r] ?? r).join(" · ")}
                      </li>
                      <li>Clash / Mihomo 订阅与 YAML 配置</li>
                    </ul>
                    <button
                      disabled={busy || hasPeriod}
                      onClick={() => buy(p.id)}
                    >
                      {hasPeriod
                        ? "当前已有有效套餐"
                        : account.paymentProvider === "stripe"
                          ? "前往 Stripe 测试支付 ↗"
                          : "开始模拟支付"}
                    </button>
                  </article>
                ))}
              </div>
              <section className="uc-card uc-orders">
                <div className="uc-card-head">
                  <h2>我的订单</h2>
                  <span>
                    最近 20 笔 ·{" "}
                    {account.paymentProvider === "stripe"
                      ? "测试支付，不产生真实扣款"
                      : "模拟支付"}
                  </span>
                </div>
                <div className="uc-table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>套餐 / 订单</th>
                        <th>金额</th>
                        <th>状态</th>
                        <th>创建时间</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {account.orders.length ? (
                        account.orders.map((o) => (
                          <tr key={o.id}>
                            <td>
                              <strong>{o.plan.name}</strong>
                              <small>{o.id}</small>
                            </td>
                            <td>
                              {money(o.amountMinor, o.currency)}
                              <small>
                                {o.provider === "stripe"
                                  ? "Stripe 测试"
                                  : "模拟支付"}
                              </small>
                            </td>
                            <td>
                              <span className="uc-badge">
                                {o.status === "pending"
                                  ? "待支付"
                                  : (labels[o.status] ?? o.status)}
                              </span>
                            </td>
                            <td>{date(o.createdAt)}</td>
                            <td>
                              {o.status === "pending" ? (
                                <button
                                  className="uc-text-button"
                                  disabled={busy}
                                  onClick={() => buy(o.planId)}
                                >
                                  继续支付 ↗
                                </button>
                              ) : (
                                "—"
                              )}
                            </td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan={5} className="uc-table-empty">
                            还没有订单，购买套餐后会显示在这里。
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          )}
          {section === "guide" && (
            <section className="uc-card uc-guide">
              <span className="uc-kicker">GET CONNECTED</span>
              <h2>三步开始使用</h2>
              <ol>
                <li>
                  <b>01</b>
                  <div>
                    <h3>获取订阅链接或 YAML</h3>
                    <p>
                      在“我的订阅”复制链接，或下载配置文件。复制 YAML
                      内容适用于支持从剪贴板导入的客户端。
                    </p>
                  </div>
                </li>
                <li>
                  <b>02</b>
                  <div>
                    <h3>导入 Clash Meta / Mihomo 客户端</h3>
                    <p>
                      选择从 URL 导入或从文件导入，保存后启用该配置。旧版 Clash
                      可能不支持 VLESS / REALITY。
                    </p>
                  </div>
                </li>
                <li>
                  <b>03</b>
                  <div>
                    <h3>按应用选择区域</h3>
                    <p>
                      AI 服务仅使用日本、新加坡、美国；Telegram
                      仅使用香港、台湾。对应区域不可用时，该分组会停止连接。
                    </p>
                  </div>
                </li>
              </ol>
              <div className="uc-guide-note">
                <h3>什么时候需要重新导入？</h3>
                <p>
                  撤销访问并重新生成配置后，旧链接和旧 YAML
                  不再有效，请重新导入。撤销与恢复不会重置已用流量，也不会延长服务期。
                </p>
              </div>
              <button onClick={() => setSection("subscription")}>
                回到我的订阅 ↗
              </button>
            </section>
          )}
          <footer className="uc-footer">
            <span>xRay-zoo · 你的连接空间</span>
            <span>数据更新于 {date(account.asOf)}</span>
          </footer>
        </main>
      </div>
      {modal && (
        <Dialog
          title={
            modal === "revoke"
              ? "撤销当前订阅访问？"
              : modal === "regenerate"
                ? "生成新的访问凭证？"
                : "取消自动续费？"
          }
          onClose={closeModal}
        >
          <p>
            {modal === "revoke"
              ? "旧订阅链接立即失效，所有已导入的旧配置会随节点同步停用。已付套餐、剩余流量和到期时间保留，你可以之后重新生成配置。"
              : modal === "regenerate"
                ? "将生成新的订阅链接与访问凭证并重新启用服务。请在所有设备重新导入；旧配置不会重新生效。原流量额度和到期时间保持不变。"
                : "当前已付服务期保留，到期后不再自动扣款。此操作不会立即停止当前节点访问。"}
          </p>
          {modal === "revoke" && (
            <div className="uc-dialog-note">
              本操作不会取消自动续费。离线节点会在恢复连接后接收撤销指令。
            </div>
          )}
          {error && (
            <p className="uc-inline-error" role="alert">
              {error}
            </p>
          )}
          <div className="uc-dialog-actions">
            <button
              className="uc-secondary"
              disabled={busy}
              onClick={closeModal}
            >
              取消
            </button>
            <button
              className={modal === "revoke" ? "uc-danger" : ""}
              disabled={busy}
              onClick={confirm}
            >
              {busy
                ? "处理中…"
                : modal === "revoke"
                  ? "确认撤销访问"
                  : modal === "regenerate"
                    ? "生成并启用"
                    : "确认取消续费"}
            </button>
          </div>
        </Dialog>
      )}
      {devCheckout && account.paymentProvider === "dev" && (
        <Dialog title="确认模拟支付" onClose={() => setDevCheckout("")}>
          <p>仅发送本地测试支付事件，不产生扣款。</p>
          <div className="uc-dialog-actions">
            <button
              className="uc-secondary"
              disabled={busy}
              onClick={() => setDevCheckout("")}
            >
              取消
            </button>
            <button
              disabled={busy}
              onClick={() =>
                perform(async () => {
                  await json("/dev/pay/" + devCheckout, {});
                  setDevCheckout("");
                  window.history.replaceState({}, "", "/account");
                  setNotice("模拟支付已收到，正在自动开通。");
                })
              }
            >
              确认模拟支付
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
