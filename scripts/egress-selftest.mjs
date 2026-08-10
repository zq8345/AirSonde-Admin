// 出站写闸自检 —— 用**无害输入**把两道闸的组合量一遍。
//
// 🔴 为什么这个测试值得单独存在：这道闸防的是"误改官网数据仓"。
//    而一个需要**真发一次写请求**才能验证的防写测试，本身就是它要防的那件事。
//    所以闸被抽成纯函数 assertEgressAllowed(env, method)，用假 env 量，零副作用。
//
// ⚠️ 判据纪律：正对照必须在。只测"被拒"的话，一个 `throw` 恒真的空壳也全绿 ——
//    那种闸的表现是"谁也别想读 GitHub"，而症状会是"列表一直是空的"。
import { assertEgressAllowed } from "../src/github.ts";

let pass = 0, fail = 0;
const out = [];
const check = (name, cond, detail = "") => {
  if (cond) { pass++; out.push(`✅ ${name}`); }
  else { fail++; out.push(`🔴 ${name}${detail ? "\n     " + detail : ""}`); }
};

/** 返回 null 表示放行，返回错误消息表示拒绝。 */
const attempt = (env, method) => {
  try { assertEgressAllowed(env, method); return null; }
  catch (e) { return e.message; }
};

const PROD_NOW = {};                                        // A2 现状：写能力未开
const PROD_WRITE_ON = { ALLOW_GITHUB_WRITE: "1" };           // M2 放行后的生产
const DEV_NOW = { DEV_BYPASS_AUTH: "1" };                    // A2 现状：本地
const DEV_WRITE_ON = { DEV_BYPASS_AUTH: "1", ALLOW_GITHUB_WRITE: "1" }; // 有人在本地把开关也打开了

// ── 正对照：读必须永远畅通（否则这道闸是"谁也别想读"）──
for (const [label, env] of [["生产(现状)", PROD_NOW], ["生产(写已开)", PROD_WRITE_ON], ["本地(现状)", DEV_NOW], ["本地(写已开)", DEV_WRITE_ON]]) {
  check(`① 正对照：${label} 的 GET 必须放行`, attempt(env, "GET") === null, attempt(env, "GET") || "");
  check(`① 正对照：${label} 的 HEAD 必须放行`, attempt(env, "HEAD") === null, attempt(env, "HEAD") || "");
}

// ── 闸①：写能力总开关 ──
for (const m of ["PUT", "POST", "PATCH", "DELETE"]) {
  const r = attempt(PROD_NOW, m);
  check(`② A2 现状：生产的 ${m} 必须被拒（写能力未开）`, r !== null && r.includes("写能力未开启"), String(r));
}
{
  const r = attempt(PROD_WRITE_ON, "PUT");
  check("② 反向自证：显式开启 ALLOW_GITHUB_WRITE=1 后，生产的 PUT 必须放行（闸不是恒拒）", r === null, String(r));
}

// ── 闸②：本地永不写生产，且**不以闸①为前提** ──
{
  const r = attempt(DEV_NOW, "PUT");
  check("③ 本地(现状) 的 PUT 必须被拒", r !== null, String(r));
}
{
  // 🔴 关键用例：把写开关打开后，本地**仍然**必须被拒。
  //    两道闸各挡一种失效、互不为前提 —— 只要有一道是另一道的前提，
  //    那就不是两道闸，是一道闸加一句注释。
  const r = attempt(DEV_WRITE_ON, "PUT");
  check("③ 关键：本地即使 ALLOW_GITHUB_WRITE=1 也必须被拒（两道闸互不为前提）",
    r !== null && r.includes("本地开发禁止"), String(r));
}

// ── 大小写不该成为绕过方式 ──
{
  const r = attempt(PROD_NOW, "post");
  check("④ 小写方法名照样被拒（大小写不是绕过方式）", r !== null, String(r));
}

console.log(out.join("\n"));
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
