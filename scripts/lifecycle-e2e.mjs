// A6 全链实跑：新建（含图）→ draft→published → published→draft → 删除。
//
// 🔴 打的是**靶子仓** `zq8345/AirSonde-Admin` 的 `fixtures/products/`，**绝不碰官网数据仓**。
//    这不是靠自觉：src/github.ts 的出站闸把 `zq8345/AirSonde-Web` 写死在黑名单里，
//    本机无论怎么配都写不到它（见 scripts/egress-selftest.mjs 第 ④ 组）。
//
// 前提（缺一不可，第 ⓪ 步会逐条断言，不满足就 exit 2 且**不出任何验收结论**）：
//   1) .dev.vars: GITHUB_REPO=zq8345/AirSonde-Admin / PRODUCTS_DIR=fixtures/products
//                 GITHUB_TOKEN_SELFTEST=<仅 AirSonde-Admin 仓 Contents R+W 的 fine-grained token>
//   2) 另一个终端跑着 `npm run dev`
//
// ⚠️ 跑完会把测试产品和它的图**删干净**（最后一步就是删除，且会复核仓内无残留）。

const B = "http://localhost:8788";
const SLUG = "a6-selftest-widget";
const TARGET_REPO = "zq8345/AirSonde-Admin";
const DIR = "fixtures/products";
const GH = { "User-Agent": "a6-lifecycle", Accept: "application/vnd.github+json" };

let pass = 0, fail = 0; const out = [];
const ck = (n, ok, d = "") => { if (ok) pass++; else fail++; out.push(`${ok ? "✅" : "🔴"} ${n}${d ? "\n     " + d : ""}`); };
const say = (s) => { console.log(s); out.push(s); };

const req = async (path, init) => {
  const r = await fetch(B + path, init);
  return { status: r.status, body: await r.json().catch(() => null) };
};
const put = (slug, env) => req(`/api/products/${slug}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(env) });
const del = (slug) => req(`/api/products/${slug}`, { method: "DELETE" });

/**
 * 仓内真实文件树（真读远端，不看接口返回）。返回 path → blob sha。
 * ⚠️ 带上 sha 不是顺手：下面读文件内容要靠它，见 readJsonAt 的理由。
 */
async function repoTree() {
  const r = await fetch(`https://api.github.com/repos/${TARGET_REPO}/git/trees/main?recursive=1`, { headers: GH });
  if (!r.ok) throw new Error(`读靶子仓 tree 失败 ${r.status}`);
  const j = await r.json();
  if (j.truncated) throw new Error("tree 被截断，拒绝在不完整基线上判断");
  return new Map(j.tree.filter((t) => t.type === "blob").map((t) => [t.path, t.sha]));
}
const has = (tree, p) => tree.has(p);

/**
 * 按 **blob sha** 读文件内容。
 *
 * 🔴 不要用 `raw.githubusercontent.com`：它有 ≈300s 的 CDN 缓存，
 *    commit 刚落就去读，可能拿到**上一版**甚至 404 —— 于是会出现
 *    「tree 断言绿、JSON 断言红」这种组合，而被测对象其实完全正常。
 *    那是一次纯粹的误诊，且方向指向代码。
 * ⇒ blob sha 是**内容的哈希**，按 sha 取到的对象**不可变、永不陈旧**，闭环。
 */
async function readJsonAt(tree, path) {
  const sha = tree.get(path);
  if (!sha) throw new Error(`${path} 不在树里，读不了`);
  const r = await fetch(`https://api.github.com/repos/${TARGET_REPO}/git/blobs/${sha}`, { headers: GH });
  if (!r.ok) throw new Error(`读 blob ${sha.slice(0, 7)} 失败 ${r.status}`);
  const j = await r.json();
  return JSON.parse(Buffer.from(j.content.replace(/\n/g, ""), "base64").toString("utf8"));
}

// ══════════ ⓪ 仪器自检：先证明我在跟谁说话、以及这次真的能写 ══════════
// ⚠️ 这一段自己必须先健壮：dev 没起时 fetch 会**抛**，不是回一个状态码。
//    不接住的话，脚本以未捕获异常 exit 1 结束 —— 而 1 的含义是"判据没过"，
//    看结果的人会去查被测对象，可实际上根本没量到东西。exit 2 才是"我没量成"。
let who;
try { who = await req("/api/_whoami"); }
catch (e) {
  console.log(`🔴 连不上 ${B}（${e.message}）—— 先在另一个终端跑 \`npm run dev\`。本次不出任何结论。`);
  process.exit(2);
}
if (who.status !== 200) { console.log(`🔴 /api/_whoami → ${who.status}，不出结论。`); process.exit(2); }
const d = who.body.data;
say(`⓪ 进程身份：repo=${d.repo}  dir=${d.productsDir}  writeEnabled=${d.writeEnabled}  isLocalDev=${who.body.request.isLocalDev}`);
if (d.repo !== TARGET_REPO || d.productsDir !== DIR) {
  console.log(`🔴 数据源不是靶子（期望 ${TARGET_REPO} / ${DIR}）—— 本次不出任何结论，也绝不在别的仓上跑生命周期测试。`);
  process.exit(2);
}
if (!d.writeEnabled) {
  console.log("🔴 writeEnabled=false（多半是 GITHUB_TOKEN_SELFTEST 没配）—— 不出结论。");
  process.exit(2);
}

// 拿一张**真实的 webp 字节**来上传：从公开仓取一张现成的产品图，不自己合成。
// ⚠️ 合成的"最小 webp"可能绕过真实解码路径，测过了也不代表真图能用。
const imgRes = await fetch("https://raw.githubusercontent.com/zq8345/AirSonde-Web/main/src/assets/products/16in1-large-display-monitor.webp");
if (!imgRes.ok) { console.log(`🔴 取测试图失败 ${imgRes.status}`); process.exit(2); }
const imgBytes = new Uint8Array(await imgRes.arrayBuffer());
let bin = ""; for (const b of imgBytes) bin += String.fromCharCode(b);
const IMG_B64 = btoa(bin);
say(`⓪ 测试图：${imgBytes.length}B（真实 WebP，取自公开仓）\n`);

const BASE = {
  slug: SLUG, name: "A6 Selftest Widget", model: "AS-T99",
  category: "other", sensors: ["CO2"], status: "draft",
  images: { main: "" },   // 由服务端按 status 归一化
};
const P_DRAFT = `src/assets/products/_draft/${SLUG}.webp`;
const P_PUB = `src/assets/products/${SLUG}.webp`;
const P_JSON = `${DIR}/${SLUG}.json`;

try {
  // 起点必须干净，否则后面的断言全都可能是上一次残留造成的
  const t0 = await repoTree();
  if (has(t0, P_JSON) || has(t0, P_DRAFT) || has(t0, P_PUB)) {
    console.log("🔴 靶子仓里已有上次残留的测试文件，先清掉再跑（拒绝在脏基线上测）。");
    process.exit(2);
  }

  // ══════════ ① 新建（draft，含图）——JSON 与图必须在同一个 commit ══════════
  const r1 = await put(SLUG, { patch: BASE, uploads: [{ slot: "main", base64: IMG_B64 }], mustCreate: true });
  ck("① 新建成功", r1.body?.wrote === true, `status=${r1.status} ${JSON.stringify(r1.body?.error || r1.body?.reason || "")}`);
  const c1 = r1.body?.commitSha;
  const t1 = await repoTree();
  ck("① JSON 与图片进了仓", has(t1, P_JSON) && has(t1, P_DRAFT), `json=${has(t1, P_JSON)} img=${has(t1, P_DRAFT)}`);
  ck("① draft 的图在 _draft/，**不在** products/（物理隔离那条硬规则）",
    has(t1, P_DRAFT) && !has(t1, P_PUB), `_draft=${has(t1, P_DRAFT)} products=${has(t1, P_PUB)}`);
  // 原子性：两个文件必须属于**同一个** commit
  const cm = await (await fetch(`https://api.github.com/repos/${TARGET_REPO}/commits/${c1}`, { headers: GH })).json();
  const touched = (cm.files || []).map((f) => f.filename);
  ck("① 原子：JSON 与图在同一个 commit 里", touched.includes(P_JSON) && touched.includes(P_DRAFT),
    `commit ${String(c1).slice(0, 7)} 触及 ${touched.length} 个文件：${touched.join(", ")}`);

  // ══════════ ② draft → published：图必须搬到 products/ ══════════
  const r2 = await put(SLUG, { patch: { status: "published" } });
  ck("② 转 published 成功", r2.body?.wrote === true, JSON.stringify(r2.body?.error || ""));
  const t2 = await repoTree();
  ck("② 图搬到 products/，且 _draft/ 里的已删除",
    has(t2, P_PUB) && !has(t2, P_DRAFT), `products=${has(t2, P_PUB)} _draft=${has(t2, P_DRAFT)}`);
  const j2 = await readJsonAt(t2, P_JSON);
  ck("② JSON 里的路径也跟着改了（文件搬了而 JSON 没改 = 官网当场缺图）",
    j2.images.main === `products/${SLUG}.webp`, JSON.stringify(j2.images));

  // ══════════ ③ published → draft：反方向必须同样成立 ══════════
  const r3 = await put(SLUG, { patch: { status: "draft" } });
  ck("③ 转回 draft 成功", r3.body?.wrote === true, JSON.stringify(r3.body?.error || ""));
  const t3 = await repoTree();
  ck("③ 反方向：图回到 _draft/，products/ 里的已删除",
    has(t3, P_DRAFT) && !has(t3, P_PUB), `_draft=${has(t3, P_DRAFT)} products=${has(t3, P_PUB)}`);
  const j3 = await readJsonAt(t3, P_JSON);
  ck("③ 往返闭合：JSON 路径回到起点", j3.images.main === `products/_draft/${SLUG}.webp`, JSON.stringify(j3.images));

  // ══════════ ④ 契约闸不回归：坏数据必须 422 且**零 commit** ══════════
  const before = await (await fetch(`https://api.github.com/repos/${TARGET_REPO}/commits?per_page=1`, { headers: GH })).json();
  const headBefore = before[0].sha;
  const r4 = await put(SLUG, { patch: { specs: { src: "https://www.alibaba.com/x" } } });
  ck("④ 坏数据被拒（422）", r4.status === 422 && r4.body?.wrote === false, `status=${r4.status}`);
  const after = await (await fetch(`https://api.github.com/repos/${TARGET_REPO}/commits?per_page=1`, { headers: GH })).json();
  ck("④ **零 commit**：HEAD 一点没动（这才是「被拒」的证据，不是接口说 422）",
    after[0].sha === headBefore, `前=${headBefore.slice(0, 7)} 后=${after[0].sha.slice(0, 7)}`);

  // ══════════ ⑤ 删除：JSON 与图一起消失 ══════════
  const r5 = await del(SLUG);
  ck("⑤ 删除成功", r5.body?.wrote === true, JSON.stringify(r5.body?.error || ""));
  const t5 = await repoTree();
  ck("⑤ 仓内无残留（JSON、_draft 图、products 图都没了）",
    !has(t5, P_JSON) && !has(t5, P_DRAFT) && !has(t5, P_PUB),
    `json=${has(t5, P_JSON)} _draft=${has(t5, P_DRAFT)} products=${has(t5, P_PUB)}`);
} finally {
  // 兜底清理：上面任何一步炸了都不要在靶子仓留垃圾
  const t = await repoTree().catch(() => null);
  if (t && (has(t, P_JSON) || has(t, P_DRAFT) || has(t, P_PUB))) {
    say("\n⚠️ 检测到残留，尝试清理…");
    const r = await del(SLUG).catch(() => null);
    say(`   清理结果：${r?.body?.wrote === true ? "已删除" : "未能删除，请人工检查靶子仓 " + DIR}`);
  }
}

console.log("\n" + out.filter((l) => l.startsWith("✅") || l.startsWith("🔴") || l.startsWith("⚠️")).join("\n"));
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
