const SRC = new URL("../src/", import.meta.url).href;   // ⚠️ 绝不写绝对路径：CI 是 Linux，`C:/…` 在那里根本不存在
// 图片位置规划自检 —— 本批最容易漏的那条联动（status 切换时图片搬家）在这里被量。
//
// 🔴 判据纪律：**往返两个方向都要测**。
//    只测 published→draft 的话，一个"永远往 _draft 搬"的实现也全绿 ——
//    而那种实现会把已上线产品的图搬进 draft 目录，官网当场缺图。
// 🔴 还要有"不该动"的正对照：状态没变、图没换时**必须零操作**。
//    否则每次保存都产生一次无谓的文件搬动 commit，官网跟着重建，
//    而且 git 历史会被"搬来搬去"淹没，真正的改动看不出来。
import { pathToFileURL } from "url";
const M = await import(SRC + "imagepaths.ts");
const { planImages, planDelete, dirForStatus, repoPath } = M;

let pass = 0, fail = 0; const out = [];
const ck = (n, c, d = "") => { if (c) { pass++; out.push(`✅ ${n}`); } else { fail++; out.push(`🔴 ${n}\n     ${d}`); } };
const SLUG = "test-widget";
const P = (p) => "src/assets/" + p;
const ops2s = (ops) => ops.map((o) => `${o.op} ${o.path}${o.fromPath ? " ←" + o.fromPath : ""}`).sort().join(" | ");

// ── ① 正对照：状态没变、图没换 ⇒ 零操作 ──
{
  const cur = { main: "products/test-widget.webp" };
  const r = planImages(SLUG, "published", cur, cur, [], []);
  ck("① 正对照：published 保持不变 ⇒ 零文件操作", r.ops.length === 0, ops2s(r.ops));
  ck("① 且 images 原样", r.images.main === "products/test-widget.webp", JSON.stringify(r.images));
}
{
  const cur = { main: "products/_draft/test-widget.webp" };
  const r = planImages(SLUG, "draft", cur, cur, [], []);
  ck("① 正对照：draft 保持不变 ⇒ 零文件操作", r.ops.length === 0, ops2s(r.ops));
}

// ── ② published → draft ──
let afterToDraft;
{
  const cur = { main: "products/test-widget.webp" };
  const r = planImages(SLUG, "draft", cur, cur, [], []);
  afterToDraft = r.images;
  ck("② published→draft：JSON 路径进 _draft", r.images.main === "products/_draft/test-widget.webp", JSON.stringify(r.images));
  ck("② 且产生 copy+delete 一对（git 没有 move）",
    r.ops.length === 2 && r.ops.some((o) => o.op === "copy" && o.path === P("products/_draft/test-widget.webp"))
      && r.ops.some((o) => o.op === "delete" && o.path === P("products/test-widget.webp")), ops2s(r.ops));
}

// ── ③ draft → published（反方向，必须测）──
{
  const r = planImages(SLUG, "published", afterToDraft, afterToDraft, [], []);
  ck("③ draft→published：JSON 路径回到 products/", r.images.main === "products/test-widget.webp", JSON.stringify(r.images));
  ck("③ 且 copy 目标是 products/、delete 的是 _draft/",
    r.ops.some((o) => o.op === "copy" && o.path === P("products/test-widget.webp"))
      && r.ops.some((o) => o.op === "delete" && o.path === P("products/_draft/test-widget.webp")), ops2s(r.ops));
}

// ── ④ 往返闭合：published→draft→published 必须回到原位 ──
{
  const start = { main: "products/test-widget.webp", gallery: ["products/test-widget-2.webp"] };
  const a = planImages(SLUG, "draft", start, start, [], []).images;
  const b = planImages(SLUG, "published", a, a, [], []).images;
  ck("④ 往返闭合：published→draft→published 回到原路径（含 gallery）",
    JSON.stringify(b) === JSON.stringify(start), `起点=${JSON.stringify(start)}\n     往返后=${JSON.stringify(b)}`);
}

// ── ⑤ 上传主图 ──
{
  const r = planImages(SLUG, "draft", null, null, [{ slot: "main", base64: "AAAA" }], []);
  ck("⑤ 新建+上传主图：落在 _draft 且文件名 = slug",
    r.images.main === "products/_draft/test-widget.webp"
      && r.ops.length === 1 && r.ops[0].op === "upsert" && r.ops[0].base64 === "AAAA", ops2s(r.ops));
}
{
  const cur = { main: "products/old-name.webp" };
  const r = planImages(SLUG, "published", cur, cur, [{ slot: "main", base64: "BBBB" }], []);
  ck("⑤ 换主图：写新文件 + 删旧文件（否则仓里留一张没人引用的图）",
    r.ops.some((o) => o.op === "upsert" && o.path === P("products/test-widget.webp"))
      && r.ops.some((o) => o.op === "delete" && o.path === P("products/old-name.webp")), ops2s(r.ops));
}

// ── ⑥ gallery ──
{
  const cur = { main: "products/test-widget.webp", gallery: ["products/a.webp", "products/b.webp"] };
  const r = planImages(SLUG, "published", cur, cur, [], [0]);
  ck("⑥ 删 gallery[0]：产生 delete，且剩下的项还在",
    r.ops.some((o) => o.op === "delete" && o.path === P("products/a.webp"))
      && JSON.stringify(r.images.gallery) === JSON.stringify(["products/b.webp"]), ops2s(r.ops) + " | " + JSON.stringify(r.images));
}
{
  const cur = { main: "products/test-widget.webp", gallery: ["products/a.webp"] };
  const r = planImages(SLUG, "published", cur, cur, [{ slot: 1, base64: "CCCC" }], []);
  ck("⑥ 新增 gallery：追加到末尾，文件名按 slug 编号（gallery 从 -2 起，主图算第 1 张）",
    r.images.gallery.length === 2 && r.images.gallery[1] === "products/test-widget-3.webp", JSON.stringify(r.images));
}
{
  const cur = { main: "products/test-widget.webp", gallery: ["products/a.webp"] };
  const r = planImages(SLUG, "draft", cur, cur, [], []);
  ck("⑥ 状态切换时 gallery 也跟着搬（不能只搬主图）",
    r.images.gallery[0] === "products/_draft/a.webp"
      && r.ops.some((o) => o.op === "copy" && o.path === P("products/_draft/a.webp")), JSON.stringify(r.images));
}

// ── ⑦ 删除产品 ──
{
  const ops = planDelete("src/content/products/test-widget.json",
    { main: "products/test-widget.webp", gallery: ["products/test-widget-2.webp"] });
  ck("⑦ 删除产品：JSON + 主图 + gallery 全部进删除列表",
    ops.length === 3 && ops.every((o) => o.op === "delete"), ops2s(ops));
}

// ── ⑧ 目录映射本身 ──
{
  ck("⑧ dirForStatus 映射正确", dirForStatus("published") === "products" && dirForStatus("draft") === "products/_draft");
  // ⚠️ 反向自证：未知状态**不能**落到 published 目录 —— 那会让一个状态不明的产品的图直接上站
  ck("⑧ 反向自证：未知状态不落在 published 目录", dirForStatus("weird") === "products/_draft", dirForStatus("weird"));
  ck("⑧ repoPath 前缀", repoPath("products/x.webp") === "src/assets/products/x.webp");
}

console.log(out.join("\n"));
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);


