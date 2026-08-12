// AirSonde 产品后台（admin.airsonde.com）—— M1：只读打通。
//
// M1 范围：进程身份端点 + Access 门控 + GitHub 只读列目录。**没有任何写入能力。**
// 写入是 M2，单独派单。别在这个文件里"顺手"加保存端点。

import { Hono } from "hono";
import type { Env } from "./env";
import { listProducts, readProductFile, hasWriteToken, base64ToBytes, EgressDenied, ConflictError, ByteMismatchError } from "./github";
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
