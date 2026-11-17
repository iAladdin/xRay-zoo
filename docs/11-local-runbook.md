# 运行与恢复

所有命令从仓库根目录执行。需要 Node 22+、pnpm 10、Docker、Azure CLI / Bicep、Python 3；Stripe 测试需要 Stripe CLI。当前本机使用 Node 26。

## 本地初始化

```sh
pnpm install --frozen-lockfile
python3 scripts/local-env.py
docker compose --env-file .local/stack.env -f infra/local/compose.yaml up -d postgres redis engine-db engine-redis engine
pnpm db:generate
pnpm db:migrate
python3 scripts/engine-p0.py init
```

`.local/stack.env` 和 `app.env` 自动生成并设为 0600。首次登录引擎会生成仅保存在 `.local/engine-auth.json` 的管理员密码及 30 天 API token。密钥不打印、不进 Git。升级或恢复应保留数据库卷与 `ENCRYPTION_KEY`，否则已有订阅凭证无法解密。

## 五区域 Azure P0

只用项目自己的 CLI 登录目录：

```sh
AZURE_CONFIG_DIR="$PWD/.local/azure" az login --tenant <tenant-id> --use-device-code
python3 scripts/azure-p0.py plan --subscription <subscription-id> --management-cidr <你的管理出口IPv4>/32
# 审阅 .local/azure-plan.json 的区域、SKU、配额、模板摘要与成本假设
python3 scripts/azure-p0.py deploy
python3 scripts/azure-p0.py status
python3 scripts/azure-p0.py install --node-image remnawave/node@sha256:3d5fde656a36920f53c5c080f2dc821df8318f453803b07c4e5242752a549d69
python3 scripts/engine-p0.py configure
```

`deploy` 校验计划有效期、模板摘要与资源组标签。重复使用稳定资源名；不会为了失败而自动删掉已成功区域。ARM 请求接受不等于部署结束，必须检查 status 和后续探测。Compute / Network provider 需先注册；当前 AAL-Dev 已完成注册。

节点私钥不放进 cloud-init、ARM outputs 或仓库。SSH 私钥和主机指纹在 `.local/`。首次主机指纹采用 accept-new；重新建机造成指纹改变时需要人工核对，脚本不会关闭主机验证。

## 本机控制隧道

在 OrbStack 中，当前 `host.docker.internal` 解析为 `0.250.250.254`，已写入私有 `stack.env` 的 `P0_HOST_GATEWAY`。其他 Docker 环境可使用默认 host-gateway 或实际主机地址，先验证容器能访问主机回环转发端口。

```sh
python3 scripts/control-tunnels.py start
python3 scripts/control-tunnels.py status
python3 scripts/engine-p0.py export
pnpm db:seed
```

脚本为每区建立独立 SSH 转发 `22221..22225 → VM localhost:2222`，并更新引擎的控制地址。客户端配置始终使用 VM 的公网 IP:443。SSH 断线后重跑 start；这只是本机 P0 运输方案，生产控制面不应依赖笔记本。

## 启动网页闭环

```sh
python3 scripts/local-runtime.py start
python3 scripts/local-runtime.py status
```

网页 `http://localhost:3100`；API `http://localhost:3101`；Remnawave `http://127.0.0.1:3300`。端口绑定本机，业务程序要求 `APP_ENV=local`。浏览器使用 localhost 访问，以匹配 Origin 和 Cookie。

默认 `PAYMENT_PROVIDER=dev` 是明显标注的模拟支付，用于没有 Stripe 凭证时调试。正式测试 Stripe 时，在 `.local/stripe.env` 填入测试密钥：

```dotenv
STRIPE_SECRET_KEY=sk_test_REPLACE_LOCALLY
STRIPE_WEBHOOK_SECRET=
```

```sh
python3 scripts/stripe-listen.py
# 将 .local/app.env 中 PAYMENT_PROVIDER 改为 stripe
python3 scripts/local-runtime.py stop
python3 scripts/local-runtime.py start
```

listener 从 Stripe 获取本地专用 signing secret 并转发 invoice.paid 到 `/webhooks/stripe`。它与 Dashboard 中现有 webhook 的 signing secret 不通用；不要修改其他项目的 webhook。密钥仅支持 Sandbox，Live key 会被拒绝。托管 Checkout 不需要前端 Publishable key。重复运行 listener 前先停止 `.local/stripe-listener.pid` 指向的本项目监听进程，避免重复监听。

用户注册后选择测试套餐，使用 [Stripe 官方测试卡](https://docs.stripe.com/testing) 完成付款；返回页面等待自动开通，复制链接或下载 YAML。当前无密码找回流程，测试账号请自行保存密码。

## 导出与验证

```sh
python3 scripts/engine-p0.py customer
pnpm subscription:render .local/nodes.json .local/p0-access.json /绝对路径/xRay-zoo-tc-split.yaml
pnpm test
pnpm exec tsc --noEmit
pnpm build:web
pnpm test:integration
```

`customer` 创建单独的 20 GB / 30 天 P0 访问身份。不要把导出 YAML 上传公共仓库，它包含用户访问凭证。需要 Mihomo / Clash Meta；旧 Clash 不支持该配置。规则集初次加载需要连接 GitHub，后续缓存并定时更新。

`scripts/probe-nodes.ts` 为五台节点创建隔离客户端和临时本地端口，不修改系统代理。设置 `MIHOMO_BINARY` 指定客户端路径；默认是本机 mClash 核心。若现有系统代理干扰协议检测，可先建立临时 SSH SOCKS：

```sh
ssh -f -N -M -S .local/probe-transport.sock -D 127.0.0.1:19789 -i .local/node_ssh -o UserKnownHostsFile=.local/known_hosts xrayzoo@<JP节点IP>
PROBE_SOCKS_PORT=19789 pnpm exec tsx scripts/probe-nodes.ts
PROBE_SOCKS_PORT=19789 pnpm exec tsx scripts/test-cached-access.ts
ssh -S .local/probe-transport.sock -O exit xrayzoo@<JP节点IP>
```

第二项测试需要先运行 test:integration 创建仍有效的临时服务期。测试最终停用自己的测试身份；已有长连接的回收不是当前测试范围。

## 关闭与费用

```sh
python3 scripts/local-runtime.py stop
python3 scripts/control-tunnels.py stop
docker compose --env-file .local/stack.env -f infra/local/compose.yaml stop
```

这只停止本地服务，**Azure VM 仍会继续计费**。暂停云计算需要逐台 `az vm deallocate`；公网 IP 和磁盘仍收费。当前没有自动删资源命令，删除专用资源组前必须明确接受节点及磁盘数据丢失，并检查组内是否新增了其他资源。仓库没有把停止本地服务伪装成云资源关闭。

恢复时启动 Docker 依赖、隧道、Stripe listener 和 local-runtime。不要使用 `docker compose down -v`，它会清空本地支付账本与引擎数据库。
