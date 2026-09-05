// OpenRouter 通道 —— **当前唯一用例：SEO 文章产线的生成步骤**。
//
// ⛔ 这里不放任何"顺手做的 AI 功能"（后台按钮、自动填充、自动改文案）。
//    通道存在 ≠ 到处可以调它：每一个新用例都要单独过一次"该不该"。
// ⛔ 没有自动发布路径：这里只产出**草稿文本**，写进官网仓是另一条已经存在的、
//    带校验和审计的路，⛔ 不从这里绕过去。
//
// 🔴 三条纪律，全是别的窗真栽过的：
//   ① **模型下架报 model-not-found，⛔ 不装成余额问题。**
//      CRM 窗被这个坑过：旗舰模型被 OpenRouter 下架，症状看起来像"余额不足/挂了"，
//      查错方向整个偏掉。⇒ 下面 `classifyError` 把它单独认出来，并把**模型名**放进错误里。
//   ② **成本问权威源，⛔ 不拿写死的单价自己算。**
//      写死单价 = 换个模型就**悄悄变假**，而且没人会记得改。OpenRouter 自己知道这次花了多少
//      （请求里带 `usage.include`）⇒ 拿它给的数。给不出来就报 `null`，
//      ⛔ 不填 0 —— "这次没花钱"和"我们没问到"必须分得开。
//   ③ **没配密钥就明说缺配置**，⛔ 不假装成功、⛔ 不静默降级。

import type { Env } from "./env";

const OR_URL = "https://openrouter.ai/api/v1/chat/completions";

/** 默认模型。⚠️ 可被请求覆盖 —— 模型下架时不必等一次部署才能换。 */
export const DEFAULT_MODEL = "deepseek/deepseek-chat";

export interface ChatMsg { role: "system" | "user"; content: string; }

export interface AiResult {
  model: string;
  content: string;
  /** OpenRouter 报的 token 数。拿不到就是 null，⛔ 不猜。 */
  tokens: { prompt: number | null; completion: number | null; total: number | null };
  /** 这次调用的美元成本，**由 OpenRouter 给出**。给不出来 ⇒ null，⛔ 不填 0。 */
  costUsd: number | null;
  ms: number;
}

export type AiErrorKind =
  | "missing_key"        // 没配 OPENROUTER_API_KEY
  | "model_not_found"    // 🔴 模型下架/写错 —— ⛔ 绝不能报成余额问题
  | "auth"               // 密钥无效/被撤销
  | "credits"            // 真的没钱了
  | "rate_limited"
  | "upstream"           // OpenRouter 那边其它错
  | "empty";             // 通了但没给内容

/**
 * 分类过的失败。`kind` 是给人看的判断，⛔ 不是把 HTTP 码换个名字。
 *
 * ⚠️ 字段**显式声明 + 显式赋值**，⛔ 不用 TS 的"构造器参数属性"（`constructor(readonly x)`）——
 *    自检脚本是 .mjs、走 Node 的类型剥离，那个语法它**直接抛 SyntaxError**
 *    （`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`）。tsc 编译得过，自检跑不起来。
 */
export class AiError extends Error {
  kind: AiErrorKind;
  detail?: string;
  status?: number;
  constructor(kind: AiErrorKind, message: string, detail?: string, status?: number) {
    super(message);
    this.kind = kind;
    this.detail = detail;
    this.status = status;
  }
}

/**
 * 把上游的失败**分成人能据以行动的几类**。
 *
 * 🔴 判据取自 OpenRouter 的**响应内容**，⛔ 不只看 HTTP 码：
 *    模型下架时它可能给 404，也可能给 200 + body 里一个 error 对象，
 *    而"402/余额"和"404/模型没了"的处方完全相反（一个去充值，一个去换模型）。
 *    ⚠️ 报错方向错了，人会往完全错的地方查 —— 这就是本文件纪律①的由来。
 */
export function classifyError(status: number, bodyText: string, model: string): AiError {
  const t = (bodyText || "").toLowerCase();
  const modelish =
    t.includes("no endpoints found") || t.includes("model not found") ||
    t.includes("no allowed providers") || t.includes("is not a valid model") ||
    (status === 404 && t.includes("model"));
  if (modelish) {
    return new AiError("model_not_found",
      `模型 ${model} 在 OpenRouter 上取不到 —— 多半是**它被下架或改名了**，不是余额问题。`,
      `去 https://openrouter.ai/models 查这个名字，然后在请求里传 model 换一个（不用改代码、不用重部署）。原话：${bodyText.slice(0, 300)}`,
      status);
  }
  if (status === 401 || status === 403 || t.includes("invalid api key") || t.includes("user not found")) {
    return new AiError("auth", "OpenRouter 拒绝了这把密钥（无效或已被撤销）。",
      `需要重新 wrangler secret put OPENROUTER_API_KEY。原话：${bodyText.slice(0, 300)}`, status);
  }
  if (status === 402 || t.includes("insufficient") || t.includes("credit")) {
    return new AiError("credits", "OpenRouter 账户余额不足。", bodyText.slice(0, 300), status);
  }
  if (status === 429 || t.includes("rate limit")) {
    return new AiError("rate_limited", "被 OpenRouter 限流了，稍后再试。", bodyText.slice(0, 300), status);
  }
  return new AiError("upstream", `OpenRouter 返回 ${status}。`, bodyText.slice(0, 300), status);
}

/**
 * 调一次模型。
 *
 * @param label 记进日志的用途标签（如 `seo_article`）—— 让日志说得出**这笔钱花在哪个用例上**。
 */
export async function aiChat(
  env: Env,
  messages: ChatMsg[],
  opts: { model?: string; maxTokens?: number; temperature?: number; label: string; operator?: string | null } = { label: "unlabelled" },
): Promise<AiResult> {
  const model = (opts.model || env.AI_MODEL || DEFAULT_MODEL).trim();
  if (!env.OPENROUTER_API_KEY) {
    // ⛔ 不静默降级、⛔ 不返回空串假装成功 —— 缺配置就是缺配置。
    throw new AiError("missing_key",
      "没有配置 OPENROUTER_API_KEY —— AI 通道没开。",
      "生产：`npx wrangler secret put OPENROUTER_API_KEY`（只有 Joe 能做，密钥不进仓）。本地：写进 .dev.vars（已 gitignore）。");
  }

  const t0 = Date.now();
  const res = await fetch(OR_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "content-type": "application/json",
      "http-referer": "https://admin.airsonde.com",
      "x-title": "AirSonde Admin",
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: opts.temperature ?? 0.7,
      max_tokens: opts.maxTokens ?? 4000,
      // ⭐ 让 OpenRouter 把**这次调用真实的花费**一起返回。见纪律②：⛔ 不拿写死单价自己算。
      usage: { include: true },
    }),
  });

  const raw = await res.text();
  if (!res.ok) throw classifyError(res.status, raw, model);

  let data: any;
  try { data = JSON.parse(raw); }
  catch { throw new AiError("upstream", "OpenRouter 返回的不是 JSON。", raw.slice(0, 300), res.status); }

  // 🔴 200 也可能是失败：OpenRouter 会把错误放进 body 的 error 对象里。
  //    只看 res.ok 的话，模型下架会以"内容为空"的形式出现 —— 又一次指错方向。
  if (data?.error) throw classifyError(Number(data.error.code) || res.status, JSON.stringify(data.error), model);

  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new AiError("empty", "模型通了但没有返回任何内容。",
      `finish_reason=${data?.choices?.[0]?.finish_reason ?? "(无)"}　—— 若是 length，说明 max_tokens 太小。`, res.status);
  }

  const u = data?.usage ?? {};
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const result: AiResult = {
    // ⚠️ 报**上游实际用的那个** model（OpenRouter 会做路由），⛔ 不报我们请求的那个。
    model: typeof data?.model === "string" ? data.model : model,
    content: content.trim(),
    tokens: { prompt: num(u.prompt_tokens), completion: num(u.completion_tokens), total: num(u.total_tokens) },
    costUsd: num(u.cost),
    ms: Date.now() - t0,
  };

  // 结构化日志：一行一次调用。⚠️ ⛔ 不记 prompt / 不记正文 / 不记密钥 —— 日志会被很多人看到。
  console.log(JSON.stringify({
    evt: "ai_call", label: opts.label, operator: opts.operator ?? null,
    modelRequested: model, modelUsed: result.model,
    promptTokens: result.tokens.prompt, completionTokens: result.tokens.completion,
    costUsd: result.costUsd, ms: result.ms, chars: result.content.length,
  }));

  return result;
}
