// AirSonde 产品后台（admin.airsonde.com）—— M1：只读打通。
//
// M1 范围：进程身份端点 + Access 门控 + GitHub 只读列目录。**没有任何写入能力。**
// 写入是 M2，单独派单。别在这个文件里"顺手"加保存端点。

import { Hono } from "hono";
import type { Env } from "./env";
import { listProducts, readProductFile, readRepoFile, hasWriteToken, base64ToBytes, ghFetch, EgressDenied, ConflictError, ByteMismatchError } from "./github";
// ⚠️ catlabels.ts 已删除（A13）：它在**运行时解析官网 lib/products.ts** 去取分类显示名。
//    契约 v1.4 之后，显示名的真源是 taxonomy.json，而 products.ts 里的 CATEGORY_LABELS
//    本身就是从 taxonomy 派生的 ⇒ 那条路径变成"解析一个派生值"。
//    留着它 = 留一份看起来还在用、其实指错方向的代码。
import { validateSiteContent, mergeSiteContent, serializeSiteContent, changedFields, SEO_PAGES, SEO_LIMITS } from "./sitecontent";
import { crossReference, PRODUCT_IMG_PREFIX } from "./media";
import { classify, mergeCommits } from "./audit";
import { commitFiles, type CommitFile } from "./gitcommit";
import { planImages, planDelete, repoPath, type Upload } from "./imagepaths";
import {
  validateProduct, mergeProduct, checkSlugMatchesPath, serializeProduct, actionableWarnCount, INFO_CODES,
  STATUSES, META_DESCRIPTION_MAX, modelKey, type Axes,
} from "./contract";
import {
  validateTaxonomy, axesOf, valuesOf, refsOf, unreadableCount, addItem, editItem, deleteItem,
  serializeTaxonomy, AXIS_LABEL, type Taxonomy, type Axis,
} from "./taxonomy";
import { summarizeDiff } from "./diff";
import { verifyAccessJwt, AccessDenied } from "./access";

// ⚠️ Variables.operator：身份由鉴权中间件从**验过签的令牌**里取出来放进这里。
//    下游一律读它，⛔ 不要再去读 `cf-access-authenticated-user-email` 那个明文头 ——
//    验签之后头仍然在，但它只是"边缘顺手放的一份拷贝"，没有任何东西保证它与令牌一致。
const app = new Hono<{ Bindings: Env; Variables: { operator: string } }>();

/**
 * 这个请求的操作人。**唯一来源是验过签的 Access 令牌。**
 * 🔴 它会被写进 commit message 和审计日志 ⇒ 取错来源 = 审计记录指认错人，
 *    而那种错在事后完全查不出来（日志里就是一个合法邮箱）。
 * dev 旁路下没有令牌 ⇒ "dev-bypass"，与生产不可能重名。
 */
const operatorOf = (c: any): string | null =>
  c.get("operator") || (c.env.DEV_BYPASS_AUTH === "1" ? "dev-bypass" : null);


// ───────────────────────── fail-closed 鉴权 ─────────────────────────
//
// admin.airsonde.com 应当在 Cloudflare Access 后面：未登录请求在**边缘**就被拦。
// 到达本 Worker 的请求必须带 `Cf-Access-Authenticated-User-Email`。
//
// 🔴 这一层不是"重复 Access"。它挡的是 Access **不在**的那些情况：
//    误开 workers.dev、Access 应用被误删、将来多一条不经 Access 的路由。
//    没有它，上述任何一种发生时后台就是**裸奔的**，而且没有人会收到通知。
//    ⇒ 所以哪怕边缘那道门还没挂上，这个 worker 也不会 200 —— 它只会 403。
//
// ⚠️ **没有 Basic Auth 兜底 = 故意的。** M2 之后这个 worker 会持有能写数据仓的 token，
//    兜底口就是后门。任何一道不确定就拒绝，不放行。
app.use("*", async (c, next) => {
  // ① 开发旁路：**只在本机生效**，靠的不是"记得别在生产配"。
  //    ⚠️ 用另一个环境变量（ENVIRONMENT=development 之类）去守它，等于用一份配置守另一份配置——
  //       两个都配错的那天它照样敞着。宿主名是**请求自带的事实**，配不出来。
  //    🔴 生产上出现这个变量 ⇒ 直接 500 停服，而不是"忽略它继续跑"：
  //       一个被误配的后门应该让服务停、让人立刻看见，而不是让服务安静地敞着。
  if (c.env.DEV_BYPASS_AUTH === "1") {
    const h = new URL(c.req.url).hostname;
    const isLocal = h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h.endsWith(".localhost");
    if (!isLocal) {
      console.error(JSON.stringify({ evt: "auth_bypass_in_production", host: h }));
      return c.text("配置错误：DEV_BYPASS_AUTH 出现在非本机环境。已拒绝服务——请移除该变量后重新部署。", 500);
    }
    return next();
  }

  // ② 🔴 **验 Access JWT 的签名**，不再裸读 `cf-access-authenticated-user-email`。
  //
  //    以前这里读那个明文头，再查 worker 自己的 `ALLOWED_EMAILS`。两个问题：
  //    · 那份名单要与 Access 策略**手工同步**，而 2026-08-27 就因为它们不同步吃了一次
  //      （Access 四个邮箱、名单三个 ⇒ 同事过了 Access 拿到 403）。
  //      Joe 要的是「我自己定义谁能登录，不用再找你们加」⇒ Access 成为**唯一名单**。
  //    · 而"删掉名单、继续裸读那个头"是**不安全的**：那样安全性完全挂在
  //      `workers_dev:false` + 所有路由都在 Access 后面这两条配置上，而**没有任何东西在检查它们**。
  //      加一条不经 Access 的路由，那个头就可以随便伪造 —— 且没有症状。
  //    ⇒ 验签。验过 = 这个请求确实经过了**本应用**的 Access，与路由怎么配无关。
  //
  // ⚠️ 配置缺失一律 500 不 403：那是部署错，不是"你没权限"。
  //    混成一个码，排查的人会去查用户权限，而问题在配置。
  if (!c.env.ACCESS_TEAM_DOMAIN || !c.env.ACCESS_AUD) {
    console.error(JSON.stringify({ evt: "auth_access_config_missing",
      team: !!c.env.ACCESS_TEAM_DOMAIN, aud: !!c.env.ACCESS_AUD }));
    return c.text("配置错误：ACCESS_TEAM_DOMAIN / ACCESS_AUD 未配置。为安全起见已拒绝全部请求。", 500);
  }
  const jwt = c.req.header("cf-access-jwt-assertion");
  try {
    const claims = await verifyAccessJwt(jwt || "", {
      teamDomain: c.env.ACCESS_TEAM_DOMAIN,
      aud: c.env.ACCESS_AUD,
    });
    // 身份取自**验过签的令牌**，不取那个明文头 —— 头可以伪造，令牌不能。
    c.set("operator", claims.email);
  } catch (e) {
    if (e instanceof AccessDenied) {
      console.error(JSON.stringify({ evt: "auth_denied", why: String(e.message), path: c.req.path }));
      return c.text(`Cloudflare Access 验证未通过：${e.message}`, 403);
    }
    // ⚠️ 非预期错误也拒。"验不了就先放行"是这类闸最常见的死法。
    console.error(JSON.stringify({ evt: "auth_error", msg: String(e) }));
    return c.text("鉴权过程出错，已拒绝。", 403);
  }
  return next();
});

// ───────────────────── 进程身份：任何联调的第一步 ─────────────────────
//
// 🔴 这条不是可选的健康检查。铁律是"先证明我在跟谁说话"：
//    僵尸进程占端口、curl 全打到老进程、部署了但边缘还在服务旧版本——
//    这些故障的症状和代码 bug 一模一样，而不先证身份就会去改代码。
//
// ⭐ 三个来源，越往上越伪造不了：
//    deploy.versionId  —— Cloudflare 写的，代码碰不到
//    git.sha           —— deploy.mjs 部署那一刻从 git 现算并注入
//    request.colo/host —— 请求自带的事实
//
// ⚠️ 绝不硬编码版本号。GIT_SHA 缺失时**明说缺失**（null + warning），
//    而不是回一个看起来像样的占位串 —— 那样这个端点就从"证据"退化成"装饰"。
app.get("/api/_whoami", (c) => {
  const vm = c.env.CF_VERSION_METADATA;
  const sha = c.env.GIT_SHA || null;
  const cf = (c.req.raw as any).cf as { colo?: string } | undefined;
  const isDev = c.env.DEV_BYPASS_AUTH === "1";

  const warnings: string[] = [];
  if (!sha && !isDev) {
    warnings.push("GIT_SHA 未注入 —— 这次部署不是走 `npm run deploy` 发的，无法确认它对应哪个 commit。");
  }
  if (c.env.GIT_DIRTY === "1") {
    warnings.push("部署时工作区是脏的（有未提交改动）—— GIT_SHA 不足以还原这次部署的字节。");
  }

  return c.json({
    app: "airsonde-admin",
    // 🔴 这个字段一度长期写着「M1（只读，无写入能力）」，而那时它早就能写了。
    //    一个**诊断端点里的假话**是最坏的一种假话：出事时第一个被引用的就是它。
    //    ⇒ 别再写死阶段名。能力由**同一份事实**推出来（下面 data.writeEnabled 也是它算的）。
    milestone: c.env.ALLOW_GITHUB_WRITE === "1" && hasWriteToken(c.env)
      ? "可写（写入闸已开、token 已配）"
      : "只读（写入闸未开或 token 未配 —— 见 data.writeGateOpen / ghTokenConfigured）",
    deploy: {
      // 拿不到就是 null，别编一个占位串。
      // ⚠️ 更正（2026-08-12 实测）：本地 `wrangler dev` **也会**给一个 version_metadata id
      //    （每次重载换一个）。所以「有 versionId」不代表「这是生产」——
      //    要判是不是生产，看 request.host / isLocalDev，不要看这个字段。
      versionId: vm?.id ?? null,
      versionTag: vm?.tag ?? null,
      versionTimestamp: vm?.timestamp ?? null,
      source: vm ? "cloudflare version_metadata 绑定（平台写入）" : "不可用（没有该绑定）",
    },
    git: {
      sha,
      shortSha: sha ? sha.slice(0, 7) : null,
      dirty: c.env.GIT_DIRTY === "1",
      buildTime: c.env.BUILD_TIME || null,
      // ⚠️ "谁发的"必须是看得见的事实：CI 接上后仍出现 local，说明有人绕过了自动部署，
      //    而那正是"生产上跑的到底是哪一版"开始说不清的那一刻。
      deploySource: c.env.DEPLOY_SOURCE || null,
      ciBuildUuid: c.env.CI_BUILD_UUID || null,
      ciBranch: c.env.CI_BRANCH || null,
    },
    request: {
      host: new URL(c.req.url).hostname,
      colo: cf?.colo ?? null,
      isLocalDev: isDev,
    },
    data: {
      repo: c.env.GITHUB_REPO || null,
      branch: c.env.GITHUB_BRANCH || null,
      productsDir: c.env.PRODUCTS_DIR || null,
      // 只报有无，绝不报值。⚠️ dev 看的是 GITHUB_TOKEN_SELFTEST（靶子仓专用），
      //    生产看的是 GITHUB_TOKEN —— 两者互不回落，见 github.ts 的 tokenFor()。
      ghTokenConfigured: hasWriteToken(c.env),
      // ⭐ 界面的按钮文案和横幅**由这个字段决定**，不是各写各的。
      //    写死文案的话，闸的状态和界面说的话迟早不一致 —— 而那时界面说的是假话。
      //    ⚠️ 两个条件缺一不可：闸开着、且 token 在。少一个就写不成。
      writeEnabled: c.env.ALLOW_GITHUB_WRITE === "1" && hasWriteToken(c.env),
      writeGateOpen: c.env.ALLOW_GITHUB_WRITE === "1",
    },
    // 🔴 取**验过签的**身份，不取明文头。这一行尤其要紧：
    //    /api/_whoami 是"我在跟谁说话"的权威答复，它自己要是读了一个可伪造的头，
    //    那么每一次"先证身份"的排查都建立在一个伪造得了的值上。
    operator: operatorOf(c),
    // ───── 两道门。**这里只报得出其中一道，另一道必须明说看不见** ─────
    //
    // ⚠️ Access（边缘那道）的策略名单，这个 worker **看不到**：
    //    ① 请求到得了这里，就说明它已经过了 Access —— 被挡住的那些**根本不产生请求**；
    //    ② 拿 CF API 去查也不行：无 Zero Trust 权限时 `GET /access/apps` 会返回
    //       `success:true` + **空列表**，与"真的一个应用都没有"**同形**（2026-08 实测）。
    //       用它下结论，等于把"我没权限看"读成"那里没有门"。
    // ⇒ 只报 worker 侧这道，并把"另一道看不见"作为**结论的一部分**说出去。
    //    ⚠️ 两道门的名单**必须集合相等**：Access 放进来而这里没有 ⇒ 那个人看到 403；
    //       这里有而 Access 没有 ⇒ 那个人连页面都打不开。两种症状完全不同，修法也不同。
    access: {
      // 🔴 **不再有"后台名单"这个东西。** Access 策略是唯一名单（2026-08-27）。
      //    ⛔ 这里故意不再返回 allowlist 字段：留一个空数组的话，界面会渲染出
      //       一张"0 人"的名单，而那正是我们要消灭的第二份名单的样子。
      singleSource: "Cloudflare Access 策略",
      teamDomain: c.env.ACCESS_TEAM_DOMAIN || "（未配置）",
      audConfigured: !!c.env.ACCESS_AUD,
      accessPolicyVisible: false,
      accessPolicyNote:
        "谁能进由 **Cloudflare Access 策略**说了算，改它不需要动这个后台、也不需要重新部署。" +
        "本后台看不到那份名单（被 Access 挡下的请求根本到不了这里；CF API 在无 Zero Trust 权限时" +
        "返回的空列表与真·零应用同形，不能据此下结论）—— 但**也不需要看到了**：" +
        "这个 worker 只验令牌的签名与 aud，名单在谁手里就由谁说了算。",
      // ⚠️ 这一条必须说出来：两份名单意外形成的双层没了。
      writeImplication:
        "🔴 统一之后「能进」就等于「能写」—— 写入闸是全局的、不分人。" +
        "往 Access 策略里加一个人 = 给他改官网产品数据的权限，不只是「给他看看」。",
    },
    warnings,
  });
});


// ═══════════ 分类轴（机型 / 传感器）—— 契约 v1.4 的真源 ═══════════
//
// 🔴 官网仓的 `src/data/taxonomy.json` 是**唯一真源**：官网 content.config.ts 与
//    lib/products.ts 都从它读，本后台从 A13 起可以增删改它。
// 🔴🔴 **删除在用的取值时，官网构建不会兜底**（W18 四层实验实测：只有删
//    `node_modules/.astro/data-store.json` 才失败）⇒ 这里的删除闸是**唯一防线**。
const taxonomyPath = (env: Env): string => env.TAXONOMY_PATH || "src/data/taxonomy.json";

async function loadTaxonomy(env: Env): Promise<{ tax: Taxonomy; sha: string; path: string }> {
  const path = taxonomyPath(env);
  const f = await readRepoFile(env, path);
  if (!f.exists) throw new Error(`官网仓里没有 ${path} —— 分类轴的真源不在，拒绝据此下任何结论。`);
  let tax: Taxonomy;
  try { tax = JSON.parse(f.text!); }
  catch (e) { throw new Error(`${path} 不是合法 JSON（${e}）—— 拒绝在坏文件上做任何修改。`); }
  const v = validateTaxonomy(tax);
  // ⚠️ 真源坏了就**停**，不"尽量用"：用半份轴去校验产品，会把合法产品判成非法。
  if (!v.ok) throw new Error(`${path} 未通过校验：${v.errors.map((e) => e.field + " " + e.code).join("; ")}`);
  return { tax, sha: f.sha!, path };
}

/** 校验产品时要用的轴 —— **每次都从真源现读**，不缓存成模块级常量。 */
const loadAxes = async (env: Env): Promise<Axes> => axesOf((await loadTaxonomy(env)).tax);

// ───────────────────── M1 只读打通：列产品数据文件 ─────────────────────
app.get("/api/products", async (c) => {
  try {
    return c.json(await listProducts(c.env));
  } catch (e) {
    if (e instanceof EgressDenied) {
      console.error(JSON.stringify({ evt: "egress_denied", msg: String(e.message) }));
      return c.json({ error: "出站被本地策略拒绝", detail: String(e.message) }, 403);
    }
    // ⚠️ 读失败绝不降级成空列表。空列表意味着"那里没有产品"，
    //    而这里的事实是"我没读到" —— 两句话不一样。
    console.error(JSON.stringify({ evt: "products_list_failed", msg: String(e) }));
    return c.json({ error: "读取 GitHub 失败", detail: String(e) }, 502);
  }
});

// ─────────── 列表所需的全部元数据（表格要缩略图/标题/状态/机型，光有文件名不够）───────────
//
// ⚠️ 为什么单开一个 expand 而不是让前端逐个拉：列表页要一次画出 23 行，
//    前端逐个拉就是 23 个串行往返，列表会一行一行地"长出来"，而且筛选/计数在数据到齐前都是错的。
//    这里并发拉一次，前端拿到的就是完整的一页。

/**
 * 全部产品的展开视图 —— `/api/products-expanded` 与**删除闸的引用检查**共用同一份。
 * 🔴 各读各的话，会出现"列表说 15 个在用、删除闸说 0 个"这种分歧，
 *    而分歧发生时被信的往往是那个放行的。
 * ⚠️ 读不出来的产品**保留在结果里并带 error 字段** —— 过滤掉的话，
 *    它引用的取值会凭空变成"没人用"，于是删除闸放行。
 */
async function listExpanded(env: Env): Promise<any[]> {
  const axes = await loadAxes(env);
  const list = await listProducts(env);
  return Promise.all(list.files.map(async (f) => {
    try {
      const r = await readProductFile(env, f.slug);
      if (!r.exists || !r.text) return { slug: f.slug, error: "读不到" };
      let p: any;
      try { p = JSON.parse(r.text); }
      catch (e) { return { slug: f.slug, error: "不是合法 JSON", detail: String(e).slice(0, 120) }; }
      const v = validateProduct(p, axes);
      return {
        slug: f.slug, name: p.name ?? null, model: p.model ?? null,
        category: p.category ?? null, status: p.status ?? null,
        image: p.images?.main ?? null, sensors: p.sensors ?? [],
        hasSupplierRef: !!p.supplierRef,
        valid: v.ok, errorCount: v.errors.length,
        warnCount: actionableWarnCount(v.warnings),
        size: f.size,
      };
    } catch (e) { return { slug: f.slug, error: String(e).slice(0, 120) }; }
  }));
}

app.get("/api/products-expanded", async (c) => {
  try {
    const list = await listProducts(c.env);
    const items = await listExpanded(c.env);
    return c.json({ ...list, items });
  } catch (e) {
    console.error(JSON.stringify({ evt: "expand_failed", msg: String(e) }));
    return c.json({ error: "读取失败", detail: String(e) }, 502);
  }
});

// ─────────── 审计日志：谁在什么时候改了哪个产品 ───────────
//
// 数据源就是 git commit 链 —— 不另存审计表。另存一份就有两个真源，
// 而"审计表说改过、git 说没改过"这种分歧恰恰会在出事时出现。
// ⚠️ **两条路径都要查**：产品 JSON 与图片是分开的目录，只查一条会漏掉纯图片改动。
app.get("/api/audit", async (c) => {
  const repo = c.env.GITHUB_REPO, branch = c.env.GITHUB_BRANCH, dir = c.env.PRODUCTS_DIR;
  if (!repo || !branch || !dir) return c.json({ error: "配置缺失" }, 500);
  const limit = Math.min(Number(c.req.query("limit") || 60), 100);
  // ── ?slug=<slug>：单个产品的改动记录（crm-skin D 批 §4，编辑页侧栏「记录」卡用）──
  // ⚠️ 口径按**数据文件**算（<dir>/<slug>.json 的 commits）：admin 的每次保存（含图片操作）都会
  //    碰这个 JSON，所以后台写的都在；别处**只动图片不动 JSON** 的改动不在这份里 —— 界面上写明。
  // ⛔ slug 先过形状闸再拼路径：查询参数直接进 GitHub API path，不能什么都收。
  const slugQ = c.req.query("slug");
  if (slugQ !== undefined && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slugQ)) {
    return c.json({ error: "slug 形状不对" }, 400);
  }
  try {
    const fetchPath = async (path: string) => {
      const r = await ghFetch(c.env, `/repos/${repo}/commits?sha=${branch}&path=${encodeURIComponent(path)}&per_page=${limit}`);
      if (!r.ok) throw new Error(`读 commits(${path}) 失败 ${r.status}：${(await r.text()).slice(0, 160)}`);
      return ((await r.json()) as any[]).map((x) =>
        classify(x.sha, x.commit?.message || "", x.commit?.author?.date || "", x.html_url || ""));
    };
    const [data, imgs] = slugQ
      ? [await fetchPath(`${dir}/${slugQ}.json`), []]     // 单产品：只查那个文件；图片目录是全目录级，查了也分不出是谁的
      : await Promise.all([fetchPath(dir), fetchPath("src/assets/products")]);
    const entries = mergeCommits(data, imgs).slice(0, limit);
    const fromAdmin = entries.filter((e) => e.source === "admin").length;
    return c.json({
      repo, branch, entries,
      total: entries.length, fromAdmin, fromOther: entries.length - fromAdmin,
      // ⚠️ 这句要说出来：日志里**包含**别处推的改动，否则人会以为"这就是后台干的全部"
      note: "包含所有改动过产品数据/图片的 commit —— 后台写的标 admin，Web 窗或直接推送的标 other。",
    });
  } catch (e) {
    console.error(JSON.stringify({ evt: "audit_failed", msg: String(e) }));
    return c.json({ error: "读取审计日志失败", detail: String(e) }, 502);
  }
});

// ─────────── A8 媒体库：图片清单 + 引用对账（孤儿扫描）───────────
//
// ⛔ **只报告，绝不自动删。** 判错一张在用的图 = 官网当场缺图，而删除不可逆。
//    要删由人在界面上逐张确认（走既有的 PUT/DELETE 路径），这里不提供"一键清理孤儿"。
app.get("/api/media", async (c) => {
  const repo = c.env.GITHUB_REPO, branch = c.env.GITHUB_BRANCH;
  if (!repo || !branch) return c.json({ error: "配置缺失：GITHUB_REPO / GITHUB_BRANCH" }, 500);
  try {
    // ① 仓内全部 blob
    const rr = await ghFetch(c.env, `/repos/${repo}/git/trees/${branch}?recursive=1`);
    if (!rr.ok) throw new Error(`读 tree 失败 ${rr.status}：${(await rr.text()).slice(0, 200)}`);
    const tj = (await rr.json()) as any;
    if (tj.truncated) {
      // ⚠️ 截断的树里"找不到某张图"和"那张图不存在"长得一模一样 ——
      //    在这种输入上做孤儿判定会把在用的图判成孤儿。宁可停。
      return c.json({ error: "仓内文件数超出一次 tree 查询上限（truncated），拒绝在不完整清单上做孤儿判定" }, 503);
    }
    const blobs = (tj.tree || [])
      .filter((t: any) => t.type === "blob")
      .map((t: any) => ({ path: t.path as string, size: (t.size as number) ?? 0, sha: t.sha as string }));

    // ② 全部产品 JSON（引用来自**解析后的字段**，不是文本匹配）
    const list = await listProducts(c.env);
    const products = await Promise.all(list.files.map(async (f) => {
      try {
        const r = await readProductFile(c.env, f.slug);
        if (!r.exists || !r.text) return { slug: f.slug, images: null, unreadable: true };
        return { slug: f.slug, images: (JSON.parse(r.text) as any).images ?? null };
      } catch { return { slug: f.slug, images: null, unreadable: true }; }
    }));

    // 🔴 有产品读不出来 ⇒ 它声明的引用我们看不见 ⇒ 那些图会被误判成孤儿。
    //    这种情况下**不给孤儿结论**，只给清单 —— 半份输入算不出可信的孤儿。
    const unreadable = products.filter((p: any) => p.unreadable).map((p: any) => p.slug);
    const report = crossReference(blobs, products as any);

    return c.json({
      repo, branch,
      ...report,
      unreadable,
      orphansTrustworthy: unreadable.length === 0,
      note: unreadable.length
        ? `⚠️ 有 ${unreadable.length} 个产品读不出来（${unreadable.join("、")}），它们声明的引用看不见 ⇒ **本次孤儿结论不可信**，先修好那些文件。`
        : "孤儿仅供人工确认，本接口不提供自动删除。",
    });
  } catch (e) {
    console.error(JSON.stringify({ evt: "media_failed", msg: String(e) }));
    return c.json({ error: "读取媒体库失败", detail: String(e) }, 502);
  }
});

// ─────────── 图片页新能力（crm-skin E 批 §7，Joe 点名）───────────
//
// 🔴 前置事实（实测官网 src/lib/products.ts）：产品图的 glob 是 **单层 `products/*.webp` 且 eager:true** ——
//    ① 任何子目录（_draft/、originals/、以及这里新建的文件夹）都**天然在构建之外**；
//    ② 反过来，**上传到 products/ 根的图会被 eager glob 全部打进产物**，哪怕没人引用。
//    ⇒ 上传**必须选文件夹，⛔ 不许传根** —— 传根等于把素材直接塞进官网构建物。
//
// ⚠️ 传上去的图不挂任何产品 ⇒ 在媒体页会立刻出现在「未被引用」里（areaOf 把 products/<folder>/ 判为
//    published 区、referencedBy 为空 ⇒ orphan）—— 这是它的**可见出口**（SPEC §7：⛔ 不能传了就消失）。

/** 文件夹名/文件名的形状闸：小写字母数字连字符。查询值要进 GitHub API 路径，⛔ 什么都收等于让人注入路径。 */
const MEDIA_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** 保留目录：语义已有主，⛔ 不许当普通文件夹建/传。 */
const MEDIA_RESERVED = new Set(["_draft", "originals"]);

app.post("/api/media/folder", async (c) => {
  const body = await c.req.json().catch(() => null) as { name?: string } | null;
  const name = String(body?.name || "").trim().toLowerCase();
  if (!MEDIA_NAME_RE.test(name)) return c.json({ wrote: false, error: "文件夹名只能用小写字母、数字和连字符（如 banners、expo-2026）。" }, 422);
  if (MEDIA_RESERVED.has(name)) return c.json({ wrote: false, error: `「${name}」是保留目录（草稿区/原图存档），不能当普通文件夹建。` }, 422);
  try {
    // 已存在就拒 —— "建了但其实早就有"会让人以为自己丢了东西
    const probe = await ghFetch(c.env, `/repos/${c.env.GITHUB_REPO}/contents/${PRODUCT_IMG_PREFIX}${name}?ref=${encodeURIComponent(c.env.GITHUB_BRANCH!)}`);
    if (probe.ok) return c.json({ wrote: false, error: `文件夹「${name}」已经存在。` }, 409);
    const r = await commitFiles(c.env, {
      message: `admin: create media folder ${name} (${operatorOf(c)})`,
      // .gitkeep：git 不存空目录，占位文件让目录立刻可见
      files: [{ path: `${PRODUCT_IMG_PREFIX}${name}/.gitkeep`, text: "" }],
    });
    return c.json({ wrote: true, what: `新建文件夹 ${name}`, commitSha: r.commitSha, commitUrl: r.commitUrl });
  } catch (e) {
    if (e instanceof EgressDenied) return c.json({ wrote: false, error: "出站被本地策略拒绝", detail: String((e as Error).message) }, 403);
    console.error(JSON.stringify({ evt: "media_folder_failed", msg: String(e) }));
    return c.json({ wrote: false, error: "新建文件夹失败", detail: String(e) }, 502);
  }
});

app.post("/api/media/upload", async (c) => {
  const body = await c.req.json().catch(() => null) as { folder?: string; files?: { name?: string; base64?: string }[] } | null;
  const folder = String(body?.folder || "").trim().toLowerCase();
  const files = Array.isArray(body?.files) ? body!.files! : [];
  // 🔴 必须选文件夹（见顶部前置事实②）；⛔ 根、⛔ 保留目录
  if (!MEDIA_NAME_RE.test(folder)) return c.json({ wrote: false, error: "必须选择一个文件夹 —— 传到根目录会被官网构建全部打包，哪怕没人用。" }, 422);
  if (MEDIA_RESERVED.has(folder)) return c.json({ wrote: false, error: `「${folder}」是保留目录，不能往里传 —— 草稿区/原图存档由产品保存流程管理。` }, 422);
  if (!files.length || files.length > 20) return c.json({ wrote: false, error: "一次 1–20 张。" }, 422);
  try {
    const commits: { path: string; base64: string }[] = [];
    const seen = new Set<string>();
    for (const f of files) {
      const stem = String(f.name || "").trim().toLowerCase().replace(/\.webp$/, "");
      if (!MEDIA_NAME_RE.test(stem)) return c.json({ wrote: false, error: `文件名「${f.name}」不合规：小写字母、数字、连字符（界面应先规范化）。未产生任何 commit。` }, 422);
      if (!f.base64) return c.json({ wrote: false, error: `「${stem}.webp」没有内容。未产生任何 commit。` }, 422);
      try { assertWebp(base64ToBytes(f.base64), `图片(${stem}.webp)`); }
      catch (e) { return c.json({ wrote: false, error: "图片不合格，未产生任何 commit", detail: String((e as Error).message) }, 422); }
      const path = `${PRODUCT_IMG_PREFIX}${folder}/${stem}.webp`;
      if (seen.has(path)) return c.json({ wrote: false, error: `这一批里有两个「${stem}.webp」。未产生任何 commit。` }, 422);
      seen.add(path);
      // 已存在就整批拒 —— ⛔ 静默覆盖：素材库里同名不同图是查不出来的账
      const probe = await ghFetch(c.env, `/repos/${c.env.GITHUB_REPO}/contents/${path}?ref=${encodeURIComponent(c.env.GITHUB_BRANCH!)}`);
      if (probe.ok) return c.json({ wrote: false, error: `「${folder}/${stem}.webp」已存在，⛔ 不覆盖。换个文件名再传。未产生任何 commit。` }, 409);
      commits.push({ path, base64: f.base64 });
    }
    const r = await commitFiles(c.env, {
      message: `admin: upload ${commits.length} image(s) to ${folder}/ (${operatorOf(c)})`,
      files: commits,
    });
    return c.json({ wrote: true, what: `上传 ${commits.length} 张到 ${folder}/`, commitSha: r.commitSha, commitUrl: r.commitUrl,
      note: "这些图还没挂任何产品 ⇒ 会出现在「未被引用」里 —— 那是它们的入口，不是错误。" });
  } catch (e) {
    if (e instanceof EgressDenied) return c.json({ wrote: false, error: "出站被本地策略拒绝", detail: String((e as Error).message) }, 403);
    console.error(JSON.stringify({ evt: "media_upload_failed", msg: String(e) }));
    return c.json({ wrote: false, error: "上传失败", detail: String(e) }, 502);
  }
});

// ─────────── 批量操作：一次批量 = **一个** commit ───────────
//
// 🔴 为什么合成一个 commit（与 wanew-admin 的 publishBulk 同一条路）：
//    ① **原子**：要么全改要么全不改。逐个 commit 的话，中途失败会留下"改了一半"的状态，
//       而那种状态没人知道它存在，直到官网上出现一半上架一半没上架。
//    ② **一次构建**：逐个 commit = N 次 Pages 重建，官网被反复刷。
//    ③ **审计**：一条 commit 里列全 slug，比翻 N 条 commit 容易看。
// ⚠️ 契约闸对**每一个**产品照过；有任何一个不过 ⇒ **整批不写**，并把是谁挡的说清楚。
//    这条是有意的：批量里混进一个坏数据时，"其余的照常写"会让人以为整批都成了。
app.post("/api/products/batch", async (c) => {
  const operator = operatorOf(c);
  if (!operator) return c.json({ error: "拿不到操作人身份，拒绝写入" }, 403);

  // `expectedShas` 是 { slug: 打开列表时读到的该文件 blob sha }。
  // 🔴 批量一次动多个文件 ⇒ 锁也必须**逐个文件**，⛔ 不是一把总锁。
  let body: { slugs?: string[]; op?: string; value?: string; expectedShas?: Record<string, string> };
  try { body = await c.req.json(); } catch (e) { return c.json({ error: "请求体不合法", detail: String(e) }, 400); }
  const slugs = [...new Set(body.slugs || [])];
  if (!slugs.length) return c.json({ wrote: false, error: "没有选中任何产品" }, 400);
  const expectedShas: Record<string, string> = body.expectedShas && typeof body.expectedShas === "object"
    ? body.expectedShas : {};
  // 🔴 缺锁就拒。批量这里判在**整批**层面：一个旧页面根本不会带这个字段，
  //    ⇒ 与其逐条报"这条没锁"，不如一句话说清"你这页是旧的"。
  // ⚠️ 逐条缺失（名单里有、sha 查不到）在下面循环里单独处理 —— 那是另一种情况。
  const missing = slugs.filter((s) => !expectedShas[s]);
  if (missing.length === slugs.length) return c.json(missingLock("这些产品"), 428);

  // 轴从真源现读 —— 批量改机型的合法值必须包含 Joe 刚新增的那个
  let axes: Axes;
  try { axes = await loadAxes(c.env); }
  catch (e) { return c.json({ wrote: false, error: "读不到分类轴", detail: String(e) }, 502); }

  // ⭐ 允许批改的字段是**白名单**，不是"body 里给什么就改什么"。
  //    后者等于把整个产品结构暴露成批量接口：哪天有人传 op:"supplierRef"，
  //    一次就能把 23 个产品的内部字段全改掉，而契约闸拦不住（那是合法字段）。
  const OPS: Record<string, readonly string[]> = { status: STATUSES, category: axes.categories };
  const op = String(body.op || "");
  const allowed = OPS[op];
  if (!allowed) {
    return c.json({ wrote: false, error: `未知批量操作：${body.op}（只支持 ${Object.keys(OPS).join(" / ")}）` }, 400);
  }
  if (!allowed.includes(String(body.value))) {
    return c.json({ wrote: false, error: `${op} 非法：${body.value}（只能是 ${allowed.join(" | ")}）` }, 400);
  }
  const value = String(body.value);

  try {
    const files: CommitFile[] = [];
    const changed: string[] = [];
    const skipped: { slug: string; why: string }[] = [];   // ⭐ 跳过的必须数出来并报出去
    const rejected: { slug: string; codes: string[] }[] = [];
    const conflicts: { slug: string; why: string }[] = [];  // 🔴 被别人改过的，逐个点名
    let imageOps = 0;

    for (const slug of slugs) {
      const f = await readProductFile(c.env, slug);
      if (!f.exists) { skipped.push({ slug, why: "文件不存在" }); continue; }

      // 🔴 **逐个文件各判各的**：一批里某一个被别人改过，只有那一个算冲突。
      //    ⛔ 不整批失败（另外 4 个是好的，凭什么陪葬）、⛔ 也不整批放行（那就等于没锁）。
      //    ⇒ 冲突的进 `conflicts` 并**点名**，与 `skipped`/`rejected` 分开报 —— 三种原因修法不同。
      const exp = expectedShas[slug];
      // 🔴 逐条缺锁也不许放行：整批带了字段、但**这一条**查不到 sha
      //    （例如列表里没有它）⇒ 它没有保护，⛔ 不能因为"别的有"就顺带写了它。
      if (!exp) { conflicts.push({ slug, why: "这一条没有版本号，无法确认它有没有被别人改过 ⇒ 未写入。请刷新页面后重试。" }); continue; }
      const cf = staleConflict(exp, f.sha, "这个产品");
      if (cf) { conflicts.push({ slug, why: cf.detail }); continue; }

      let existing: any;
      try { existing = JSON.parse(f.text!); }
      catch { skipped.push({ slug, why: "不是合法 JSON，拒绝在它上面改" }); continue; }

      if (existing[op] === value) { skipped.push({ slug, why: `已经是 ${value}` }); continue; }

      const { merged } = mergeProduct(existing, { [op]: value });
      // ⚠️ 图片的落点只由 **status** 决定（published→products/，其余→products/_draft/）。
      //    批改 category 时这里传的是**没变的** status ⇒ planImages 算出 0 项搬迁，
      //    而不是"category 分支不调用 planImages"。一条路径，行为不可能分叉。
      const nextStatus = String((merged as any).status ?? existing.status ?? "");
      const plan = planImages(slug, nextStatus, existing.images ?? null, (merged as any).images ?? null, [], []);
      (merged as any).images = plan.images;

      const v = validateProduct(merged, axes);
      const si = checkSlugMatchesPath((merged as any).slug ?? "", `${slug}.json`);
      if (si) v.errors.push(si);
      if (!v.ok) { rejected.push({ slug, codes: v.errors.map((e) => e.code) }); continue; }

      files.push({ path: f.path, text: serializeProduct(merged) });
      for (const op of plan.ops) {
        if (op.op === "upsert") files.push({ path: op.path, base64: op.base64! });
        else if (op.op === "copy") files.push({ path: op.path, fromPath: op.fromPath! });
        else files.push({ path: op.path, remove: true });
      }
      imageOps += plan.ops.length;
      changed.push(slug);
    }

    // 🔴 有任何一个被契约闸挡下 ⇒ 整批不写。
    if (rejected.length) {
      return c.json({
        wrote: false,
        reason: "批量中有产品未通过契约校验，**整批未写入**（不产生任何 commit）",
        rejected, skipped, wouldChange: changed,
      }, 422);
    }
    if (!changed.length) {
      // ⚠️ 冲突与"本来就无需改"是**两种不同的原因**，⛔ 不能混成一句话。
      //    🔴 这里第一版写的是「选中的产品**全部**被别人改过（N 个）」——
      //       而实测那次是 **1 个冲突 + 4 个本就是目标状态**，那句话**是假的**。
      //       ⇒ 两个数各自报，谁是 0 就不提谁。
      const why = [];
      if (conflicts.length) why.push(`${conflicts.length} 个被别人改过（${conflicts.map((x) => x.slug).join("、")}）`);
      if (skipped.length) why.push(`${skipped.length} 个本来就无需改动`);
      return c.json({ wrote: false, skipped, conflicts,
        reason: why.length ? `未写入任何东西：${why.join("；")}` : "没有需要改动的产品" });
    }

    const r = await commitFiles(c.env, {
      message:
        `admin: bulk ${op}=${value} · ${changed.length} 个产品 (${operator})\n\n` +
        changed.map((s) => `- ${s}`).join("\n") +
        (imageOps ? `\n\n图片 ${imageOps} 项改动（随状态搬家）` : "") +
        `\n来源：admin.airsonde.com`,
      files,
    });
    console.log(JSON.stringify({ evt: "bulk_ok", operator, op, value, count: changed.length, commit: r.commitSha }));

    return c.json({ wrote: true, ...r, changed, skipped, conflicts, imageOps,
      note: `已在**一个 commit** 里改了 ${changed.length} 个产品`
        + (skipped.length ? `，跳过 ${skipped.length} 个` : "")
        // 🔴 冲突必须出现在**成功**的这条回执里 —— 否则"改了 4 个"看起来像全做完了，
        //    而第 5 个被别人改过、这次没动它，人却不知道。
        + (conflicts.length ? `。⚠️ 另有 ${conflicts.length} 个**被别人改过、这次没有动**：${conflicts.map((x) => x.slug).join("、")}` : "")
        + "。" });
  } catch (e) {
    if (e instanceof EgressDenied) return c.json({ wrote: false, error: "写能力未开启", detail: String(e.message) }, 403);
    if (e instanceof ConflictError) return c.json({ wrote: false, error: "并发冲突", detail: String(e.message) }, 409);
    if (e instanceof ByteMismatchError) return c.json({ wrote: "unknown", error: "字节校验不一致", detail: String(e.message) }, 500);

    // ⚠️ 「要搬动的文件在仓里不存在」是**某一个产品的数据问题**，不是"批量功能坏了"。
    //    报成不透明的 502 的话，操作的人看到"批量操作失败"却不知道是谁害的，
    //    只能一个个试 —— 而错误消息里其实带着路径，路径里就有 slug。
    //    ⇒ 归因到 slug，按与契约拒绝一致的形状返回（422 + rejected），整批同样不写。
    const msg = String(e);
    const miss = /要搬动的文件在仓里不存在：(\S+)/.exec(msg);
    if (miss) {
      const path = miss[1]!;
      const guilty = slugs.find((s) => path.includes(s)) || "(认不出是哪个产品)";
      console.error(JSON.stringify({ evt: "bulk_missing_image", operator, path, guilty }));
      return c.json({
        wrote: false,
        reason: "批量中有产品的图片文件在仓里不存在，**整批未写入**（不产生任何 commit）",
        rejected: [{ slug: guilty, codes: ["image_missing"], detail: `JSON 指向 ${path}，但该文件不在仓里` }],
        hint: "这条是数据本身不一致：产品 JSON 声明了一张图，而那张图没被提交进仓。先补上图或改掉 images.main。",
      }, 422);
    }

    console.error(JSON.stringify({ evt: "bulk_failed", operator, msg }));
    return c.json({ wrote: false, error: "批量操作失败", detail: msg }, 502);
  }
});

// ───────────────────── 读单个产品 ─────────────────────
app.get("/api/products/:slug", async (c) => {
  const slug = c.req.param("slug");
  try {
    const f = await readProductFile(c.env, slug);
    if (!f.exists) return c.json({ slug, exists: false, path: f.path, product: null, validation: null }, 404);

    const axes = await loadAxes(c.env);
    let product: unknown = null;
    let parseError: string | null = null;
    try { product = JSON.parse(f.text!); }
    catch (e) { parseError = String(e); }

    // 🔴 解析失败**绝不返回 `{}`**。返 `{}` 加上前端的 `|| ""` 兜底，
    //    再加上无条件覆盖，就是"静默清空还返 ok"那条已经吃过亏的路。
    if (parseError) {
      return c.json({ slug, exists: true, path: f.path, sha: f.sha, product: null, parseError,
        raw: f.text, hint: "文件不是合法 JSON。请先修好它——本后台不会替它猜内容。" }, 422);
    }

    return c.json({
      slug, exists: true, path: f.path, sha: f.sha,
      product, raw: f.text,
      validation: validateProduct(product, axes),
      slugPathIssue: checkSlugMatchesPath((product as any)?.slug ?? "", `${slug}.json`),
    });
  } catch (e) {
    console.error(JSON.stringify({ evt: "product_read_failed", slug, msg: String(e) }));
    return c.json({ error: "读取 GitHub 失败", detail: String(e) }, 502);
  }
});

// ───────────────── A2-2：写入的 dry-run（**不会真写**）─────────────────
//
// 🔴 这个端点**没有能力**写。不是"我们没去调写接口"，是出站口（src/github.ts）
//    在 `ALLOW_GITHUB_WRITE !== "1"` 时拒绝一切非 GET，而那个变量此刻故意没配。
//    ⇒ 即使这里将来被人加了一行 POST，它也会在出站口被挡住。
//
// ⚠️ 总工 2026-08-09 明确：Web 窗此刻正在写同一批文件，真写入会撞；且写公开仓需要
//    token（`ghTokenConfigured:false`）。真写入等他通知，不在本批。
app.post("/api/products/:slug/preview", async (c) => {
  const slug = c.req.param("slug");
  let patch: Record<string, unknown>;
  let previewUploads: Upload[] = [];
  let previewRemove: number[] = [];
  try {
    const body = await c.req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("请求体必须是 JSON 对象");
    // ⚠️ 与 PUT **同一个信封**。两个端点各收各的形状，就会出现"预览通过但保存被拒"，
    //    而那种不一致一旦发生，人就不再相信预览了 —— 预览的全部价值是它可信。
    if (!(body as any).patch || typeof (body as any).patch !== "object") throw new Error("缺少 patch 字段");
    patch = (body as any).patch as Record<string, unknown>;
    previewUploads = ((body as any).uploads || []) as Upload[];
    previewRemove = ((body as any).removeGallery || []) as number[];
  } catch (e) {
    return c.json({ error: "请求体不合法", detail: String(e) }, 400);
  }

  try {
    const f = await readProductFile(c.env, slug);

    let existing: Record<string, unknown> | null = null;
    if (f.exists) {
      try { existing = JSON.parse(f.text!); }
      catch (e) {
        // ⚠️ 现有文件坏了就停。在一份解析不出来的文件上做 merge，
        //    等于拿"我以为的原内容"去覆盖真内容 —— 那是数据丢失，不是保存。
        return c.json({ error: "现有文件不是合法 JSON，拒绝在它上面合并", path: f.path, detail: String(e) }, 422);
      }
    }

    const { merged, cleared, touched } = mergeProduct(existing, patch);
    // 与 PUT 同一套图片规划 —— 预览必须显示"图片会被搬到哪里"，那是这次改动的一部分
    const plan = planImages(
      slug, String((merged as any).status || "draft"),
      (existing as any)?.images ?? null, (merged as any).images ?? null,
      previewUploads, previewRemove,
    );
    (merged as any).images = plan.images;

    const axes = await loadAxes(c.env);
    const validation = validateProduct(merged, axes);
    const slugIssue = checkSlugMatchesPath((merged as any).slug ?? "", `${slug}.json`);
    if (slugIssue) validation.errors.push(slugIssue);

    const newText = serializeProduct(merged);
    const oldText = f.text ?? "";
    const diff = summarizeDiff(oldText, newText);

    return c.json({
      mode: "dry-run",
      // 🔴 这三个字段是这个响应里最重要的话，放最前面：**什么都没写。**
      wrote: false,
      writeCapability: c.env.ALLOW_GITHUB_WRITE === "1" ? "已开启（⚠️但本端点仍不写）" : "未开启（出站口拒绝一切非 GET）",
      note: "这是预览。没有向 GitHub 发起任何写请求，官网数据仓未被改动。",

      target: { path: f.path, exists: f.exists, currentSha: f.sha },
      ok: validation.ok && !diff.identical,
      validation,
      change: {
        touched,                      // 真的变了值的字段
        cleared,                      // 显式传 null 清空的字段
        identical: diff.identical,    // JSON 逐字节一致
        // 🔴 **"这次保存会不会改到东西"要看这一条，不是 identical。**
        //    identical 只说 JSON；只换一张图时 JSON 确实没变，但**图必须写进去**。
        //    ⚠️ 真实写入路径（下面那个 PUT）判的一直是 `diff.identical && plan.ops.length === 0`，
        //       而 dry-run 只发了 identical ⇒ 界面据它决定给不给提交按钮 ⇒
        //       **只换图不改字段时按钮根本不出现，图永远传不上去。**
        //       两边判的不是同一件事 —— 这个字段就是为了让它们判同一件事。
        wouldChange: !diff.identical || plan.ops.length > 0,
        added: diff.added,
        removed: diff.removed,
      },
      diff: diff.lines,
      // 图片会被怎么处理，预览里就要说清楚 —— 这是这次改动的一部分，不是"顺带发生的事"
      imageOps: plan.ops.map((o) => ({ op: o.op, path: o.path, fromPath: o.fromPath, why: o.why })),
      wouldWrite: { bytes: new TextEncoder().encode(newText).length, text: newText },
    });
  } catch (e) {
    if (e instanceof EgressDenied) {
      console.error(JSON.stringify({ evt: "egress_denied", slug, msg: String(e.message) }));
      return c.json({ error: "出站被策略拒绝", detail: String(e.message) }, 403);
    }
    console.error(JSON.stringify({ evt: "preview_failed", slug, msg: String(e) }));
    return c.json({ error: "预览失败", detail: String(e) }, 502);
  }
});

// ───────────────── A4：真实写入 ─────────────────
//
// 🔴 流程与 preview **完全共用前半段**（读 → merge → 校验 → 序列化）。
//    不共用的话会出现"预览通过但保存被拒"或者更糟的反过来 —— 那时人会不再相信预览。
//
// ⚠️ 校验不通过 ⇒ **在发出任何写请求之前**返回，绝不产生 commit。
//    这道闸的全部价值就是拦在**不可逆那一步之前**，"警告一下继续提交"等于没有它。
// 图片：只收 webp。
// 🔴 这不是偷懒，是让"文件名"和"文件内容"不可能不一致：`uploadName()` 一律产出 `.webp`，
//    若同时收 png/jpg，就会出现内容是 PNG 而扩展名是 .webp 的文件 —— Astro 与浏览器
//    多半仍能显示，于是这个错**不会有任何症状**，直到某天某个工具按扩展名去解析它。
//    ⇒ 界面负责在 canvas 里转成 webp，服务端只认 webp，并且**按magic bytes 认，不按扩展名**。
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
function assertWebp(bytes: Uint8Array, label: string): void {
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new Error(`${label} 有 ${(bytes.length / 1024 / 1024).toFixed(2)}MB，超过 2MB 上限。`);
  }
  // RIFF....WEBP
  const isWebp = bytes.length > 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  if (!isWebp) {
    throw new Error(`${label} 不是 WebP（按文件头判断，不看扩展名）。界面应当先在浏览器里转成 WebP 再上传。`);
  }
}

/**
 * 🔴 乐观锁 —— **全仓只有这一处实现**。
 *
 * 判据是**文件自己的 blob sha**，⛔ 不是分支 HEAD。
 * ⚠️ 这不是随便挑的，是量出来的（2026-08-28）：官网仓 3 小时内 14 个 commit、
 *    相邻间隔中位数 **3.1 分钟**，而其中只有 5 个碰了产品 JSON。
 *    ⇒ 用分支 HEAD 当锁，**编辑超过 3 分钟就必然冲突**（别人传一张图就推一个 commit），
 *      而真正的冲突只可能来自"同一个文件被改过"。**粒度选错，锁就变成了拒服务。**
 *
 * 📌 旧的 `baseHeadSha`/`expectedHeadSha` 那条路已删：**服务端读它、客户端从来不发**，
 *    ⇒ 它从上线那天起就是空转的。⛔ 不留没人走的旧路 —— 那正是它当初失效而无人察觉的方式。
 *
 * @param expected 调用方读到数据那一刻的 sha（随同数据在**同一个响应**里返回 ⇒ 没有时间缝隙）
 * @param actual   此刻仓里的 sha
 */
/**
 * 🔴 「缺锁就拒」—— 请求根本没带版本号时的回绝。
 *
 * ⚠️ 为什么不能"没带就放行"：`if (expected && …)` 这种写法**对"没传"和"传了且正确"给同一个结果** ——
 *    于是哪天客户端忘了传，保护就**静默消失**，而没有任何症状。
 *    📌 本仓前科：`baseHeadSha` 服务端读、客户端从来不发，空转了很久没人发现。
 *
 * 🔴 文案是给 **Joe** 看的，不是给我们看的：
 *    ⛔ 绝不出现"缺少 expectedSha 字段"这种话 —— 他看到只会以为后台坏了。
 *    要说清**四**件事：**这页是旧的 / 它少带了什么 / 刷新后重做 / 你没损失什么**。
 *
 * ⚠️ 第四件是总工 2026-08-28 补的，而它不是客套：
 *    人撞上这种拒绝时，第一反应是"**我刚才改的东西是不是白改了**"。
 *    🔴 而我第一版只写了「没有写入任何东西，这个产品还是原来的样子」——
 *       那句话在他眼里可能正好读成"我的改动没了"。**说清损失，和说清怎么办一样重要。**
 */
function missingLock(what: string) {
  return {
    wrote: false as const,
    error: "页面是旧版本",
    detail: `你这个页面是**打开得比较久的旧版本**，它在保存时没有带上"防止两个人同时改坏同一份数据"所需的版本号。`
      + `\n\n⇒ 请**刷新页面**（Ctrl+R），然后重做这次修改。`
      + `\n\n✅ **数据没丢**：${what}在仓里还是原来的样子，这次一个字都没写进去；`
      + `你刚才在屏幕上填的内容也还在（刷新前可以先复制走）。`,
  };
}

function staleConflict(expected: string | null | undefined, actual: string | null | undefined, what: string) {
  if (!expected || expected === actual) return null;
  return {
    wrote: false as const,
    error: "并发冲突",
    detail: `${what}在你打开它之后被改过了（你基于 ${String(expected).slice(0, 7)}，现在是 ${String(actual).slice(0, 7)}）。`
      + `请重新读一次再改 —— 直接覆盖会把别人的改动弄丢。`,
  };
}

interface WriteEnvelope {
  patch?: Record<string, unknown>;
  uploads?: { slot: "main" | number; base64: string }[];
  removeGallery?: number[];
  /**
   * 🔴 打开这个产品时读到的**文件 blob sha**（`GET /api/products/:slug` 的 `sha`）。
   * ⚠️ 它与产品数据在**同一个响应**里返回 ⇒ ⛔ 不存在"保存时再去取一次"的时间缝隙（那种锁等于没有）。
   */
  expectedSha?: string;
  /** true = 这是"新建"，若文件已存在则拒绝（slug 唯一性）。 */
  mustCreate?: boolean;
}

app.put("/api/products/:slug", async (c) => {
  const slug = c.req.param("slug");
  const operator = operatorOf(c);
  if (!operator) return c.json({ error: "拿不到操作人身份，拒绝写入" }, 403);

  let env0: WriteEnvelope;
  try {
    const body = await c.req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("请求体必须是 JSON 对象");
    env0 = body as WriteEnvelope;
    if (!env0.patch || typeof env0.patch !== "object") throw new Error("缺少 patch 字段");
  } catch (e) {
    return c.json({ error: "请求体不合法", detail: String(e) }, 400);
  }
  const patch = env0.patch!;
  const uploads: Upload[] = env0.uploads || [];

  try {
    const f = await readProductFile(c.env, slug);

    // slug 唯一性：新建时文件已存在 ⇒ 拒绝。
    // ⚠️ 不能"存在就当成更新" —— 那会让人在毫不知情的情况下覆盖掉另一个产品。
    if (env0.mustCreate && f.exists) {
      return c.json({ wrote: false, error: "slug 已被占用", detail: `${f.path} 已经存在。换一个 slug，或去编辑那个已有的产品。` }, 409);
    }

    // 🔴 缺锁就拒：文件已经存在却没带版本号 ⇒ 这是个旧页面，⛔ 不许放行。
    //    ⚠️ **新建**天然没有版本号（文件还不存在）⇒ 只在 `f.exists` 时要求它，
    //       否则会把"新建产品"整条路堵死。
    if (f.exists && !env0.expectedSha) return c.json(missingLock("这个产品"), 428);

    // 🔴 乐观锁：在**合并与写入之前**判。⛔ 不能放到 commitFiles 那一步 —— 那时图片可能已经处理过了。
    const conflict = staleConflict(env0.expectedSha, f.sha, "这个产品");
    if (conflict) return c.json(conflict, 409);

    let existing: Record<string, unknown> | null = null;
    if (f.exists) {
      try { existing = JSON.parse(f.text!); }
      catch (e) {
        return c.json({ error: "现有文件不是合法 JSON，拒绝在它上面合并", path: f.path, detail: String(e) }, 422);
      }
    }

    // 图片先验，再谈别的 —— 坏图片就没必要往下走了
    for (const u of uploads) {
      try { assertWebp(base64ToBytes(u.base64), `图片(${u.slot === "main" ? "主图" : "gallery[" + u.slot + "]"})`); }
      catch (e) { return c.json({ wrote: false, error: "图片不合格，未产生任何 commit", detail: String((e as Error).message) }, 422); }
    }

    const { merged, cleared, touched } = mergeProduct(existing, patch);

    // ⭐ 图片位置按 status 归一化 —— 纯函数算，这里只消费结果。
    //    ⚠️ 必须在校验**之前**：校验器要看到最终的 images 值，否则它验的是一份不会被写入的东西。
    const plan = planImages(
      slug,
      String((merged as any).status || "draft"),
      (existing as any)?.images ?? null,
      (merged as any).images ?? null,
      uploads,
      env0.removeGallery || [],
    );
    (merged as any).images = plan.images;

    const axes = await loadAxes(c.env);
    const validation = validateProduct(merged, axes);
    const slugIssue = checkSlugMatchesPath((merged as any).slug ?? "", `${slug}.json`);
    if (slugIssue) validation.errors.push(slugIssue);

    // 🔴 拦在写之前。wrote:false 要说得明明白白 —— 让人一眼看出"没有产生 commit"。
    if (!validation.ok) {
      console.error(JSON.stringify({ evt: "write_rejected", slug, operator, codes: validation.errors.map((e) => e.code) }));
      return c.json({ wrote: false, reason: "契约校验未通过，未产生任何 commit", validation }, 422);
    }

    // ── 🔴 型号唯一性：**在服务端、写入的这一刻**算 ──
    //
    // ⚠️ 型号现在就是网址（W29）⇒ 两个产品同型号 = 两个产品抢同一个地址 ⇒
    //    官网会**跳过其中一个**（只打印警告、不失败）⇒ 站上安静地少一个产品。
    // 🔴 ⛔ 不能只在客户端表单里查：两个人同时保存时，各自拿的是**自己加载时**的那份名单，
    //    **两边都会通过**。乐观锁也挡不住这类 —— 那是两个不同文件，两把锁都放行。
    // ⚠️ 判重按**规范化后的值**（`modelKey`：trim + 小写 + `/`→`-`）：
    //    `ak19` / `AK19` / `AK19 ` 落到同一个网址，字面比较会放它们过去。
    const wantKey = modelKey((merged as any).model);
    if (wantKey) {
      const all = await listExpanded(c.env);
      const clash = all.find((p: any) =>
        p && !p.error && p.slug !== slug && modelKey(p.model) === wantKey);
      if (clash) {
        return c.json({
          wrote: false, error: "型号已被占用",
          // ⛔ 不许只说"型号重复" —— 要说得出**是谁占着**，否则他没法处理
          detail: `型号 ${JSON.stringify(String((merged as any).model))} 已经被产品「${clash.name || clash.slug}」`
            + `（slug: ${clash.slug}）占用。型号就是官网地址 ⇒ 两个产品同型号，官网会跳过其中一个。`
            + `换一个型号，或先去改那个产品的型号。`,
          conflictWith: { slug: clash.slug, name: clash.name, model: clash.model },
        }, 409);
      }
    }

    const newText = serializeProduct(merged);
    const diff = summarizeDiff(f.text ?? "", newText);
    // 内容没变**且没有文件要动**才算无需提交。
    // ⚠️ 只看 JSON 是不够的：状态没变但换了一张图时 JSON 可能逐字节相同，而图必须写进去。
    if (diff.identical && plan.ops.length === 0) {
      return c.json({ wrote: false, reason: "内容与现有文件逐字节相同、且没有图片变动，无需提交", change: { identical: true } });
    }

    // ── 组装一次原子提交：产品 JSON + 所有图片动作 ──
    const files: CommitFile[] = [{ path: f.path, text: newText }];
    for (const op of plan.ops) {
      if (op.op === "upsert") files.push({ path: op.path, base64: op.base64! });
      else if (op.op === "copy") files.push({ path: op.path, fromPath: op.fromPath! });
      else files.push({ path: op.path, remove: true });
    }

    const imgSummary = plan.ops.length ? `，图片 ${plan.ops.length} 项` : "";
    const fields = [...touched, ...cleared.map((k) => `-${k}`)];
    const result = await commitFiles(c.env, {
      message:
        `admin: ${f.exists ? "update" : "create"} ${slug} (${operator})\n\n` +
        `字段：${fields.length ? fields.join(", ") : "(无字段变化)"}${imgSummary}\n` +
        `来源：admin.airsonde.com`,
      files,
      // ⛔ 旧的 expectedHeadSha（分支 HEAD）已删：粒度错、且客户端从来不发 ⇒ 空转。锁在上面按文件 sha 判。
    });
    console.log(JSON.stringify({ evt: "write_ok", slug, operator, commit: result.commitSha, fields: touched, imageOps: plan.ops.length }));

    return c.json({
      wrote: true,
      ...result,
      created: !f.exists,
      change: { touched, cleared, added: diff.added, removed: diff.removed },
      imageOps: plan.ops.map((o) => ({ op: o.op, path: o.path, why: o.why })),
      validation,
      note: "已提交到数据仓（JSON 与图片在同一个 commit）。CF Pages 会自动重建 —— 线上生效有延迟，不是没写成功。",
    });
  } catch (e) {
    if (e instanceof EgressDenied) {
      console.error(JSON.stringify({ evt: "egress_denied", slug, msg: String(e.message) }));
      return c.json({ wrote: false, error: "写能力未开启", detail: String(e.message) }, 403);
    }
    if (e instanceof ConflictError) {
      return c.json({ wrote: false, error: "并发冲突", detail: String(e.message) }, 409);
    }
    if (e instanceof ByteMismatchError) {
      // ⚠️ 这一条 commit 可能已经产生了。绝不能说成"保存失败"——那会让人再存一次。
      console.error(JSON.stringify({ evt: "byte_mismatch", slug, msg: String(e.message) }));
      return c.json({ wrote: "unknown", error: "字节校验不一致，需要人工核对", detail: String(e.message) }, 500);
    }
    console.error(JSON.stringify({ evt: "write_failed", slug, operator, msg: String(e) }));
    return c.json({ wrote: false, error: "写入失败", detail: String(e) }, 502);
  }
});

// ───────────────── 删除产品（JSON + 它的图，一个 commit）─────────────────
//
// ⚠️ 只删这个产品**自己引用**的文件。不做"扫描孤儿图然后清理"那种事 ——
//    引用扫描漏掉任何一种写法，就会把别人还在用的图删掉，而那是不可逆的。
app.delete("/api/products/:slug", async (c) => {
  const slug = c.req.param("slug");
  const operator = operatorOf(c);
  if (!operator) return c.json({ error: "拿不到操作人身份，拒绝删除" }, 403);

  try {
    const f = await readProductFile(c.env, slug);
    if (!f.exists) return c.json({ wrote: false, error: "产品不存在", path: f.path }, 404);

    // 🔴 删除也要过乐观锁：⛔ 删掉一个"别人刚改过"的产品，改动连同文件一起没了，
    //    而删除是**不可逆**的 —— 这一条比保存更需要它。
    const delExpected = c.req.query("expectedSha") || undefined;
    if (!delExpected) return c.json(missingLock("这个产品"), 428);
    const delConflict = staleConflict(delExpected, f.sha, "这个产品");
    if (delConflict) return c.json(delConflict, 409);

    let existing: Record<string, unknown>;
    try { existing = JSON.parse(f.text!); }
    catch {
      // 文件坏了仍然允许删 —— 但只删 JSON 本身，不去猜它引用了哪些图。
      const r = await commitFiles(c.env, {
        message: `admin: delete ${slug} (${operator})\n\n⚠️ 该文件不是合法 JSON，只删除了数据文件，未删任何图片。\n来源：admin.airsonde.com`,
        files: [{ path: f.path, remove: true }],
      });
      return c.json({ wrote: true, ...r, warning: "文件不是合法 JSON，图片未删除，请人工确认 src/assets/products/ 下是否有残留。" });
    }

    const ops = planDelete(f.path, (existing as any).images ?? null);
    const r = await commitFiles(c.env, {
      message:
        `admin: delete ${slug} (${operator})\n\n` +
        `删除：${ops.map((o) => o.path.replace(/^src\//, "")).join("、")}\n` +
        `来源：admin.airsonde.com`,
      files: ops.map((o) => ({ path: o.path, remove: true as const })),
    });
    console.log(JSON.stringify({ evt: "delete_ok", slug, operator, commit: r.commitSha, files: ops.length }));

    return c.json({
      wrote: true, ...r,
      // ⚠️ 基线里本来就没有的路径要报出来，不能静默跳过 —— 静默会掩盖"我以为删了"
      note: r.skippedRemoves.length
        ? `已删除。⚠️ 以下路径在仓里本来就不存在，未删：${r.skippedRemoves.join("、")}`
        : "已删除（数据文件与它引用的图片在同一个 commit）。CF Pages 会自动重建。",
    });
  } catch (e) {
    if (e instanceof EgressDenied) return c.json({ wrote: false, error: "写能力未开启", detail: String(e.message) }, 403);
    if (e instanceof ConflictError) return c.json({ wrote: false, error: "并发冲突", detail: String(e.message) }, 409);
    console.error(JSON.stringify({ evt: "delete_failed", slug, operator, msg: String(e) }));
    return c.json({ wrote: false, error: "删除失败", detail: String(e) }, 502);
  }
});

// ═══════════ 站点内容：联系方式 / 首页文案 / 站级 SEO ═══════════
//
// 真源是官网仓的**一个** JSON（SITE_CONTENT_PATH），官网 src/data/site.ts 从它读。
//
// 🔴 后台只写 JSON，**永远不写 .ts**。重写 TS 的出错方式是产出一个语法合法
//    但语义变了的文件 —— 契约闸看不出来，tsc 也可能看不出来，而它会直接上线。
// 🔴 路径**写死在服务端**，不接受调用方传。做成参数的话，这个端点就成了
//    "往官网仓任意位置写文件"，而那正是整套出站闸在防的事。
const siteContentPath = (env: Env): string => env.SITE_CONTENT_PATH || "src/data/site-content.json";

app.get("/api/site-content", async (c) => {
  const path = siteContentPath(c.env);
  try {
    const f = await readRepoFile(c.env, path);
    if (!f.exists) {
      return c.json({ path, exists: false, sha: null, content: null,
        hint: "官网仓里还没有这个文件。它由官网仓维护（src/data/site.ts 从它读），本后台不会自己创建它。" }, 404);
    }
    let content: unknown = null, parseError: string | null = null;
    try { content = JSON.parse(f.text!); } catch (e) { parseError = String(e); }
    // 🔴 解析失败绝不返回 {} —— 那会让前端的表单显示成"所有字段都是空的"，
    //    而一旦有人在那个状态下按保存，就是把整份内容清空。
    if (parseError) {
      return c.json({ path, exists: true, sha: f.sha, content: null, parseError,
        hint: "文件不是合法 JSON。**本后台拒绝在它上面做任何修改** —— 在坏文件上做合并，结果是不可预料的。" }, 422);
    }
    // ⚠️ 页面清单与长度阈值一并发给界面：前端**不抄第二份** ——
    //    抄一份的话，这里改了阈值而界面还按旧的提示，两边说的话就不一样了。
    // ── 首页精选：把「这些 slug 现在是什么状态」一起发过去 ──
    // 🔴 ⛔ **绝不在这里静默过滤掉坏条目** —— 那样 Joe 永远不知道自己的列表里有坏的，
    //    而首页会安静地少一张卡。⇒ 原样返回，附上每一条的实况，界面负责标红。
    // ⚠️ 产品清单读失败不该让整页读不出来 ⇒ 降级成"这一段没核过"，并说出来。
    let featured: any = null;
    try {
      const products = await listExpanded(c.env);
      const by = new Map(products.filter((p: any) => p && !p.error).map((p: any) => [p.slug, p]));
      const list: string[] = Array.isArray((content as any)?.home?.featuredSlugs)
        ? (content as any).home.featuredSlugs : [];
      featured = {
        checked: true,
        items: list.map((slug) => {
          const p = by.get(slug);
          // ⚠️ 卡片要画缩略图和型号 ⇒ 一并发过去。
          //    坏条目这两样**必然是 null**（产品不存在或读不出来）——
          //    界面要能靠这个画出"坏卡"，⛔ 而不是取不到图就跳过它。
          return { slug, exists: !!p, status: p?.status ?? null, name: p?.name ?? null,
                   image: p?.image ?? null, model: p?.model ?? null,
                   ok: !!p && p.status === "published" };
        }),
        // 可选清单：**只有已上架的**。未上架的选了等于选了一个官网上不存在的页面。
        选得到的: products.filter((p: any) => p && !p.error && p.status === "published")
          .map((p: any) => ({ slug: p.slug, name: p.name, image: p.image, model: p.model })),
      };
    } catch (e) {
      featured = { checked: false, why: `产品清单读失败：${String(e)}`, items: null, 选得到的: [] };
    }
    return c.json({ path, exists: true, sha: f.sha, content,
      pages: SEO_PAGES, limits: SEO_LIMITS, featured,
      validation: validateSiteContent(content) });
  } catch (e) {
    return c.json({ path, error: "读取失败", detail: String(e) }, 502);
  }
});

app.put("/api/site-content", async (c) => {
  const operator = operatorOf(c);
  if (!operator) return c.json({ wrote: false, error: "拿不到操作人身份，拒绝写入" }, 403);

  const path = siteContentPath(c.env);
  let body: { patch?: unknown; expectedSha?: string | null; section?: string };
  try { body = await c.req.json(); } catch (e) { return c.json({ wrote: false, error: "请求体不合法", detail: String(e) }, 400); }
  if (!body.patch || typeof body.patch !== "object" || Array.isArray(body.patch)) {
    return c.json({ wrote: false, error: "patch 必须是一个对象" }, 400);
  }

  try {
    const f = await readRepoFile(c.env, path);
    if (!f.exists) return c.json({ wrote: false, error: `官网仓里没有 ${path}，本后台不会创建它` }, 404);

    let existing: any;
    try { existing = JSON.parse(f.text!); }
    catch { return c.json({ wrote: false, error: "现有文件不是合法 JSON，拒绝在它上面改" }, 422); }

    // ⚠️ 乐观锁：expectedSha 是"这次编辑所基于的那一版"。不带的话，两个人先后保存，
    //    后一个会**静默覆盖**前一个 —— 而两边都看到"保存成功"。
    const scConflict = staleConflict(body.expectedSha, f.sha, "这个文件");
    if (scConflict) return c.json(scConflict, 409);

    const merged = mergeSiteContent(existing, body.patch);
    const v = validateSiteContent(merged);
    if (!v.ok) {
      return c.json({ wrote: false, reason: "未通过站点内容校验，**没有产生任何 commit**", validation: v }, 422);
    }

    const text = serializeSiteContent(merged);
    if (text === f.text) {
      // 空 commit 会让审计日志里多一条"改过"，而实际上什么都没变
      return c.json({ wrote: false, reason: "内容与仓里的完全相同，无需写入", validation: v });
    }

    const fields = changedFields(existing, merged);
    const label = body.section === "contact" ? "联系方式" : body.section === "home" ? "首页" : body.section === "seo" ? "SEO" : "站点内容";
    const r = await commitFiles(c.env, {
      message:
        `admin: site ${label} (${operator})\n\n` +
        `字段：${fields.length ? fields.join(", ") : "(无字段变化)"}\n` +
        `来源：admin.airsonde.com`,
      files: [{ path, text }],
      // 锁已在上面按文件 blob sha 判过（staleConflict）⇒ 这里不再传分支 HEAD。
    });
    console.log(JSON.stringify({ evt: "site_content_ok", operator, section: body.section, fields, commit: r.commitSha }));
    return c.json({ wrote: true, ...r, changedFields: fields, validation: v,
      note: "已提交。官网由 Cloudflare Pages 重建，约 1 分钟后站上可见。" });
  } catch (e) {
    if (e instanceof EgressDenied) return c.json({ wrote: false, error: "写能力未开启", detail: String(e.message) }, 403);
    if (e instanceof ConflictError) return c.json({ wrote: false, error: "并发冲突", detail: String(e.message) }, 409);
    if (e instanceof ByteMismatchError) return c.json({ wrote: "unknown", error: "字节校验不一致", detail: String(e.message) }, 500);
    console.error(JSON.stringify({ evt: "site_content_failed", operator, msg: String(e) }));
    return c.json({ wrote: false, error: "写入失败", detail: String(e) }, 502);
  }
});

// ───────────────────── 分类轴：现在**可管理**（契约 v1.4 / A13）─────────────────────
//
// 🔴 这一节以前写着「这一轴是冻结的……走总工，不在后台做」——**那句话已经不成立了**：
//    W18 把两个轴搬进了官网仓的 `src/data/taxonomy.json`（唯一真源），本后台可以增删改。
//    ⚠️ 留着那句旧话比没有更糟：人会照它去找总工，而总工会说"你自己在后台改"。
//
// 🔴🔴 **删除在用的取值时，官网构建不会兜底。** 见 taxonomy.ts 顶部那四层实验。
//    ⇒ 这里的引用检查是**唯一防线**，而且它必须**准确**：漏数一个 = 放行一次删除，
//      而后果要到某次毫不相关的提交时才爆，那时没人会想到是几天前删了个分类。
app.get("/api/taxonomy", async (c) => {
  try {
    const { tax, sha, path } = await loadTaxonomy(c.env);
    const products = await listExpanded(c.env);
    const unreadable = unreadableCount(products);
    const decorate = (axis: Axis) =>
      tax[axis].slice().sort((a, b) => a.order - b.order).map((it) => {
        const refs = refsOf(products, axis, it.value);
        return {
          ...it,
          refs,                       // 谁在用 —— 删除被拒时要列给人看
          refCount: refs.length,
          // 🔴 有产品读不出来时，"0 个在用"**不成立**：那不是"没人用"，是"我没看全"。
          canDelete: refs.length === 0 && unreadable === 0,
          /**
           * 官网 /products/ 的筛选栏上会不会出现这一条（机型轴才有意义）。
           * 🔴 **在这里算，不在界面上算。** 界面原来拿 `state.list` 自己数一遍 published，
           *    而同一行的「在用 N」出自上面这次扫描 —— 两个数来自**两次不同时刻的读取**。
           *    2026-08-26 亲眼见过它们分家：那次有 4 个产品读不出来，逐机型引用之和 19，
           *    产品数 23。同一行上"在用 0"与"筛选栏显示"完全可能同时出现，而没人看得出为什么。
           *    ⇒ 一行上的两个数字必须出自同一次扫描。
           */
          onSite: axis === "categories"
            && products.some((p: any) => p && !p.error && p.category === it.value && p.status === "published"),
        };
      });
    return c.json({
      path, sha,
      categories: decorate("categories"),
      sensors: decorate("sensors"),
      productCount: products.length,
      unreadable,
      unreadableNote: unreadable
        ? `有 ${unreadable} 个产品读不出来 —— 它们引用了什么看不见，所以**任何删除都先拒绝**。`
        : "",
      // 官网 /products/ 的筛选栏只列**有已上架产品**的机型（lib/products.ts 的 categoriesOf）。
      onSiteRule: "published > 0",
    });
  } catch (e) {
    return c.json({ error: "读取分类轴失败", detail: String(e) }, 502);
  }
});

app.put("/api/taxonomy", async (c) => {
  const operator = operatorOf(c);
  if (!operator) return c.json({ wrote: false, error: "拿不到操作人身份，拒绝写入" }, 403);

  let body: { axis?: Axis; op?: string; value?: string; label?: string; order?: number; expectedSha?: string };
  try { body = await c.req.json(); } catch (e) { return c.json({ wrote: false, error: "请求体不合法", detail: String(e) }, 400); }

  const axis = body.axis as Axis;
  if (axis !== "categories" && axis !== "sensors") {
    return c.json({ wrote: false, error: `未知的轴：${body.axis}（只支持 categories / sensors）` }, 400);
  }
  const value = String(body.value || "").trim();
  if (!value) return c.json({ wrote: false, error: "value 必填" }, 400);

  try {
    const { tax, sha, path } = await loadTaxonomy(c.env);
    const taxConflict = staleConflict(body.expectedSha, sha, "分类轴");
    if (taxConflict) return c.json(taxConflict, 409);

    let next: Taxonomy;
    let what: string;
    if (body.op === "add") {
      if (tax[axis].some((x) => x.value === value)) {
        return c.json({ wrote: false, error: `${AXIS_LABEL[axis]}里已经有「${value}」了` }, 422);
      }
      next = addItem(tax, axis, { value, label: String(body.label || value) });
      what = `新增${AXIS_LABEL[axis]} ${value}`;
    } else if (body.op === "edit") {
      // ⛔ 只改 label / order。value 一旦创建不可改 —— 它已经写进产品 JSON，改它 = 改数据。
      next = editItem(tax, axis, value, { label: body.label, order: body.order });
      what = `改${AXIS_LABEL[axis]} ${value} 的显示名`;
    } else if (body.op === "delete") {
      // 🔴🔴 唯一防线：自己数引用、自己拒绝。官网构建不会替我们把关。
      const products = await listExpanded(c.env);
      const unreadable = unreadableCount(products);
      if (unreadable) {
        return c.json({ wrote: false, error: "拒绝删除",
          detail: `有 ${unreadable} 个产品读不出来 —— 它们引用了什么看不见。此时"没人在用"这个结论不成立，所以先拒绝。` }, 422);
      }
      const refs = refsOf(products, axis, value);
      if (refs.length) {
        return c.json({ wrote: false, error: "拒绝删除：还有产品在用",
          refs, refCount: refs.length,
          detail: `「${value}」还被 ${refs.length} 个产品使用。先把它们改成别的${AXIS_LABEL[axis]}，再回来删。` +
                  `
⚠️ 官网构建**不会**替我们拦这一步（实测），所以这里必须拦。`,
        }, 422);
      }
      next = deleteItem(tax, axis, value);
      what = `删除${AXIS_LABEL[axis]} ${value}`;
    } else {
      return c.json({ wrote: false, error: `未知操作：${body.op}（只支持 add / edit / delete）` }, 400);
    }

    const v = validateTaxonomy(next);
    if (!v.ok) return c.json({ wrote: false, reason: "改完之后的分类轴未通过校验，**没有产生任何 commit**", errors: v.errors }, 422);

    const text = serializeTaxonomy(next);
    const cur = await readRepoFile(c.env, path);
    if (text === cur.text) return c.json({ wrote: false, reason: "内容与仓里的完全相同，无需写入" });

    const r = await commitFiles(c.env, {
      message: `admin: taxonomy ${what} (${operator})

来源：admin.airsonde.com`,
      files: [{ path, text }],
    });
    console.log(JSON.stringify({ evt: "taxonomy_ok", operator, axis, op: body.op, value, commit: r.commitSha }));
    return c.json({ wrote: true, ...r, what,
      note: "已提交。官网由 Cloudflare Pages 重建，约 1 分钟后生效。" });
  } catch (e) {
    if (e instanceof EgressDenied) return c.json({ wrote: false, error: "写能力未开启", detail: String(e.message) }, 403);
    if (e instanceof ConflictError) return c.json({ wrote: false, error: "并发冲突", detail: String(e.message) }, 409);
    if (e instanceof ByteMismatchError) return c.json({ wrote: "unknown", error: "字节校验不一致", detail: String(e.message) }, 500);
    console.error(JSON.stringify({ evt: "taxonomy_failed", operator, msg: String(e) }));
    return c.json({ wrote: false, error: "写入失败", detail: String(e) }, 502);
  }
});

// 契约的机器可读形态：界面用它渲染下拉框/多选框，避免枚举在前端被抄第二份。
// ⚠️ 前端硬编码一份枚举 = 第二个真源：契约改了，界面不会跟着变，而它看起来一切正常。
app.get("/api/contract", async (c) => {
  // ⚠️ 枚举从 taxonomy.json **现读**，不再是模块级常量 ——
  //    常量的话，Joe 在后台新增一个机型后，界面的下拉框不会有它。
  //
  // 🔴 读不出来时必须**说清是哪个文件读不出来**，不能让它冒成一个裸 500。
  //    实测（把 TAXONOMY_PATH 指到不存在的路径）：不接这一段，界面上的症状是
  //    "两个下拉框都是空的" —— 和"数据没加载完"长得一模一样，而真因在另一个仓的一个文件上。
  //    ⛔ 也不回落到 SAMPLE_*：回落的话下拉框会有值、看起来一切正常，
  //       而那些值来自后台自己抄的一份，与官网真源无关。宁可空着并说明白。
  // ⚠️ 读整份 taxonomy 而不是只读 axes：下拉框要的是 value **和** label 两样。
  let tax: Taxonomy;
  try {
    tax = (await loadTaxonomy(c.env)).tax;
  } catch (e) {
    return c.json({
      error: "读不到分类轴，界面的机型/传感器选项无法渲染",
      path: taxonomyPath(c.env),
      repo: c.env.GITHUB_REPO,
      detail: String(e),
    }, 502);
  }
  /** 一个轴的下拉选项：{value,label}，按 order 排。两个轴共用，写成两份迟早分家。 */
  const opts = (axis: Axis) =>
    tax[axis].slice().sort((a, b) => a.order - b.order)
      // ⚠️ label 空着就退回 value —— 但那是**兜底显示**，不是"没有显示名"这件事的答案：
      //    校验器不允许空 label，所以走到这里说明数据已经不合契约了。
      .map((it) => ({ value: it.value, label: it.label || it.value }));
  return c.json({
    version: "C1 v1.4",
    // 🔴 带 **label** 一起发：机型/传感器的显示名是 taxonomy.json 里的数据，
    //    只发 value 的话，界面上的下拉框只能拿 value 当文字 ——
    //    于是分类页显示「Desktop」、官网显示「Desktop」、而编辑器下拉写着「desktop」，
    //    **Joe 在分类页改了显示名，这两个下拉不跟着变**。那等于把刚做的功能废掉一半。
    //    ⛔ 界面不许自己抄一份 value→label 的映射表：那是第二个真源。
    // ⚠️ 顺序照 taxonomy.json 的 order —— 下拉框的顺序 = 文件里的顺序 = 分类页上的顺序。
    categories: opts("categories"),
    sensors: opts("sensors"),
    // ⚠️ status **不带 label**：它的中文说法（在线 / 未上架）是界面词汇，不是数据 ——
    //    界面里已经有唯一一张 STATUS_LABEL 表（tab、徽章、行内都用它）。
    //    在这里再发一份就是第二张表，两张表迟早分家。
    statuses: STATUSES,
    // 界面的每行字数计数器用它 —— ⛔ 界面不许自己抄一个数。
    // ⚠️ `highlight` 那一项已撤（A17：卖点长度不再限、不再警告 —— Joe 2026-09-03）；界面也不再读它。
    limits: { metaDescription: META_DESCRIPTION_MAX },
    // ⚠️ 判据落在**集合**上，界面不抄第二份：哪些 warning 属于"状态说明、不是待办"
    //    由契约说了算。界面写 `if (code === "internal_field")` 的话，
    //    下一个加同类 warning 的人不会知道有这条规矩。
    infoCodes: [...INFO_CODES],
  });
});

// ⭐ 没匹配上的路径 → 交给静态资源（界面在 public/）。
//
// ⚠️ `run_worker_first: true` 意味着**所有**请求都先进 worker，包括 `/` 和 `/app.js`。
//    Hono 默认对没匹配上的路径回 404 —— 不接这一句的话，界面**一个字节也出不来**，
//    而症状是"打开后台是一片 404"，看起来像资源没上传。
//    ⚠️ 这一句在鉴权中间件**之后**：静态页同样在 Access + 名单门后面，这是开
//       run_worker_first 的全部理由。
//
// ── 缓存头（2026-09-03，Joe 亲自踩到才补的）──
// 🔴 病根：`app.js?v=74` 那套指纹只护得住 **JS/CSS**，`index.html` 自己没有版本号 ——
//    型号排序的新表头写在 HTML 里，推上生产后 Joe 看到的还是缓存的旧页，要 Ctrl+F5。
//    "改了但用户看不见"的症状和"没做"一模一样（index.html 头部那段注释早写过这句话，
//    这次轮到 HTML 本身应验）。
// ⇒ 判据分两类，⛔ 别按扩展名列清单（列表会漏，第五个进来的类型一定没人记得加）：
//    · 回应是 HTML（或路径就是页面本身）⇒ no-cache：每次导航都向服务器核一次，
//      配 etag 仍能 304，代价是一次协商往返，不是整页重下。⛔ 不用 no-store —— 那连 304 都不给。
//    · 带 `?v=` 指纹的 ⇒ 长缓存 + immutable：内容变化必然换 URL（这仓的既有纪律，
//      index.html 头部写着"改 style.css / app.js 必须同时改这个数字"）。
//    · 其余（无指纹的散资源）⇒ 不动，维持平台默认 —— 本单只修 Joe 踩到的那一类。
app.notFound(async (c) => {
  const r = await c.env.ASSETS.fetch(c.req.raw);
  const res = new Response(r.body, r);   // ASSETS 的响应头是不可改的，必须先复制一份
  const url = new URL(c.req.url);
  const isHtml = (res.headers.get("content-type") || "").includes("text/html")
    || url.pathname === "/" || url.pathname.endsWith(".html");   // 304 可能不带 content-type，路径兜底
  if (isHtml) res.headers.set("cache-control", "no-cache, must-revalidate");
  else if (url.searchParams.has("v")) res.headers.set("cache-control", "public, max-age=31536000, immutable");
  return res;
});

export default app;


