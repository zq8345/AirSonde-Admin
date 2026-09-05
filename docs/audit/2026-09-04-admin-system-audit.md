# 2026-09-04 · AirSonde-Admin 系统级审计（SPEC-B）

**审的是"这个后台本身行不行"，不是"今天有没有做错"**（后者见同目录 `2026-09-04-admin-full-audit.md`）。

| 项 | 值 |
|---|---|
| admin `origin/main` | **`a9fee73`** |
| web `origin/main` | **`ad16bbf`** |
| 读数时刻 | 2026-09-04T07:27–08:00Z（逐条另标）|
| 执行 | AirSonde-审计窗 · 全程只读 · 独立 worktree |

发现按**会不会伤到 Joe / 会不会让他做错决定**排序，⛔ 不按发现顺序，⛔ 不按模块。

---

## 🔴 1. 官网构建挂了，后台一个字都不会说（§D）

- **现象**：2026-09-04 官网从 09:53 停止部署到 12:43 才被发现，近三小时里 Joe 每次保存都"成功"，而线上一直是旧的。
- **判据（已实测）**：`grep -c "build.json"` 在 **`public/app.js` = 0、`src/index.ts` = 0** ⇒ **后台从不读官网的构建戳，没有任何轮询、探测或告警**。它提交完就结束了，构建红没红它不知道也不问。
- **「保存成功」和「官网生效」分得开吗 —— 文案上分得开，但也只有文案**：
  - 服务端 note：「已提交到数据仓…CF Pages 会自动重建 —— **线上生效有延迟，不是没写成功**」（`index.ts:1029`）
  - 前端：「**已提交。**」（`app.js:1770`）+「官网重建需要一两分钟。**现在去刷 airsonde.com 看到的仍是旧内容**」（`app.js:1785`）
  - ⇒ 措辞是诚实的、也是准确的。**问题不在这句话，在于它永远是这句话** —— 构建成功时它这么说，构建已经红了三小时时它还是这么说。
- **爆炸半径**：**高**。这不是"少显示一张图"，是 Joe 在一个**他以为在工作、实际已经停摆**的系统上连续工作三小时。他做的每一个决定（"这条文案改好了"、"这个产品上线了"）都建立在假信息上。
- **⭐ 这条的本质不是"缺个告警"**：一个**恒真的提示不携带任何信息**，而它长得像在提供信息。「已提交」在构建绿时是真的，在构建红了三小时时**也还是真的** —— 它从不撒谎，也从不告诉你任何事。Joe 读到的不是错误信息，是**零信息**，而零信息穿着有信息的衣服。
- **建议**：后台读一次 `airsonde.com/build.json`（它是公开的，我匿名就读到了），与数据仓 HEAD 比对；**超过 N 分钟仍不一致就在列表页顶部亮红**。成本是一个 fetch。

  > 🔴 **实现时必须同时把 `airsonde.com` 加进出站白名单**（`assertEgressAllowed`），否则这个 fetch 会被 Admin 自己的出站闸挡掉。
  >
  > ⚠️ **而那时的症状是"告警从来不亮" —— 与"一切正常"长得一模一样。**
  > ⇒ **一道用来防止假绿的闸，自己以假绿的方式失效。** 这类闸必须自带"我今天真的跑过吗"的证据（例如把上次成功比对的时刻显示出来），⛔ 不能只在异常时才有输出：**只在异常时说话的东西，沉默既可能是"没事"，也可能是"它死了"，而这两件事必须分得开。**

## 🟡 2. 两个写端点的乐观锁可以被静默绕过，而注释自己写明了那个风险（§B）

- **背景**：`commitFiles` **有意不做锁**，理由写在 `gitcommit.ts:47-62`，两条都成立：① 原来那个 `expectedHeadSha` 是**空转的**（服务端传、客户端从不发 ⇒ 恒 undefined ⇒ 整条被跳过，**而且不报错**）；② 粒度错（分支 HEAD 当锁 ⇒ 编辑超 3 分钟必冲突，而真冲突只来自同一文件被改）。⇒ 锁下沉到调用方按**文件 blob sha** 判。**这个设计是对的。**
- **判据：枚举 `staleConflict` 的全部调用方，看"没带 sha"时谁兜底**（`staleConflict` 第一行是 `if (!expected || expected === actual) return null` ⇒ **不带就放行**，兜底靠另一个函数 `missingLock`）：

| 端点 | staleConflict | **missingLock（缺锁就拒）** | 判定 |
|---|---|---|---|
| `PUT /api/products/:slug` | 926 | **923** `if (f.exists && !env0.expectedSha)` | ✅ 成对 |
| `DELETE /api/products/:slug` | 1066 | **1065** `if (!delExpected)` | ✅ 成对 |
| `POST /api/products/batch` | 574 | **534**（整批）+ **571 逐条** `if (!exp) { conflicts.push(…); continue; }` | ✅ 成对（见下方自误）|
| **`PUT /api/site-content`** | 1190 | **无** | 🔴 **缺** |
| **`PUT /api/taxonomy`** | 1295 | **无** | 🔴 **缺** |

- **最刺眼的一点**：`site-content` 那处的注释**自己描述了这个风险** ——「⚠️ 乐观锁：expectedSha 是"这次编辑所基于的那一版"。**不带的话，两个人先后保存，后一个会静默覆盖前一个 —— 而两边都看到"保存成功"**」（`index.ts:1188-1189`）。**注释说的正是没被防住的那件事。**

  > ⭐ **这个形状值得单独命名：作者知道这个洞、把它写下来了、然后没有堵。**
  > 写下来的风险读起来**像是被处理过的风险** —— 一段准确描述危险的注释，会让下一个读代码的人（包括审计）以为"他想到了，所以他防了"。
  > ⇒ **判据不能是"有没有人想到过"，只能是"那条路上有没有第二道闸"。** 注释是意图，不是闸。
- **触发条件（已实测）**：前端在这两处**确实会传** —— `app.js:3037` 传 `expectedSha: state.site.sha`、`3210` 传 `expectedSha: state.cats?.sha`。但：
  - `3210` 用了可选链 `?.` ⇒ 代码自己承认 `state.cats` 可能为空；
  - `JSON.stringify` 会把 `undefined` 的键**整个省略** ⇒ 服务端收到"没带 sha" ⇒ **放行**。
  - ⇒ 状态没加载全 / 读取失败 / 旧标签页，都会落进这个洞。**产品端点在同样情形下被 `missingLock` 兜住了（前端 `app.js:1467` 同样会省略），这两处没有。**
- **爆炸半径**：中。`site-content` 是全站文案、`taxonomy` 是分类轴，覆盖后**两边都显示"保存成功"**，丢失无声。⚠️ 现实风险取决于是不是多人同时用后台 —— 见下方「待 Joe 确认」。
- **建议**：把已有的 `missingLock` 加到这两处，⛔ 不需要发明新东西。

## 🟡 3. Admin 管得了产品，管不了官网的其余部分（§A，反向证据）

**判据**：不看 Admin 声称能做什么，看 **Joe 本人必须绕过它直接改文件的是哪些**（`git log --since=2026-08-01`，按 commit message 是否 `admin:` 前缀分两组，聚合到目录）：

| 只有人手改过的路径（Admin 无入口）| 次数 |
|---|---|
| `src/styles/light.css` | 79 |
| `src/assets/photos` | 45 |
| `src/pages/products`（产品页模板）| 31 |
| `src/pages/index.astro`（首页）| 31 |
| `src/data/home-light.ts` | 17 |
| `scripts/check-dist.mjs` | 12 |
| **`src/pages/solutions`（策展位）** | 11 |
| **`public/_redirects`（重定向）** | 9 |
| `src/lib/products.ts` | 8 |
| `src/pages/about.astro` · `contact.astro` · `src/data/about.ts` · `src/data/solutions.ts` | 6–9 各 |

**Admin 触及的只有三处**：`src/assets/products`(385) · `src/content/products`(167) · `src/data/taxonomy.json`(13)。
⇒ **SPEC-B 已知的两条（guides/solutions 策展位、5 条重定向）实测成立**，且缺口比那两条更宽：**首页、样式、页面模板、非产品图片、about/contact/solutions 的文案**全都没有入口。
⚠️ `src/data/site.ts` 那 18 次要单独说：Admin **有** `/api/site-content`，但它写的是 `src/data/site-content.json`（`index.ts:1113`），官网的 `src/data/site.ts` 从那个 JSON 读 ⇒ **两者不是同一个文件**，`site.ts` 本身仍然只能人手改。
- **爆炸半径**：低（不会弄坏东西），但它决定了**这个后台的天花板**：Joe 想改首页一句话，仍然要找人动代码。

## 🟢 4. 一个下架产品在边缘还活着，源站早就 404（§D 邻域）

- **判据（已实测，两组读数）** 读于 2026-09-04T07:57:55Z：
  - `/products/ak11c/` → **200**，`Cache-Control: public, s-maxage=604800`，`Age: 84207`
  - 同一 URL 加随机查询参数（绕缓存打源站）→ **404**，`no-store`
  - 仓里**没有** ak11c 对应的产品文件
- **✅ 正对照（这条最重要）**：今天之前删掉的另外三个产品 `ak34-1` / `as-d3l` / `ak28b`，逐个探测 ⇒ **全部正确 404 + `no-store`**；在线产品 `/products/ak19/` ⇒ 200 + `max-age=0, must-revalidate`。
  ⇒ **当前配置没有长缓存问题，这是一个历史残留对象。**⛔ 不是系统性缺陷。
- ⚠️ 三次读到的 `Age` 各不相同（总工读到 72793、12358，我读到 84207）—— **不是缓存被刷新，是打到了不同 PoP，各自持有各自的副本、各自到期**。所以"只剩一个残留"这个结论**只对我打到的这个 PoP 成立**。
- **建议**：对 `ak11c` 做一次 purge。⚠️ 它同时是一个好例子：**缓存里的东西会说过去的话** —— 读边缘读到的是"曾经的配置"，判断"当前配置"必须绕缓存问源站。

## ⛔ 5. §E（顺不顺手：三条真实路径的步数与等待）—— **本窗做不了**

Admin 是 Cloudflare Access 保护的 Worker，本窗**没有 Access 凭据、也没有 GitHub token**，起不了可用实例，`admin.airsonde.com` 匿名一律 302（见 §C）。
⇒ 「改一句文案 / 换一张主图 / 下架一个产品」的**步数、等待时间、看不见结果的那几步**，我**没有实测**。
⛔ **不用读代码推断代替实测**：步数能从前端流程推出来，但"等待多久""哪一步看不见结果"只有真点才知道，推断出来的数字会被当成实测数字用。
⇒ 这一条留给有凭据的窗补做。

---

## §C 谁能进来 —— ✅ 全绿（**实测，⛔ 未用"代码里有中间件"代替**）

读数时刻 2026-09-04T07:56–07:58Z。对 `admin.airsonde.com` 的**全部 17 个 `/api/*` 端点**逐个匿名请求，并各配一次**伪造 `Cf-Access-Authenticated-User-Email` + `Cf-Access-Jwt-Assertion` 头**：

| 组 | 端点数 | 裸请求 | 伪造 Access 头 |
|---|---|---|---|
| GET（`_whoami` / `products` / `products-expanded` / `media` / `audit` / `contract` / `taxonomy` / `site-content` / `products/:slug`）| 9 | **全 302** | **全 302** |
| 写（`media/folder` / `media/upload` / `products/batch` / `products/:slug/preview` / `PUT products/:slug` / `DELETE products/:slug` / `PUT site-content` / `PUT taxonomy`）| 8 | **全 302** | **全 302** |
| 根路径与静态资源（`/` `/app.js` `/style.css` `/index.html`）| 4 | **全 302** | — |

⛔ **零副作用**：写端点一律用**不存在的 slug**（`__audit-probe-does-not-exist__`）+ 空 body，即使穿透也写不到真数据。

**Access 三信号齐全**（`GET /api/products` 的响应头）：
`302` + `Www-Authenticate: Cloudflare-Access resource_metadata=…` + `Set-Cookie: CF_AppSession=…; Secure; HttpOnly` + `Location: https://wanewgroup.cloudflareaccess.com/cdn-cgi/access/login/admin.airsonde.com?kid=…`

**绕过自定义域也不行**：`wrangler.jsonc` 里 `workers_dev: false`，`routes` 只有一条 `{"pattern":"admin.airsonde.com","custom_domain":true}`；实测 `airsonde-admin.zq8345.workers.dev/api/_whoami` → **404**（该子域未启用）。

---

## 待 Joe 确认（⛔ 未推进依赖它的结论）

官网仓 21 条内容提交的 `author` 是 `zq8345@outlook.com`，而 commit message 尾括号里的操作人是 **`mzmyz168@outlook.com`**（由服务端 `operatorOf(c)` 从 Access 身份头写入，⛔ 客户端伪造不了）。
**`mzmyz168` 是谁？** 若是 Joe 自己的另一个 Access 账号 ⇒ 正常；**若是另一个人 ⇒ 今天一整天在改产品数据的不止一个人**，那会直接抬高上方发现 2（并发覆盖）的分量。
⇒ 总工已去问 Joe，未回。**本窗按"待确认"记录，⛔ 不当异常也不当正常。**

## 砍了什么（明写，⛔ 不静默跳过）

1. **§E 全部**（步数 / 等待 / 看不见结果的步骤）—— 无凭据，起不了实例。
2. **Admin 一切界面级行为** —— 同上。本报告 Admin 侧结论**全部是代码级 + 自检脚本级**。
3. **发现 2 的实际触发验证** —— 要真的构造一次"不带 expectedSha 的保存"才能证明它会静默覆盖，那是写操作，超出只读边界。⇒ 缺口由代码路径坐实（`staleConflict` 首行放行 + 无 `missingLock`），**"会静默覆盖"这句是代码推论，标待验**。
4. **Cloudflare Pages 构建日志** —— 拿不到，所以 09-04 停摆三小时的时间线我引用的是派单所述，⛔ 未独立复验。

## 自误记录

**Batch 端点差点被我报成缺口。** 我先看到 `index.ts:534` 的 `if (missing.length === slugs.length)` —— "只有全部都缺 sha 才拒"，据此推出"10 个里 9 个缺就放行 9 个"。**但读完循环体才发现它是对的**：571 行逐条判 `if (!exp) { conflicts.push({slug, why:"这一条没有版本号…未写入"}); continue; }`，注释明写「⛔ 不能因为'别的有'就顺带写了它」。534 那条只是"整批都没带 ⇒ 一句话说清页面是旧的"，是体验优化不是闸。
⇒ **一个守卫的判据不能只看它的入口条件，要看被放过的那条路后面还有没有第二道。** 这与本报告发现 2 恰好互为反例：那两处是**真的**没有第二道。
