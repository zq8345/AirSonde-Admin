# 2026-09-05 · admin.airsonde.com 全方位死物审计

**审计对象**：`airsonde-admin` `origin/main` = **`1dda94f`** · **读数时刻 2026-09-05T07:31:40Z**
**执行**：AirSonde-审计窗 · 独立 worktree（`C:/开发/airsonde/wt-dead0905`）· 🔴 **只查不删，本单一个文件未动**

⚠️ **比 9-4 两份审计所审的 `a9fee73` 多 10 个 commit**，涉及处已按 `1dda94f` 重新实测，⛔ 未套用旧行号。
⚠️ **9-4 那两份报告不在仓里**（`git ls-tree origin/main docs/audit/` 只有 `2026-08-26-admin-audit.md`）——它们在我的 worktree 未提交。故本报告需要引用处**内联写出要点**，不假设读者能看到。

---

## 一、覆盖率表（防"无死角"变成口号）

仓内 git 跟踪文件 **59 个**，逐类：

| 类型 | 数量 | 扫了 | 方法 | 未覆盖 / 为什么 |
|---|---|---|---|---|
| `.mjs`（scripts/）| 20 | **20** | `package.json` scripts 引用图 + `.mjs` 互相 import 图 + 每个文件头部自述 + 动态拼接搜索 | — |
| `.ts`（src/）| 12 | **12** | 从 `wrangler.jsonc main` 出发的 import 可达性 + 101 个导出符号全仓引用计数 | 函数**内部**的死分支只做了抽查，见下方「砍了什么」① |
| `.js`（public/app.js）| 1 | **1** | 101 个顶层函数零调用 + `window.*` 挂载反向比对 + 18 个端点↔前端调用双向比对 | — |
| `.html` / `.css` | 1 / 1 | **各 1** | CSS 258 个类选择器 ↔ html+js 使用（含运行时前缀拼接排除）| — |
| 图片（png/webp/ico/svg）| 12 | **12** | 每张图用**字面文件名的多形态**全仓搜（见判据说明）| — |
| `.json` / `.jsonc` | 7 / 1 | **8** | fixtures 4 个查引用方；配置 4 个（package/package-lock/tsconfig/wrangler）为构建必需 | — |
| `.md` | 3 | **3** | 引用关系 + 内容性质判定 | — |
| 无扩展名（`.gitignore`）| 1 | **1** | 构建必需 | — |
| **合计** | **59** | **59** | | |

**另扫**：`package.json` 的 4 个依赖是否都被 import（结果：**4/4 在用**，无死依赖）。
**未跟踪文件**：`git status --porcelain --ignored` ⇒ **0 个**（工作区无游离文件）。

### 图片判据说明（SPEC 点名的历史事故点）

⛔ **本次没有写"匹配文件名的正则"** —— 那正是历史事故的形状（正则漏字符 ⇒ 在用图被判孤儿 ⇒ 误删）。
✅ 改为**反向**：对每一张**真实存在**的图，取它的**字面文件名**去全仓搜。字面量搜索不存在"字符集覆盖"问题，⇒ 该类事故从根上不可能发生。

每张图搜的形态（共 5 类 × 3 种转义 = 最多 15 个变体）：
`basename` · 仓内相对路径 · 反斜杠路径 · `/basename`（站根引用）· 无扩展名 stem；
各自再加：HTML 实体（`&`→`&amp;`）· 正则转义写法（`-`→`\-`）· JSON 转义斜杠（`/`→`\/`）。
**扫描面**：全部 48 个文本文件（含 `.md`/`.json`/`.jsonc`，⛔ 未排除任何目录）。
**动态拼接排除**：另搜路径各段 `favicon` / `apple-touch` / `airsonde-logo` / `fixture-desktop` / `/assets/products` / `public/` —— 结果见下表。

---

## 二、可删（证据齐全，删除风险低）

### 2.1 图片 · 4 张零引用图标

| 路径 | 大小 | 证据 | 删除风险 |
|---|---|---|---|
| `public/favicon-180.png` | 9662 B | **与 `apple-touch-icon.png` 的 md5 完全相同**（`26107aa5268b`）⇒ 同一张图的重复副本。且 `index.html` 只 link 了 `apple-touch-icon.png`；苹果设备按约定请求的也是 `/apple-touch-icon.png`，⛔ 不会请求 `favicon-180.png` | **最低**（重复副本）|
| `public/favicon-16.png` | 687 B | 全形态搜索零命中；`index.html` 的 5 条 icon link 里没有它 | 低 |
| `public/favicon-48.png` | 2517 B | 同上 | 低 |
| `public/favicon-512.png` | 46646 B | 同上；512 通常由 PWA manifest 引用，而**仓内无任何 manifest/webmanifest 文件**（`git ls-files | grep manifest` 零命中）| 低 |

**双向证**：
- 正向：字面名 15 形态 × 48 个文本文件 ⇒ 零命中。
- 反向（从注册表出发）：`index.html` 的 icon 注册清单只有 5 条 —— `favicon.svg?v=2` · `favicon-32.png?v=2` · `favicon-192.png?v=2` · `favicon.ico?v=2` · `apple-touch-icon.png?v=2`。这 4 张**不在注册表里**。
- 运行时拼接排除：搜段 `favicon` ⇒ 只命中 `public/index.html` 一个文件（即那 5 条 link），无任何变量拼接。
- ⚠️ 浏览器**约定自动请求**只对 `/favicon.ico` 与 `/apple-touch-icon.png` 成立，两者都在且都被 link；带尺寸后缀的 `favicon-N.png` **必须**被 `<link>` 引用才会生效。

> ⚠️ 附带事实（不影响判定）：`wrangler.jsonc` 的 `assets.directory = ./public` 是**整目录上传**，所以这 4 张现在会被部署但从不被请求。删除后只是少上传 4 个文件。

### 2.2 CSS · 17 条零使用类规则（`public/style.css`）

258 个类选择器中零使用的 17 个。**每一个都做了两道证**：① 脚本判据（排除运行时前缀拼接）；② **原文 `grep` 复核**（不剥注释、直接搜 `index.html` + `app.js`）⇒ 两道一致。

`.featlist` · `.featrow` · `.feattext` · `.field-internal` · `.filebtn` · `.filters` · `.imeta2` · `.imgrow` · `.imgrow-side` · `.internal` · `.internal-row` · `.layout` · `.muted` · `.pane-detail` · `.pane-head` · `.pane-list` · `.taglist`

它们对应的是 v3 撤掉的三块 UI：**内部信息区**（`.internal*` / `.field-internal` —— `app.js:1025` 注释「原内部信息区里的 moq/文件路径不再展示」）、**双栏布局**（`.pane-*` / `.layout`）、**旧图片行与筛选区**（`.imgrow*` / `.filters` / `.filebtn`）。

> 🔴 **`.muted` 的删除必须写清边界**：要删的是 `style.css:254` 的**类规则** `.muted { color: var(--text-secondary); }`。
> ⛔ **不是** CSS 变量 `--muted`（`:root` 第 16 行定义，全文件 14 处 `var(--muted)` 在用）。
> 二者名字相近、`grep muted` 会一起命中 —— 这正是"拿不准的不许混进可删"要防的那种误删。
>
> 同理 **`.internal`**：`app.js:961/965` 出现的 `internal_field` 是**错误码字符串**（在注释里），不是 CSS 类；类选择器本身零使用。

### 2.3 死代码 · 1 个零引用导出

| 路径 | 符号 | 证据 | 删除风险 |
|---|---|---|---|
| `src/contract.ts:70` | `export interface Product` | 101 个导出符号全仓引用计数中**唯一一个零引用**（定义之外一次都没出现，`\b` 词边界搜索，扫描面含 `.ts/.js/.mjs/.json/.jsonc/.html/.md`）| 低（TS 接口，删除不改变运行时行为）|

⚠️ 附带发现：该接口里带 `moq?: number` 字段。**`moq` 已经被清理干净了** —— 全仓活代码零处理 `moq`（唯一的数据出现是 `fixtures/products/fixture-desktop-16in1.json:24` 的测试夹具），其余 11 处全是注释在讲"moq 是死字段、输入框已撤、**数据保留**"。⇒ 这个接口是那次清理的残留物。

---

## 三、暂留（此刻零自动引用，但**不是**死物）

### 3.1 七个手动 e2e 脚本 —— ⛔ 不可按"零引用"删

`batch-category-e2e.mjs` · `dryrun-e2e.mjs` · `imgorder-e2e.mjs` · `lifecycle-e2e.mjs` · `sitecontent-e2e.mjs` · `taxonomy-batch-e2e.mjs` · `write-order-e2e.mjs`

- **零引用是事实**：不在 `package.json` 任何 script 里；不被其它 `.mjs` import；全仓无动态拼接调用（搜 `` `scripts/ `` 与 `scripts/${` ⇒ 仅两处注释提及）。
- **但那是它们的设计意图**：每个文件头部都自述是**手动端到端实跑**，且写明前提 ——「打的是**靶子仓** `zq8345/AirSonde-Admin` 的 `fixtures/`，**绝不碰官网数据仓**」「需要另一个终端跑着 `npm run dev`」。
- **且 `fixtures/` 4 个文件正是为它们存在**（已验证：`fixture-desktop-16in1` ← `dryrun-e2e` + `write-order-e2e`；`fixture-supplier-leak` ← `dryrun-e2e`；`site-content` ← `sitecontent-e2e`；`taxonomy` ← `taxonomy-batch-e2e`）。删脚本会连带让 fixtures 变成死文件。
- ⇒ **判定：暂留。** 若要处理，正确的方向是**给它们一个 npm script 入口**（让"手动跑"这件事在 `package.json` 里可见），⛔ 不是删。

### 3.2 `scripts/jsonc.mjs` —— 有引用，不是死物

被 `dev.mjs` import（`package.json` 的 `dev` 用它派生去掉 routes 的本地配置）。列在此处只为说明它**已被核实**，非零引用。

### 3.3 `docs/audit/2026-08-26-admin-audit.md`

历史审计报告。**不建议删** —— 它是可追溯记录，且被 `README` 之外的文件引用（`taxonomy` 相关说明）。占 1 个文件。

### 3.4 24 个"导出多余但代码活着"的符号

`AccessClaims` · `VerifyOpts` · `AuditEntry` · `Category` · `Sensor` · `Status` · `ValidationResult` · `DiffLine` · `diffLines` · `DiffSummary` · `CommitResult` · `ListResult` · `ReadResult` · `WriteResult` · `ASSETS_ROOT` · `PUB_DIR` · `DRAFT_DIR` · `maxUsedIndex` · `FileOp` · `ImagePlan` · `MediaFile` · `MediaReport` · `TaxonomyItem` · `AXIS_FIELD`

它们**只在本文件内被使用**，即 `export` 关键字是多余的，但**代码本身活着**。
⚠️ 典型例：`diffLines` 只在本文件出现 1 次 —— 那 1 次是 `summarizeDiff` 在第 64 行调用它，而 `summarizeDiff` 被 `index.ts` 用 ⇒ **它不是死函数**，只是不必导出。
⇒ **判定：暂留**（收窄 `export` 是风格整理，不是死物清除；且 TS 接口导出是常见写法）。⛔ 不列入可删。

---

## 四、不确定（⛔ 未混进可删，需要更多信息才能定）

| 项 | 为什么不确定 | 定案需要什么 |
|---|---|---|
| `src/index.ts:439-451` 的 `/api/audit?slug=` 分支 | **零调用方是确定的**（前端 `app.js:3908` 调的是 `/api/audit?limit=60`，不传 slug；`state.auditSlug` 全仓无赋值点，只有一处清空）。**不确定的是该删还是该接** —— 9-4 报告已建议"接入口的同时把筛选下推到服务端"，那条**需 Joe 点头**。⚠️ 若判"可删"而 Joe 其实想要这个功能，删掉的是**半个已完成的功能** | Joe 对"按产品看改动历史"的取舍 |
| `.gitignore` 中的忽略项是否仍有对应物 | 未逐条核（工作区无未跟踪文件，说明忽略规则当前无可见效果，但那不等于规则本身无用）| 低价值，可不追 |

---

## 五、明确**不是**死物的（Joe 预期与实测不符，需要说明）

### 🔴 「wanew 移植残留」实测**没有找到**

Joe 的原话是「都是之前从 wanew 那套系统里面移植过来的……把里面没用的代码找出来」。我按这条线索全量搜 `wanew` / `Wanew` / `WANEW` / `wanew.com`，共 **37 处**，逐处分类后：

| 类别 | 处数 | 说明 |
|---|---|---|
| **在用的真配置** | 1 | `wrangler.jsonc:57` `ACCESS_TEAM_DOMAIN: "wanewgroup.cloudflareaccess.com"` —— **这是当前生效的 Access 团队域**（9-4 实测：匿名请求的 302 Location 就指向它）。⛔ 动不得 |
| **测试夹具里的真实身份** | 11 | `access-selftest.mjs` / `audit-selftest.mjs` 里的 `joe@wanew.com` —— 那是 Joe 的**真实登录邮箱**（git 历史里的 commit 作者也是它），自检脚本用它做正/反对照 |
| **设计决策注释** | 12 | `index.html:407-408`「学 wanew 的：单一数组+i===0 挂封面…⛔ 不学 wanew 的：dragover 里整块 innerHTML 重绘」；`style.css:647`「取 64px 不是照抄 wanew 的 40」等 —— 这些是**为什么这么做**的记录 |
| **测试用例来源说明** | 1 | `media-selftest.mjs:30` `"products/a,b.webp"  // 逗号 —— wanew 真实踩过的那个` |
| 其余注释/文档 | 12 | README、历史审计报告里的对比叙述 |

⇒ **零处是"移植过来但用不到的代码"**。这套 admin 看起来是**重写**的，不是搬运的；`wanew` 这个词留在仓里的都是配置、夹具或决策记录。
⚠️ 我用了多种形态搜索（大小写变体、域名、中文"万"），但**这只能证明"以 wanew 命名的东西没有"**，⛔ 不能证明"没有任何来自那套系统的无用逻辑"——后者需要 wanew 那套系统的代码做对照，本窗没有。**这一条标"已尽力，未穷尽"。**

### `moq` 已清理完毕
见 2.3 附带发现。活代码零处理，只剩接口里的字段定义与一条夹具数据。

### 附 · 9-4 两份审计的发现在新基线 `1dda94f` 上的当前状态（复核，⛔ 不引用旧结论）

| 9-4 的发现 | 当前状态（`1dda94f` 实测）|
|---|---|
| **SPEC-B 发现 2**：`PUT /api/site-content` 与 `PUT /api/taxonomy` 的乐观锁缺 `missingLock` 兜底，不带 sha 就放行 | ✅ **已修**。`index.ts:1356` 与 `1491` 各补了一道；5 个 `staleConflict` 调用点（674 / 1067 / 1226 / 1357 / 1492）现在**全部与 `missingLock` 成对**（634 / 1064 / 1225 / 1356 / 1491）。修复注释直接写明「⇒ 补上产品端点早就有的 `missingLock`（⛔ 不发明新机制，就是同一个）」「🔴 与 site-content 同一个洞」<br>⚠️ **这条的现实分量在同一天被抬高了**：Joe 已确认 `mzmyz168@outlook.com` 是他同事 ⇒ **确实有第二个人在改产品数据**，"两人先后保存静默覆盖"的前提条件是现实存在的，不是理论风险。修得及时 |
| **SPEC-B 发现 1**：后台从不查官网是否真的部署成功（`build.json` 全仓命中 0） | ✅ **已修**，见下 |
| **SPEC.md 发现 3**：`/api/audit?slug=` 零调用方、`state.auditSlug` 无赋值点 | ⚪ **未变**（`index.ts:439-451` 分支仍在；`app.js:3908` 仍调 `?limit=60` 不传 slug；`3942` 仍是客户端过滤）⇒ 已列入本报告「不确定」一节 |
| **SPEC.md 发现 1**：`ak13a` 悬空引用（换封面删了图仍在 gallery 引用）| — 属官网仓，不在本单范围 |

### 附 · 原生弹窗数复核（`06e5254` 声称"删除流程的 3 个原生 alert 换成页内提示"）

用本单修好的剥离器（全文一次遍历、保留换行、正确处理跨行模板串）重数**实调用**：

| 基线 | app.js | index.html | 合计 |
|---|---|---|---|
| `a9fee73`（9-4 审计时）| 21 | 0 | **21** |
| **`1dda94f`（今天）** | **17** | 0 | **17** |

⇒ **`06e5254` 的声称成立**（净减 4 处）。但要说清现状：**仓里仍有 17 处原生弹窗实调用**（`alert` 11 · `confirm` 5 · `prompt` 1），集中在三处流程 —— 批量操作（721/741/745/748/751/752）、站点内容保存（2971/3256/3269/3273/3276/3279/3280）、分类轴保存与放弃（3849/3858）。
🟡 **一处值得单独看**：`app.js:4129` 仍是 `prompt("删除 ${slug}？确认请输入它的 slug：…")`，而 `cece754` 声称"删除产品改成页内确认对话框"。⇒ **两者可能指不同路径**（页内对话框走的是另一个删除入口，这个 `prompt` 是残留的第二条路），也可能是漏改。**本单未验界面行为，⛔ 不下判定**，仅记为待查。

### 9-4 报告里的一条建议已被实现
`/api/site-build`（`index.ts`，`1dda94f` 上新增，`a9fee73` 时还没有）正是 9-4 SPEC-B 发现 1 建议的"读官网构建戳与数据仓 HEAD 比对"。实现比建议更细：注释写明「'已多少分钟没生效'要从**改动落地那一刻**算起，⛔ 不从 build.json 的 builtAt 算：那是上一次成功构建的时间，方向反了」。⇒ 那条**不再是待办**。

---

## 六、砍了什么（⛔ 不静默跳过）

1. **函数内部的死分支未穷尽**。我做的是"符号级/文件级/规则级"零引用，**不是**逐条件的可达性分析（那需要符号执行或运行时覆盖率）。已知的一处（`/api/audit?slug=`）来自 9-4 审计并已在本单复核仍在；其余分支只做了抽查。⇒ 若要穷尽，正确工具是**跑一次带覆盖率的 e2e**（仓里那 7 个脚本正好可用），⛔ 不是继续静态搜。
2. **未验证 Admin 界面行为**：无 Access 凭据、无 GitHub token，起不了实例（`admin.airsonde.com` 匿名一律 302）。⇒ 本报告全部结论为**代码级**，"这个 CSS 类删了页面不会变样"是**推论**，⚠️ 建议 Admin 窗执行删除后**肉眼过一遍四个页面**。
3. **`package-lock.json` 未逐条核**：只核了 `package.json` 的 4 个直接依赖（全部在用）。间接依赖树不在本单范围。
4. **"wanew 无用逻辑"未穷尽**：见五-1 说明，缺 wanew 侧代码做对照。

## 七、自误记录（本单三次，全部在报出去之前被拦下）

1. **`function startNew` 被判"零调用"** —— 假红。我的裸引用正则字符类 `[,)\]\n]` **漏了分号**，而实际写法是 `$("#newBtn").onclick = startNew;`。⇒ 判据只认得一种形态，就只查得出那一种。
2. **`POST /api/media/upload` 被判"前端无调用方"** —— 假红。根因在我的注释剥离器：它**逐行**处理并在每行开头重置字符串状态，于是**跨行模板字符串**的后续行被当成普通代码，里面的 `https://` 被当作行注释、整行被截掉，连带把 `api("/api/media/upload", …)` 那一行也弄没了。改成**全文一次遍历**后消失。
3. **块注释替换吞掉换行** —— 用等长空格替换 `/* */` 会把换行也换掉 ⇒ 行数塌缩、行号错位，我一度看到"第 2767 行"是完全不相干的内容。

> ⇒ 三次都是**工具缺陷伪装成发现**。凡"明显在用的功能被判成死的"（新建产品、上传图片），**先查判据，别先写结论**。
