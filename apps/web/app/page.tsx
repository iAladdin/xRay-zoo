"use client";
import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
const API = "http://localhost:3101";
type Account = {
  user: { email: string; role: string };
  subscription: null | {
    status: string;
    validUntil: string;
    quotaBytes: string;
    usedBytes: string;
    regions: string[];
    pending: boolean;
    url: string | null;
  };
};
type Plan = {
  id: string;
  name: string;
  amountMinor: number;
  currency: string;
  quotaBytes: string;
  regions: string[];
};
async function call(path: string, body?: unknown) {
  const response = await fetch(API + path, {
    credentials: "include",
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "暂时无法连接");
  return result;
}
const regions = [
  { code: "JP", name: "日本", city: "Japan East", category: "AI" },
  { code: "SG", name: "新加坡", city: "Southeast Asia", category: "AI" },
  { code: "US", name: "美国", city: "East US 2", category: "AI" },
  { code: "HK", name: "香港", city: "East Asia", category: "Telegram" },
  { code: "TW", name: "台湾", city: "Taiwan North", category: "Telegram" },
];
export default function Home() {
  const router = useRouter();
  const [account, setAccount] = useState<Account | null>(null),
    [plans, setPlans] = useState<Plan[]>([]),
    [provider, setProvider] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [login, setLogin] = useState(false),
    [checkoutId, setCheckoutId] = useState("");
  async function refresh() {
    try {
      const result = await call("/me");
      if (result.user.role === "ADMIN") {
        router.replace("/admin");
        return;
      }
      router.replace("/account" + window.location.search);
      setAccount(result);
    } catch {
      setAccount(null);
    }
  }
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has("login"))
      setLogin(true);
    call("/plans")
      .then((v) => {
        setPlans(v.plans);
        setProvider(v.provider);
      })
      .catch(() => setMessage("服务正在启动，请稍后刷新"));
    refresh();
    setCheckoutId(
      new URLSearchParams(window.location.search).get("devCheckout") ?? "",
    );
    const interval = setInterval(refresh, 4000);
    return () => clearInterval(interval);
  }, []);
  async function perform(fn: () => Promise<void>) {
    setBusy(true);
    setMessage("");
    try {
      await fn();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }
  function auth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    perform(async () => {
      await call(login ? "/auth/login" : "/auth/register", {
        email: data.get("email"),
        password: data.get("password"),
      });
      await refresh();
    });
  }
  const sub = account?.subscription;
  const labels: Record<string, string> = {
    pending: "等待开通",
    active: "已开通",
    expired: "已到期",
    suspended: "已暂停",
    exhausted: "流量已用完",
  };
  return (
    <main>
      <header>
        <a href="/" className="brand">
          <span className="brandmark">x</span>xRay-zoo
        </a>
        <nav>
          <a href="#regions">区域网络</a>
          <a href="#plans">套餐</a>
          {account && (
            <button
              className="plain"
              onClick={() =>
                perform(async () => {
                  await call("/auth/logout", {});
                  setAccount(null);
                })
              }
            >
              退出
            </button>
          )}
        </nav>
      </header>
      <div className="notice">
        {provider === "stripe"
          ? "Stripe Sandbox · 测试支付，不产生真实扣款"
          : "本地技术验证 · 模拟支付，不产生真实扣款"}
      </div>
      <section className="hero">
        <div>
          <div className="eyebrow">YOUR CONNECTION, EVERYWHERE</div>
          <h1>
            一个订阅。
            <br />
            <span>连接你的世界。</span>
          </h1>
          <p>
            五个区域，按应用选择合适的出口。
            <br />
            付款后自动开通，导入 Clash 即可使用。
          </p>
          <a className="button" href={account ? "#plans" : "#account"}>
            {account ? "查看套餐" : "创建账户"} <span>↗</span>
          </a>
          <div className="hero-meta">
            VLESS / REALITY <span>·</span> Clash / Mihomo
          </div>
        </div>
        <div className="network-art" aria-label="五区域分流示意图">
          <div className="orbit orbit-a" />
          <div className="orbit orbit-b" />
          <div className="globe">
            <span>zoo</span>
            <small>GLOBAL NETWORK</small>
          </div>
          <div className="point jp">
            JP <b>日本</b>
          </div>
          <div className="point sg">
            SG <b>新加坡</b>
          </div>
          <div className="point us">
            US <b>美国</b>
          </div>
          <div className="point hk">
            HK <b>香港</b>
          </div>
          <div className="point tw">
            TW <b>台湾</b>
          </div>
          <div className="art-caption">
            AI → JP / SG / US
            <br />
            Telegram → HK / TW
          </div>
        </div>
      </section>
      <section id="regions">
        <div className="section-title">
          <div>
            <div className="eyebrow">REGIONAL ROUTING</div>
            <h2>为常用应用，安排好路线。</h2>
          </div>
          <p>沿用 tc split 分流规则</p>
        </div>
        <div className="regions">
          {regions.map((r) => (
            <article key={r.code}>
              <span className="region-code">{r.code}</span>
              <h3>{r.name}</h3>
              <p>{r.city}</p>
              <span
                className={"tag " + (r.category === "AI" ? "mint" : "blue")}
              >
                {r.category}
              </span>
            </article>
          ))}
        </div>
      </section>
      <section className="account-grid" id="account">
        <div>
          <div className="eyebrow">GET CONNECTED</div>
          <h2>{account ? "你的连接空间" : "从这里开始"}</h2>
          <p>
            {account ? account.user.email : "注册、选择套餐，等待自动开通。"}
          </p>
          <ol>
            <li>
              <b>01</b> 创建你的账户
            </li>
            <li>
              <b>02</b> 选择套餐并支付
            </li>
            <li>
              <b>03</b> 导入专属订阅链接
            </li>
          </ol>
        </div>
        <div className="panel">
          {!account ? (
            <>
              <div className="panel-heading">
                <h3>{login ? "欢迎回来" : "创建账户"}</h3>
                <button className="plain" onClick={() => setLogin(!login)}>
                  {login ? "去注册" : "已有账户，登录"}
                </button>
              </div>
              <form onSubmit={auth}>
                <label>
                  邮箱
                  <input
                    name="email"
                    type="email"
                    placeholder="you@example.com"
                    autoComplete="email"
                    required
                  />
                </label>
                <label>
                  密码
                  <input
                    name="password"
                    type="password"
                    minLength={12}
                    maxLength={128}
                    placeholder="至少 12 位"
                    autoComplete={login ? "current-password" : "new-password"}
                    required
                  />
                </label>
                <button disabled={busy}>
                  {busy ? "处理中…" : login ? "登录" : "创建账户"}
                </button>
              </form>
            </>
          ) : (
            <>
              <div className="panel-heading">
                <h3>我的订阅</h3>
                <span className="tag mint">
                  {sub
                    ? sub.pending
                      ? "正在同步"
                      : (labels[sub.status] ?? sub.status)
                    : "尚未购买"}
                </span>
              </div>
              {sub ? (
                <>
                  <div className="usage">
                    <strong>
                      {(Number(sub.usedBytes) / 1e9).toFixed(2)}{" "}
                      <small>/ {Number(sub.quotaBytes) / 1e9} GB</small>
                    </strong>
                    <p>
                      到期时间：
                      {sub.validUntil
                        ? new Date(sub.validUntil).toLocaleString("zh-CN")
                        : "等待开通"}
                    </p>
                  </div>
                  <div className="meter">
                    <span
                      style={{
                        width:
                          Math.min(
                            100,
                            (Number(sub.usedBytes) / Number(sub.quotaBytes)) *
                              100,
                          ) + "%",
                      }}
                    />
                  </div>
                  {sub.url ? (
                    <>
                      <label>
                        Clash 订阅链接
                        <input
                          type="password"
                          readOnly
                          value={sub.url}
                          aria-label="Clash 订阅链接"
                        />
                      </label>
                      <div className="actions">
                        <button
                          onClick={() =>
                            perform(async () => {
                              await navigator.clipboard.writeText(sub.url!);
                              setMessage("订阅链接已复制");
                            })
                          }
                        >
                          复制链接
                        </button>
                        <a className="secondary" href={sub.url}>
                          下载 YAML
                        </a>
                      </div>
                      <small>
                        链接包含访问凭证，请仅在你自己的客户端使用。
                      </small>
                    </>
                  ) : (
                    <p>付款确认后会自动开通，此页面每 4 秒更新。</p>
                  )}
                  {provider === "stripe" && (
                    <button
                      className="plain cancel"
                      onClick={() =>
                        perform(async () => {
                          await call("/billing/cancel-renewal", {});
                          setMessage("已取消续费，当前已付服务期保留。");
                        })
                      }
                    >
                      取消到期续费
                    </button>
                  )}
                </>
              ) : (
                <p>选择下方套餐，付款后会在这里显示订阅链接。</p>
              )}
            </>
          )}
        </div>
      </section>
      <section id="plans">
        <div className="section-title">
          <div>
            <div className="eyebrow">SIMPLE PLAN</div>
            <h2>五个区域，按需选择流量。</h2>
          </div>
          <p>50 / 150 / 300 GB · 每月共享流量</p>
        </div>
        <div className="plan-grid">
          {plans.map((plan) => (
            <article className="plan" key={plan.id}>
              <span className="tag mint">五区域共享流量</span>
              <h3>{plan.name}</h3>
              <div className="price">
                ${(plan.amountMinor / 100).toFixed(2)}
                <small>USD / {provider === "stripe" ? "月" : "30 天"}</small>
              </div>
              <ul>
                <li>{Number(plan.quotaBytes) / 1e9} GB 全球共享流量</li>
                <li>JP / SG / US / HK / TW</li>
                <li>AI 和 Telegram 专属分流组</li>
                <li>自动开通 · Clash 订阅</li>
              </ul>
              <button
                disabled={
                  busy || !!(sub && ["active", "pending"].includes(sub.status))
                }
                onClick={() => {
                  if (!account) {
                    document
                      .getElementById("account")
                      ?.scrollIntoView({ behavior: "smooth" });
                    return;
                  }
                  perform(async () => {
                    const checkout = await call("/checkout", {
                      planId: plan.id,
                      idempotencyKey: crypto.randomUUID(),
                    });
                    window.location.href = checkout.url;
                  });
                }}
              >
                {!account
                  ? "注册后购买"
                  : sub?.status === "active"
                    ? "当前套餐"
                    : provider === "stripe"
                      ? "前往 Stripe 测试支付 ↗"
                      : "开始模拟支付 →"}
              </button>
            </article>
          ))}
          <aside>
            <h3>按应用分流，自动选择出口。</h3>
            <p>
              AI 服务仅在日本、新加坡、美国之间选择；Telegram
              仅在香港、台湾之间选择。
            </p>
            <p>对应区域不可用时暂停该组连接，避免切换到其他区域。</p>
            <span className="line" />
            <p>
              支持 Clash Meta / Mihomo。使用客户端导入链接后，即可获得配置更新。
            </p>
          </aside>
        </div>
      </section>
      {checkoutId && account && provider === "dev" && (
        <div className="modal-backdrop">
          <section role="dialog" aria-label="模拟支付" className="modal">
            <span className="tag">仅本地验证</span>
            <h2>模拟支付确认</h2>
            <p>此操作只发送本地测试支付事件，不会扣款。</p>
            <div className="actions">
              <button
                disabled={busy}
                onClick={() =>
                  perform(async () => {
                    await call("/dev/pay/" + checkoutId, {});
                    setCheckoutId("");
                    window.history.replaceState({}, "", "/");
                    setMessage("测试事件已收到，正在自动开通…");
                    await refresh();
                  })
                }
              >
                确认模拟支付
              </button>
              <button className="plain" onClick={() => setCheckoutId("")}>
                取消
              </button>
            </div>
          </section>
        </div>
      )}
      {message && (
        <div className="toast" role="status">
          {message}
          <button onClick={() => setMessage("")} aria-label="关闭提示">
            ×
          </button>
        </div>
      )}
      <footer>
        <a className="brand" href="/">
          xRay-zoo
        </a>
        <span>本地技术验证 · 五区域网络</span>
        <span>Build your own connection.</span>
      </footer>
    </main>
  );
}
