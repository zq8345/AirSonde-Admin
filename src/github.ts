// GitHub API 访问层。
//
// ⭐ 本文件是**全仓唯一的出站口子**（唯一调用 `fetch()` 的地方）。
//    别在各个端点里各自 fetch —— 那样每加一道防护都要在 N 处重复，第 N+1 处一定会漏。
//    收在一个口子上，出站策略才有一个可以被验证的落点。
//
// ⚠️ M1 只读。写入是 M2，单独派单。

import type { Env } from "./env";

const GH = "https://api.github.com";
const UA = "airsonde-admin";

/** 出站策略拒绝时抛这个——调用方要能区分"我方拒绝"和"GitHub 拒绝"。 */
export class EgressDenied extends Error {}

/**
 * 唯一出站口。
 *
 * 🔴 **两道闸，都在这一个地方，都是默认拒绝：**
 *
 *  ① 写能力总开关：没有显式设置 `ALLOW_GITHUB_WRITE=1` 时，**任何非 GET 一律拒绝**。
 *     A2 阶段（当下）写入是 dry-run，这个变量**故意没配** ⇒ 这个 worker 在结构上
 *     就不可能改到官网数据仓，而不是"我们记得没去调写接口"。
 *     ⚠️ 这道闸的位置很关键：它必须在**不可逆那一步之前**。放在端点里没用 ——
 *        端点会越来越多，第五个一定会漏；出站口只有一个。
 *     ⇒ M2 放行时，打开写入是一次**显式的配置动作**（改 wrangler.jsonc + 部署），
 *        不会因为某个端点被加出来就悄悄具备了写能力。
 *
 *  ② dev 永远只准读：即使将来 ①打开了，`DEV_BYPASS_AUTH=1` 下仍然拒绝非 GET。
 *     本地没有 Access 门挡着，而目标是**生产数据仓**，误点一下就是真提交。
 *     ⚠️ 两道分开写、不互为前提：①是"这个环境该不该有写能力"，②是"本机绝不写生产"。
 */
// ⭐ 闸单独抽成一个纯函数，为的是**它自己能被测**。
//    藏在 ghFetch 里的话，要验证它就得真发一次请求 —— 而"验证一道防写闸"的测试
//    如果需要真发一次写请求，那这个测试本身就是它要防的那件事。
//    纯函数版可以用无害的输入把两道闸的四种组合全部量一遍。
/**
 * 🔴 本机允许写入的仓 —— **硬编码在源码里，不是环境变量。**
 *    做成变量的话，它就是一个"开关"：谁都能把它设成 AirSonde-Web，那道闸当场作废。
 *    硬编码 ⇒ 要放开另一个仓，必须改这一行、提交、被 review 看见。
 * ⚠️ 官网数据仓 `zq8345/AirSonde-Web` **永远不在这个名单里**，无论开关怎么配。
 */
const DEV_WRITABLE_REPOS = new Set(["zq8345/AirSonde-Admin"]);
/** 永不允许本机写的仓。与上面是**两条独立判据**：白名单写错了，这条仍然挡得住。 */
const NEVER_DEV_WRITABLE = new Set(["zq8345/AirSonde-Web"]);

/**
 * 🔴 本机**绝不**写的分支名 —— 第三道闸（AU2 ⑨）。
 *
 * 前两道闸只问"写哪个仓"，答对了就放行 ⇒ e2e 打靶子仓，**一路写到靶子仓的 `main`**。
 * 而靶子仓就是本 worker 自己的仓，`main` 上一个提交 = Workers Builds 一次**生产部署**。
 * ⇒ 跑一轮 e2e ≈ 11 个提交 ≈ 11 次生产部署。**测试把生产推来推去，而且悄无声息。**
 *
 * ⚠️ 这不是理论：仓库历史里那串 `admin: create/update/delete imgorder-e2e (dev-bypass)`
 *    每一条都进过 main。
 *
 * ⛔ 修法不是"记得在 .dev.vars 里改分支" —— 文档不是机制，忘一次就又推一次生产。
 *    判据挂在出站口：**本机写靶子仓可以，写它的生产分支不行。**
 * ⚠️ 与仓白名单一样硬编码：做成变量它就是个开关，谁都能把它设回 main。
 */
const NEVER_DEV_WRITABLE_BRANCHES = new Set(["main", "master"]);

export function assertEgressAllowed(env: Env, method: string, repo?: string): void {
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD") return;

  if (env.ALLOW_GITHUB_WRITE !== "1") {
    throw new EgressDenied(
      `写能力未开启：本 worker 当前不允许对 GitHub 发起 ${m}。` +
      `要开启需显式配置 ALLOW_GITHUB_WRITE=1 并重新部署 —— 这是一次有意的动作，不该被某个端点顺带带出来。`,
    );
  }

  if (env.DEV_BYPASS_AUTH === "1") {
    const target = repo || env.GITHUB_REPO || "(未知)";
    // ⚠️ 先判黑名单再判白名单：白名单哪天被改错了，这一条仍然挡得住官网数据仓。
    if (NEVER_DEV_WRITABLE.has(target)) {
      throw new EgressDenied(
        `本机永远不允许写 ${target} —— 那是官网数据仓，本地没有 Access 门挡着，误点一下就是真提交。`,
      );
    }
    if (!DEV_WRITABLE_REPOS.has(target)) {
      throw new EgressDenied(
        `本机只允许写自检靶子仓（${[...DEV_WRITABLE_REPOS].join(", ")}），当前目标是 ${target}。`,
      );
    }
    // 🔴 第三道：靶子仓对了，还要看写的是哪个分支。
    //    ⚠️ 这条**只在 dev 分支里**：生产就是要写 main，那是它的本职。
    const branch = env.GITHUB_BRANCH || "main";
    if (NEVER_DEV_WRITABLE_BRANCHES.has(branch)) {
      throw new EgressDenied(
        `本机不允许写 ${target} 的 \`${branch}\` 分支 —— 那是本 worker 自己的生产分支，` +
        `往它推一个提交就是一次生产部署（Workers Builds），而跑一轮 e2e 会推十几个。` +
        `\n⇒ 跑 e2e 前在 .dev.vars 里加一行 GITHUB_BRANCH=e2e-fixtures（那个分支已建好）。`,
      );
    }
    // 落到这里 = 目标是靶子仓的非生产分支，放行。⚠️ 生产环境永远走不到这个分支（没有 DEV_BYPASS_AUTH）。
  }
}

/**
 * 本次请求打的是哪个仓 —— **从真实请求路径解析，不靠调用方传参**。
 * ⚠️ 传参迟早会有人忘记传，而忘了传的那次恰好就是绕过闸的那次；路径不会忘。
 */
function repoFromPath(path: string): string | undefined {
  return (/^\/repos\/([^/]+\/[^/]+)/.exec(path) || [])[1];
}

/**
 * 本次该用哪个 token。
 * 🔴 dev 与生产**用不同的变量名**，且**互不回落**：
 *    dev 回落到生产 token 的话，本机就握着一把能写官网数据仓的钥匙 ——
 *    而那正是我们花了两道闸在防的事。宁可 dev 没 token 报错，也不要它"顺手能用"。
 */
function tokenFor(env: Env): string | undefined {
  return env.DEV_BYPASS_AUTH === "1" ? env.GITHUB_TOKEN_SELFTEST : env.GITHUB_TOKEN;
}

export async function ghFetch(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method || "GET").toUpperCase();
  assertEgressAllowed(env, method, repoFromPath(path));

  const headers: Record<string, string> = {
    "User-Agent": UA,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...((init.headers as Record<string, string>) || {}),
  };
  // 有 token 用 token（配额 5000/h）；没有就匿名（公开仓可读，配额 60/h）。
  // ⚠️ token 只在这里进 header，绝不出现在任何响应体里 —— 见 index.ts 只报布尔值。
  const tok = tokenFor(env);
  if (tok) headers.Authorization = `Bearer ${tok}`;

  return fetch(`${GH}${path}`, { ...init, method, headers });
}

/** 只报有无，绝不报值。dev 与生产看的是不同的变量。 */
export const hasWriteToken = (env: Env): boolean => !!tokenFor(env);

export interface ListResult {
  repo: string;
  ref: string;
  dir: string;
  /** ⭐ 目录不存在 与 目录存在但是空的，是两件事，必须分得出来。 */
  dirExists: boolean;
  count: number;
  files: { name: string; slug: string; path: string; size: number; sha: string }[];
  /** 匿名还是带 token 读的 —— 排查配额问题时第一个要知道的事。 */
  authenticated: boolean;
  rateLimitRemaining: string | null;
  note?: string;
}

/**
 * 列出 `<repo>/<PRODUCTS_DIR>/` 下的 *.json。
 *
 * ⚠️ 目录此刻可能还不存在（AirSonde-Web 窗并发建站中，那个目录归它）。
 *    派单明确要求：**不存在返回空列表，不报错，也绝不自己去创建它。**
 *
 * 🔴 但"空列表"不许被当成万能兜底：只有 GitHub 明确说了 404（目录不存在 / 仓是空的）
 *    才返回空。401/403/429/5xx 一律抛出 —— 把"我没读到"伪装成"那里没东西"，
 *    正是最难发现的一类错（读侧全绿，实则一个都没读到）。
 */
export async function listProducts(env: Env): Promise<ListResult> {
  const repo = env.GITHUB_REPO;
  const ref = env.GITHUB_BRANCH;
  const dir = env.PRODUCTS_DIR;
  if (!repo || !ref || !dir) {
    throw new Error(
      `配置缺失：GITHUB_REPO/GITHUB_BRANCH/PRODUCTS_DIR 必须全部配置（当前 repo=${repo} ref=${ref} dir=${dir}）`,
    );
  }

  const res = await ghFetch(env, `/repos/${repo}/contents/${dir}?ref=${encodeURIComponent(ref)}`);
  const rateLimitRemaining = res.headers.get("x-ratelimit-remaining");
  const base = {
    repo,
    ref,
    dir,
    authenticated: !!env.GITHUB_TOKEN,
    rateLimitRemaining,
  };

  if (res.status === 404) {
    // 两种 404 都走这里，但要把 GitHub 的原话带出去，别自己编一句概括。
    const body = (await res.text()).slice(0, 300);
    return {
      ...base,
      dirExists: false,
      count: 0,
      files: [],
      note: `目录尚不存在（GitHub 404）。AirSonde-Web 窗建出 ${dir}/ 之后这里会自动有内容。GitHub 原话：${body}`,
    };
  }

  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}：${(await res.text()).slice(0, 300)}`);
  }

  const json = (await res.json()) as unknown;

  // 路径指向文件而不是目录时，GitHub 返回对象而不是数组。静默当成空会掩盖配置写错了。
  if (!Array.isArray(json)) {
    throw new Error(`${dir} 不是一个目录（GitHub 返回了单个对象）——请检查 PRODUCTS_DIR 配置。`);
  }

  const files = json
    .filter((e: any) => e?.type === "file" && typeof e.name === "string" && e.name.endsWith(".json"))
    .map((e: any) => ({
      name: e.name as string,
      slug: (e.name as string).replace(/\.json$/, ""), // 契约 C1：一个产品一个文件，文件名即 slug
      path: e.path as string,
      size: e.size as number,
      sha: e.sha as string,
    }));

  return { ...base, dirExists: true, count: files.length, files };
}

// ── git blob SHA：让「GitHub 存下的字节 == 我们发出去的字节」变成可证明的 ──────────
//
// ⭐ 不用探针，用**确定性哈希**自证：
//    git 的 blob SHA = `sha1("blob " + 字节数 + "\0" + 字节)` —— 是**内容的函数**。
//    而 contents API 的响应里带着 **GitHub 算出来的 `content.sha`**。
//    本地按 UTF-8 算出期望值，与响应比对：**相等 ⇒ 服务端存的字节与我们发的完全相同。**
//    零额外子请求，也不用再读回来。
//
// ⚠️ 长度必须是**字节数**不是字符数：`"é".length === 1` 但 UTF-8 是 2 字节。
//    写成 `.length` 的话纯 ASCII 全对、一遇非 ASCII 就错 —— 正是最容易漏测的那种。
const HEX = "0123456789abcdef";
function toHex(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i++) s += HEX[b[i]! >> 4]! + HEX[b[i]! & 15]!;
  return s;
}

/** 对**字节**算 git blob sha —— 图片走这一条（二进制没有"字符"可言）。 */
export async function gitBlobShaBytes(body: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`blob ${body.length}\0`); // ⚠️ 字节数
  const all = new Uint8Array(header.length + body.length);
  all.set(header, 0);
  all.set(body, header.length);
  return toHex(await crypto.subtle.digest("SHA-1", all));
}

/** 对**文本**算 git blob sha（先按 UTF-8 编码）。 */
export async function gitBlobSha(text: string): Promise<string> {
  return gitBlobShaBytes(new TextEncoder().encode(text));
}

/** base64 → 字节。⚠️ atob 出来的是 latin1 字符串，必须逐字符取码点还原成字节。 */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** UTF-8 → base64。⚠️ 不能直接 btoa(text)：btoa 只吃 latin1，非 ASCII 会抛或写坏。 */
function toBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

export interface ReadResult {
  path: string;
  /** 文件不存在（新建产品的情形）。⚠️ 与"读失败"是两回事，后者会抛。 */
  exists: boolean;
  /** GitHub 上这个 blob 的 sha —— 真写入时要拿它做乐观锁，防止覆盖别人的改动。 */
  sha: string | null;
  /** 原始文本。⚠️ 保留原字节，不做任何归一化 —— diff 要比的是真实字节。 */
  text: string | null;
}

/**
 * 读单个产品文件的原文。
 *
 * ⚠️ 返回**原始文本**而不是解析后的对象：diff 要拿真实字节去比。
 *    先 parse 再 stringify 会把缩进、键序、行尾都抹掉，于是 diff 显示"没变化"，
 *    而真写进去会产生一次全文件改动。
 */
export async function readProductFile(env: Env, slug: string): Promise<ReadResult> {
  const dir = env.PRODUCTS_DIR;
  if (!dir) throw new Error("配置缺失：PRODUCTS_DIR 必须配置。");
  return readRepoFile(env, `${dir}/${slug}.json`);
}

/**
 * 读官网仓里**任意一个**文件的原文。
 *
 * ⚠️ **只读**。后台在官网仓的写入范围仍然只有 `PRODUCTS_DIR`；这个函数不改变那件事
 *    （写走的是 gitcommit.ts，而出站闸在 ghFetch 里，与这里无关）。
 *    加它当初是为了读官网源码里的分类显示名（catlabels.ts，A13 已删 —— 契约 v1.4 之后
 *    显示名的真源是 taxonomy.json，不再需要解析别人的源码）。它现在的用处是读产品 JSON。
 */
export async function readRepoFile(env: Env, path: string): Promise<ReadResult> {
  const repo = env.GITHUB_REPO, ref = env.GITHUB_BRANCH;
  if (!repo || !ref) throw new Error("配置缺失：GITHUB_REPO/GITHUB_BRANCH 必须全部配置。");

  const res = await ghFetch(env, `/repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`);

  if (res.status === 404) return { path, exists: false, sha: null, text: null };
  if (!res.ok) throw new Error(`GitHub API ${res.status}：${(await res.text()).slice(0, 300)}`);

  const j = (await res.json()) as any;
  if (Array.isArray(j)) throw new Error(`${path} 是一个目录，不是文件。`);
  if (j.encoding !== "base64" || typeof j.content !== "string") {
    // 大文件 GitHub 会返回 encoding:"none" 且 content 为空。静默当成空文件 = 把"读不到"
    // 伪装成"里面没东西"，随后 dry-run 会显示"整份新增"，而真写入会覆盖掉真实内容。
    throw new Error(`GitHub 返回了非 base64 内容（encoding=${j.encoding}）——拒绝据此判断文件内容。`);
  }
  // atob → 字节 → UTF-8 解码。⚠️ 直接 atob 得到的是 latin1，中文/ñ á ç 会坏。
  const bin = atob(j.content.replace(/\n/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  // ⚠️ ignoreBOM:false ⇒ 文件真带 BOM 时它会被剥掉。这是对的：BOM 留在字符串里
  //    会让 JSON.parse 直接失败，而症状看起来像"文件内容坏了"。
  const text = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(bytes);

  return { path, exists: true, sha: j.sha as string, text };
}

/** 别人在我们读取之后改动了同一个文件 —— 不是失败，是必须让人重新看一眼的情况。 */
export class ConflictError extends Error {}
/** GitHub 存下的字节与我们发出去的不一致。**这一条永远不该发生**，发生了要吼。 */
export class ByteMismatchError extends Error {}

export interface WriteResult {
  path: string;
  created: boolean;
  commitSha: string;
  commitUrl: string;
  blobSha: string;
  bytes: number;
}

/**
 * 把一份产品 JSON 提交到数据仓。
 *
 * 🔴 调用方必须**先**跑完契约校验并确认没有 error —— 这里不再校验一次。
 *    不是偷懒：校验放在两个地方就会有两份规则，而两份规则迟早不一样。
 *    这里只负责"写得对不对"，"该不该写"归 contract.ts。
 *
 * ⚠️ `expectedSha` 是乐观锁：它必须是**这次编辑所基于的那一版**的 blob sha。
 *    不传的话，GitHub 会把并发的改动**静默覆盖掉** —— 那正是"保存成功，别人的改动没了"。
 */
export async function writeProductFile(
  env: Env,
  slug: string,
  text: string,
  opts: { expectedSha: string | null; operator: string; changedFields: string[] },
): Promise<WriteResult> {
  // 🔴 出站策略必须**第一个**判 —— 顺序本身就是一条判据。
  //    原来先判 token：本地跑一次写，报的是「GITHUB_TOKEN 未配置」，
  //    而真正的原因是「本机永远不准写生产数据仓」。于是人会去配一个 token，
  //    配完再撞上出站闸，被同一件事挡两次、看到两个不同的理由。
  //    ⚠️ 这正是我们那张误判表要防的事：**报错报错了原因，比不报错更能把人带偏。**
  const repo = env.GITHUB_REPO, branch = env.GITHUB_BRANCH, dir = env.PRODUCTS_DIR;
  assertEgressAllowed(env, "PUT", repo);

  if (!repo || !branch || !dir) throw new Error("配置缺失：GITHUB_REPO/GITHUB_BRANCH/PRODUCTS_DIR 必须全部配置。");
  if (!hasWriteToken(env)) {
    // fail-closed：没有 token 就明说，别让它退化成一次匿名请求然后回 401 —— 那个症状看起来像 token 错了。
    throw new Error("写入用的 token 未配置，拒绝写入（读可以匿名，写不行）。");
  }

  const path = `${dir}/${slug}.json`;
  const expected = await gitBlobSha(text);

  // commit message：以后官网内容出问题，要能从 git log 直接查到是后台哪一次操作、谁做的。
  // ⚠️ operator 来自 Access 的身份头，不是用户可填的字段 —— 它伪造不了（边缘会剥掉客户端自带的）。
  const fields = opts.changedFields.length ? opts.changedFields.join(", ") : "(无字段变化)";
  const message =
    `admin: ${opts.expectedSha ? "update" : "create"} ${slug} (${opts.operator})\n\n` +
    `字段：${fields}\n` +
    `来源：admin.airsonde.com`;

  const body: Record<string, unknown> = {
    message,
    content: toBase64Utf8(text),
    branch,
  };
  if (opts.expectedSha) body.sha = opts.expectedSha;   // 有它才是乐观锁；新建时必须没有

  const res = await ghFetch(env, `/repos/${repo}/contents/${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (res.status === 409 || res.status === 422) {
    // 422 在这个端点上通常也是 sha 不匹配（GitHub 用它表达"你给的 sha 不是当前版本"）
    throw new ConflictError(
      `文件在你打开它之后被改过了（GitHub ${res.status}）。请重新读一次再改 —— ` +
      `直接覆盖会把别人的改动弄丢。原话：${(await res.text()).slice(0, 200)}`,
    );
  }
  if (!res.ok) throw new Error(`GitHub 写入失败 ${res.status}：${(await res.text()).slice(0, 300)}`);

  const j = (await res.json()) as any;
  const gotBlob = j?.content?.sha as string | undefined;

  // ⭐ 密码学自证：GitHub 算出的 blob sha 必须等于我们本地按 UTF-8 算的。
  //    不等 ⇒ 存下去的字节和我们发的不一样。**必须吼出来**，不能"写成功了"就完事。
  if (gotBlob !== expected) {
    throw new ByteMismatchError(
      `🔴 GitHub 存下的字节与发出去的不一致：期望 blob ${expected}，实际 ${gotBlob || "(响应里没有 content.sha)"}。` +
      `commit 可能已经产生（${j?.commit?.sha || "?"}），请人工核对 ${path}。`,
    );
  }

  return {
    path,
    created: !opts.expectedSha,
    commitSha: j?.commit?.sha,
    commitUrl: j?.commit?.html_url,
    blobSha: expected,
    bytes: new TextEncoder().encode(text).length,
  };
}
