// AirSonde 产品后台（admin.airsonde.com）—— M1：只读打通。
//
// M1 范围：进程身份端点 + Access 门控 + GitHub 只读列目录。**没有任何写入能力。**
// 写入是 M2，单独派单。别在这个文件里"顺手"加保存端点。

import { Hono } from "hono";
import type { Env } from "./env";
import { listProducts, readProductFile, hasWriteToken, base64ToBytes, ghFetch, EgressDenied, ConflictError, ByteMismatchError } from "./github";
import { crossReference } from "./media";
import { commitFiles, type CommitFile } from "./gitcommit";
import { planImages, planDelete, repoPath, type Upload } from "./imagepaths";
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

// ─────────── 列表所需的全部元数据（表格要缩略图/标题/状态/机型，光有文件名不够）───────────
//
// ⚠️ 为什么单开一个 expand 而不是让前端逐个拉：列表页要一次画出 23 行，
//    前端逐个拉就是 23 个串行往返，列表会一行一行地"长出来"，而且筛选/计数在数据到齐前都是错的。
//    这里并发拉一次，前端拿到的就是完整的一页。
app.get("/api/products-expanded", async (c) => {
  try {
    const list = await listProducts(c.env);
    const items = await Promise.all(list.files.map(async (f) => {
      try {
        const r = await readProductFile(c.env, f.slug);
        if (!r.exists || !r.text) return { slug: f.slug, error: "读不到" };
        let p: any;
        try { p = JSON.parse(r.text); }
        catch (e) {
          // ⚠️ 坏文件要**出现在列表里并标红**，不能被过滤掉 ——
          //    过滤掉的话，一个解析不了的产品会从后台彻底消失，没人知道它存在。
          return { slug: f.slug, error: "不是合法 JSON", detail: String(e).slice(0, 120) };
        }
        const v = validateProduct(p);
        return {
          slug: f.slug, name: p.name ?? null, model: p.model ?? null,
          category: p.category ?? null, status: p.status ?? null,
          image: p.images?.main ?? null, sensors: p.sensors ?? [],
          hasSupplierRef: !!p.supplierRef,
          valid: v.ok, errorCount: v.errors.length, warnCount: v.warnings.length,
          size: f.size,
        };
      } catch (e) { return { slug: f.slug, error: String(e).slice(0, 120) }; }
    }));
    return c.json({ ...list, items });
  } catch (e) {
    console.error(JSON.stringify({ evt: "expand_failed", msg: String(e) }));
    return c.json({ error: "读取失败", detail: String(e) }, 502);
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
  const operator = c.req.header("cf-access-authenticated-user-email")
    || (c.env.DEV_BYPASS_AUTH === "1" ? "dev-bypass" : null);
  if (!operator) return c.json({ error: "拿不到操作人身份，拒绝写入" }, 403);

  let body: { slugs?: string[]; op?: string; value?: string };
  try { body = await c.req.json(); } catch (e) { return c.json({ error: "请求体不合法", detail: String(e) }, 400); }
  const slugs = [...new Set(body.slugs || [])];
  if (!slugs.length) return c.json({ wrote: false, error: "没有选中任何产品" }, 400);
  if (body.op !== "status") return c.json({ wrote: false, error: `未知批量操作：${body.op}` }, 400);
  if (!(STATUSES as readonly string[]).includes(String(body.value))) {
    return c.json({ wrote: false, error: `status 非法：${body.value}` }, 400);
  }
  const value = String(body.value);

  try {
    const files: CommitFile[] = [];
    const changed: string[] = [];
    const skipped: { slug: string; why: string }[] = [];   // ⭐ 跳过的必须数出来并报出去
    const rejected: { slug: string; codes: string[] }[] = [];
    let imageOps = 0;

    for (const slug of slugs) {
      const f = await readProductFile(c.env, slug);
      if (!f.exists) { skipped.push({ slug, why: "文件不存在" }); continue; }
      let existing: any;
      try { existing = JSON.parse(f.text!); }
      catch { skipped.push({ slug, why: "不是合法 JSON，拒绝在它上面改" }); continue; }

      if (existing.status === value) { skipped.push({ slug, why: `已经是 ${value}` }); continue; }

      const { merged } = mergeProduct(existing, { status: value });
      const plan = planImages(slug, value, existing.images ?? null, (merged as any).images ?? null, [], []);
      (merged as any).images = plan.images;

      const v = validateProduct(merged);
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
      return c.json({ wrote: false, reason: "没有需要改动的产品", skipped });
    }

    const r = await commitFiles(c.env, {
      message:
        `admin: bulk status=${value} · ${changed.length} 个产品 (${operator})\n\n` +
        changed.map((s) => `- ${s}`).join("\n") +
        (imageOps ? `\n\n图片 ${imageOps} 项改动（随状态搬家）` : "") +
        `\n来源：admin.airsonde.com`,
      files,
    });
    console.log(JSON.stringify({ evt: "bulk_ok", operator, op: body.op, value, count: changed.length, commit: r.commitSha }));

    return c.json({ wrote: true, ...r, changed, skipped, imageOps,
      note: `已在**一个 commit** 里改了 ${changed.length} 个产品${skipped.length ? `，跳过 ${skipped.length} 个` : ""}。` });
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

interface WriteEnvelope {
  patch?: Record<string, unknown>;
  uploads?: { slot: "main" | number; base64: string }[];
  removeGallery?: number[];
  /** 打开页面时读到的分支 HEAD —— 传了才有乐观锁。 */
  baseHeadSha?: string;
  /** true = 这是"新建"，若文件已存在则拒绝（slug 唯一性）。 */
  mustCreate?: boolean;
}

app.put("/api/products/:slug", async (c) => {
  const slug = c.req.param("slug");
  const operator = c.req.header("cf-access-authenticated-user-email")
    || (c.env.DEV_BYPASS_AUTH === "1" ? "dev-bypass" : null);
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

    const validation = validateProduct(merged);
    const slugIssue = checkSlugMatchesPath((merged as any).slug ?? "", `${slug}.json`);
    if (slugIssue) validation.errors.push(slugIssue);

    // 🔴 拦在写之前。wrote:false 要说得明明白白 —— 让人一眼看出"没有产生 commit"。
    if (!validation.ok) {
      console.error(JSON.stringify({ evt: "write_rejected", slug, operator, codes: validation.errors.map((e) => e.code) }));
      return c.json({ wrote: false, reason: "契约校验未通过，未产生任何 commit", validation }, 422);
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
      expectedHeadSha: env0.baseHeadSha,
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
  const operator = c.req.header("cf-access-authenticated-user-email")
    || (c.env.DEV_BYPASS_AUTH === "1" ? "dev-bypass" : null);
  if (!operator) return c.json({ error: "拿不到操作人身份，拒绝删除" }, 403);

  try {
    const f = await readProductFile(c.env, slug);
    if (!f.exists) return c.json({ wrote: false, error: "产品不存在", path: f.path }, 404);

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

// 契约的机器可读形态：界面用它渲染下拉框/多选框，避免枚举在前端被抄第二份。
// ⚠️ 前端硬编码一份枚举 = 第二个真源：契约改了，界面不会跟着变，而它看起来一切正常。
app.get("/api/contract", (c) =>
  c.json({ version: "C1 v1", categories: CATEGORIES, sensors: SENSORS, statuses: STATUSES }));

// ⭐ 没匹配上的路径 → 交给静态资源（界面在 public/）。
//
// ⚠️ `run_worker_first: true` 意味着**所有**请求都先进 worker，包括 `/` 和 `/app.js`。
//    Hono 默认对没匹配上的路径回 404 —— 不接这一句的话，界面**一个字节也出不来**，
//    而症状是"打开后台是一片 404"，看起来像资源没上传。
//    ⚠️ 这一句在鉴权中间件**之后**：静态页同样在 Access + 名单门后面，这是开
//       run_worker_first 的全部理由。
app.notFound((c) => c.env.ASSETS.fetch(c.req.raw));

export default app;

