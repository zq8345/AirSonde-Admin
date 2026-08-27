// A10-R1 图片列表全链实跑：R9（碰撞场景）+ 排序零操作。
//
// 🔴 打**靶子仓** `zq8345/AirSonde-Admin` 的 `fixtures/products`，绝不碰官网仓。
//
// 为什么非要端到端跑一次（总工点名"不接受推演结论"）：
//   R9 的事故时序里，"删掉中间一张"必须是一次**真实保存**——
//   删完之后仓里的状态才是下一步的输入。用假数据串起来的话，
//   我串的是"我以为保存之后会变成什么样"，而不是它真的变成了什么样。
//
// 前提：.dev.vars 临时打开 GITHUB_REPO=zq8345/AirSonde-Admin / PRODUCTS_DIR=fixtures/products
//       另一个终端跑着 npm run dev。跑完会把测试产品删干净。

import fs from "fs";
const B = "http://localhost:8788";
const SLUG = "imgorder-e2e";
const TARGET_REPO = "zq8345/AirSonde-Admin";

// 🔴 分支**不写死**，从 /api/_whoami 现取（AU2 ⑨）。
//    写死 `main` 有两个后果，第二个更毒：
//      ① 写入现在去 e2e-fixtures 分支了（出站口第三道闸不许本机写生产分支）——
//         再去 main 上核对，读到的是别人的世界。
//      ② `commits?per_page=1` 不带 sha 时读的是**仓库默认分支**（main）⇒
//         "有没有产生提交"这种前后对比会看到"没变"，于是**报告"没写成"，而其实写成了**。
//         那不是报错，是一个安静的错答案。
//    ⇒ 分支只有一个来源：被测进程自己说的那个。
let BRANCH = null;   // ⓪ 里赋值；下面的 URL 都是模板串，取值发生在调用时

const DIR = "fixtures/products";

const TOKEN = (() => {
  try {
    const m = /^\s*GITHUB_TOKEN_SELFTEST\s*=\s*([^\s#]+)/m.exec(
      fs.readFileSync(new URL("../.dev.vars", import.meta.url), "utf8"));
    return m ? m[1] : null;
  } catch { return null; }
})();
const GH = { "User-Agent": "imgorder-e2e", Accept: "application/vnd.github+json",
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) };

let pass = 0, fail = 0;
const ck = (n, ok, d = "") => { if (ok) pass++; else fail++; console.log(`${ok ? "✅" : "🔴"} ${n}${d ? "\n     " + d : ""}`); };
const say = (s) => console.log(s);
const req = async (p, i) => { const r = await fetch(B + p, i); return { status: r.status, body: await r.json().catch(() => null) }; };
const put = (env) => req(`/api/products/${SLUG}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(env) });

async function tree() {
  const r = await fetch(`https://api.github.com/repos/${TARGET_REPO}/git/trees/${BRANCH}?recursive=1&_=${Date.now()}`, { headers: GH });
  const t = await r.text();
  if (r.status === 403 && /rate limit/i.test(t)) { console.log("🔴 GitHub 限流（仪器问题）—— 不出结论。"); process.exit(2); }
  const j = JSON.parse(t);
  if (j.truncated) throw new Error("tree 被截断，拒绝在不完整基线上判断");
  return new Map(j.tree.filter((x) => x.type === "blob").map((x) => [x.path, x.sha]));
}
const P = (n) => `src/assets/products/${n}`;

// ── ⓪ 仪器：先证明打的是靶子仓 ──
const who = await req("/api/_whoami").catch(() => null);
if (!who || who.status !== 200) { console.log("🔴 连不上 dev —— 不出结论。"); process.exit(2); }
if (who.body.data.repo !== TARGET_REPO || who.body.data.productsDir !== DIR) {
  console.log(`🔴 数据源是 ${who.body.data.repo}/${who.body.data.productsDir}，不是靶子 —— 不出结论。`);
  process.exit(2);
}

// 🔴 ⓪ 分支：从被测进程自己那里取，并且**必须不是生产分支**（AU2 ⑨）。
//    靶子仓就是本 worker 自己的仓 ⇒ 往它的 main 推一个提交 = 一次 Workers Builds 生产部署，
//    跑一轮这种脚本会推十几个。出站口已经硬拒了，这里再拦一道是为了**早报、报得懂**：
//    否则症状是跑到一半突然一片 403，看起来像 token 坏了。
BRANCH = who.body.data.branch;
if (!BRANCH || BRANCH === "main" || BRANCH === "master") {
  console.log(`🔴 数据源分支是 \`${BRANCH}\`（生产分支）—— 不出结论。
` +
    `   在 .dev.vars 里加一行 GITHUB_BRANCH=e2e-fixtures 再重启 dev。`);
  process.exit(2);
}
if (!who.body.data.writeEnabled || !TOKEN) { console.log("🔴 writeEnabled/token 不满足 —— 不出结论。"); process.exit(2); }
say(`⓪ 目标：${TARGET_REPO}/${DIR}\n`);

// 真实 webp 字节
const imgRes = await fetch("https://raw.githubusercontent.com/zq8345/AirSonde-Web/main/src/assets/products/16in1-large-display-monitor.webp");
if (!imgRes.ok) { console.log("🔴 取测试图失败"); process.exit(2); }
const bytes = new Uint8Array(await imgRes.arrayBuffer());
let bin = ""; for (const b of bytes) bin += String.fromCharCode(b);
const IMG = btoa(bin);

const BASE = { slug: SLUG, name: "Imgorder E2E", model: "AK901", category: "other", sensors: ["CO2"], status: "published" };

try {
  const t0 = await tree();
  if (t0.has(`${DIR}/${SLUG}.json`)) { console.log("🔴 靶子仓有残留，拒绝在脏基线上测。"); process.exit(2); }

  // ── ① 建一个带 1 主图 + 3 gallery 的产品 ──
  const r1 = await put({
    patch: { ...BASE, images: { main: "", gallery: [null, null, null] } },
    uploads: [{ slot: "main", base64: IMG }, { slot: 0, base64: IMG }, { slot: 1, base64: IMG }, { slot: 2, base64: IMG }],
    mustCreate: true,
  });
  ck("① 建成（主图 + 3 张 gallery）", r1.body?.wrote === true, JSON.stringify(r1.body?.error || r1.body?.validation?.errors || ""));
  const g1 = (await req(`/api/products/${SLUG}`)).body.product.images;
  say(`   gallery = ${JSON.stringify(g1.gallery.map((x) => x.split("/").pop()))}`);
  ck("① 编号从 -2 起、依次递增（不与既有 23 个产品分叉）",
    JSON.stringify(g1.gallery) === JSON.stringify([`products/${SLUG}-2.webp`, `products/${SLUG}-3.webp`, `products/${SLUG}-4.webp`]),
    JSON.stringify(g1.gallery));

  // ── ② R9 第一步：**真实保存**一次"删掉中间那张" ──
  const keep = [g1.gallery[0], g1.gallery[2]];
  const r2 = await put({ patch: { images: { main: g1.main, gallery: keep } }, uploads: [] });
  ck("② 删中间一张保存成功", r2.body?.wrote === true, JSON.stringify(r2.body?.error || ""));
  const t2 = await tree();
  ck("② 被删的 -3 真的从仓里消失了", !t2.has(P(`${SLUG}-3.webp`)));
  ck("② 🔴 关键：仍被引用的 -2 与 -4 **还在仓里**（没被顺手删掉）",
    t2.has(P(`${SLUG}-2.webp`)) && t2.has(P(`${SLUG}-4.webp`)));
  const sha4Before = t2.get(P(`${SLUG}-4.webp`));

  // ── ③ R9 第二步：在**真实的删后状态**上再传一张 ──
  const g2 = (await req(`/api/products/${SLUG}`)).body.product.images;
  const r3 = await put({
    patch: { images: { main: g2.main, gallery: [...g2.gallery, null] } },
    uploads: [{ slot: g2.gallery.length, base64: IMG }],
  });
  ck("③ 再传一张保存成功", r3.body?.wrote === true, JSON.stringify(r3.body?.error || ""));
  const g3 = (await req(`/api/products/${SLUG}`)).body.product.images;
  say(`   gallery = ${JSON.stringify(g3.gallery.map((x) => x.split("/").pop()))}`);

  const t3 = await tree();
  // 🔴 本轮的核心判据：旧写法会在这里把仍被引用的 -4 覆盖掉（slot=2 → 名字算出 -4）
  ck("③ 🔴🔴 关键：仍被引用的 -4 **字节未变**（旧写法会在这里静默覆盖它）",
    t3.get(P(`${SLUG}-4.webp`)) === sha4Before,
    `前=${String(sha4Before).slice(0, 7)} 后=${String(t3.get(P(`${SLUG}-4.webp`))).slice(0, 7)}`);
  ck("③ 新图拿到没人用过的号 -5", g3.gallery[g3.gallery.length - 1] === `products/${SLUG}-5.webp`,
    JSON.stringify(g3.gallery));
  const names = g3.gallery.map((x) => x.split("/").pop());
  ck("③ gallery 里没有重复路径", new Set(names).size === names.length, JSON.stringify(names));

  // ── ④ 排序：只换顺序，**零文件操作**（真保存一次，看仓里 blob sha 全都没动）──
  const before4 = await tree();
  const shas = names.map((n) => before4.get(P(n)));
  const reordered = [...g3.gallery].reverse();
  const r4 = await put({ patch: { images: { main: g3.main, gallery: reordered } }, uploads: [] });
  ck("④ 只换顺序保存成功", r4.body?.wrote === true, JSON.stringify(r4.body?.error || ""));
  const after4 = await tree();
  ck("④ 🔴 关键：所有图片 blob sha 一个都没变（排序不搬文件）",
    names.every((n, i) => after4.get(P(n)) === shas[i]),
    names.map((n, i) => `${n}:${String(shas[i]).slice(0, 7)}→${String(after4.get(P(n))).slice(0, 7)}`).join(" | "));
  const g4 = (await req(`/api/products/${SLUG}`)).body.product.images;
  ck("④ 但 JSON 里的顺序确实倒过来了", JSON.stringify(g4.gallery) === JSON.stringify(reordered), JSON.stringify(g4.gallery));

  // ── ⑤ 把 gallery 第一张提为封面 ──
  const promoted = { main: g4.gallery[0], gallery: [g4.main, ...g4.gallery.slice(1)] };
  const before5 = await tree();
  const r5 = await put({ patch: { images: promoted }, uploads: [] });
  ck("⑤ 提为封面保存成功", r5.body?.wrote === true, JSON.stringify(r5.body?.error || ""));
  const g5 = (await req(`/api/products/${SLUG}`)).body.product.images;
  ck("⑤ images.main 变成被提升的那张", g5.main === promoted.main, g5.main);
  ck("⑤ 原主图落进 gallery[0]", g5.gallery[0] === g4.main, JSON.stringify(g5.gallery));
  const after5 = await tree();
  ck("⑤ 🔴 仍然零文件搬动（同目录，只改 JSON 指向）",
    [...before5.keys()].filter((k) => k.includes(SLUG) && k.endsWith(".webp"))
      .every((k) => after5.get(k) === before5.get(k)));
} finally {
  await req(`/api/products/${SLUG}`, { method: "DELETE" }).catch(() => {});
  const tz = await tree();
  // 🔴 只在**这个测试真正会写的两个目录**里找残留。
  //    原来是全仓 `k.includes(SLUG)` 的子串匹配 —— 而 `scripts/imgorder-e2e.mjs`
  //    这个脚本**自己**就躺在仓里且包含这个串 ⇒ 这一条**永远红**，报的是它自己。
  //    一条恒红的判据和一条恒绿的一样没用：它训练人忽略红色，真残留来了没人信。
  //    （子串匹配假命中，与图片死链扫描那次是同一个病。）
  const WRITES_TO = ["fixtures/products/", "src/assets/products/"];
  const left = [...tz.keys()].filter((k) => WRITES_TO.some((d) => k.startsWith(d)) && k.includes(SLUG));
  ck("⑥ 清理干净（仓里无残留）", left.length === 0, left.join(", "));
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
