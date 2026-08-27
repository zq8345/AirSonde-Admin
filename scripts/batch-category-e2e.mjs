const SRC = new URL("../src/", import.meta.url).href;   // ⚠️ 绝不写绝对路径：CI 是 Linux
// 批量改机型（op=category）全链实跑。
//
// 🔴 打的是**靶子仓** `zq8345/AirSonde-Admin` 的 `fixtures/products/`，**绝不碰官网数据仓**。
//    （src/github.ts 的出站闸把 `zq8345/AirSonde-Web` 写死在黑名单里，本机配不出来。）
//
// 这一轮真正要量的是**一件很容易悄悄出错的事**：
//   批改 category 时，图片**不许动**。
//   图片的落点只由 status 决定，而批量那条路是与改 status 共用的 ——
//   共用代码 + 换了个字段 = "顺手把图也搬了"这种事会发生，而且**看不出来**：
//   JSON 里的 category 确实改对了，界面一切正常，只有官网构建时才会缺图。
//   ⇒ 所以下面不只断言 category 变了，还断言**图片路径与 blob sha 一个字节都没变**。
//
// 前提（缺一不可，第 ⓪ 步逐条断言，不满足 exit 2 且**不出任何结论**）：
//   1) .dev.vars 临时打开：GITHUB_REPO=zq8345/AirSonde-Admin / PRODUCTS_DIR=fixtures/products
//   2) 另一个终端跑着 `npm run dev`
// 跑完会把测试产品和图删干净。

import fs from "fs";
const B = "http://localhost:8788";
const SLUGS = ["batchcat-selftest-a", "batchcat-selftest-b"];
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

const DEV_VARS = new URL("../.dev.vars", import.meta.url);
const TOKEN = (() => {
  try {
    const m = /^\s*GITHUB_TOKEN_SELFTEST\s*=\s*([^\s#]+)/m.exec(fs.readFileSync(DEV_VARS, "utf8"));
    return m ? m[1] : null;
  } catch { return null; }
})();
const GH = {
  "User-Agent": "batchcat-e2e",
  Accept: "application/vnd.github+json",
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
};

/** 限流是**仪器问题**，不是判据没过 —— 必须单独识别并 exit 2。 */
function assertNotRateLimited(res, bodyText) {
  if (res.status === 403 && /rate limit/i.test(bodyText || "")) {
    console.log("🔴 GitHub API 限流（仪器问题，不是被测对象的问题）—— 本次不出任何验收结论。");
    process.exit(2);
  }
}

let pass = 0, fail = 0;
const ck = (n, ok, d = "") => { if (ok) pass++; else fail++; console.log(`${ok ? "✅" : "🔴"} ${n}${d ? "\n     " + d : ""}`); };
const say = (s) => console.log(s);

const req = async (path, init) => {
  const r = await fetch(B + path, init);
  return { status: r.status, body: await r.json().catch(() => null) };
};
const put = (slug, env) => req(`/api/products/${slug}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(env) });
const del = (slug) => req(`/api/products/${slug}`, { method: "DELETE" });
const batch = (slugs, op, value) => req("/api/products/batch", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slugs, op, value }),
});

async function repoTree() {
  const r = await fetch(`https://api.github.com/repos/${TARGET_REPO}/git/trees/${BRANCH}?recursive=1&_=${Date.now()}`, { headers: GH });
  if (!r.ok) { const t = await r.text(); assertNotRateLimited(r, t); throw new Error(`读靶子仓 tree 失败 ${r.status}`); }
  const j = await r.json();
  if (j.truncated) throw new Error("tree 被截断，拒绝在不完整基线上判断");
  return new Map(j.tree.filter((t) => t.type === "blob").map((t) => [t.path, t.sha]));
}
/** 按 blob sha 读 —— raw CDN 有 ≈300s 缓存，刚 commit 完读它会拿到旧内容，红得毫无意义。 */
async function readJsonAt(tree, path) {
  const sha = tree.get(path);
  if (!sha) return null;
  const r = await fetch(`https://api.github.com/repos/${TARGET_REPO}/git/blobs/${sha}`, { headers: GH });
  if (!r.ok) throw new Error(`读 blob 失败 ${r.status}`);
  const j = await r.json();
  return JSON.parse(Buffer.from(j.content.replace(/\n/g, ""), "base64").toString("utf8"));
}
const headSha = async () =>
  (await (await fetch(`https://api.github.com/repos/${TARGET_REPO}/commits?sha=${BRANCH}&per_page=1&_=${Date.now()}`, { headers: GH })).json())[0].sha;

// ══════════ ⓪ 仪器自检：先证明我在跟谁说话 ══════════
let who;
try { who = await req("/api/_whoami"); }
catch (e) { console.log(`🔴 连不上 ${B}（${e.message}）—— 先起 \`npm run dev\`。不出结论。`); process.exit(2); }
if (who.status !== 200) { console.log(`🔴 /api/_whoami → ${who.status}，不出结论。`); process.exit(2); }
const d = who.body.data;
say(`⓪ 进程身份：repo=${d.repo}  dir=${d.productsDir}  writeEnabled=${d.writeEnabled}`);
if (d.repo !== TARGET_REPO || d.productsDir !== DIR) {
  console.log(`🔴 数据源不是靶子（期望 ${TARGET_REPO} / ${DIR}）—— 不出结论，绝不在别的仓上跑写入测试。`);
  process.exit(2);
}

// 🔴 ⓪ 分支：从被测进程自己那里取，并且**必须不是生产分支**（AU2 ⑨）。
//    靶子仓就是本 worker 自己的仓 ⇒ 往它的 main 推一个提交 = 一次 Workers Builds 生产部署，
//    跑一轮这种脚本会推十几个。出站口已经硬拒了，这里再拦一道是为了**早报、报得懂**：
//    否则症状是跑到一半突然一片 403，看起来像 token 坏了。
BRANCH = d.branch;
if (!BRANCH || BRANCH === "main" || BRANCH === "master") {
  console.log(`🔴 数据源分支是 \`${BRANCH}\`（生产分支）—— 不出结论。
` +
    `   在 .dev.vars 里加一行 GITHUB_BRANCH=e2e-fixtures 再重启 dev。`);
  process.exit(2);
}
if (!d.writeEnabled) { console.log("🔴 writeEnabled=false —— 不出结论。"); process.exit(2); }
if (!TOKEN) { console.log("🔴 校验侧拿不到 token，匿名读会被限流，结论不可信。不出结论。"); process.exit(2); }

// 真实 webp 字节（不自己合成：合成的最小 webp 可能绕开真实路径）
const imgRes = await fetch("https://raw.githubusercontent.com/zq8345/AirSonde-Web/main/src/assets/products/16in1-large-display-monitor.webp");
if (!imgRes.ok) { console.log(`🔴 取测试图失败 ${imgRes.status}`); process.exit(2); }
const imgBytes = new Uint8Array(await imgRes.arrayBuffer());
let bin = ""; for (const b of imgBytes) bin += String.fromCharCode(b);
const IMG_B64 = btoa(bin);
say(`⓪ 测试图 ${imgBytes.length}B（真实 WebP）\n`);

const P_JSON = (s) => `${DIR}/${s}.json`;
const P_PUB = (s) => `src/assets/products/${s}.webp`;
const P_DRAFT = (s) => `src/assets/products/_draft/${s}.webp`;

try {
  const t0 = await repoTree();
  for (const s of SLUGS) {
    if (t0.has(P_JSON(s)) || t0.has(P_PUB(s)) || t0.has(P_DRAFT(s))) {
      console.log(`🔴 靶子仓里有 ${s} 的残留，拒绝在脏基线上测。`); process.exit(2);
    }
  }

  // ── 建两个 published 产品（category=other），带真图 ──
  for (const s of SLUGS) {
    const r = await put(s, {
      patch: { slug: s, name: `Batchcat Selftest ${s.slice(-1).toUpperCase()}`, model: "AS-T98",
               category: "other", sensors: ["CO2"], status: "published", images: { main: "" } },
      uploads: [{ slot: "main", base64: IMG_B64 }], mustCreate: true,
    });
    if (r.body?.wrote !== true) { console.log(`🔴 建 ${s} 失败：${JSON.stringify(r.body)}`); process.exit(2); }
  }
  const tA = await repoTree();
  const imgShaBefore = SLUGS.map((s) => tA.get(P_PUB(s)));
  say(`⓪ 起点就绪：2 个 published 产品，category=other，图在 products/\n`);

  // ══════════ ① 批量改机型：一次 commit，两份 JSON 都改 ══════════
  const before1 = await headSha();
  const r1 = await batch(SLUGS, "category", "portable");
  ck("① 批量改机型成功", r1.body?.wrote === true, `status=${r1.status} ${JSON.stringify(r1.body?.error || r1.body?.reason || "")}`);
  ck("① 两个都算改动（不是只改了一个）", r1.body?.changed?.length === 2, JSON.stringify(r1.body?.changed));

  const t1 = await repoTree();
  const j1 = await Promise.all(SLUGS.map((s) => readJsonAt(t1, P_JSON(s))));
  ck("① 两份 JSON 的 category 都变成 portable", j1.every((j) => j?.category === "portable"),
    JSON.stringify(j1.map((j) => j?.category)));

  // ⭐ 本轮的核心判据：图**一个字节都不许动**
  ck("① 🔴 关键：图片仍在 products/，没有被搬到 _draft/",
    SLUGS.every((s) => t1.has(P_PUB(s)) && !t1.has(P_DRAFT(s))),
    SLUGS.map((s) => `${s}: pub=${t1.has(P_PUB(s))} draft=${t1.has(P_DRAFT(s))}`).join(" | "));
  ck("① 🔴 关键：图片 blob sha 与改之前完全相同（没被重写）",
    SLUGS.every((s, i) => t1.get(P_PUB(s)) === imgShaBefore[i]),
    SLUGS.map((s, i) => `${s}: ${String(imgShaBefore[i]).slice(0, 7)}→${String(t1.get(P_PUB(s))).slice(0, 7)}`).join(" | "));
  ck("① JSON 里的图片路径也没变", j1.every((j, i) => j?.images?.main === `products/${SLUGS[i]}.webp`),
    JSON.stringify(j1.map((j) => j?.images?.main)));
  ck("① 服务端报告 imageOps=0（不是「搬了又搬回原处」）", r1.body?.imageOps === 0, `imageOps=${r1.body?.imageOps}`);

  // ── 原子性 + commit message 形状（审计日志要解析它）──
  const cm = await (await fetch(`https://api.github.com/repos/${TARGET_REPO}/commits/${r1.body.commitSha}`, { headers: GH })).json();
  const touched = (cm.files || []).map((f) => f.filename);
  ck("① 原子：两份 JSON 在同一个 commit 里，且**只**动了这两个文件",
    touched.length === 2 && SLUGS.every((s) => touched.includes(P_JSON(s))),
    `触及 ${touched.length} 个：${touched.join(", ")}`);
  const msg = cm.commit.message;
  ck("① commit message 写的是 category=portable", /^admin: bulk category=portable · 2 个产品 \(/.test(msg), msg.split("\n")[0]);

  // ⭐ 与审计日志**真解析器**对接：格式对不对不由我肉眼判，由那个解析器判
  const { classify } = await import(SRC + "audit.ts");
  const e = classify(r1.body.commitSha, msg, cm.commit.author.date, "x");
  ck("① 审计解析器认得这条（action=bulk / fields=category=portable / 2 个 slug）",
    e.action === "bulk" && e.fields === "category=portable" && e.slugs.length === 2, JSON.stringify(e));
  ck("① 从头到尾只产生了 1 个 commit", cm.parents?.[0]?.sha === before1, `parent=${String(cm.parents?.[0]?.sha).slice(0, 7)} before=${String(before1).slice(0, 7)}`);

  // ══════════ ② 幂等：再改成同一个值 ⇒ 全部跳过，**零 commit** ══════════
  const before2 = await headSha();
  const r2 = await batch(SLUGS, "category", "portable");
  ck("② 重复同一个值 ⇒ 不写（没有需要改动的产品）", r2.body?.wrote === false, JSON.stringify(r2.body));
  ck("② 且把跳过的理由说出来（不是静默无事发生）",
    r2.body?.skipped?.length === 2 && r2.body.skipped.every((s) => /已经是 portable/.test(s.why)), JSON.stringify(r2.body?.skipped));
  ck("② 零 commit（HEAD 没动）", (await headSha()) === before2);

  // ══════════ ③ 白名单闸：非法字段 / 非法值一律拒，且**零 commit** ══════════
  const before3 = await headSha();
  const bad1 = await batch(SLUGS, "supplierRef", "https://alibaba.com/x");
  ck("③ 🔴 关键：不在白名单的字段被拒（否则一次能批改内部字段）", bad1.status === 400 && bad1.body?.wrote === false, `status=${bad1.status} ${JSON.stringify(bad1.body)}`);
  const bad2 = await batch(SLUGS, "category", "not-a-category");
  ck("③ 非法机型值被拒", bad2.status === 400 && bad2.body?.wrote === false, `status=${bad2.status}`);
  ck("③ 两次非法请求都没产生 commit", (await headSha()) === before3);

  // ══════════ ④ 正对照：改回 other 必须真的能改（③ 不是把功能整个关掉了）══════════
  const r4 = await batch(SLUGS, "category", "other");
  ck("④ 正对照：合法值仍然写得进去（证明上面的拒绝是有选择的，不是全拒）",
    r4.body?.wrote === true && r4.body?.changed?.length === 2, JSON.stringify(r4.body?.error || r4.body?.changed));
  const t4 = await repoTree();
  const j4 = await Promise.all(SLUGS.map((s) => readJsonAt(t4, P_JSON(s))));
  ck("④ 往返闭合：category 回到 other", j4.every((j) => j?.category === "other"), JSON.stringify(j4.map((j) => j?.category)));

  // ══════════ ⑤ status 那条老路没被我改坏（同一个端点，共用代码）══════════
  const r5 = await batch(SLUGS, "status", "draft");
  ck("⑤ 回归：批量改 status 仍然可用", r5.body?.wrote === true && r5.body?.changed?.length === 2, JSON.stringify(r5.body?.error || r5.body?.changed));
  const t5 = await repoTree();
  ck("⑤ 回归：改 status 时图**确实**搬去了 _draft/（对照 ①：那次不搬是对的，不是它根本不会搬）",
    SLUGS.every((s) => t5.has(P_DRAFT(s)) && !t5.has(P_PUB(s))),
    SLUGS.map((s) => `${s}: draft=${t5.has(P_DRAFT(s))} pub=${t5.has(P_PUB(s))}`).join(" | "));
} finally {
  // ── 清理：不管上面结果如何都要清干净，否则下一轮会在脏基线上拒跑 ──
  for (const s of SLUGS) { try { await del(s); } catch { /* 尽力清理 */ } }
  const tz = await repoTree();
  const leftover = SLUGS.flatMap((s) => [P_JSON(s), P_PUB(s), P_DRAFT(s)]).filter((p) => tz.has(p));
  ck("⑥ 清理干净（仓里无残留）", leftover.length === 0, leftover.join(", "));
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
