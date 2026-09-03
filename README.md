# AirSonde Admin — `admin.airsonde.com`

AirSonde 产品与站点内容后台。**没有数据库**：真源是 `zq8345/AirSonde-Web` 仓里的文件。
本 worker 是那些文件的编辑器，不是它们的宿主。

```
admin.airsonde.com  =  Cloudflare Workers + Hono
        ↓ Cloudflare Access 门控
        ↓ GitHub API 读写
AirSonde-Web : src/content/products/*.json   ← 产品（契约 C1，一个产品一个文件）
               src/data/site-content.json    ← 站点内容（联系方式 / 首页文案 / 站级 SEO）
        ↓ commit 触发
CF Pages 重建 airsonde.com
```

## 🔴 写入范围 —— 就这两处，没有别的

后台在官网仓**能写的全部**是上面那两行。其余任何文件（页面、模板、样式、图片、配置、
**任何 `.ts`**）都不写。

**为什么站点内容是一份 JSON，而不是让后台去改 `src/data/site.ts`：**
重写 TS 的出错方式是产出一个**语法合法但语义变了**的文件 —— 契约闸看不出来，
tsc 也可能看不出来，而它会直接上线。所以官网把可编辑的**值**抽进了
`site-content.json`，`site.ts` 只负责读它；后台只写 JSON。

**有意不接进后台的东西**（改错了会静默坏掉，不是"文案难看"）：

| 东西 | 不接的理由 |
|---|---|
| `NAV` / CTA 的 `href` | 改错 = 指向 404 |
| `CONTACT_FORM.inquiryOptions` | 必须与 `functions/api/contact.ts` 的白名单一致；只改一边 = 表单被后端拒，**而页面上看不出任何异常** |
| section `id`、各种 label / 字段名 | 那是结构，不是内容 |
| `HOME_SECTIONS` 的两个 heading、整个 `CAPABILITIES` | **实测在产出页里 0 处**（死导出）。接上去 = 让人改一段改了不会变的字，比没有那个输入框更糟 |

⚠️ 站上的 `mailto:` / `wa.me` / `tel:` / Google 地图链接**都是派生的**，不单独存。
存两份的下场是号码改了而某个 href 没改 —— 页面上毫无症状，直到有人点了它。

当前进度：产品 CRUD、批量、图片、媒体库、审计日志、分类、设置、站点内容**全部上线**。
`/api/_whoami` 的 `milestone` 字段由**写入闸与 token 的实际状态**算出来，不写死阶段名 ——
一个诊断端点里的假话是最坏的一种，因为出事时第一个被引用的就是它。

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

### ⚠️ 保存配置**不会**触发首次构建

在控制台把 Builds 配好并保存之后，**不会自动跑第一次构建**。实测：Joe 保存后部署列表没有任何新增，
push 一个空提交，**8 秒后**才出现新部署。

⇒ 配好之后盯着 Builds 列表发呆是白等的，**push 一次**即可。
⭐ 触发用**空提交**（`git commit --allow-empty`）最干净：不改任何文件 ⇒
构建成功与否**只能归因于管线本身**，排除了"是不是我改的内容导致的"。

### ⚠️ 已知的不一致（写下来，否则它就是下一个陷阱）

| 位置 | 现状 | 为什么 |
|---|---|---|
| 控制台「版本命令」（非生产分支） | 仍是默认的 `npx wrangler versions upload` | 与仓内 `npm run versions:upload` **不一致**。实测默认命令拿不到 `GIT_SHA` / `DEPLOY_SOURCE`，上传的会是**没有身份字段的版本**。代码这半边已经就位，控制台那一行等下次有人进控制台时一并改（**不为它单独占用一次人工操作**——那条命令目前还没被用到过，只往 `main` 推） |

🔴 **看到 `package.json` 里有 `versions:upload` 不等于它在生效。** 生效的是控制台里填的那一行。

### 若将来收窄「构建监视路径」

现在是 `*`（任何文件改动都触发构建），**保持不动**。

主因**不是**配额，是**不引入例外**：收窄之后改 README 不再触发部署，`origin/main` 就会长期与生产不一致，
于是「`git.sha` == `origin/main`」这条判据多出一类"这个差是正常的"的例外 ——
**而一旦有了例外，下次真的漂了也没人会当回事。**

> **判据的价值不在它有多严，而在它有没有例外。**
> 一个"通常应该相等，但改文档的时候不算"的判据等于没有判据 ——
> 因为每次不相等时，第一反应都会是"哦大概是文档"。

⇒ **条件式规矩**：若将来真要收窄监视路径，**必须同时**把验收判据从
「生产 sha == `origin/main`」改成「生产 sha 是 `origin/main` 的祖先」。
**两件事必须一起改，不许只改一件。**

### 实测：一次部署会保留什么、抹掉什么

⚠️ 下表**不是查文档得来的**，是在一个一次性 worker 上真跑出来的（无路由、`workers_dev:false`，零爆炸半径）。

| 来源 | 重新部署（不重新传）后 | 含义 |
|---|---|---|
| `wrangler secret put/bulk` 的 secret | **保留** ✅ | 一次性 probe worker 上实测 |
| **控制台「变量和密钥」里加的密钥** | **保留** ✅ | **跨一次真实 CI 部署实测**（`1d7a0d8` → `8ad1cb9`，部署前后各读一次 bindings）：`GITHUB_TOKEN` 仍在，类型仍是 `secret_text`。⇒ **CI 部署不会重置它，配一次即可** |
| `wrangler.jsonc` 里的 `vars` | **保留** ✅ | `ALLOWED_EMAILS` 安全（它本来就随每次部署带上） |
| CLI `--var` 注入的变量 | **🔴 被抹掉** | 正是上面那条：deploy command 必须走 `npm run deploy` |

⚠️ 第二行为什么值得单独实测：控制台密钥和 `wrangler secret put` 在机制上**应该**等价，但那是推断。
**如果这条错了，后果是隐蔽的**——某次 CI 部署后 token 悄悄消失，后台点保存开始失败，
而失败原因看起来像"GitHub API 权限有问题"，又是一条症状指错方向的路。
⚠️ 注意读法：**必须在部署前后各读一次**。同一时刻读两遍证明不了任何东西。

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

⚠️ 这张表专收**「真因和症状长得完全不像」**的那几种 —— 症状指向哪里，真因就偏不在那里。
不写下来的话，每个人都会先照着症状去查，而症状是错的。

> **何时往这张表加一行**：**不限于已造成事故的 bug**。只要出现过「**我们照着症状去查，方向是错的**」，
> 就该加一行 —— 哪怕当时靠运气或旁证绕过去了、哪怕最后什么都没坏。
>
> 中间那列（"症状会让你去查什么"）是这张表的核心。写这一列时要**如实写下当时的错误直觉**，
> 不要事后美化成"我一开始就怀疑是 X"。
> 🔴 **它记录的是错误直觉，不是正确推理。** 事后写文档的人总会不自觉地把自己写得更聪明，
> 而那样这一列就没有意义了 —— 一张只记载正确判断的表，帮不了下一个正在犯错的人。

⚠️ 反例（提醒这张表为什么不能只收"修好了的 bug"）：最后一行那个 `wrangler tail` 的坑
**从头到尾没坏过任何东西**，是查别的问题时顺带撞上的。但不记下来，下一个人还会拿
"日志里没东西"当作 worker 挂了的证据。

| 症状 | 症状会让你去查 | 真实原因 |
|---|---|---|
| 后台打开是一片 404，界面一个字节都没有 | 静态资源没上传 / `public/` 没打包 | **`src/index.ts` 少了 `app.notFound(… ASSETS.fetch …)`**。`run_worker_first:true` 让**所有**请求先进 worker，Hono 对没匹配上的路径默认回 404 —— 资源好好地在那儿，只是没人把请求转交给它 |
| `/api/_whoami` 的 `git.sha` 是 `null` | 部署脚本坏了 / 变量没配 | **Deploy command 用了默认的 `npx wrangler deploy`**。CLI `--var` 注入的变量不会在下一次部署里保留，所以它被上一次部署带走了。改成 `npm run deploy` |
| 门后出现 "Failed to fetch" / 空白页 | 前端请求写错了 / 端点挂了 | 边缘 302 到登录页 = **会话过期**。硬刷新解封；`curl` 看 `Location` 才是石锤 |
| 本地一起来就 500，说"出现后门" | 鉴权代码写错了 | 直接跑了 `wrangler dev`，**host 被 routes 合成成了生产域名**。用 `npm run dev` |
| Access 明明放行了却仍被拒 | 用户权限 / Access 策略 | **`ALLOWED_EMAILS` 没跟着 Access 策略改**。看 body 文案分诊（见上面自检 ③） |
| `/api/products` 一直是空的 | 代码坏了 / token 没配 | 先看 `dirExists`：`false` = Web 窗还没建那个目录（正常，那个目录归它） |
| `wrangler tail` 里一条日志都没有 | worker 没运行 / 部署坏了 | **匿名请求被 Access 在边缘就 302 拦掉了，根本到不了 worker** —— 没请求进来，当然没日志。这不是 worker 的问题 |
| 读 CF API 全部 `403 Authentication error` | CI / 权限配置被搞坏了 | **本机 wrangler 的 OAuth 令牌过期了**。跑一次 `npx wrangler whoami` 让它自己刷新。⚠️ 照着症状报出去的结论会是"CI 把权限搞坏了"——完全错误，而且听起来很有道理 |
| `/api/products` 说 `dirExists:false`，而那个目录明明有文件 | 目录真的不存在 / GitHub API 坏了 | **`.dev.vars` 把数据源指到了 `fixtures/products`**，读的根本不是 `AirSonde-Web`。⚠️ 两种情况的输出**长得完全一样** —— 先看 `/api/_whoami` 的 `data.repo` / `data.productsDir` |
| 编辑页缩略图一片空白 | 图片路径错了 / raw 地址不可用 / 沙盒挡了外链 | **`<img loading="lazy">` 在 `display:none` 的容器里永远不进视口**。`renderImages()` 是在编辑面板还 `hidden` 时跑的，惰性图从此不再补加载。⚠️ 判别式：裸 `new Image()` 打同一个 URL —— 秒开就说明 URL 没问题，问题在 lazy |
| 本地写入报 `GITHUB_TOKEN 未配置` | token 没配好 | **本机永远不准写生产数据仓**（出站闸）。配了 token 也照样被拦 —— 已修：出站策略现在第一个判，报的是真原因 |

## 🔴 每一条事实性断言，都要能回答「我是什么时候、用什么方式量的」

> **顺带提及的事实，和主结论适用同一条标准。**

2026-08-10 A4 交付时犯过一次：报告的主结论部分做得很严（部署前后各读一次、正对照、判别式），
却在末尾"顺带提及"了一句「`AirSonde-Web` 的 `src/content/products/` 目前还不存在（刚确认）」——
**那个目录里当时有 23 个文件**，而"刚确认"三个字是假的：那是 M1 时期的旧观测。

⚠️ **一个陈旧观测被冠上「刚确认」送出去，比没有观测更危险 —— 它看起来是实测。**

### 这次的具体成因：仪器被指到了别处，而输出长得一模一样

根因不只是"引用了旧数据"。本地 `.dev.vars` 把数据源指向了**本仓的 `fixtures/products`**（见 `fixtures/README.md`）：

```
GITHUB_REPO=zq8345/AirSonde-Admin      ← 不是 AirSonde-Web
PRODUCTS_DIR=fixtures/products         ← 不是 src/content/products
```

于是近期所有 `dirExists` 观测**描述的都是 fixtures，不是真目标** ——
而 `dirExists:false` 这个输出，**在两种情况下长得完全一样**。

⇒ **规矩**：任何观测都要连同「**我当时指着谁**」一起记。本仓的 `/api/_whoami` 会吐出
`data.repo` / `data.productsDir`，验收脚本第 ⓪ 条就是打印并断言它们
（见 `scripts/dryrun-e2e.mjs`）—— **那一条不是仪式，它挡的正是这次这个错。**

⚠️ 特别注意：**为了安全而搭的替身环境，本身就是一种"指向别处"。** 它让你敢跑测试，
同时也让你的观测不再描述真目标。两件事同时成立，容易只记住前一件。

## 🔴 出结论之前，先证明仪器是好的

上面最后一行是这条规矩的来历：**403 那次，如果照着报，结论会是"CI 把权限搞坏了"** ——
一个完全错误、却听起来很有道理的结论。真因是我自己的令牌过期。

⇒ **任何验收脚本的第 ⓪ 步，必须先拿一个「已知存在」的东西去量这把尺子。量不到就退出，
一条结论都不许出。**

```js
// scripts 里的验收脚本都照这个形状写（实例见 A3 验收脚本）
const probe = await api("/workers/scripts/airsonde-admin/settings");
if (probe.status !== 200) {
  console.log(`🔴 仪器无效：读生产 bindings 得到 HTTP ${probe.status}`);
  console.log(`   本次不出任何验收结论 —— 这可能是令牌过期，不是被测对象的问题。`);
  process.exit(2);          // ⚠️ 不是 1：与"判据不通过"分开，两者含义完全不同
}
```

⚠️ **`exit 2` 与 `exit 1` 必须分开**：`1` = 判据没通过（被测对象有问题），`2` = 没量成（我有问题）。
混成一个码，看结果的人会去查被测对象，而问题在尺子上。

这条和上面那张误判表是同一件事的两面：**表记录"症状指错方向"，这条防的是"仪器坏了却在出结论"。**

## 🔴 绿灯本身也会骗人：三个真栽过的变种（2026-09-03 · crm-skin 五批里各栽一次）

上一节防的是「仪器坏了」。这一节防的是**仪器是好的、量的东西也对，但结论仍然与被测对象无关**——
三次都发生在同一天、同一条流水线上，形状一样：**取数点选错了。**

### ① 退出码取自管道最后一环，不是闸

```bash
bash skin-gate.sh "$REPO" "$DEL_LIST" | grep -E "命中|结果"   # ⛔ $? 是 grep 的
[ $? -eq 0 ] && git commit ...                                #    闸红着照样提交
```

实际发生：E 批那次闸**红着**（5 条 `.gcard/.mcard` 死规则残留），commit 照样进去了，
因为 `grep` 找到了内容 ⇒ 退出 0。**屏幕上"有红"两个字就在上面几行，而判据没在读它。**

```bash
bash skin-gate.sh "$REPO" "$DEL_LIST" > /tmp/g.txt 2>&1; G=$?   # ✅ 先取码，再看输出
tail -14 /tmp/g.txt; [ $G -eq 0 ] && git commit ...
```

📌 同族：`cmd | tail` 的 `$?` 是 `tail` 的。**任何时候把闸接进管道，都要先把它自己的退出码存下来。**

### ② dev 的数据形态 ≠ 生产的数据形态

设置页「构建时间」那一行：生产的 `BUILD_TIME` 是 **epoch 毫秒串**（`"1788446135099"`），
而 dev 的恰好是 **ISO 串**。同一段代码：

```js
const d = new Date(v);            // ISO 串 ⇒ 有效；epoch 毫秒串 ⇒ Invalid Date
return isNaN(d) ? String(v) : fmt(d);   // ⇒ "原样放"的兜底把 epoch 裸露上了生产
```

**dev 走的是好分支、生产走的是坏分支**，本地怎么点都看不出来 —— 是 Joe 在生产上看见的。
⇒ **凡是"解析不了就原样显示"的兜底，必须按每一种真实的输入形态各跑一次**
（这里是 epoch / ISO / 缺失三种），⛔ 不能只跑本地手上那一种。

⚠️ 修它的时候还栽了第二层：补丁写在 shell 单引号外，`\d` 被吃成 `/^d+$/`（匹配字母 d）。
**改完不实测就等于没改** —— 同一天第二次。

### ③ 复验的 HEAD 不是最新的那个 commit

总工 grep `siteSave` 得出"两态没做"——结论对，但取数点停在 `54bfa92`，
而两态在下一个 commit `996d2c2` 里。**如果照着办，就会把同一件事做两遍。**

⇒ **报告与复验都必须带 commit sha**，不能只说"我 grep 了仓里"。
仓是会动的，"仓里"不是一个时刻。

**三条的共同判据一句话：**
> 出结论之前先问一句 —— **我读的这个数，是不是我以为的那个东西在此刻的值？**
> 退出码是谁的？数据形态是哪一边的？HEAD 停在哪个 commit？
