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
export function assertEgressAllowed(env: Env, method: string): void {
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD") return;

  if (env.ALLOW_GITHUB_WRITE !== "1") {
    throw new EgressDenied(
      `写能力未开启：本 worker 当前不允许对 GitHub 发起 ${m}（A2 阶段写入是 dry-run）。` +
      `要开启需显式配置 ALLOW_GITHUB_WRITE=1 并重新部署 —— 这是一次有意的动作，不该被某个端点顺带带出来。`,
    );
  }
  if (env.DEV_BYPASS_AUTH === "1") {
    throw new EgressDenied(
      `本地开发禁止对 GitHub 发起 ${m} —— 目标是生产数据仓 ${env.GITHUB_REPO}，本地没有 Access 门挡着。`,
    );
  }
}

async function ghFetch(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method || "GET").toUpperCase();
  assertEgressAllowed(env, method);

  const headers: Record<string, string> = {
    "User-Agent": UA,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...((init.headers as Record<string, string>) || {}),
  };
  // 有 token 用 token（配额 5000/h）；没有就匿名（公开仓可读，配额 60/h）。
  // ⚠️ token 只在这里进 header，绝不出现在任何响应体里 —— 见 index.ts 只报 `ghTokenConfigured` 布尔值。
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;

  return fetch(`${GH}${path}`, { ...init, method, headers });
}

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
  const repo = env.GITHUB_REPO, ref = env.GITHUB_BRANCH, dir = env.PRODUCTS_DIR;
  if (!repo || !ref || !dir) throw new Error("配置缺失：GITHUB_REPO/GITHUB_BRANCH/PRODUCTS_DIR 必须全部配置。");

  const path = `${dir}/${slug}.json`;
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
