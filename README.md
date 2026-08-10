# AirSonde Admin — `admin.airsonde.com`

AirSonde 产品后台。**没有数据库**：产品数据的真源是 `zq8345/AirSonde-Web` 仓的
`src/content/products/*.json`（契约 C1）。本 worker 是那些文件的编辑器，不是它们的宿主。

```
admin.airsonde.com  =  Cloudflare Workers + Hono
        ↓ Cloudflare Access 门控
        ↓ GitHub API 读写
AirSonde-Web : src/content/products/*.json
        ↓ commit 触发
CF Pages 重建 airsonde.com
```

当前进度：**M1 —— 只读打通。没有任何写入能力。** 写入 / 编辑界面是 M2，单独派单。

---

## 常用命令

```bash
npm run dev
```

```bash
npm run typecheck
```

```bash
npm run deploy
```

🔴 **CI 接上之后，不要再手动 `npm run deploy`。** 见下面「自动部署」一节。

🔴 **不要直接 `wrangler dev` / `wrangler deploy`**，两条都会坏事：

- `wrangler dev` 会拿 `wrangler.jsonc` 里 `routes` 的第一条 custom_domain 去**合成请求 host**，
  于是本机也被当成 `admin.airsonde.com`，开发旁路的 host 检查判定"生产上出现了后门"→ 500 停服。
  `scripts/dev.mjs` 从 `wrangler.jsonc` **派生**一份去掉 routes 的本地配置（不是手抄第二份，手抄会漂）。
- `wrangler deploy` 不会注入 `GIT_SHA`，`/api/_whoami` 就认不出自己是哪个 commit。
  `scripts/deploy.mjs` 在部署那一刻从 git 现算并 `--var` 注入。

---

## 自动部署（Workers Builds）

push 到 `main` → Cloudflare 自动构建并部署。**用 Workers Builds，不是 Pages。**

⛔ **绝不要为这个仓建 Cloudflare Pages 项目。** 两个理由：
1. 这是 Workers 结构（`wrangler.jsonc` + `src/index.ts`），**没有构建输出目录**，Pages 的构建流程对不上；
2. `admin.airsonde.com` 的 DNS 记录类型是 **Worker → `airsonde-admin`**。若再有一个 Pages 项目来绑同一个自定义域，
   会和现有 Worker 路由打架，**可能把正在工作的后台顶掉** —— 那是现在唯一能进后台的路。

### 🔴 Deploy command 必须改成 `npm run deploy`

Workers Builds 的 **Deploy command 默认是 `npx wrangler deploy`**。用默认值这个后台会坏在一个不显眼的地方：

`GIT_SHA` / `GIT_DIRTY` / `DEPLOY_SOURCE` / `BUILD_TIME` 是 `scripts/deploy.mjs` 用 `--var` 在部署那一刻注入的，
而 **CLI `--var` 注入的变量不会在下一次部署里保留**（实测见下表）。
⇒ 默认命令一跑，这四个变量当场消失，`/api/_whoami` 的 `git.sha` 变成 `null` ——
**「能证明边缘现在跑的是哪一份代码」这个能力就没了**，而且没有任何报错，界面一切正常。

### CI 里 `GIT_SHA` 从哪来

`.git` 在构建容器里不保证存在，所以 `scripts/deploy.mjs` 优先取平台注入的 `WORKERS_CI_COMMIT_SHA`。

⭐ **两个来源都拿得到时，必须相等，不等就停止部署。** 不等意味着"平台说在构建 commit A，而工作目录里是 commit B"——
那时无论注入哪个都是在说谎，而说谎的恰恰是我们用来证明版本的那个字段。

### 手动部署与 CI 冲突

CI 接上之后手动 `npm run deploy`，两条路会互相覆盖，**谁也说不清生产上跑的是哪一版**。

⚠️ 脚本**不硬拦**：硬拦会挡住真正的紧急发布，而被挡住的人会去找绕过的办法。
约束改成看得见的事实 —— 手动部署会注入 `DEPLOY_SOURCE=local`，它出现在 `/api/_whoami` 里。
**CI 接上后仍看到 `deploySource: "local"`，就是有人绕过了自动部署。** 下一次 CI 构建会把它覆盖回 `ci`。

### 实测：一次部署会保留什么、抹掉什么

⚠️ 下表**不是查文档得来的**，是在一个一次性 worker 上真跑出来的（无路由、`workers_dev:false`，零爆炸半径）。

| 来源 | 重新部署（不重新传）后 | 含义 |
|---|---|---|
| `wrangler secret put/bulk` 的 secret | **保留** ✅ | `GITHUB_TOKEN` 不会被 CI 部署重置，配一次即可 |
| `wrangler.jsonc` 里的 `vars` | **保留** ✅ | `ALLOWED_EMAILS` 安全（它本来就随每次部署带上） |
| CLI `--var` 注入的变量 | **🔴 被抹掉** | 正是上面那条：deploy command 必须走 `npm run deploy` |

顺带实测：`wrangler secret bulk` **不会**抹掉已有的 plain vars（两者共存）。

## 端点（M1）

| 端点 | 作用 |
|---|---|
| `GET /api/_whoami` | 进程身份：部署版本、commit hash、运行环境 |
| `GET /api/products` | 列出数据仓 `src/content/products/` 下的产品 JSON |
| `GET /` | 一句话说明（界面在 M2） |

### `/api/_whoami` 为什么是必需的，不是"健康检查"

任何联调的第一步是**证明你在跟谁说话**。僵尸进程占端口、curl 全打到老进程、部署了但边缘还在
服务旧版本 —— 这些故障的症状和代码 bug 一模一样，不先证身份就会跑去改代码。

三个来源，越往上越伪造不了：

- `deploy.versionId` —— Cloudflare `version_metadata` 绑定写入，代码碰不到
- `git.sha` —— 部署那一刻从 git 现算注入；**源码里没有它的值**
- `request.colo / host` —— 请求自带的事实

⚠️ `GIT_SHA` 缺失时返回 `null` + `warnings`，**绝不回一个看起来像样的占位串** ——
那样这个端点就从证据退化成装饰。

### `/api/products` 的两种"空"

`dirExists:false` = 目录还不存在（Web 窗尚未建出），`dirExists:true && count:0` = 目录存在但没有产品。
两件事必须分得出来。**只有 GitHub 明确 404 才返回空**；401/403/429/5xx 一律 502 抛出 ——
把"我没读到"伪装成"那里没东西"是最难发现的一类错（读侧全绿，实则一条都没读到）。

---

## 鉴权：两道门，不是重复

| | 谁负责 | 挡什么 |
|---|---|---|
| ① Cloudflare Access（边缘） | Zero Trust 策略 | 谁能走到门口 |
| ② 本 worker 的 `ALLOWED_EMAILS` | `wrangler.jsonc` vars | 谁能进后台 |

②挡的是①**不在**的那些情况：误开 workers.dev、Access 应用被误删、将来多一条不经 Access 的路由。
没有它，上述任何一种发生时后台就是裸奔的，而且没有人会收到通知。

### 🔴 两张名单必须**同源**，不是"够用就行"

> **worker 的 `ALLOWED_EMAILS` 必须逐字等于 Access 策略的 Include Emails。**
> 改任一边都要同时改另一边；
> **校验方法 ＝ 把两处的邮箱列表排序后逐字比对，不比"我记得是一样的"。**

⚠️ 判据是**集合相等**，不是"包含"：只查"三个都在不在"的话，多写一个邮箱进去也会绿 ——
而多出来的那个是一把没人知道的钥匙。两个方向都要查：**缺项**和**多项**。

⚠️ 比对的左边取**生产上真正生效的值**，不是本仓 `wrangler.jsonc` 里的字面量
（读法见下面自检 ②）—— 两者可能不一致，而"改了但没推上去"和"改错了"表现完全一样。

这次的根因不是谁写错了，是**两处名单之间没有强制同源关系，靠人记住**。所以上面写成判据，
不写成叮嘱：症状是"Access 放行了却仍被拒" —— 那不是 bug，是这份名单没跟着改。

⚠️ **出事时不要只加那一个人。** 2026-08-09 M1 首发就栽在这上面：这里只有 `zq8345@gmail.com`，
而 Access 策略里是三个，Joe 用 `joe@wanew.com` 登录 → Access 放行、worker 拒绝 →
**他被自己的后台挡在门外**。当时的修法是把三个**补齐**，不是把他这次用的那个加进来 ——
只加一个的话，他下次换个邮箱登录还会被挡，这个病治不好。
（wanew-admin 同一个病犯过两次，这是第三次。）

⚠️ **空 `ALLOWED_EMAILS` = 拒绝全部**，不是"不限制"。但它是**部署错**不是"你没权限"，
所以回 500 不回 403 —— 混成一个码，排查的人会去查用户权限，而问题在配置。

⚠️ **没有 Basic Auth 兜底 = 故意的。** M2 之后这个 worker 会持有能写数据仓的 token，兜底口就是后门。

### 改完 Access 名单后的自检

**① 边缘那道门还在不在**（反向判据：**能匿名打开就是不合格**）：

```bash
curl -sS -o /dev/null -w "%{http_code} %{redirect_url}\n" https://admin.airsonde.com/
```

期望 `302`，且 redirect 指向 `wanewgroup.cloudflareaccess.com`。

⚠️ **不要用 Cloudflare API 的 `GET /access/apps` 去确认门在不在。** 令牌权限不足时它会返回
`success:true` **加一个空列表** —— 那是**假零**，和"真的没有应用"长得一模一样。
判别式只认上面这条匿名 curl（302 + `Www-Authenticate: Cloudflare-Access` + `Location` 指向团队域 + `CF_AppSession` cookie）。

**② worker 那道门的名单对不对**（读**生产上真正生效的值**，不是读 `wrangler.jsonc` 的字面量）：

```bash
npx wrangler deployments list
```

生效版本的 vars 可用 CF API `GET /accounts/{account_id}/workers/scripts/airsonde-admin/settings` 读出
`ALLOWED_EMAILS` 的实际字节。⚠️ **空值和"名单里没这个人"表现完全一样**，所以要看到值本身，不能只看行为。

**③ 症状分诊** —— 登录后拿到的 body 就是判别式，三句话在 `src/index.ts` 里各只出现一次：

| 看到 | 含义 |
|---|---|
| JSON | 两道门都通 |
| `此账号不在本后台的允许名单内。` | Access 放行了，`ALLOWED_EMAILS` 没这个邮箱 |
| `此后台需通过 Cloudflare Access 登录（airsonde-admin 应用）。` | 会话建立了但身份头没透到 worker，是 Access 应用配置问题，不是名单问题 |

⚠️ 匿名请求**根本到不了 worker**（边缘 302 拦掉），所以它不产生任何 worker 日志 ——
别拿"日志里没东西"当作 worker 没运行/坏了的证据。

---

## 出站

`src/github.ts` 是**全仓唯一调用 `fetch()` 的地方**。别在各端点里各自 fetch ——
那样每加一道防护都要在 N 处重复，第 N+1 处一定会漏。

🔴 本地开发下**任何非 GET 的 GitHub 请求直接被拒**：本地没有 Access 门挡着，
而目标是**生产数据仓**，误点一下就是真提交。

---

## 机密

- `GITHUB_TOKEN` 用 `wrangler secret put`，**绝不进 git、绝不写进 `wrangler.jsonc`**
- M1 **不需要** token：`zq8345/AirSonde-Web` 是公开仓，列目录匿名可读（配额 60/h）
- M2 写入才需要 fine-grained PAT：Repository access 仅 `zq8345/AirSonde-Web`，Contents Read+write
- 本地要看真数据可在 `.dev.vars`（已 gitignore）写 `GITHUB_TOKEN=...`；
  ⚠️ 用一个**不勾任何权限**的 PAT 就够了 —— 读公开仓不需要权限，而不给写权限 = 本地误点也提交不到生产

---

## 常见误判

| 症状 | 真实原因 |
|---|---|
| 门后出现 "Failed to fetch" | 不是代码 bug，是边缘 302 到登录页 = 会话过期。硬刷新解封；`curl` 看 `Location` 才是石锤 |
| 本地起来就 500，说"出现后门" | 直接跑了 `wrangler dev`，host 被 routes 合成了。用 `npm run dev` |
| Access 明明放行了却仍被拒 | `ALLOWED_EMAILS` 没跟着 Access 策略加人 |
| `/api/products` 一直是空的 | 先看 `dirExists`：`false` = Web 窗还没建那个目录（正常，那个目录归它） |
