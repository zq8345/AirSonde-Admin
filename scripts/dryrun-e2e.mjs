// dry-run 端到端验收（20 条）。⚠️ 需要**先**满足两个前提，否则它量的是别的东西：
//   1) .dev.vars 里把数据源指到本仓 fixtures（见 fixtures/README.md）
//   2) 另一个终端跑着 `npm run dev`（本脚本打 localhost:8788）
// 脚本第 ⓪ 条会先证明「我在跟谁说话」—— 数据源不对就直接红，不会拿别的目录的结果冒充通过。
//
// 🔴 走的是**真实 GitHub contents API**，不是本地假数据注入：
//    假数据旁路测的是一条生产上根本不存在的代码路径，测过了也不说明什么。
// A2-2 端到端验收：走真实 GitHub contents API 读 fixtures，验 dry-run 的行为。
import { pathToFileURL } from "url";
const B = "http://localhost:8788";
let pass = 0, fail = 0; const out = [];
const check = (n, c, d = "") => { if (c) { pass++; out.push(`✅ ${n}`); } else { fail++; out.push(`🔴 ${n}\n     ${d}`); } };

const get = async (p) => { const r = await fetch(B + p); return { status: r.status, body: await r.json().catch(() => null) }; };
const post = async (p, b) => {
  const r = await fetch(B + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

// 先证身份：确认打到的是指向 fixtures 的那个进程，而不是别的
const t0 = Date.now();
let who = null;
while (Date.now() - t0 < 90000) {
  try { const r = await get("/api/_whoami"); if (r.status === 200) { who = r.body; break; } } catch {}
  await new Promise((r) => setTimeout(r, 800));
}
if (!who) { console.log("🔴 dev 起不来"); process.exit(1); }
console.log(`进程身份：repo=${who.data.repo}  dir=${who.data.productsDir}  sha=${who.git.shortSha}  isLocalDev=${who.request.isLocalDev}\n`);
check("⓪ 数据源确实指向 fixtures（否则下面全部量的是别的东西）",
  who.data.repo === "zq8345/AirSonde-Admin" && who.data.productsDir === "fixtures/products",
  JSON.stringify(who.data));

// ── 列表 ──
{
  const r = await get("/api/products");
  check("① 列目录读到 2 个 fixture", r.body?.dirExists === true && r.body?.count === 2,
    JSON.stringify({ dirExists: r.body?.dirExists, count: r.body?.count }));
  check("① slug 从文件名推出来", r.body?.files?.some((f) => f.slug === "fixture-desktop-16in1"), JSON.stringify(r.body?.files?.map(f => f.slug)));
}

// ── 读单个 + 校验（正对照）──
{
  const r = await get("/api/products/fixture-desktop-16in1");
  check("② 合法 fixture：读得到且校验通过（正对照）",
    r.status === 200 && r.body?.validation?.ok === true && r.body?.validation?.errors?.length === 0,
    JSON.stringify(r.body?.validation));
  check("② 中文/重音字节没坏（UTF-8 解码路径）", typeof r.body?.raw === "string" && r.body.raw.includes("USB-C / built-in battery"), "");
}

// ── 读单个 + 校验（反向自证：真实存在过的缺陷形态）──
{
  const r = await get("/api/products/fixture-supplier-leak");
  const codes = (r.body?.validation?.errors || []).map((e) => e.code);
  check("③ 反向自证：specs 里粘了 alibaba 链接的文件，读出来必须报 supplier_leak",
    r.status === 200 && codes.includes("supplier_leak"), JSON.stringify(codes));
}

// ── 不存在的产品 ──
{
  const r = await get("/api/products/no-such-product");
  check("④ 不存在的 slug 回 404 且 exists:false（不是 500，也不是空对象）",
    r.status === 404 && r.body?.exists === false, JSON.stringify(r.body));
}

// ── dry-run：改一个字段 ──
{
  const r = await post("/api/products/fixture-desktop-16in1/preview", { name: "16-in-1 Desktop Air Monitor" });
  const b = r.body;
  check("⑤ dry-run 明确声明什么也没写", b?.wrote === false && b?.mode === "dry-run", JSON.stringify({ wrote: b?.wrote, mode: b?.mode }));
  check("⑤ 写能力显示为未开启", String(b?.writeCapability).includes("未开启"), String(b?.writeCapability));
  check("⑤ 只有 name 被记为改动", JSON.stringify(b?.change?.touched) === '["name"]', JSON.stringify(b?.change));
  check("⑤ diff 恰好 1 增 1 删（只动了一行）", b?.change?.added === 1 && b?.change?.removed === 1,
    JSON.stringify({ added: b?.change?.added, removed: b?.change?.removed }));
  check("⑤ 校验通过", b?.validation?.ok === true, JSON.stringify(b?.validation?.errors));
}

// ── dry-run：空补丁 ⇒ 必须明说"什么也不会变" ──
{
  const r = await post("/api/products/fixture-desktop-16in1/preview", {});
  check("⑥ 空补丁必须报 identical:true（不能让人以为存进去了）",
    r.body?.change?.identical === true && r.body?.ok === false, JSON.stringify(r.body?.change));
}

// ── dry-run：undefined ≠ 清空（JSON 里传不了 undefined，缺字段就是缺）──
{
  const r = await post("/api/products/fixture-desktop-16in1/preview", { name: "X" });
  const w = JSON.parse(r.body.wouldWrite.text);
  check("⑦ 补丁没提到的字段原样保留（moq/specs/gallery 都还在）",
    w.moq === 1000 && w.specs?.display === "7-inch TFT" && w.images?.gallery?.length === 1,
    JSON.stringify({ moq: w.moq, specs: w.specs, gallery: w.images?.gallery }));
}

// ── dry-run：显式 null 才是清空 ──
{
  const r = await post("/api/products/fixture-desktop-16in1/preview", { moq: null });
  const w = JSON.parse(r.body.wouldWrite.text);
  check("⑧ 显式 null 清空该字段，且被记进 cleared",
    !("moq" in w) && r.body.change.cleared.includes("moq"), JSON.stringify(r.body.change));
}

// ── dry-run：坏数据必须拦住 ──
{
  const r = await post("/api/products/fixture-desktop-16in1/preview", { category: "handheld" });
  const codes = (r.body?.validation?.errors || []).map((e) => e.code);
  check("⑨ 枚举外的 category 必须报错且 ok=false", r.body?.ok === false && codes.includes("enum"), JSON.stringify(codes));
}
{
  const r = await post("/api/products/fixture-desktop-16in1/preview", { specs: { src: "https://www.alibaba.com/x" } });
  const codes = (r.body?.validation?.errors || []).map((e) => e.code);
  check("⑨ 往 specs 粘供应商链接必须在**写入之前**被拦", codes.includes("supplier_leak"), JSON.stringify(codes));
}
{
  const r = await post("/api/products/fixture-desktop-16in1/preview", { slug: "renamed-thing" });
  const codes = (r.body?.validation?.errors || []).map((e) => e.code);
  check("⑨ 改了 slug 但文件名没变 ⇒ 必须报 slug_path_mismatch", codes.includes("slug_path_mismatch"), JSON.stringify(codes));
}

// ── dry-run：新建（文件不存在）──
{
  const r = await post("/api/products/brand-new-meter/preview", {
    slug: "brand-new-meter", name: "Handheld TVOC Meter", model: "AS-H03",
    category: "portable", sensors: ["TVOC"], images: { main: "products/brand-new-meter.webp" }, status: "draft",
  });
  check("⑩ 新建：target.exists=false，diff 是整份新增，校验通过",
    r.body?.target?.exists === false && r.body?.validation?.ok === true && r.body?.change?.removed === 0,
    JSON.stringify({ exists: r.body?.target?.exists, ok: r.body?.validation?.ok, change: r.body?.change }));
}

// ── 契约枚举端点（界面用，避免前端抄第二份）──
{
  const r = await get("/api/contract");
  // ⚠️ 原来写的是 `sensors.length === 13` —— 那是**比字面量**：契约 v1.1 加了个 `CO`，
  //    这条断言当场过时，而它过时的方式是"报红"，会被当成端点坏了。
  //    改成**比真源**：端点吐出来的必须与 src/contract.ts 里那份**集合相等**。
  //    这样它只有一个正确答案，也永远不需要跟着契约手动改。
  const { CATEGORIES, SENSORS, STATUSES } = await import(pathToFileURL("C:/开发/airsonde/airsonde-admin/src/contract.ts").href);
  const same = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join();
  check("⑪ /api/contract 与 src/contract.ts 集合相等（比真源，不比条数）",
    same(r.body?.categories || [], CATEGORIES) && same(r.body?.sensors || [], SENSORS) && same(r.body?.statuses || [], STATUSES),
    JSON.stringify({ 端点sensors: r.body?.sensors?.length, 模块sensors: SENSORS.length }));
}

console.log(out.join("\n"));
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);

