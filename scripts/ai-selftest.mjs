const SRC = new URL("../src/", import.meta.url).href;   // ⚠️ 绝不写绝对路径：CI 是 Linux
// AI 通道自检 —— **只打纯函数，⛔ 不打真实端点**（那要花钱、要密钥，且结果不确定）。
//
// 🔴 这里唯一值得测、也最值得测的是 `classifyError`：
//    CRM 窗真栽过一次 —— OpenRouter 把旗舰模型下架，症状看起来像"余额不足"，
//    整个排查方向偏掉。**报错分类错了，人就会往完全错的地方查。**
//    ⇒ 每一类都要有正对照（该认出来）+ 反向自证（⛔ 不许被别的类抢走）。

const { classifyError, AiError, DEFAULT_MODEL } = await import(SRC + "ai.ts");

let pass = 0, fail = 0; const out = [];
const ck = (n, c, d = "") => { if (c) { pass++; out.push(`✅ ${n}`); } else { fail++; out.push(`🔴 ${n}\n     ${d}`); } };
const kind = (status, body) => classifyError(status, body, "deepseek/deepseek-chat").kind;

// ══════ ① 模型下架 —— 这一族必须**不**被认成余额问题 ══════
{
  // OpenRouter 模型下架时的真实措辞（几种都见过）
  const REAL = [
    [404, '{"error":{"message":"No endpoints found for deepseek/deepseek-chat.","code":404}}'],
    [400, '{"error":{"message":"deepseek/deepseek-r1 is not a valid model ID"}}'],
    [404, '{"error":{"message":"No allowed providers are available for the selected model."}}'],
  ];
  for (const [s, b] of REAL) {
    ck(`① ${s} ${b.slice(20, 62)}… ⇒ model_not_found`, kind(s, b) === "model_not_found", kind(s, b));
  }
  const e = classifyError(404, '{"error":{"message":"No endpoints found for x/y."}}', "x/y");
  ck("① 🔴 错误里带上**模型名**（否则人不知道该去换哪个）", e.message.includes("x/y"), e.message);
  ck("① 🔴 明说「不是余额问题」（这就是那次栽的地方）", e.message.includes("余额"), e.message);
  ck("① 说得出怎么办：去 models 页换一个，且不用重部署", (e.detail || "").includes("openrouter.ai/models"), e.detail);
}

// ══════ ② 其余几类各归各位（反向自证：⛔ 不许被 model_not_found 抢走）══════
{
  ck("② 402 ⇒ credits", kind(402, '{"error":{"message":"Insufficient credits"}}') === "credits");
  ck("② 401 ⇒ auth", kind(401, '{"error":{"message":"Invalid API key"}}') === "auth");
  ck("② 403 ⇒ auth", kind(403, "forbidden") === "auth");
  ck("② 429 ⇒ rate_limited", kind(429, '{"error":{"message":"Rate limit exceeded"}}') === "rate_limited");
  ck("② 500 ⇒ upstream", kind(500, "internal error") === "upstream");
  ck("② 认不出来的 ⇒ upstream，⛔ 不硬塞进某一类", kind(418, "teapot") === "upstream");
}

// ══════ ③ 🔴 判别式：两类**不许互相认错** ══════
{
  // 余额文案里出现 "model" 这个词，⛔ 不许因此被认成模型下架
  ck("③ 🔴 余额报错里提到 model ⇒ 仍是 credits",
    kind(402, '{"error":{"message":"Insufficient credits for this model request"}}') === "credits",
    kind(402, '{"error":{"message":"Insufficient credits for this model request"}}'));
  // 反过来：模型下架的 404 里没有 credit 字样 ⇒ 不该落进 credits
  ck("③ 🔴 模型下架 ⇒ **不是** credits",
    kind(404, '{"error":{"message":"No endpoints found for a/b."}}') !== "credits");
  // ⚠️ 404 但与模型无关（比如路径写错）⇒ ⛔ 不许冒充模型下架
  ck("③ 🔴 与模型无关的 404 ⇒ upstream，不冒充 model_not_found",
    kind(404, '{"error":{"message":"Not Found"}}') === "upstream",
    kind(404, '{"error":{"message":"Not Found"}}'));
}

// ══════ ④ 大小写与包裹形式不影响判定 ══════
{
  ck("④ 大写措辞也认得出", kind(404, "NO ENDPOINTS FOUND FOR X/Y") === "model_not_found");
  ck("④ 纯文本（非 JSON）body 也认得出", kind(402, "insufficient credits") === "credits");
}

// ══════ ⑤ 形状 ══════
{
  const e = classifyError(500, "boom", "m");
  ck("⑤ 抛的是 AiError，带 status", e instanceof AiError && e.status === 500);
  ck("⑤ 默认模型是 deepseek", DEFAULT_MODEL.startsWith("deepseek/"), DEFAULT_MODEL);
}

console.log(out.join("\n"));
console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
