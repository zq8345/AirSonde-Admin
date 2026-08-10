// `npm run deploy` —— 部署，并把**这次部署对应的 commit** 现算注入。
//
// 🔴 为什么不能直接 `wrangler deploy`：
//    /api/_whoami 的全部价值是"能证明边缘现在跑的是哪一份代码"。
//    版本号若来自源码里的常量，它证明的只是"有人改过那个常量"——那是装饰，不是证据。
//    所以 GIT_SHA 在**部署那一刻**从 git 现算，用 `--var` 注入，源码里没有它的值。
//
// 传 --dry-run 只打包不发布，用来先看清将要发出去的绑定长什么样。
import path from "path";
import { fileURLToPath } from "url";
import { execFileSync, spawnSync } from "child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = process.argv.includes("--dry-run");

const git = (args) => execFileSync("git", args, { cwd: ROOT }).toString().trim();

let sha, dirty;
try {
  sha = git(["rev-parse", "HEAD"]);
  dirty = git(["status", "--porcelain"]) ? "1" : "0";
} catch (e) {
  console.error(`🔴 拿不到 git 身份：${e.message}\n   不用占位值兜底 —— 一个认不出自己是哪个 commit 的部署，出事时无法定位。`);
  process.exit(1);
}

// ⚠️ 脏工作区照发，但要**大声说**，并且这个事实会跟着进 /api/_whoami 的 warnings。
//    不拦是有意的：拦住会让人去 `git stash` 绕过闸，而绕过之后就没人知道了。
if (dirty === "1") {
  console.warn("⚠️ 工作区有未提交改动 —— 本次部署的字节无法由 " + sha.slice(0, 7) + " 还原。/api/_whoami 会带 warning 标出来。");
}

const vars = {
  GIT_SHA: sha,
  GIT_DIRTY: dirty,
  // ⚠️ 不用 ISO 字符串：`--var K:V` 按冒号切，ISO 里的 `12:34:56` 会被切坏。
  //    epoch 毫秒无冒号，读的时候再格式化 —— 让格式适应工具，别让工具去猜格式。
  BUILD_TIME: String(Date.now()),
};

const args = ["wrangler", "deploy"];
for (const [k, v] of Object.entries(vars)) args.push("--var", `${k}:${v}`);
if (dryRun) args.push("--dry-run", "--outdir", ".wrangler/dry-run");

console.log(`→ npx ${args.join(" ")}\n`);
const r = spawnSync("npx", args, { cwd: ROOT, stdio: "inherit", shell: true });
if (r.status !== 0) process.exit(r.status ?? 1);

if (!dryRun) {
  console.log(`\n✅ 已部署 ${sha.slice(0, 7)}${dirty === "1" ? "（脏）" : ""}`);
  console.log("   验收：登录后打开 https://admin.airsonde.com/api/_whoami，核对 git.sha 与 deploy.versionId。");
}
