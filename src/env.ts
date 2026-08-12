// 运行时环境的类型 —— 与 wrangler.jsonc 的 vars / bindings 一一对应。
//
// ⚠️ 全部标成可选（`?`）是有意的：**它们在类型上可选，在行为上必填**。
//    标成必填只会骗过 tsc，运行时该缺还是缺；标成可选则强迫每个读取点显式回答
//    "缺了怎么办" —— 而本仓对"缺了怎么办"的统一答案是 **fail-closed / 明说缺**，
//    绝不是 `|| ""` 静默兜底（契约 C1 硬规则 4）。

export interface Env {
  /** public/ 静态资源。worker 没匹配上的路径转交给它（run_worker_first=true）。 */
  ASSETS: { fetch: (req: Request) => Promise<Response> };

  // ---- 平台提供，伪造不了 ----
  /** Cloudflare 写入的部署版本元数据。dev 下为占位值。 */
  CF_VERSION_METADATA?: { id: string; tag: string; timestamp: string };

  // ---- wrangler.jsonc vars ----
  GITHUB_REPO?: string;
  GITHUB_BRANCH?: string;
  PRODUCTS_DIR?: string;
  /** 逗号分隔。**空 = 拒绝全部**，不是"不限制"。 */
  ALLOWED_EMAILS?: string;

  // ---- scripts/deploy.mjs 在 deploy 时 --var 注入 ----
  GIT_SHA?: string;
  /** "1" = 部署时工作区是脏的（有未提交改动）⇒ GIT_SHA 不足以还原这次部署的字节。 */
  GIT_DIRTY?: string;
  BUILD_TIME?: string;
  /**
   * "ci" | "local" —— 这一版是自动部署的还是有人手动发的。
   * ⚠️ CI 接上之后，手动部署与自动部署会互相覆盖。规矩写在 README，但**规矩不是机制**：
   *    这个字段让"谁发的"变成 /api/_whoami 上看得见的事实，不靠自觉。
   */
  DEPLOY_SOURCE?: string;
  /** Workers Builds 的构建 id / 分支，用来在控制台 Builds 列表里对上号。 */
  CI_BUILD_UUID?: string;
  CI_BRANCH?: string;

  // ---- secret（wrangler secret put）----
  /** 生产写入用。Worker secret，只存在于生产。 */
  GITHUB_TOKEN?: string;

  /**
   * 🔴 **仅本地 `.dev.vars`**（gitignored）。权限仅 `zq8345/AirSonde-Admin`（自检靶子仓）。
   * 与生产的 `GITHUB_TOKEN` **变量名不同、互不回落** —— dev 回落到生产 token 的话，
   * 本机就握着一把能写官网数据仓的钥匙，那正是两道闸在防的事。
   */
  GITHUB_TOKEN_SELFTEST?: string;

  /**
   * 🔴 写能力总开关。**没有它 = 出站口拒绝一切非 GET。**
   * A2 阶段故意不配 ⇒ 结构上不可能改到官网数据仓，而不是"我们记得没去调写接口"。
   * 开启是一次显式动作（改 wrangler.jsonc + 部署），不该被某个新端点顺带带出来。
   */
  ALLOW_GITHUB_WRITE?: string;

  // ---- 仅 scripts/dev.mjs 派生的本地配置里有；生产出现即 500 ----
  DEV_BYPASS_AUTH?: string;
}
