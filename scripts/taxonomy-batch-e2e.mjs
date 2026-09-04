// 分类轴**批量保存**写入全链实跑（Joe 2026-09-04「编辑 / 保存」）。
//
// 🔴 打的是**靶子仓** `zq8345/AirSonde-Admin` 的 `fixtures/taxonomy.json`，
//    **绝不碰官网仓**（出站闸把 zq8345/AirSonde-Web 写死在黑名单里）。
//
// 本轮真正要量的那一件事：
//   **一次保存 = 一个 commit，而且三处改动都在那一个 commit 里。**
//   单元自检（applyOps 那 19 条）只证明"折出来的那份对象对"——
//   它证不到"真写进仓的字节对"，更证不到"只产生了一个 commit"。
//   ⚠️ 这两件事恰恰是这次改动的全部目的：原来改三个机型 = 三个 commit。
//
// 还要量的第二件：**失败时仓里一个字节都不许动**（整批不生效）。
//
// 前提（第 ⓪ 步逐条断言，不满足 exit 2 且**不出任何结论**）：
//   .dev.vars 临时加：GITHUB_REPO=zq8345/AirSonde-Admin
//                     GITHUB_BRANCH=e2e-fixtures
//                     TAXONOMY_PATH=fixtures/taxonomy.json
//   另一个终端跑着 `npm run dev`
// 跑完把 fixture 还原成起始内容。

import fs from "fs";
const B = "http://localhost:8811";
const TARGET_REPO = "zq8345/AirSonde-Admin";
const PATH = "fixtures/taxonomy.json";
let BRANCH = null;   // ⓪ 里赋值 —— ⛔ 不写死（写死会去读默认分支，得到"没变"这个安静的错答案）

const DEV_VARS = new URL("../.dev.vars", import.meta.url);
const TOKEN = (() => {
  try {
    const m = /^\s*GITHUB_TOKEN_SELFTEST\s*=\s*([^\s#]+)/m.exec(fs.readFileSync(DEV_VARS, "utf8"));
    return m ? m[1] : null;
  } catch { return null; }
})();
const GH = { "User-Agent": "taxonomy-batch-e2e", Accept: "application/vnd.github+json", ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) };

let pass = 0, fail = 0;
const ck = (n, ok, d = "") => { if (ok) pass++; else fail++; console.log(`${ok ? "✅" : "🔴"} ${n}${d ? "\n     " + d : ""}`); };

const req = async (p, init) => {
  const r = await fetch(B + p, init);
  return { status: r.status, body: await r.json().catch(() => null) };
};
const get = () => req("/api/taxonomy");
const save = (ops, expectedSha) => req("/api/taxonomy", {
  method: "PUT", headers: { "content-type": "application/json" },
  body: JSON.stringify({ ops, expectedSha }),
});
const headSha = async () =>
  (await (await fetch(`https://api.github.com/repos/${TARGET_REPO}/commits?sha=${BRANCH}&per_page=1&_=${Date.now()}`, { headers: GH })).json())[0].sha;

/** 按 blob sha 读**仓里真实的字节** —— ⛔ 不看接口自己说了什么。 */
async function readFromRepo() {
  const t = await fetch(`https://api.github.com/repos/${TARGET_REPO}/git/trees/${BRANCH}?recursive=1&_=${Date.now()}`, { headers: GH });
  const tt = await t.text();
  if (t.status === 403 && /rate limit/i.test(tt)) { console.log("🔴 GitHub 限流（仪器问题）—— 不出结论。"); process.exit(2); }
  const tree = JSON.parse(tt);
  if (tree.truncated) throw new Error("tree 被截断，拒绝在不完整基线上判断");
  const node = tree.tree.find((x) => x.path === PATH);
  if (!node) return null;
  const b = await (await fetch(`https://api.github.com/repos/${TARGET_REPO}/git/blobs/${node.sha}`, { headers: GH })).json();
  return JSON.parse(Buffer.from(b.content.replace(/\n/g, ""), "base64").toString("utf8"));
}

// ══════ ⓪ 仪器自检：先证明我在跟谁说话、打的是哪个文件 ══════
let who;
try { who = await req("/api/_whoami"); }
catch (e) { console.log(`🔴 连不上 ${B}（${e.message}）—— 先起 \`npm run dev\`。不出结论。`); process.exit(2); }
if (who.status !== 200) { console.log(`🔴 /api/_whoami → ${who.status}，不出结论。`); process.exit(2); }
if (who.body.data.repo !== TARGET_REPO) {
  console.log(`🔴 数据源是 ${who.body.data.repo}，不是靶子仓 —— 不出结论，绝不在官网仓上跑写入测试。`);
  process.exit(2);
}
BRANCH = who.body.data.branch;
if (!BRANCH || BRANCH === "main" || BRANCH === "master") {
  console.log(`🔴 数据源分支是 \`${BRANCH}\`（生产分支）—— 不出结论。\n   在 .dev.vars 里加 GITHUB_BRANCH=e2e-fixtures 再重启 dev。`);
  process.exit(2);
}
if (!who.body.data.writeEnabled) { console.log("🔴 writeEnabled=false —— 不出结论。"); process.exit(2); }
if (!TOKEN) { console.log("🔴 校验侧没有 token，匿名读会被限流 —— 不出结论。"); process.exit(2); }
console.log(`⓪ 仪器：repo=${who.body.data.repo} branch=${BRANCH} path=${PATH}\n`);

// ══════ 起始快照（跑完要还原）══════
const start = await get();
if (start.status !== 200) { console.log(`🔴 读不到 taxonomy（${start.status}）—— 不出结论。`); process.exit(2); }
const START_TAX = JSON.parse(JSON.stringify(start.body.taxonomy ?? start.body));
const startSha = start.body.sha;
const NEW_VALUE = "e2e-tmp-" + Date.now().toString(36);
const firstCat = (START_TAX.categories || [])[0];
const zeroRefSensor = null;   // 传感器改名不需要零引用，删除才需要

// ══════ ① 反向自证：**失败时仓里一个字节都不许动** ══════
{
  const before = await headSha();
  const r = await save([
    { axis: "categories", op: "edit", value: firstCat.value, label: "E2E 不该落地" },
    { axis: "categories", op: "edit", value: "根本不存在的取值", label: "x" },   // 第 2 处必挂
  ], startSha);
  ck("① 一批里有一处非法 ⇒ 整批被拒（422）", r.status === 422, `实得 ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
  ck("① 而且说得出是第几处", r.body && r.body.failedAt === 1, JSON.stringify(r.body && r.body.error));
  const after = await headSha();
  ck("① 🔴 关键：仓里 HEAD 一个字节没动（⛔ 不许改了一半）", before === after, `${before} → ${after}`);
  const repo = await readFromRepo();
  ck("① 🔴 而且第 1 处那个改名**没有**落进文件", (repo.categories.find((x) => x.value === firstCat.value) || {}).label !== "E2E 不该落地");
}

// ══════ ② 正对照：一次保存 3 处 ⇒ **一个 commit**，三处都在里面 ══════
{
  const before = await headSha();
  const cur = await get();
  const ops = [
    { axis: "categories", op: "edit", value: firstCat.value, label: "E2E 改名 A" },
    { axis: "sensors", op: "add", value: NEW_VALUE, label: "E2E 新增 B" },
    { axis: "sensors", op: "delete", value: NEW_VALUE },   // 本批新增又删 ⇒ 净效果只有改名
  ];
  // ⚠️ 上面那组净效果只有 1 处，会撞上"内容相同"分支 —— 换成真正的 3 处净改动：
  ops[2] = { axis: "sensors", op: "edit", value: (cur.body.taxonomy ?? cur.body).sensors[0].value, label: "E2E 改名 C" };
  const r = await save(ops, cur.body.sha);
  ck("② 保存成功", r.status === 200 && r.body.wrote === true, JSON.stringify(r.body).slice(0, 200));
  ck("② 服务端回报 3 处都应用了", Array.isArray(r.body.applied) && r.body.applied.length === 3, JSON.stringify(r.body.applied));

  const after = await headSha();
  ck("② 🔴🔴 关键：**只产生了一个 commit**", before !== after && r.body.commitSha === after,
    `before=${before} after=${after} 接口说=${r.body.commitSha}`);
  // 🔴 直接问 GitHub：这个 commit 的父提交是不是 before —— 只有一个 commit 才成立
  const cm = await (await fetch(`https://api.github.com/repos/${TARGET_REPO}/commits/${after}?_=${Date.now()}`, { headers: GH })).json();
  ck("② 🔴 而且它的父提交就是保存之前那个（中间没有第二个 commit）",
    (cm.parents || []).length === 1 && cm.parents[0].sha === before,
    `parents=${JSON.stringify((cm.parents || []).map((p) => p.sha))}`);

  const repo = await readFromRepo();
  // ⚠️ 这条断言第一版写错过：我把第 3 条 op 从「删掉本批新增的」换成了「改名」，
  //    却还断言那条新增应该消失 ⇒ 报红的是**判据**，不是代码。
  //    ⛔ 别把自己写错的期望当成缺陷去改代码。
  ck("② 三处改动**都在仓里的字节上**（改名 A · 新增 B · 改名 C）",
    (repo.categories.find((x) => x.value === firstCat.value) || {}).label === "E2E 改名 A"
    && (repo.sensors.find((x) => x.value === (cur.body.taxonomy ?? cur.body).sensors[0].value) || {}).label === "E2E 改名 C"
    && repo.sensors.some((x) => x.value === NEW_VALUE) === true,
    JSON.stringify({ cat: repo.categories.find((x) => x.value === firstCat.value), added: repo.sensors.some((x) => x.value === NEW_VALUE) }));
}

// ══════ ③ 还原 fixture ══════
{
  const cur = await get();
  const now = cur.body.taxonomy ?? cur.body;
  const back = [];
  for (const axis of ["categories", "sensors"]) {
    for (const it of START_TAX[axis]) {
      const n = now[axis].find((x) => x.value === it.value);
      if (n && n.label !== it.label) back.push({ axis, op: "edit", value: it.value, label: it.label });
    }
    for (const n of now[axis]) if (!START_TAX[axis].some((x) => x.value === n.value)) back.push({ axis, op: "delete", value: n.value });
  }
  if (back.length) {
    const r = await save(back, cur.body.sha);
    ck("③ fixture 已还原", r.status === 200 && r.body.wrote === true, JSON.stringify(r.body).slice(0, 160));
  } else ck("③ fixture 无需还原（本来就一致）", true);
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
