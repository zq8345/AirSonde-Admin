// 站点内容写入全链实跑（联系方式 / 首页 / SEO 三个视图共用的那一个 JSON）。
//
// 🔴 打的是**靶子仓** `zq8345/AirSonde-Admin` 的 `fixtures/site-content.json`，
//    **绝不碰官网仓**（出站闸把 zq8345/AirSonde-Web 写死在黑名单里）。
//
// 本轮真正要量的那一件事：
//   三个视图共用一个文件、每次**只提交自己那一节** ⇒
//   保存「联系方式」时，**首页文案和 SEO 必须一个字都不变**。
//   这条错了的症状是：保存联系方式 → 首页文案被抹掉 → 接口还回 ok。
//   单看合并函数的自检不够 —— 那只证明我以为的协议；这里要证明**真写进仓的字节**是对的。
//
// 前提（第 ⓪ 步逐条断言，不满足 exit 2 且不出任何结论）：
//   .dev.vars 临时打开：GITHUB_REPO=zq8345/AirSonde-Admin
//                       SITE_CONTENT_PATH=fixtures/site-content.json
//   另一个终端跑着 `npm run dev`
// 跑完会把 fixture 还原成起始内容。

import fs from "fs";
const B = "http://localhost:8788";
const TARGET_REPO = "zq8345/AirSonde-Admin";
const PATH = "fixtures/site-content.json";

const DEV_VARS = new URL("../.dev.vars", import.meta.url);
const TOKEN = (() => {
  try {
    const m = /^\s*GITHUB_TOKEN_SELFTEST\s*=\s*([^\s#]+)/m.exec(fs.readFileSync(DEV_VARS, "utf8"));
    return m ? m[1] : null;
  } catch { return null; }
})();
const GH = { "User-Agent": "sitecontent-e2e", Accept: "application/vnd.github+json", ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) };

let pass = 0, fail = 0;
const ck = (n, ok, d = "") => { if (ok) pass++; else fail++; console.log(`${ok ? "✅" : "🔴"} ${n}${d ? "\n     " + d : ""}`); };
const say = (s) => console.log(s);

const req = async (path, init) => {
  const r = await fetch(B + path, init);
  return { status: r.status, body: await r.json().catch(() => null) };
};
const get = () => req("/api/site-content");
const put = (patch, expectedSha, section) => req("/api/site-content", {
  method: "PUT", headers: { "content-type": "application/json" },
  body: JSON.stringify({ patch, expectedSha, section }),
});
const headSha = async () =>
  (await (await fetch(`https://api.github.com/repos/${TARGET_REPO}/commits?per_page=1&_=${Date.now()}`, { headers: GH })).json())[0].sha;

/** 按 blob sha 读**仓里真实的字节** —— 不看接口自己说了什么。 */
async function readFromRepo() {
  const t = await fetch(`https://api.github.com/repos/${TARGET_REPO}/git/trees/main?recursive=1&_=${Date.now()}`, { headers: GH });
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
if (!who.body.data.writeEnabled) { console.log("🔴 writeEnabled=false —— 不出结论。"); process.exit(2); }
if (!TOKEN) { console.log("🔴 校验侧没有 token，匿名读会被限流 —— 不出结论。"); process.exit(2); }

const g0 = await get();
if (g0.status !== 200) { console.log(`🔴 GET /api/site-content → ${g0.status}：${JSON.stringify(g0.body)}`); process.exit(2); }
if (g0.body.path !== PATH) {
  console.log(`🔴 端点打的是 ${g0.body.path}，不是 ${PATH} —— 说明 SITE_CONTENT_PATH 没生效。不出结论。`);
  process.exit(2);
}
say(`⓪ 目标：${TARGET_REPO} / ${g0.body.path}  sha=${String(g0.body.sha).slice(0, 7)}`);
const ORIGINAL = JSON.parse(JSON.stringify(g0.body.content));
say(`⓪ 起始内容校验：ok=${g0.body.validation.ok}\n`);

try {
  // ══════ ① 只提交 contact 一节 ⇒ 另外两节**一个字都不许变** ══════
  const before = await readFromRepo();
  const r1 = await put({ contact: { ...ORIGINAL.contact, phone: "+86 138 0000 0001" } }, g0.body.sha, "contact");
  ck("① 保存联系方式成功", r1.body?.wrote === true, `status=${r1.status} ${JSON.stringify(r1.body?.error || r1.body?.reason || r1.body?.validation?.errors || "")}`);

  const after = await readFromRepo();
  ck("① 电话确实改了", after?.contact?.phone === "+86 138 0000 0001", JSON.stringify(after?.contact?.phone));
  // ⭐ 本轮的核心判据
  ck("① 🔴 关键：seo 一节逐字节未变（只提交 contact 不许波及它）",
    JSON.stringify(after?.seo) === JSON.stringify(before?.seo));
  ck("① 🔴 关键：home 一节逐字节未变",
    JSON.stringify(after?.home) === JSON.stringify(before?.home));
  ck("① 同一节里没提交的字段也没丢", after?.contact?.email === before?.contact?.email && after?.contact?.address === before?.contact?.address,
    JSON.stringify(after?.contact));
  ck("① _readme 原样保留（它写着哪些东西有意没放进来）",
    JSON.stringify(after?._readme) === JSON.stringify(before?._readme));
  ck("① 服务端报出的改动字段就是那一个", JSON.stringify(r1.body?.changedFields) === '["contact.phone"]', JSON.stringify(r1.body?.changedFields));

  const cm = await (await fetch(`https://api.github.com/repos/${TARGET_REPO}/commits/${r1.body.commitSha}`, { headers: GH })).json();
  ck("① 一个 commit 只动了这一个文件", (cm.files || []).length === 1 && cm.files[0].filename === PATH,
    (cm.files || []).map((f) => f.filename).join(", "));
  ck("① commit message 认得出是哪一节", /^admin: site 联系方式 \(/.test(cm.commit.message), cm.commit.message.split("\n")[0]);

  // ══════ ② 坏数据：两页 title 相同 ⇒ 422 且**零 commit** ══════
  const g2 = await get();
  const before2 = await headSha();
  const dupe = JSON.parse(JSON.stringify(g2.body.content.seo));
  dupe.pages.contact.title = dupe.pages.products.title;
  const r2 = await put({ seo: dupe }, g2.body.sha, "seo");
  ck("② 重复 title 被拒（422）", r2.status === 422 && r2.body?.wrote === false, `status=${r2.status}`);
  ck("② 拒绝理由说得出后果（官网构建会失败）",
    (r2.body?.validation?.errors || []).some((e) => e.code === "duplicate_title"),
    JSON.stringify((r2.body?.validation?.errors || []).map((e) => e.code)));
  ck("② 🔴 零 commit：HEAD 一点没动（这才是「被拒」的证据，不是接口说 422）",
    (await headSha()) === before2, `前=${String(before2).slice(0, 7)} 后=${String(await headSha()).slice(0, 7)}`);

  // ══════ ③ 乐观锁：拿过期的 sha 保存 ⇒ 409 且零 commit ══════
  const before3 = await headSha();
  const r3 = await put({ contact: { ...ORIGINAL.contact, hours: "变了" } }, "0000000000000000000000000000000000000000", "contact");
  ck("③ 过期 sha ⇒ 409（不静默覆盖别人的改动）", r3.status === 409 && r3.body?.wrote === false, `status=${r3.status}`);
  ck("③ 零 commit", (await headSha()) === before3);

  // ══════ ④ 内容没变 ⇒ 不产生空 commit ══════
  const g4 = await get();
  const before4 = await headSha();
  const r4 = await put({ contact: g4.body.content.contact }, g4.body.sha, "contact");
  ck("④ 与仓里完全相同 ⇒ 不写（不制造「改过」的假记录）", r4.body?.wrote === false && /相同/.test(r4.body?.reason || ""),
    JSON.stringify(r4.body));
  ck("④ 零 commit", (await headSha()) === before4);

  // ══════ ⑤ 正对照：合法改动仍然写得进去（证明上面的拒绝是有选择的）══════
  const g5 = await get();
  const r5 = await put({ home: { ...g5.body.content.home, hero: { ...g5.body.content.home.hero, headline: "E2E headline" } } }, g5.body.sha, "home");
  ck("⑤ 正对照：合法的首页改动写得进去", r5.body?.wrote === true, JSON.stringify(r5.body?.error || r5.body?.validation?.errors || ""));
  const after5 = await readFromRepo();
  ck("⑤ 且这次轮到 contact 不受影响", after5?.contact?.phone === "+86 138 0000 0001", JSON.stringify(after5?.contact?.phone));
} finally {
  // ── 还原 fixture 到起始内容 ──
  const gz = await get();
  if (gz.status === 200 && JSON.stringify(gz.body.content) !== JSON.stringify(ORIGINAL)) {
    const rz = await put({ seo: ORIGINAL.seo, contact: ORIGINAL.contact, home: ORIGINAL.home }, gz.body.sha, "restore");
    ck("⑥ 还原 fixture 成功", rz.body?.wrote === true, JSON.stringify(rz.body?.error || ""));
  } else ck("⑥ 还原 fixture（本就无需还原）", true);
  const final = await readFromRepo();
  ck("⑥ 仓里内容与起始逐字节相同", JSON.stringify(final) === JSON.stringify(ORIGINAL));
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
