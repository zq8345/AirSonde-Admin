// 部署，并把**这次部署对应的 commit** 现算注入。本地和 CI 共用这一条路径。
//
// 🔴 为什么不能直接 `wrangler deploy`：
//    /api/_whoami 的全部价值是"能证明边缘现在跑的是哪一份代码"。
//    版本号若来自源码里的常量，它证明的只是"有人改过那个常量"——那是装饰，不是证据。
//    所以 GIT_SHA 在**部署那一刻**求值，用 `--var` 注入，源码里没有它的值。
//
// ⭐ Workers Builds（CI）下 `.git` 不一定在，但平台会注入 WORKERS_CI_COMMIT_SHA。
//    两个来源都要，且**两个都在时必须相等** —— 见下面 assertShaAgreement 的理由。
//
// 传 --dry-run 只打包不发布。
import path from "path";
import { fileURLToPath } from "url";
import { execFileSync, spawnSync } from "child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = process.argv.includes("--dry-run");

// ⭐ `wrangler versions upload`（非生产分支用）与 `wrangler deploy` **是同一个病**：
//    实测 `--dry-run` 下，不带 `--var` 的 versions upload 拿不到 GIT_SHA / DEPLOY_SOURCE。
//    ⇒ 非生产分支上传的会是"**没有身份字段的版本**"。现在不影响生产，但将来用 preview
//      排查问题时，会看到一个 git.sha 为 null 的版本，然后去查一遍部署脚本 —— 查错方向。
//    所以两条路共用这一个脚本、共用同一套 SHA 求值逻辑，只换子命令。
const versionsUpload = process.argv.includes("--versions-upload");
const SUBCMD = versionsUpload ? ["versions", "upload"] : ["deploy"];

const isCI = process.env.WORKERS_CI === "1";
const ciSha = process.env.WORKERS_CI_COMMIT_SHA || "";
const ciBranch = process.env.WORKERS_CI_BRANCH || "";

/** 跑 git，失败返回 null（CI 里 .git 可能不在，那不是错误）。 */
function git(args) {
  try { return execFileSync("git", args, { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); }
  catch { return null; }
}

const gitSha = git(["rev-parse", "HEAD"]);
const porcelain = git(["status", "--porcelain"]);

// ⭐ 两个来源都拿得到时，**必须相等**。
//    不等意味着：平台说它在构建 commit A，而工作目录里的字节是 commit B。
//    那种情况下无论选哪个都是在说谎，而说谎的恰恰是我们用来"证明跑的是哪一版"的那个字段 ——
//    ⇒ 宁可停下来，也不要发一个自称是 A、实为 B 的版本。
if (isCI && ciSha && gitSha && ciSha !== gitSha) {
  console.error(
    `🔴 SHA 不一致，停止部署：\n` +
    `   平台 WORKERS_CI_COMMIT_SHA = ${ciSha}\n` +
    `   工作目录 git rev-parse HEAD = ${gitSha}\n` +
    `   两者不等 ⇒ 无论注入哪个，/api/_whoami 都会指向一份不是这次部署的代码。`,
  );
  process.exit(1);
}

let sha, dirty, source;
if (isCI) {
  // CI：commit 由平台给。拿不到就停 —— 不用占位值，也不退回本地 git
  // （CI 里的 .git 未必对应这次触发的 commit）。
  sha = ciSha || gitSha;
  if (!sha) {
    console.error("🔴 CI 环境里既没有 WORKERS_CI_COMMIT_SHA 也没有 git —— 认不出自己是哪个 commit，停。");
    process.exit(1);
  }
  // CI 从干净检出构建。⚠️ 但仍以**实测**为准：真有脏文件（比如构建产物落在了仓内）要如实报。
  dirty = porcelain === null ? "0" : (porcelain ? "1" : "0");
  source = "ci";
} else {
  if (!gitSha) {
    console.error("🔴 拿不到 git 身份 —— 一个认不出自己是哪个 commit 的部署，出事时无法定位。停。");
    process.exit(1);
  }
  sha = gitSha;
  dirty = porcelain ? "1" : "0";
  source = "local";

  // ⚠️ CI 接上之后，手动部署会和自动部署互相覆盖，谁也说不清生产上跑的是哪一版。
  //    这里不硬拦 —— 硬拦会挡住真正的紧急发布，而被挡住的人会去找绕过的办法。
  //    真正的约束是下面注入的 DEPLOY_SOURCE=local：它会出现在 /api/_whoami 里，
  //    **谁手动发的、发的哪一版，是看得见的事实，不靠自觉。**
  //    （versions upload 不动生产流量，所以不吼这一句。）
  if (!versionsUpload) {
    console.warn(
      "⚠️ 这是一次**手动**部署。README 的规矩是：CI 接上之后不要手动 deploy。\n" +
      "   本次会注入 DEPLOY_SOURCE=local，/api/_whoami 上会显示出来 —— 下一次 CI 构建会把它覆盖回 ci。",
    );
  }
}

// 🔴 工作区不干净 ⇒ **拒绝部署**（总工 2026-08-26 立的规矩，这里把它变成机制）。
//
// 为什么必须是闸而不是一句 warning：`wrangler deploy` 发的是**工作区**，不是某个 commit。
// 于是"手上有一块改到一半的活" + "顺手发一下已验收的那个 commit" = **半成品直接上生产**，
// 而版本戳上只会多一个 dirty=1 —— 没有人会因为那个字段去回滚。
// ⚠️ **规矩不是机制**：一条只写在消息里的纪律，撑不过一次"就这一次，很急"。
//
// 逃生口是**显式的**：真有急事时带 ALLOW_DIRTY_DEPLOY=1，那一次会在日志里留痕。
if (dirty === "1") {
  if (process.env.ALLOW_DIRTY_DEPLOY === "1") {
    console.warn("⚠️ 工作区不干净，但 ALLOW_DIRTY_DEPLOY=1 —— 放行。");
    console.warn(`   本次部署的字节**无法**由 ${sha.slice(0, 7)} 还原；/api/_whoami 会带 warning 标出来。`);
  } else {
    console.error("🔴 拒绝部署：工作区有未提交改动。");
    console.error(`   wrangler 发的是**工作区**、不是 ${sha.slice(0, 7)} ⇒ 手上改到一半的东西会一起上生产。`);
    console.error("   未提交的文件：");
    for (const line of String(porcelain || "").split("\n").filter(Boolean)) console.error("     " + line);
    console.error("   ⇒ 先 commit 或 stash；确实要带着脏工作区发，显式加 ALLOW_DIRTY_DEPLOY=1。");
    process.exit(1);
  }
}

const vars = {
  GIT_SHA: sha,
  GIT_DIRTY: dirty,
  DEPLOY_SOURCE: source,
  // ⚠️ 不用 ISO 字符串：`--var K:V` 按冒号切，ISO 里的 `12:34:56` 会被切坏。
  //    epoch 毫秒无冒号，读的时候再格式化 —— 让格式适应工具，别让工具去猜格式。
  BUILD_TIME: String(Date.now()),
};
if (isCI) {
  // 追到具体是哪一次构建产生的这一版（控制台 Builds 列表里能对上号）。
  if (process.env.WORKERS_CI_BUILD_UUID) vars.CI_BUILD_UUID = process.env.WORKERS_CI_BUILD_UUID;
  if (ciBranch) vars.CI_BRANCH = ciBranch;
}

const args = ["wrangler", ...SUBCMD];
for (const [k, v] of Object.entries(vars)) args.push("--var", `${k}:${v}`);
if (dryRun) args.push("--dry-run", "--outdir", ".wrangler/dry-run");

const what = versionsUpload ? "上传版本（不动生产流量）" : "部署";
console.log(`${what} · 来源：${source}${isCI ? `（分支 ${ciBranch || "?"}）` : ""}  commit ${sha.slice(0, 7)}${dirty === "1" ? "（脏）" : ""}`);
console.log(`→ npx ${args.join(" ")}\n`);
const r = spawnSync("npx", args, { cwd: ROOT, stdio: "inherit", shell: true });
if (r.status !== 0) process.exit(r.status ?? 1);

if (!dryRun) {
  console.log(`\n✅ 已${what} ${sha.slice(0, 7)}（来源 ${source}）`);
  if (!versionsUpload) {
    console.log("   验收：登录后打开 https://admin.airsonde.com/api/_whoami，核对 git.sha / deploy.source / deploy.versionId。");
  }
}
