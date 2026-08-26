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
  // ⚠️ A10-R1-c 之后期望值从 `-3` 变成 `-2`，**不是把测试改成迁就代码**：
  //    旧的 `-3` 是「编号 = 数组下标 + 2」算出来的，而拆掉"编号编码位置"这件事
  //    正是这次要修的根（见第 ⑨ 组那个实测过的静默覆盖）。
  //    新规则是「已占用编号 max+1」；本用例里那张 `a.webp` 不符合 `<slug>-N.webp` 约定、
  //    **不占任何编号** ⇒ 最小可用号就是 2。换成符合约定的 fixture 时它会给 -3（第 ⑨ 组量过）。
  ck("⑥ 新增 gallery：追加到末尾，编号取「已占用 max+1」",
    r.images.gallery.length === 2 && r.images.gallery[1] === "products/test-widget-2.webp", JSON.stringify(r.images));
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

// ══════ ⑨ A10-R1-c：文件名不许由数组下标派生（**实测过的静默覆盖**）══════
//
// 🔴 这不是假想的错法。旧写法 `uploadName = <slug>-<slot+2>` 在下面这个时序上
//    会 upsert 覆盖一张**仍被引用**的图，而预览把它显示成"新增"、不给任何警告：
//      [foo-2,foo-3,foo-4] → 删中间的 foo-3 → 长度变 2 → 再传一张 slot=2 → 给出 foo-4
//    加上拖拽排序后，下标与编号彻底脱钩，这个洞更容易踩。
{
  const start = { main: "products/foo.webp",
    gallery: ["products/foo-2.webp", "products/foo-3.webp", "products/foo-4.webp"] };
  const afterDel = planImages("foo", "published", start, start, [], [1]);
  ck("⑨ 删中间一张后 gallery 收缩", JSON.stringify(afterDel.images.gallery) ===
    '["products/foo-2.webp","products/foo-4.webp"]', JSON.stringify(afterDel.images.gallery));

  const cur = afterDel.images;
  const slot = (cur.gallery || []).length;          // 前端按数组长度给 slot
  const added = planImages("foo", "published", cur, cur, [{ slot, base64: "TkVX" }], []);
  const norm = (p) => p.replace(/^src\/assets\//, "");
  const stillRef = new Set((cur.gallery || []).map(norm));
  const upserts = added.ops.filter((o) => o.op === "upsert").map((o) => norm(o.path));

  ck("⑨ 🔴 关键：新图不许 upsert 到仍被引用的路径（静默覆盖）",
    !upserts.some((p) => stillRef.has(p)),
    `upserts=${JSON.stringify(upserts)} 仍被引用=${JSON.stringify([...stillRef])}`);

  const g = (added.images.gallery || []).map(norm);
  ck("⑨ 🔴 关键：结果 gallery 里不许出现重复路径（两个下标指向同一文件）",
    g.length === new Set(g).size, JSON.stringify(g));

  ck("⑨ 新号取「已占用 max+1」，不复用刚删掉的号（复用会让 git 历史同名不同图）",
    upserts[0] === "products/foo-5.webp", JSON.stringify(upserts));
}
{
  // 反向自证：分配器不是"永远给一个大号" —— 干净产品的第一张仍是 -2
  const p = planImages("bar", "published", null, { main: "products/bar.webp" },
    [{ slot: 0, base64: "WA==" }], []);
  ck("⑨ 反向自证：干净产品的第一张 gallery 仍是 -2（不与既有 23 个产品的命名分叉）",
    (p.images.gallery || [])[0] === "products/bar-2.webp", JSON.stringify(p.images.gallery));
}
{
  // 同一次提交里传多张：号必须**各不相同**且接在已占用之后
  const cur = { main: "products/baz.webp", gallery: ["products/baz-2.webp"] };
  const p = planImages("baz", "published", cur, cur,
    [{ slot: 1, base64: "QQ==" }, { slot: 2, base64: "Qg==" }], []);
  const g = p.images.gallery || [];
  ck("⑨ 一次传多张：编号各不相同", new Set(g).size === g.length, JSON.stringify(g));
  ck("⑨ 一次传多张：接在已占用编号之后（-3、-4）",
    JSON.stringify(g) === '["products/baz-2.webp","products/baz-3.webp","products/baz-4.webp"]', JSON.stringify(g));
}

// ══════ ⑩ R1-d 第 7 条：只换顺序不换图 ⇒ **零文件操作** ══════
// 总工读代码推断"排序走 retarget 到同一目录、repoPath 相等 ⇒ 零 ops"，要求实测证实。
{
  const cur = { main: "products/foo.webp",
    gallery: ["products/foo-2.webp", "products/foo-3.webp", "products/foo-4.webp"] };
  // 把 gallery[2] 拖到首位（顺序变了，文件一个没换）
  const reordered = { main: "products/foo.webp",
    gallery: ["products/foo-4.webp", "products/foo-2.webp", "products/foo-3.webp"] };
  const p = planImages("foo", "published", cur, reordered, [], []);
  ck("⑩ 只拖 gallery 顺序 ⇒ 零文件操作", p.ops.length === 0,
    JSON.stringify(p.ops.map((o) => o.op + " " + o.path)));
  ck("⑩ 且 JSON 里的顺序确实换了", JSON.stringify(p.images.gallery) === JSON.stringify(reordered.gallery),
    JSON.stringify(p.images.gallery));
}
{
  // 第 8 条：把第 3 张拖到首位 = 它成为主图，原主图落进 gallery[0]
  const cur = { main: "products/foo.webp",
    gallery: ["products/foo-2.webp", "products/foo-3.webp"] };
  const promoted = { main: "products/foo-3.webp",
    gallery: ["products/foo.webp", "products/foo-2.webp"] };
  const p = planImages("foo", "published", cur, promoted, [], []);
  ck("⑩ 主图与 gallery 互换 ⇒ 仍是零文件操作（同目录，只改 JSON 指向）", p.ops.length === 0,
    JSON.stringify(p.ops.map((o) => o.op + " " + o.path)));
  ck("⑩ images.main 变成被提升的那张", p.images.main === "products/foo-3.webp", p.images.main);
  ck("⑩ 原主图落进 gallery[0]", (p.images.gallery || [])[0] === "products/foo.webp",
    JSON.stringify(p.images.gallery));
}

console.log(out.join("\n"));
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);


