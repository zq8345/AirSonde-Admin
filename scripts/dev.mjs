// `npm run dev` —— 本地起后台。
//
// 🔴 为什么需要这个脚本，而不是直接 `wrangler dev`：
//    wrangler.jsonc 里有 `routes:[{pattern:"admin.airsonde.com",custom_domain:true}]`。
//    **`wrangler dev` 会拿这条路由去合成请求 URL 的 host** —— 于是本地打开 localhost:8788，
//    Worker 里读到的 hostname 是 `admin.airsonde.com`。开发旁路的 host 检查一看不是
//    localhost，就按"生产上出现了后门"500 停服（这在生产上是对的）。
//    结果：**本地实例从来就起不来**，而症状看起来像代码坏了。
//
// ⚠️ 同一句推理在两个环境里真假相反：中间件注释说"宿主名是请求自带的事实，配不出来"——
//    那句话在生产上完全成立，而在 `wrangler dev` 下 host 恰恰是配置合成出来的。
//
// 做法：从 wrangler.jsonc **派生**一份本地配置（去掉 routes），每次重新生成。
//   ⚠️ 手抄一份 wrangler.local.jsonc 也能跑，但那是**第二个真源**：以后加个绑定、改个变量，
//      本地那份不会跟着变，"本地看着好好的"会重新变得不可信。派生 = 不可能漂。
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawn, execFileSync } from "child_process";
import { stripJsonc } from "./jsonc.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "wrangler.jsonc");
const OUT = path.join(ROOT, ".wrangler.dev.jsonc"); // 已 gitignore；每次重生成，绝不手改

let cfg;
try { cfg = JSON.parse(stripJsonc(fs.readFileSync(SRC, "utf8"))); }
catch (e) {
  console.error(`🔴 解析 wrangler.jsonc 失败：${e.message}\n   不做容错兜底：解析不出来就停，绝不用一份残缺配置起服务。`);
  process.exit(1);
}

// 🔴 解析成功 ≠ 解析对了。少了 vars 照样能 JSON.parse 成功，然后本地起来一个
//    读不到任何配置的 worker，而我会以为是代码坏了。逐条断言拿到的是我以为的那份配置。
const MUST = ["name", "main", "vars", "version_metadata"];
const missing = MUST.filter((k) => !cfg[k]);
if (missing.length) { console.error(`🔴 wrangler.jsonc 解析结果缺字段：${missing.join(", ")} —— 解析器可能坏了，停。`); process.exit(1); }
if (cfg.name !== "airsonde-admin") { console.error(`🔴 name=${cfg.name}，不是 airsonde-admin，停。`); process.exit(1); }
if (!cfg.routes) {
  // routes 没了 ⇒ 要么上游改了，要么解析漏了。两种都不该静默继续：静默继续的话，
  // 这个脚本会变成一个"什么也没修"的壳子，而症状（500）会被归到别的原因头上。
  console.error("🔴 wrangler.jsonc 里没有 routes —— 本脚本存在的唯一理由就是去掉它。若上游真删了，直接用 `wrangler dev` 即可，本脚本可删。");
  process.exit(1);
}

delete cfg.routes; // ← 唯一的实质改动：host 不再被合成，localhost 就是 localhost

// dev 也带上 git 身份，让本地 /api/_whoami 与生产**同一条代码路径**。
// （只在生产注入的话，那条路径本地永远没跑过，第一次跑就是在生产上。）
const git = (args, fallback) => { try { return execFileSync("git", args, { cwd: ROOT }).toString().trim(); } catch { return fallback; } };
cfg.vars = {
  ...cfg.vars,
  DEV_BYPASS_AUTH: "1",
  GIT_SHA: git(["rev-parse", "HEAD"], ""),
  GIT_DIRTY: git(["status", "--porcelain"], "") ? "1" : "0",
  BUILD_TIME: new Date().toISOString(),
};
// ⚠️ 旁路只写进这份**派生的、gitignore 的、每次重生成的**本地配置。
//    它不写进 .dev.vars，也永远不进 wrangler.jsonc ⇒ `npm run deploy` 读的是原文件，带不上它。
//    即使有人拿这份文件去 deploy，中间件那道 host 检查仍会 500 —— 两层各自独立，不互为前提。

fs.writeFileSync(OUT, JSON.stringify({
  __generated: "由 scripts/dev.mjs 从 wrangler.jsonc 派生，请勿手改；改配置改 wrangler.jsonc",
  ...cfg,
}, null, 2) + "\n");

const port = process.env.PORT || "8788";
const hasToken = fs.existsSync(path.join(ROOT, ".dev.vars"))
  && /^\s*GITHUB_TOKEN\s*=\s*\S/m.test(fs.readFileSync(path.join(ROOT, ".dev.vars"), "utf8"));

console.log(`本地后台 → http://localhost:${port}\n`);
console.log("  /api/_whoami   进程身份（先证明你在跟谁说话）");
console.log("  /api/products  列数据仓产品 JSON");
console.log(hasToken
  ? "  ℹ️ .dev.vars 有 GITHUB_TOKEN：读的是真仓内容，配额 5000/h。"
  : "  ℹ️ 没有 GITHUB_TOKEN：匿名读公开仓 zq8345/AirSonde-Web（配额 60/h）。M1 只读，这就够用。");
console.log("  🔴 本地对 GitHub 的**任何非 GET 请求都会被出站口拒绝**（目标是生产数据仓，本地没有 Access 门挡着）。");
console.log("  ⚠️ 派生配置 .wrangler.dev.jsonc 每次重新生成；要改配置请改 wrangler.jsonc。\n");

const child = spawn("npx", ["wrangler", "dev", "-c", OUT, "--port", port], { cwd: ROOT, stdio: "inherit", shell: true });
child.on("exit", (code) => process.exit(code ?? 0));
