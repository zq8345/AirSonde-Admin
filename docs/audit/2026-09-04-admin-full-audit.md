# 2026-09-04 · AirSonde-Admin 09-03→09-04 全部产出 · 变更审计

**审计对象（我实际审的树，⛔ 不写"最新"）**
| 仓 | 派单表写的 | **我 fetch 出来的 origin/main** | 读数时刻 |
|---|---|---|---|
| airsonde-admin | `37c31ac` | **`a9fee73`** | 2026-09-04T07:27:24Z |
| airsonde-web | `b35a931` | **`ad16bbf`** | 同上 |
| 生产产物 `airsonde.com/build.json` | — | **`ad16bbf`**，builtAt `07:20:03.976Z` | 07:30:38Z |

- admin 比派单表多 1 条 = 派单第 ⑨ 项「文件夹封面改主图」（表里标"待推"，实际**已推**）⇒ 纳入被审。
- web 比派单表多 21 条，全部 `admin: update/create <slug>` 形态。**边界核实**（⛔ 不凭 commit message）：`--name-only` 逐条看，只动 `src/content/products/*.json` 与 `src/assets/products/**` 图片，**零代码/配置/脚本改动** ⇒ 属 Joe 的内容资产，不审。
- **执行**：AirSonde-审计窗 · 全程只读 · 独立 worktree（admin 在 scratchpad；**web 那棵建在 `C:/开发/airsonde/wt-au0904web`** —— scratchpad 路径下 `Filename too long`，产品 slug 本身 150+ 字符，撞 Windows 260 限制；沿用该仓既有 `wt-*` 约定，⛔ 未碰任何人在用的树）。

---

## 发现清单（按可利用性 / 爆炸半径排序，⛔ 不按发现顺序）

### 🟡 1. 换封面留下一处悬空引用：文件删了，gallery 还指着它

- **现象**：`45af967`（`admin: update portable-breathalyser`）一次提交里 `D` 掉 `ak13a/portable-breathalyser-3.webp`，同时把 `-3.webp` **写进了 gallery**（该次 JSON 变化是 `main` 与 `gallery[0]` 互换）。当前 `origin/main` 上该引用悬空。
- **判据（已实测）**：47 个 JSON 的全部 `images.main` + `gallery` ↔ `src/assets/products/` 递归实际文件，逐条比对 ⇒ **悬空引用共 1 处，就是这一处**；反向的孤儿 38 张全在 `originals/`（存档，正常）。
- **后果（已实测，比预想轻）**：官网模板对此**有意设计** —— `[slug].astro:64` 先 `tryResolveProductImage` 过滤，缺的跳过并 `console.warn`，注释写明"缺一张只损失一张缩略图，不损失页面也不损失构建"。**构建没红、页面没坏**，Joe 那个产品的图库静默少一张，界面上无任何提示。
- **爆炸半径**：低-中。不停摆、不泄漏；但是**静默的数据不一致**，且发生在 Joe 最常做的动作（换封面）上。
- **⚠️ 待验**：是否"每次换封面都复现"——**证不了**。全库仅此 1 例，而换封面历史上做过几次查不出来。⛔ 不写"每次都会"；建议 Admin 窗本地重放一次（那是写操作，超出本窗只读边界）。
- **建议**：闸放**写入路径** —— 保存前校验 `main`+`gallery` 每个路径在本次提交后的树里存在，不一致就拒绝写入。⛔ 不做事后扫描：**事后扫描只能发现，写入闸能阻止**。

### 🟡 2. 「未被引用」孤儿入口：结论不可信时仍照常给清单（同仓已有更严的先例没跟上）

- **现象**：`orphansTrustworthy = (unreadable.length === 0)`（`index.ts:417`）。为 false 时，`renderMedia()` 在顶部追加一条红 notice（`app.js:2108`），**但**「未被引用 N」入口的渲染条件是 `if (m.orphans > 0)`（`app.js:2205`）—— **不检查 `orphansTrustworthy`**；点进去的 `renderOrphanList()` 同样不检查，只有一条常驻 warn「未被引用 ≠ 可以删…删除仍会二次确认」。
- **为什么危险**：`unreadable` 非空意味着有产品 JSON 读不出来 ⇒ **它们引用的图会被误判成孤儿**。Joe 在孤儿页照单清理，就可能删掉在用的图；二次确认框不会告诉他"这个结论此刻不可信"。
- **🔴 同一个系统里，两处对"结论不可信"的处理不一致**（已实测）：
  - **分类（taxonomy）**：`canDelete: refs.length === 0 && unreadable === 0`（`index.ts:1249`），且删除端点在 `unreadable` 非零时**直接拒绝**（`index.ts:1313-1316`，理由写明"此时'没人在用'这个结论不成立"）⇒ **硬闸**。
  - **图片孤儿**：只有红字提示，入口与删除**照常可用** ⇒ **软提示**。
- **建议**：把 taxonomy 那条硬闸的形状搬过来 —— `orphansTrustworthy === false` 时禁用入口（或入口可点但删除按钮禁用），⛔ 不靠人读警告。

### 🟡 3. 「按产品看改动历史」是一段**接上之后仍然会骗人**的死功能

v3 删 `recordCard` 的连带后果，比仓内注释所说的更深一层。三处都已实测：
1. 服务端 `/api/audit?slug=` 分支在（`index.ts:339`），注释写明"编辑页侧栏「记录」卡用" —— **记录卡已删 ⇒ 该分支零调用方**。
2. 前端 `renderAudit()` 有完整的按 slug 筛选 UI（`app.js:3495-3502`），**但 `state.auditSlug` 全仓没有任何赋值点**（只有一处把它清空）⇒ 那段 UI 永远不显示。
3. **即便将来接上入口，它仍会骗人**：前端调的是 `api("/api/audit?limit=60")`，**不传 slug**，然后在客户端过滤 ⇒ 某产品的改动若排在最近 60 条之外，界面会显示成"没有记录"，而真相是"有记录，只是不在这个窗口里"。
- **建议**：接入口的**同时**必须把筛选下推到服务端 `?slug=`（它本来就支持，且服务端是按**数据文件的 commits** 取，不受 60 条窗口限制）。⛔ 不许只接入口。或者两头一起删干净。⚠️ 走哪条**需 Joe 点头**，不是本单能定。

### 🟡 4. 未保存提醒拦得住两条路，拦不住三条（且这是有意权衡，不是疏漏）

`state.dirty` + `#dirtyBar` + `confirmLeave()`（`app.js:1955-1981`），设计上**刻意不用原生 `confirm`**（Admin 零弹窗规矩），第一次点拦下并改文案为"再点一次就丢弃"，第二次放行。

| 离开路径 | 拦不拦 | 证据 |
|---|---|---|
| 「返回列表」按钮 | ✅ 拦 | `app.js:2033` `#backBtn.onclick` |
| 左栏导航切换 | ✅ 拦 | `app.js:3580` `.nav-item[data-nav]` |
| **关标签页 / 刷新** | 🔴 **不拦** | 全仓 `beforeunload` 命中 **0** |
| **浏览器后退** | 🔴 **不拦** | 全仓 `popstate` / `hashchange` 命中 **0** |
| 直接改地址栏 | 🔴 不拦 | 同上 |

⚠️ **技术上不可兼得**：拦住关标签页/刷新**只能**靠 `beforeunload`，而它必然弹浏览器原生对话框 —— 与"零弹窗规矩"直接冲突。
- **建议（不破坏零弹窗规矩的做法）**：编辑中的草稿自动存 `localStorage`，回到该产品时提示"上次有未保存的修改，恢复/丢弃"。这样既不弹窗也不丢数据。

### 🟢 5. 派单表一里的 `.mtag` 前提不成立（记录在案，非缺陷）

SPEC 把 `.mtag` 列进"v3 已删的 CSS"，**实测它没被删**：`style.css:1206/1208` 规则仍在，`app.js:2206` 活代码在用它渲染「未被引用 N」入口，且 `style.css:1203` 注释明写「`.mtag` **留下**：它现在服务的是「未被引用 N」那个入口」。

---

## 五条硬证据（SPEC §1）

### A · 20 个产品的 `supplierRef` 还在不在 —— ✅ 一个没丢

⚠️ **SPEC 的判据我没有照搬**，因为它会误报：「`- "supplierRef"` 删除行必须为 0」我跑出来是 **3**，但那 3 行全部来自 Joe 自己删掉整个产品（`0008ac1` 09-01、`6ccf733`/`8587cbd` 08-28，**三条都早于被审范围**）——整文件删除时字段自然跟着走。**这条判据认不出"整文件删除"和"字段删除"的区别。**

改用两条：
1. **被审范围内（`63a36b6^..ad16bbf`）的字段级 `supplierRef` 删除 = 0** ✅
2. **逐产品比对，⛔ 不比总数**：迁移前 `63a36b6^` 36 个产品 / 20 个带 `supplierRef` → 当前 `ad16bbf` 47 个产品 / 20 个带 `supplierRef`；逐个核对 ⇒ **字段丢失 0、产品消失 0** ✅
   > ⭐ 为什么必须逐产品：总数都是 20，**"丢了一个旧的、Joe 又加了一个新的"会完美对消**，比总数永远看不见。

### B · 164 张图有没有内容变化 —— ✅ 一个字节没动

- `59b5daf` 变更类型：**R 164 · M 25 · D 0 · A 0** ✅
- SPEC 说"只看 R 不够（相似度有阈值）"⇒ **逐张比 blob hash：164/164 全等**，且相似度标记**全部 R100**，无一条低于 100%。

### C · 25 个产品 JSON 除路径外有无别的改动 —— ✅ 没有

- 逐行判定 `git show 59b5daf -- src/content/products/` 的全部 +/- 行：**328 行全部**是 `images.main` / `gallery` 路径，**非路径行 0**。
- **反向自证**（防"判据恒零"）：同一判据喂 Joe 真实的内容编辑 —— `e5e3083` 报红 **17 行**、`8bc02da` 报红 **20 行**（name / highlights 变化全抓到）⇒ 判据有区分力，那个 0 是真 0。

### D · 官网 25 个产品页的图真的显示得出来 —— ✅ 25/25（独立复验，⛔ 未引用 Admin 结论）

前置：先读 `build.json` = `ad16bbf`，与我审的树一致 ⇒ 不是在旧产物上验。

| 层级 | 结果 |
|---|---|
| 页面 | **25/25** 返回 200；共 313 个 `<img>`，全部指向 `/_astro/`，**空 src 0** |
| 资源 | 去重 **162 个** `_astro` 资源逐个请求 ⇒ **162/162** 200 + `content-type: image/*` + `content-length > 0` |

### E · `check-dist.mjs` 新正则会不会漏报真泄漏 —— ✅ 不漏也不误伤

判据**从 `check-dist.mjs` 原文抠出 `slugRe` 复用**，⛔ 不手写一份（手写验的是"我以为它是这样"）。

| 测试 | 规模 | 结果 |
|---|---|---|
| 正向：每个 draft slug 假想泄漏 | 22 draft × 4 种形态（HTML 链接 / 产物文件名 / JSON 裸值 / 正文散字）= **88 次** | **漏报 0** ✅ |
| 反向：published 会不会被误伤 | 22 draft × 25 published × 4 形态 = **2200 次** | **误伤 0** ✅ |
| 子串关系对（SPEC 点名） | 全库 **2 组** | 均 ✅ |

子串两组，正反两方向都测：
- `hcho-desktop-monitor`(draft) ⊂ `co2-tvoc-hcho-desktop-monitor`(published) —— 短正则打长产物 ✅ 不命中；长正则打短产物 ✅ 不命中；各自打自己 ✅ 命中
- `co2-desktop-monitor`(published) ⊂ `mini-co2-desktop-monitor`(published) —— 同上 ✅

---

## 表一 · 能力清点（⛔ 用能力查，不用改动反扫）

**问② 先答：活引用指向不存在的元素 = 0。**
判据自写：剥掉注释与字符串后的**活代码** id 引用（`$("#x")` / `getElementById` / `querySelector`）↔ HTML 与 JS 模板里的 `id=` 来源，并排除"作为裸字符串实参出现"的动态来源。**86 个活引用 / 91 个来源 ⇒ 死绑定 0**。
⭐ 并做**正对照**：植入一条引用不存在元素的活代码 ⇒ 判据报红 ✅ —— 证明这个 0 不是判据坏了。

| 项 | 问①：搬走还是删掉 | 问②：活引用 |
|---|---|---|
| `dSiteLink`「看官网页 ↗」| **删掉**，Joe 点名 | 仅注释 |
| `dSitePath`「官网 路径」| **搬走**：与「网址」字段是同一事实，合并到该字段（⛔ 不占两个显示位）| 仅注释 |
| `recordCard`「记录」整块 | **删掉**，Joe 点名；连带后果见发现 3 | 仅注释 |
| `recordBody` / `statusCard` / `moreFields` / `f_highlights_cnt` | **删掉** | 完全消失 |
| `f_supplier` | **只删输入框，数据保留** —— 与 A 条互证 | 仅注释 |
| `loadRecord()` / `paintSitePath()` | 整个函数删 | 仅注释 |
| `.edit-col-side` | CSS 删 | 仅注释 |
| **`.mtag`** | 🔴 **没删**（见发现 5）| **活代码在用** |

## 表二 · 宽扇出全量

**「还有没有第三处宽的」⇒ 没有。**

| 位置 | 元素数 | 出站 | 判定 |
|---|---|---|---|
| `index.ts:279`（listExpanded）| N = 产品数（今 47）| GitHub | ✅ `mapLimit(…, GH_CONCURRENCY=6)` |
| `index.ts:393`（`/api/media`）| N = 产品数 | GitHub | ✅ 同上 |
| `index.ts:352`（`/api/audit`）| **恒 2** | GitHub | ✅ 固定 2，不随数据增长 ⇒ 非宽扇出 |
| `github.ts:172` | = min(limit, N) | — | ✅ 这就是 `mapLimit` 的 worker 池实现本身 |
| `scripts/batch-category-e2e.mjs:156/208` | **恒 2**（`SLUGS` 两个自检 slug）| 是 | ⚪ 且不在生产路径（不在 `gate`/`typecheck`/`deploy` 里）|

⚠️ 另扫其它扇出形态 —— `Promise.allSettled` / `Promise.race|any` / `forEach(async` / 收集 promise 再统一 await —— **零命中**。（防的是"判据只认得一种形态，就只查得出那一种"。）

## 表三 · 数字对账（树 `ad16bbf`，读数时刻 2026-09-04T07:42:37Z）

| 项 | 数 | 来源 |
|---|---|---|
| 产品 JSON | **47** | `src/content/products/*.json` 文件数 |
| ├ published | **25** | `status != draft` |
| └ draft | **22** | `status == draft` |
| 图片文件 | **243** | `src/assets/products/` 递归 webp/jpg/png/avif |
| 文件夹 | **27** | 一级子目录（含 `_draft/`、`originals/`）|
| ├ `_draft/` 下 | **42** | |
| └ **根目录散图** | **0** ✅ | 与 `index.ts`「⛔ 不许传根」约定一致（见问①）|
| `originals/` 存档 | **38** | 27 jpg + 11 png，**零 webp** |
| 在用（被 JSON 引用）| **206** | main + gallery 去重 |
| 孤儿（在盘不被引用）| **38** | **全部在 `originals/`** ⇒ 与存档口径一致，非异常 |
| **悬空（引用了但盘上没有）** | **1** 🟡 | 见发现 1 |

⚠️ Joe 全天在加产品，这些数**只对这一个读数时刻自洽**，⛔ 不与任何旧报告比。

---

## 六个问题

### ① 根目录将来又出现一张图，会被打进产物吗？与「⛔ 不许传根」一致吗？

**会被打进产物；两者一致，不冲突。**
- 官网 glob 是 `'/src/assets/products/**/*.webp'`（`products.ts:31`），`**/` 可匹配零级目录 ⇒ **根目录的 webp 也在构建范围内**。官网注释自己写明这是批 1 递归化的后果："every .webp in a model subfolder is now eagerly bundled…子目录不再是'先放着不上线'的地方，那个角色只属于 `_draft/`"。
- Admin 侧 `dirForExisting`（`imagepaths.ts:73`）对 published 且不在 `_draft/` 的图"原地不动"，注释明确"根目录或型号目录都算数……递归 glob 已上生产，两处都在构建范围内 ⇒ 原地不动不会让官网缺图"。
- 「⛔ 不许传根」约束的是**新上传落点**（`dirForStatus` 只会给 `_draft/` 或型号目录，只有"型号算不出合法名"时才回落根目录）；而"根目录已有的图能不能上站"是另一件事，答案是能。**两条规则各管一段，当前一致。**
- **实测佐证**：表三「根目录散图 = 0」。⚠️ 但那是**此刻的事实**，不是"不可能出现" —— 回落分支（`imagepaths.ts:26/40`）仍在，型号算不出合法名时还是会落根目录。

### ② `s-maxage=604800` 除产品页外还有哪些路径带长缓存？下架/删除时哪些会挂着不走？

**这个前提在当前两个仓里都不成立 —— 全史从未出现过 `s-maxage`。**
- `git log --all -S "s-maxage"`：**web 仓 0 条、admin 仓 0 条**。
- 全仓字面量 `604800` / `s-maxage`：**零命中**。
- **生产实测**（读于 07:50:28Z）：`/products/ak19/`、`/`、`/products/`、`/build.json`、`/sitemap-0.xml`、`/guides/` —— **六条全部是 `public, max-age=0, must-revalidate`**。
- admin 仓唯一的长缓存是 `index.ts:1437`：带 `?v=` 的静态资源 `max-age=31536000, immutable`（内容寻址，改内容即改 URL，不存在"挂着不走"）。
⇒ **当前没有任何路径带长缓存，下架/删除不会有陈旧页面挂着。** ⚠️ 若这个 `604800` 来自别的系统或计划中的改动，需要重新给出处再审。

### ③ `orphansTrustworthy=false` 时那个入口显示什么？

**照常显示完整的孤儿清单，另加一条顶部红字警告。** 见发现 2 —— 这正是 SPEC 担心的形状，且同仓的 taxonomy 已有更严的硬闸没被沿用。

### ④ 参数表固定 7 行的三条规则在当前 `origin/main` 上是否仍成立？

**代码级：三条全部成立**（`app.js:1352-1400`，v3 搬 markup 未搬坏）：

| 规则 | 实现 | 判定 |
|---|---|---|
| 空值不写键 | `if (v) o[iv.dataset.fixedKey] = v;` —— 空则整个键不进 JSON（注释写明理由：官网 `Object.entries(specs)` 会渲染空行，JSON-LD 会多一条空 PropertyValue）| ✅ |
| 固定键在前 | 固定 7 行先写，注释"键序就是官网显示序，也是 JSON-LD 的 PropertyValue 序" | ✅ |
| 自定义键保留 | `.filter(([k]) => !SPEC_FIXED_KEYS.has(k))` 后按**仓里原顺序**追加，⛔ 不排序不去重不改写；且"一个键只出现在一个地方" | ✅ |

固定 7 键：`Dimensions` / `Net weight` / `Carton size` / `Carton qty` / `Carton gross weight` / `Lead time` + 中文标签映射。
`npm run typecheck` 链上的 `contract-selftest.mjs`：**71 通过 / 0 失败**。
⚠️ **界面级行为未验**：Admin 是 Access 保护的 Worker，本窗无凭据与 GitHub token，起不了可用实例 ⇒ 标**待验**，⛔ 不写"已验证界面正确"。

### ⑤ 未保存提醒拦得住哪些路径？

见发现 4：**拦「返回列表」与「左栏切换」两条；关标签页 / 刷新 / 浏览器后退三条拦不住**（`beforeunload` 与 `popstate` 全仓命中均为 0）。且这是**有意权衡** —— 拦住关标签页只能靠 `beforeunload`，它必然弹原生对话框，与 Admin 的零弹窗规矩冲突。建议用 `localStorage` 草稿恢复绕开这个冲突。

### ⑥ 两仓耦合：Admin 写路径规则 与 官网 glob 读路径规则不一致会怎样？有没有闸？

**两处独立硬编码，没有直接的跨仓一致性闸；只有一道间接的、事后的闸。**
- Admin 侧：`DRAFT_DIR = "products/_draft"`（`imagepaths.ts:19`）
- 官网侧：`'!/src/assets/products/_draft/**'`、`'!/src/assets/products/originals/**'`（`products.ts:32-33`）
- 两个 `_draft` 字符串**各写各的**，无共享常量；`grep` admin 的 `scripts/*.mjs` 找跨仓校验 ⇒ **零命中**。

不一致会发生什么：
- 若 Admin 改了 `DRAFT_DIR`（如改成 `products/drafts`），官网仍只排除 `_draft/**` ⇒ **草稿图进产物**。此时 `check-dist.mjs` 第 2 条（draft slug 不许出现在 dist，含文件名）会**报红拦住**。
- ⇒ 有闸，但它是**官网构建时**才响的，**代价是官网停止部署** —— 正是 09-04 那次停摆的机制（那次是判据误报，但机制相同）。
- ⚠️ 另一条**当前失效**的排除：官网注释自己写明 `!originals/**` "presently inert"（`originals/` 里 27 jpg + 11 png、**零 webp**，我实测确认）。若将来有人往 `originals/` 放一张 webp 且被产品引用，它会被 glob 排除 ⇒ **产品缺图**，而 `check-dist` 不查这类。
- **建议**：把 `_draft` / `originals` 这两个目录名做成两仓共享的单一来源（或至少给 admin 加一条自检：读官网仓的 glob 常量比对），⛔ 别让"两处独立表述"继续。

---

## 覆盖率 / 砍了什么 / 自误记录

**扫过的**：五条硬证据 A–E 全部（含 88 + 2200 次自证）；三张表全部；六问全部；两仓 fetch 与边界核实；生产 25 页 + 162 资源实测；生产六条路径缓存头实测。

**⛔ 砍了什么（明写，不静默跳过）**
1. **Admin 界面级行为未验**（问④的界面部分、以及任何"点一下看看"的验证）：Admin 是 Cloudflare Access 保护的 Worker，本窗**无 Access 凭据、无 GitHub token**，起不了可用实例。⇒ 所有 Admin 侧结论都是**代码级 + 自检脚本级**，⛔ 未做界面行为验证。
2. **换封面是否稳定复现悬空引用**：需要写操作，超出只读边界。
3. **构建日志**：拿不到 Cloudflare Pages 的构建输出，所以模板那条 `console.warn`（会点名被跳过的 gallery 图）无法直接读到。

**自误记录（三次假红，全部停在报出去之前）**
1. **按文件名 slug 拼产品页 URL ⇒ 0/25**（20 个 301、5 个 404）。真实 URL 用**型号**（`/products/ak19/`），SPEC 写的就是型号，是我读错。旧 slug 的 301 恰恰证明**重定向在正常工作** —— 差一点把它报成"25 页全挂"。
2. **`-o /dev/null` 让 `%{size_download}` 恒为 0 ⇒ 报 0/162 不合格**。同一 URL 单独落盘 133904 字节。**丢弃正文的同时去量正文，量到的当然是 0。** 改用 HEAD 读 `content-length` 后 162/162 全过。
3. **"AK13A 页面少了两张图"** —— 逐层排除（产物 sha 对 → blob 有效 → glob 收得到 → schema 无截断 → 模板无 slice → 缩略图是 SSR 非懒加载）后落到真因：**`ak13a/portable-breathalyser-4.webp` 与 `ak13b/app-breathalyser-4.webp` 是同一份内容**（blob `30aeacc1`，`-5` 同为 `408cce92`）⇒ **Astro 按内容 hash 去重，产物资源名取了另一个产品的文件名**。图一张没少。
   > 🔴 这条最值钱：**"图少了两张"和"我的判据认不出资源去重"长得一模一样**，而前者会让人去改一个没坏的东西。

**派单前提的两处更正**（⛔ 不默认接受派单里的"现状"）
- SPEC §1-A 的判据「`- "supplierRef"` 删除行必须为 0」认不出整文件删除，会把 Joe 正常删产品报成红。
- SPEC 表一把 `.mtag` 列进已删清单，实测它**没删**且活代码在用。
- SPEC 六问② 的 `s-maxage=604800` 在两仓全史都不存在。

---

## 结论

**这一天 12 次上生产，没有把 Joe 的东西弄坏。** 五条硬证据全绿：`supplierRef` 20 个一个没丢（逐产品核对）、164 张图逐张字节全等、25 个 JSON 只改路径、官网 25 页 + 162 资源全部正常、`check-dist` 新正则 88 次正向不漏 / 2200 次反向不误伤。

**最该先修的一件：发现 1 的写入闸** —— 保存前校验 `main`+`gallery` 的每个路径在提交后的树里存在。理由不是它今天造成的损失（只丢了一张缩略图），而是**它发生在 Joe 最常做的动作上、且完全静默**：没有闸的话，下一次同样的事仍然不会有人知道。
