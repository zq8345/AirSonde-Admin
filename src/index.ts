// AirSonde 产品后台（admin.airsonde.com）—— M1：只读打通。
//
// M1 范围：进程身份端点 + Access 门控 + GitHub 只读列目录。**没有任何写入能力。**
// 写入是 M2，单独派单。别在这个文件里"顺手"加保存端点。

import { Hono } from "hono";
import type { Env } from "./env";
import { listProducts, readProductFile, EgressDenied } from "./github";
import {
  validateProduct, mergeProduct, checkSlugMatchesPath, serializeProduct,
  CATEGORIES, SENSORS, STATUSES,
} from "./contract";
import { summarizeDiff } from "./diff";

const app = new Hono<{ Bindings: Env }>();

const ALLOW_LIST = (env: Env): string[] =>
  String(env.ALLOWED_EMAILS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

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

  // ② Access 头必须在（边缘那道门还在不在）
  const email = c.req.header("cf-access-authenticated-user-email");
  if (!email) {
    console.error(JSON.stringify({ evt: "auth_no_access_header", path: c.req.path }));
    return c.text("此后台需通过 Cloudflare Access 登录（airsonde-admin 应用）。", 403);
  }

  // ③ 邮箱名单。**空名单 = 拒绝所有**，绝不当成"不限制"——那是 fail-open。
  //    ⚠️ 但空名单是**部署错**，不是"你没权限"，所以回 500 不回 403：
  //       混成一个码，排查的人会去查用户权限，而问题在配置。
  const allow = ALLOW_LIST(c.env);
  if (!allow.length) {
    console.error(JSON.stringify({ evt: "auth_allowlist_missing" }));
    return c.text("配置错误：ALLOWED_EMAILS 未配置。为安全起见已拒绝全部请求——请配置后重新部署。", 500);
  }
  if (!allow.includes(email.trim().toLowerCase())) {
    console.error(JSON.stringify({ evt: "auth_denied", email }));
    return c.text("此账号不在本后台的允许名单内。", 403);
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
    milestone: "M1（只读，无写入能力）",
    deploy: {
      // dev 下 Cloudflare 不提供这个绑定，明说没有，别编一个
      versionId: vm?.id ?? null,
      versionTag: vm?.tag ?? null,
      versionTimestamp: vm?.timestamp ?? null,
      source: vm ? "cloudflare version_metadata 绑定（平台写入）" : "不可用（本地 dev 无此绑定）",
    },
    git: {
      sha,
      shortSha: sha ? sha.slice(0, 7) : null,
      dirty: c.env.GIT_DIRTY === "1",
      buildTime: c.env.BUILD_TIME || null,
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
      ghTokenConfigured: !!c.env.GITHUB_TOKEN, // 只报有无，绝不报值
    },
    operator: c.req.header("cf-access-authenticated-user-email") || (isDev ? "dev-bypass" : null),
    warnings,
  });
});

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

// ───────────────────── 读单个产品 ─────────────────────
app.get("/api/products/:slug", async (c) => {
  const slug = c.req.param("slug");
  try {
    const f = await readProductFile(c.env, slug);
    if (!f.exists) return c.json({ slug, exists: false, path: f.path, product: null, validation: null }, 404);

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
      validation: validateProduct(product),
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
  try {
    const body = await c.req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("请求体必须是 JSON 对象");
    patch = body as Record<string, unknown>;
  } catch (e) {
    return c.json({ error: "请求体不是合法 JSON 对象", detail: String(e) }, 400);
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
    const validation = validateProduct(merged);
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
        identical: diff.identical,    // 🔴 两边字节一致 ⇒ 这次保存什么也不会改
        added: diff.added,
        removed: diff.removed,
      },
      diff: diff.lines,
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

// 契约的机器可读形态：界面用它渲染下拉框/多选框，避免枚举在前端被抄第二份。
// ⚠️ 前端硬编码一份枚举 = 第二个真源：契约改了，界面不会跟着变，而它看起来一切正常。
app.get("/api/contract", (c) =>
  c.json({ version: "C1 v1", categories: CATEGORIES, sensors: SENSORS, statuses: STATUSES }));

// 根路径：界面在 public/ 里（assets 绑定），这里只兜住没有界面时的情况。
app.get("/", (c) =>
  c.text(
    "AirSonde Admin\n" +
      "  /api/_whoami                    进程身份（部署版本 / commit / 运行环境）\n" +
      "  /api/products                   列出产品 JSON\n" +
      "  /api/products/:slug             读单个产品（含契约校验结果）\n" +
      "  /api/products/:slug/preview     POST：校验 + diff 预览（**不会真写**）\n" +
      "  /api/contract                   契约枚举（界面用，避免前端抄第二份）\n",
  ),
);

export default app;
