const SRC = new URL("../src/", import.meta.url).href;   // ⚠️ 绝不写绝对路径：CI 是 Linux，`C:/…` 在那里根本不存在
// 出站写闸自检 —— 用**无害输入**把三个维度（方法 × 环境 × 目标仓）的组合量一遍。
//
// 🔴 为什么这个测试值得单独存在：这道闸防的是"误改官网数据仓"。
//    而一个需要**真发一次写请求**才能验证的防写测试，本身就是它要防的那件事。
//    所以闸被抽成纯函数 assertEgressAllowed(env, method, repo)，用假 env 量，零副作用。
//
// ⚠️ 判据纪律：正对照必须在。只测"被拒"的话，一个恒 throw 的空壳也全绿 ——
//    那种闸的表现是"谁也别想读/写"，而症状会是"列表一直空的"或"生产存不了东西"。
import { pathToFileURL } from "url";
const { assertEgressAllowed } = await import(SRC + "github.ts");

let pass = 0, fail = 0; const out = [];
const ck = (name, cond, detail = "") => {
  if (cond) { pass++; out.push(`✅ ${name}`); }
  else { fail++; out.push(`🔴 ${name}${detail ? "\n     " + detail : ""}`); }
};

/** 返回 null 表示放行，返回错误消息表示拒绝。 */
const attempt = (env, method, repo) => {
  try { assertEgressAllowed(env, method, repo); return null; }
  catch (e) { return e.message; }
};

const WEB = "zq8345/AirSonde-Web";       // 官网数据仓 —— 本机永远不许写
const ADMIN = "zq8345/AirSonde-Admin";   // 自检靶子仓 —— 本机允许写
const OTHER = "zq8345/SomethingElse";

const PROD = { ALLOW_GITHUB_WRITE: "1" };                                  // 生产（写已开）
const PROD_OFF = {};                                                       // 生产（写未开）
// ⚠️ 本地环境必须带上非生产分支：AU2 ⑨ 之后，写靶子仓的 main 会被第三道闸拒——
//    这一行不带 GITHUB_BRANCH 的话，下面每一条“本机写靶子仓放行”都会红，
//    而红的原因是**样本过时**，不是被测对象坏了。
const DEV = { DEV_BYPASS_AUTH: "1", ALLOW_GITHUB_WRITE: "1", GITHUB_BRANCH: "e2e-fixtures" };  // 本地（写已开）
const DEV_OFF = { DEV_BYPASS_AUTH: "1" };                                  // 本地（写未开）

// ── ① 正对照：读永远畅通（否则这道闸是"谁也别想读"）──
for (const [label, env] of [["生产", PROD], ["生产(写未开)", PROD_OFF], ["本地", DEV], ["本地(写未开)", DEV_OFF]]) {
  for (const repo of [WEB, ADMIN]) {
    ck(`① 正对照：${label} 读 ${repo.split("/")[1]} 必须放行`, attempt(env, "GET", repo) === null, attempt(env, "GET", repo) || "");
  }
}

// ── ② 闸一：写能力总开关（与环境、目标都无关）──
for (const [label, env] of [["生产", PROD_OFF], ["本地", DEV_OFF]]) {
  for (const repo of [WEB, ADMIN]) {
    const r = attempt(env, "PUT", repo);
    ck(`② ${label}未开写能力 ⇒ 写 ${repo.split("/")[1]} 必须被拒`, r !== null && r.includes("写能力未开启"), String(r));
  }
}

// ── ③ 生产：开了写就应当能写官网数据仓（这是它存在的意义）──
{
  ck("③ 正对照：生产写官网数据仓必须放行（闸不是恒拒）", attempt(PROD, "PUT", WEB) === null, String(attempt(PROD, "PUT", WEB)));
  ck("③ 正对照：生产写靶子仓也放行", attempt(PROD, "PUT", ADMIN) === null, String(attempt(PROD, "PUT", ADMIN)));
}

// ── ④ 闸二：本机的目标仓白名单 —— 本批新增，最要紧 ──
{
  // 🔴 关键用例：本机 + 写能力已开 + 目标是官网数据仓 ⇒ **必须硬拒**
  const r = attempt(DEV, "PUT", WEB);
  ck("④ 关键：本机即使写能力已开，写官网数据仓也必须被硬拒",
    r !== null && r.includes("永远不允许"), String(r));
}
{
  const r = attempt(DEV, "PUT", ADMIN);
  ck("④ 反向自证：本机写自检靶子仓必须放行（否则白名单是摆设，(c) 方案跑不了）", r === null, String(r));
}
{
  const r = attempt(DEV, "PUT", OTHER);
  ck("④ 本机写名单外的仓必须被拒（白名单不是「除了 Web 都行」）",
    r !== null && r.includes("只允许写自检靶子仓"), String(r));
}
{
  // 目标未知时不能放行 —— "不知道打给谁"不该等于"随便打"
  const r = attempt(DEV, "PUT", undefined);
  ck("④ 目标仓未知时必须被拒", r !== null, String(r));
}

// ── ⑤ 方法大小写不该成为绕过方式 ──
{
  ck("⑤ 小写 put 照样受同一套判据", attempt(DEV, "put", WEB) !== null, String(attempt(DEV, "put", WEB)));
  for (const m of ["POST", "PATCH", "DELETE"]) {
    ck(`⑤ 本机 ${m} 官网数据仓必须被拒`, attempt(DEV, m, WEB) !== null, String(attempt(DEV, m, WEB)));
  }
}

// ── ⑥ 🔴 第三道闸：本机不许写靶子仓的**生产分支**（AU2 ⑨）──
//    前两道只问"写哪个仓"，答对就放行 ⇒ e2e 一路写到靶子仓的 main，
//    而靶子仓就是本 worker 自己的仓：main 上一个提交 = Workers Builds 一次生产部署。
//    ⚠️ 不是理论：仓库历史里那串 `admin: create/update/delete imgorder-e2e (dev-bypass)`
//       每一条都进过 main，每一条都换来一次生产部署。
{
  const onMain = { DEV_BYPASS_AUTH: "1", ALLOW_GITHUB_WRITE: "1", GITHUB_BRANCH: "main" };
  const r = attempt(onMain, "PUT", ADMIN);
  ck("⑥ 🔴 本机写靶子仓的 main 必须被拒（一个提交 = 一次生产部署）",
    r !== null && r.includes("生产分支"), String(r));
}
{
  // 🔴 默认必须安全：没配 GITHUB_BRANCH 时默认值就是 main。
  //    这条防的是"闸只在有人显式配错时才生效" —— 那种闸挡不住"忘了配"，而忘了配才是常态。
  const noBranch = { DEV_BYPASS_AUTH: "1", ALLOW_GITHUB_WRITE: "1" };
  ck("⑥ 🔴 关键：**没配** GITHUB_BRANCH 时也被拒（默认值是 main，默认必须安全）",
    attempt(noBranch, "PUT", ADMIN) !== null, String(attempt(noBranch, "PUT", ADMIN)));
}
{
  ck("⑥ master 也算生产分支（判据不是只认 main 这一个字符串）",
    attempt({ DEV_BYPASS_AUTH: "1", ALLOW_GITHUB_WRITE: "1", GITHUB_BRANCH: "master" }, "PUT", ADMIN) !== null);
}
{
  // 反向自证①：不是"一律拒绝"。非生产分支必须放行，否则 e2e 根本无处可跑。
  ck("⑥ 反向自证：写靶子仓的 e2e-fixtures 分支必须放行（否则 e2e 无处可跑）",
    attempt(DEV, "PUT", ADMIN) === null, String(attempt(DEV, "PUT", ADMIN)));
}
{
  // 反向自证②：这道闸**只在 dev**。生产写 main 是它的本职 —— 拦它等于把整个后台废掉。
  const prodMain = { ALLOW_GITHUB_WRITE: "1", GITHUB_BRANCH: "main" };
  ck("⑥ 🔴 反向自证：生产写 main 必须放行（这道闸只在 dev 分支里）",
    attempt(prodMain, "PUT", WEB) === null, String(attempt(prodMain, "PUT", WEB)));
}
{
  // 拒绝理由要指向**真因**：仓不对时不能被分支这条抢先说错原因，否则人照着错原因去改分支。
  const r = attempt({ DEV_BYPASS_AUTH: "1", ALLOW_GITHUB_WRITE: "1", GITHUB_BRANCH: "main" }, "PUT", WEB);
  ck("⑥ 官网数据仓 + main：报的是**仓**不对，不是分支不对（理由要指向真因）",
    r !== null && r.includes("官网数据仓"), String(r));
}


console.log(out.join("\n"));
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);

