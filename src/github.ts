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
 * 🔴 dev 只准读：`DEV_BYPASS_AUTH=1` 时任何非 GET 方法直接拒绝。
 *    理由不是洁癖 —— 本地没有 Access 门挡着，而这个 token 打的是**生产数据仓**，
 *    误点一下就是真提交。把闸放在出站口而不是放在每个写端点里：
 *    写端点会越来越多，出站口只有一个。
 */
async function ghFetch(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method || "GET").toUpperCase();

  if (env.DEV_BYPASS_AUTH === "1" && method !== "GET") {
    throw new EgressDenied(
      `本地开发禁止对 GitHub 发起 ${method} —— 目标是生产数据仓 ${env.GITHUB_REPO}，本地没有 Access 门挡着。`,
    );
  }

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
