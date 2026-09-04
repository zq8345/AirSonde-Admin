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
const { planImages, planDelete, dirForStatus, repoPath, folderForModel, checkDanglingRefs } = M;

let pass = 0, fail = 0; const out = [];
const ck = (n, c, d = "") => { if (c) { pass++; out.push(`✅ ${n}`); } else { fail++; out.push(`🔴 ${n}\n     ${d}`); } };
const SLUG = "test-widget";
// 批 2：published 的图落在 `products/<型号小写>/` ⇒ 下面的期望路径都是 products/ak99/…
const MODEL = "AK99";
const P = (p) => "src/assets/" + p;
const ops2s = (ops) => ops.map((o) => `${o.op} ${o.path}${o.fromPath ? " ←" + o.fromPath : ""}`).sort().join(" | ");

// ── ① 正对照：状态没变、图没换 ⇒ 零操作 ──
{
  const cur = { main: "products/ak99/test-widget.webp" };
  const r = planImages(SLUG, "published", MODEL, cur, cur, [], []);
  ck("① 正对照：published 保持不变 ⇒ 零文件操作", r.ops.length === 0, ops2s(r.ops));
  ck("① 且 images 原样", r.images.main === "products/ak99/test-widget.webp", JSON.stringify(r.images));
}
{
  const cur = { main: "products/_draft/test-widget.webp" };
  const r = planImages(SLUG, "draft", MODEL, cur, cur, [], []);
  ck("① 正对照：draft 保持不变 ⇒ 零文件操作", r.ops.length === 0, ops2s(r.ops));
}

// ── ② published → draft ──
let afterToDraft;
{
  const cur = { main: "products/ak99/test-widget.webp" };
  const r = planImages(SLUG, "draft", MODEL, cur, cur, [], []);
  afterToDraft = r.images;
  ck("② published→draft：JSON 路径进 _draft", r.images.main === "products/_draft/test-widget.webp", JSON.stringify(r.images));
  ck("② 且产生 copy+delete 一对（git 没有 move）",
    r.ops.length === 2 && r.ops.some((o) => o.op === "copy" && o.path === P("products/_draft/test-widget.webp"))
      && r.ops.some((o) => o.op === "delete" && o.path === P("products/ak99/test-widget.webp")), ops2s(r.ops));
}

// ── ③ draft → published（反方向，必须测）──
{
  const r = planImages(SLUG, "published", MODEL, afterToDraft, afterToDraft, [], []);
  ck("③ draft→published：JSON 路径回到 products/", r.images.main === "products/ak99/test-widget.webp", JSON.stringify(r.images));
  ck("③ 且 copy 目标是 products/、delete 的是 _draft/",
    r.ops.some((o) => o.op === "copy" && o.path === P("products/ak99/test-widget.webp"))
      && r.ops.some((o) => o.op === "delete" && o.path === P("products/_draft/test-widget.webp")), ops2s(r.ops));
}

// ── ④ 往返闭合：published→draft→published 必须回到原位 ──
{
  const start = { main: "products/ak99/test-widget.webp", gallery: ["products/ak99/test-widget-2.webp"] };
  const a = planImages(SLUG, "draft", MODEL, start, start, [], []).images;
  const b = planImages(SLUG, "published", MODEL, a, a, [], []).images;
  ck("④ 往返闭合：published→draft→published 回到原路径（含 gallery）",
    JSON.stringify(b) === JSON.stringify(start), `起点=${JSON.stringify(start)}\n     往返后=${JSON.stringify(b)}`);
}

// ── ⑤ 上传主图 ──
{
  const r = planImages(SLUG, "draft", MODEL, null, null, [{ slot: "main", base64: "AAAA" }], []);
  ck("⑤ 新建+上传主图：落在 _draft 且文件名 = slug",
    r.images.main === "products/_draft/test-widget.webp"
      && r.ops.length === 1 && r.ops[0].op === "upsert" && r.ops[0].base64 === "AAAA", ops2s(r.ops));
}
{
  const cur = { main: "products/ak99/old-name.webp" };
  const r = planImages(SLUG, "published", MODEL, cur, cur, [{ slot: "main", base64: "BBBB" }], []);
  ck("⑤ 换主图：写新文件 + 删旧文件（否则仓里留一张没人引用的图）",
    r.ops.some((o) => o.op === "upsert" && o.path === P("products/ak99/test-widget.webp"))
      && r.ops.some((o) => o.op === "delete" && o.path === P("products/ak99/old-name.webp")), ops2s(r.ops));
}

// ── ⑥ gallery ──
{
  const cur = { main: "products/ak99/test-widget.webp", gallery: ["products/ak99/a.webp", "products/ak99/b.webp"] };
  const r = planImages(SLUG, "published", MODEL, cur, cur, [], [0]);
  ck("⑥ 删 gallery[0]：产生 delete，且剩下的项还在",
    r.ops.some((o) => o.op === "delete" && o.path === P("products/ak99/a.webp"))
      && JSON.stringify(r.images.gallery) === JSON.stringify(["products/ak99/b.webp"]), ops2s(r.ops) + " | " + JSON.stringify(r.images));
}
{
  const cur = { main: "products/ak99/test-widget.webp", gallery: ["products/ak99/a.webp"] };
  const r = planImages(SLUG, "published", MODEL, cur, cur, [{ slot: 1, base64: "CCCC" }], []);
  // ⚠️ A10-R1-c 之后期望值从 `-3` 变成 `-2`，**不是把测试改成迁就代码**：
  //    旧的 `-3` 是「编号 = 数组下标 + 2」算出来的，而拆掉"编号编码位置"这件事
  //    正是这次要修的根（见第 ⑨ 组那个实测过的静默覆盖）。
  //    新规则是「已占用编号 max+1」；本用例里那张 `a.webp` 不符合 `<slug>-N.webp` 约定、
  //    **不占任何编号** ⇒ 最小可用号就是 2。换成符合约定的 fixture 时它会给 -3（第 ⑨ 组量过）。
  ck("⑥ 新增 gallery：追加到末尾，编号取「已占用 max+1」",
    r.images.gallery.length === 2 && r.images.gallery[1] === "products/ak99/test-widget-2.webp", JSON.stringify(r.images));
}
{
  const cur = { main: "products/ak99/test-widget.webp", gallery: ["products/ak99/a.webp"] };
  const r = planImages(SLUG, "draft", MODEL, cur, cur, [], []);
  ck("⑥ 状态切换时 gallery 也跟着搬（不能只搬主图）",
    r.images.gallery[0] === "products/_draft/a.webp"
      && r.ops.some((o) => o.op === "copy" && o.path === P("products/_draft/a.webp")), JSON.stringify(r.images));
}

// ── ⑦ 删除产品 ──
{
  const ops = planDelete("src/content/products/test-widget.json",
    { main: "products/ak99/test-widget.webp", gallery: ["products/ak99/test-widget-2.webp"] });
  ck("⑦ 删除产品：JSON + 主图 + gallery 全部进删除列表",
    ops.length === 3 && ops.every((o) => o.op === "delete"), ops2s(ops));
}

// ── ⑧ 目录映射本身（批 2：published 按型号分文件夹）──
// ⚠️ 上面那三条断言是被机械改写误伤过的（`_draft` 被加了型号前缀、repoPath 期望值对不上），
//    整块按新签名重写；顺带把**新行为本身**的判据补齐 —— ⛔ 只改签名不加判据，
//    等于换了行为却没有任何东西在看着它。
{
  ck("⑧ published + 型号 ⇒ products/<型号小写>", dirForStatus("published", "AK99") === "products/ak99", dirForStatus("published", "AK99"));
  ck("⑧ draft 一个字没变：仍是 products/_draft", dirForStatus("draft", "AK99") === "products/_draft", dirForStatus("draft", "AK99"));
  // ⚠️ 反向自证：未知状态**不能**落到 published 目录 —— 那会让一个状态不明的产品的图直接上站
  ck("⑧ 反向自证：未知状态不落在 published 目录", dirForStatus("weird", "AK99") === "products/_draft", dirForStatus("weird", "AK99"));
  ck("⑧ repoPath 前缀", repoPath("products/ak99/x.webp") === "src/assets/products/ak99/x.webp");

  // 🔴 型号算不出合法文件夹名时**回落根目录**，⛔ 绝不编一个名字
  ck("⑧ 型号缺失 ⇒ 回落 products/ 根", dirForStatus("published", "") === "products", dirForStatus("published", ""));
  ck("⑧ 型号是 null ⇒ 回落根", dirForStatus("published", null) === "products", String(dirForStatus("published", null)));
  ck("⑧ 型号全是符号 ⇒ 回落根", dirForStatus("published", "///") === "products", dirForStatus("published", "///"));

  // ⚠️ 文件夹名口径必须与**服务端建文件夹那道闸**一致：^[a-z0-9]+(-[a-z0-9]+)*$
  //    两边口径不一致会出现"这个名字建得出来却写不进去"，或者反过来。
  const RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
  const cases = ["AK35", "AK16DAH-CO", "ak23b", "AK 101", "AK/16", "AK__7"];
  const bad = cases.map((m) => [m, folderForModel(m)]).filter(([, f]) => f !== null && !RE.test(f));
  ck("⑧ 算出来的文件夹名一律通过服务端那道闸的正则", bad.length === 0, JSON.stringify(bad));
  ck("⑧ 带连字符的真实型号不被拆坏", folderForModel("AK16DAH-CO") === "ak16dah-co", String(folderForModel("AK16DAH-CO")));
  // 🔴 反向自证：这条闸不是"永远返回 null" —— 真实型号必须算得出名字
  ck("⑧ 反向自证：真实型号算得出名字（不是永远 null）",
    ["AK35", "AK16A", "AK23B"].every((m) => folderForModel(m) !== null),
    JSON.stringify(["AK35", "AK16A", "AK23B"].map(folderForModel)));
}

// ── ⑪ 批 2 的**边界**：只改"以后往哪写"，⛔ 不碰"已经写在哪" ──
//
// 🔴 这一组是被实测逼出来的，不是我预想的。第一版让存量路径也按新目录归一化，
//    拿 39 个**真产品**逐个跑服务端 preview 之后：**25 个 published 产品在
//    "什么都不改"的保存下也会被重写 images 路径**（各 8~9 行 add + 8~9 行 del）。
//    ⇒ Joe 随手保存一下就触发一次没人要的迁移，而图**还没搬**，官网当场缺图。
//    ⇒ 拆出 `dirForExisting()`：存量原地不动，迁移留给批 3 一个产品一个 commit 地做。
{
  // ① 存量在**根目录**（迁移前的现状）+ published ⇒ 原地不动、零操作
  const atRoot = { main: "products/test-widget.webp", gallery: ["products/test-widget-2.webp"] };
  const r0 = planImages(SLUG, "published", MODEL, atRoot, atRoot, [], []);
  ck("⑪ 🔴 存量在根目录 + published ⇒ 零文件操作（批 2 不迁移）", r0.ops.length === 0, ops2s(r0.ops));
  ck("⑪ 🔴 且 images 路径一个字没改", JSON.stringify(r0.images) === JSON.stringify(atRoot), JSON.stringify(r0.images));

  // ② 存量已在型号目录、又改了型号 ⇒ 仍然原地不动（⛔ 改型号不是迁移的触发器）
  const cur = { main: "products/ak99/test-widget.webp", gallery: ["products/ak99/test-widget-2.webp"] };
  const r = planImages(SLUG, "published", "AK100", cur, cur, [], []);
  ck("⑪ 改型号也不搬存量图（迁移是批 3 的事）",
    r.ops.length === 0 && r.images.main === "products/ak99/test-widget.webp",
    ops2s(r.ops) + " | " + JSON.stringify(r.images));

  // ③ 🔴 反向自证：**新上传**必须落进型号目录 —— 这才是批 2 要做的那件事。
  //    ⛔ 没有这一条的话，一个"永远原地不动"的实现（= 什么都没做）也会全绿。
  const up = planImages(SLUG, "published", MODEL, atRoot, atRoot, [{ slot: "main", base64: "ZZZZ" }], []);
  ck("⑪ 🔴 新上传的主图落进 products/<型号>/", up.images.main === "products/ak99/test-widget.webp", JSON.stringify(up.images));
  ck("⑪ 且根目录那张旧文件被删（不留没人引用的图）",
    up.ops.some((o) => o.op === "delete" && o.path === P("products/test-widget.webp")), ops2s(up.ops));

  // ④ draft → published：图本来就要搬出 _draft ⇒ 顺势落进型号目录
  const fromDraft = { main: "products/_draft/test-widget.webp" };
  const r4 = planImages(SLUG, "published", MODEL, fromDraft, fromDraft, [], []);
  ck("⑪ draft→published：搬出 _draft 时顺势进型号目录", r4.images.main === "products/ak99/test-widget.webp", JSON.stringify(r4.images));
}

// ══════ ⑨ A10-R1-c：文件名不许由数组下标派生（**实测过的静默覆盖**）══════
//
// 🔴 这不是假想的错法。旧写法 `uploadName = <slug>-<slot+2>` 在下面这个时序上
//    会 upsert 覆盖一张**仍被引用**的图，而预览把它显示成"新增"、不给任何警告：
//      [foo-2,foo-3,foo-4] → 删中间的 foo-3 → 长度变 2 → 再传一张 slot=2 → 给出 foo-4
//    加上拖拽排序后，下标与编号彻底脱钩，这个洞更容易踩。
{
  const start = { main: "products/ak99/foo.webp",
    gallery: ["products/ak99/foo-2.webp", "products/ak99/foo-3.webp", "products/ak99/foo-4.webp"] };
  const afterDel = planImages("foo", "published", MODEL, start, start, [], [1]);
  ck("⑨ 删中间一张后 gallery 收缩", JSON.stringify(afterDel.images.gallery) ===
    '["products/ak99/foo-2.webp","products/ak99/foo-4.webp"]', JSON.stringify(afterDel.images.gallery));

  const cur = afterDel.images;
  const slot = (cur.gallery || []).length;          // 前端按数组长度给 slot
  const added = planImages("foo", "published", MODEL, cur, cur, [{ slot, base64: "TkVX" }], []);
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
    upserts[0] === "products/ak99/foo-5.webp", JSON.stringify(upserts));
}
{
  // 反向自证：分配器不是"永远给一个大号" —— 干净产品的第一张仍是 -2
  const p = planImages("bar", "published", MODEL, null, { main: "products/ak99/bar.webp" },
    [{ slot: 0, base64: "WA==" }], []);
  ck("⑨ 反向自证：干净产品的第一张 gallery 仍是 -2（不与既有 23 个产品的命名分叉）",
    (p.images.gallery || [])[0] === "products/ak99/bar-2.webp", JSON.stringify(p.images.gallery));
}
{
  // 同一次提交里传多张：号必须**各不相同**且接在已占用之后
  const cur = { main: "products/ak99/baz.webp", gallery: ["products/ak99/baz-2.webp"] };
  const p = planImages("baz", "published", MODEL, cur, cur,
    [{ slot: 1, base64: "QQ==" }, { slot: 2, base64: "Qg==" }], []);
  const g = p.images.gallery || [];
  ck("⑨ 一次传多张：编号各不相同", new Set(g).size === g.length, JSON.stringify(g));
  ck("⑨ 一次传多张：接在已占用编号之后（-3、-4）",
    JSON.stringify(g) === '["products/ak99/baz-2.webp","products/ak99/baz-3.webp","products/ak99/baz-4.webp"]', JSON.stringify(g));
}

// ══════ ⑩ R1-d 第 7 条：只换顺序不换图 ⇒ **零文件操作** ══════
// 总工读代码推断"排序走 retarget 到同一目录、repoPath 相等 ⇒ 零 ops"，要求实测证实。
{
  const cur = { main: "products/ak99/foo.webp",
    gallery: ["products/ak99/foo-2.webp", "products/ak99/foo-3.webp", "products/ak99/foo-4.webp"] };
  // 把 gallery[2] 拖到首位（顺序变了，文件一个没换）
  const reordered = { main: "products/ak99/foo.webp",
    gallery: ["products/ak99/foo-4.webp", "products/ak99/foo-2.webp", "products/ak99/foo-3.webp"] };
  const p = planImages("foo", "published", MODEL, cur, reordered, [], []);
  ck("⑩ 只拖 gallery 顺序 ⇒ 零文件操作", p.ops.length === 0,
    JSON.stringify(p.ops.map((o) => o.op + " " + o.path)));
  ck("⑩ 且 JSON 里的顺序确实换了", JSON.stringify(p.images.gallery) === JSON.stringify(reordered.gallery),
    JSON.stringify(p.images.gallery));
}
{
  // 第 8 条：把第 3 张拖到首位 = 它成为主图，原主图落进 gallery[0]
  const cur = { main: "products/ak99/foo.webp",
    gallery: ["products/ak99/foo-2.webp", "products/ak99/foo-3.webp"] };
  const promoted = { main: "products/ak99/foo-3.webp",
    gallery: ["products/ak99/foo.webp", "products/ak99/foo-2.webp"] };
  const p = planImages("foo", "published", MODEL, cur, promoted, [], []);
  ck("⑩ 主图与 gallery 互换 ⇒ 仍是零文件操作（同目录，只改 JSON 指向）", p.ops.length === 0,
    JSON.stringify(p.ops.map((o) => o.op + " " + o.path)));
  ck("⑩ images.main 变成被提升的那张", p.images.main === "products/ak99/foo-3.webp", p.images.main);
  ck("⑩ 原主图落进 gallery[0]", (p.images.gallery || [])[0] === "products/ak99/foo.webp",
    JSON.stringify(p.images.gallery));
}

{
  // ⑫ 悬空图片引用（审计③）。
  //
  // 🔴 这道闸判的是「**这次保存有没有让它变坏**」，⛔ 不是"引用是否都存在"。
  //    差别不是措辞：官网仓里此刻就有一条历史遗留的悬空引用（AK13A 的 -3.webp）。
  //    按"都存在"去判，那个产品会**当场变成保存不了** —— 一道防悬空的闸
  //    会把自己变成一个锁死产品的 bug，而且是在 Joe 想改它的时候才发作。
  // 🔴 所以下面**两向都测**：该拦的拦得住，不该拦的一条都不许拦。
  //    ⛔ 只测"被拒"的话，一个恒拒的实现也全绿。
  const E = new Set(["products/ak99/foo.webp", "products/ak99/foo-2.webp"]);

  // ── 正对照：引用都指得到 ⇒ 两边都空 ──
  {
    const r = checkDanglingRefs({ main: "products/ak99/foo.webp", gallery: ["products/ak99/foo-2.webp"] },
      { main: "products/ak99/foo.webp", gallery: ["products/ak99/foo-2.webp"] }, E, [], []);
    ck("⑫ 正对照：引用都在 ⇒ 零 introduced 零 legacy", r.introduced.length === 0 && r.legacy.length === 0, JSON.stringify(r));
  }
  // ── 新引入一条不存在的路径 ⇒ introduced ──
  {
    const r = checkDanglingRefs({ main: "products/ak99/foo.webp", gallery: ["products/ak99/nope.webp"] },
      { main: "products/ak99/foo.webp", gallery: [] }, E, [], []);
    ck("⑫ 新引入的坏路径进 introduced", r.introduced.includes("products/ak99/nope.webp"), JSON.stringify(r));
    ck("⑫ 且不进 legacy（它不是历史遗留）", r.legacy.length === 0, JSON.stringify(r));
  }
  // ── 🔴🔴 历史遗留：上一版就引用着、仓里本来就没有 ⇒ legacy，⛔ 不许拦 ──
  {
    const bad = "products/ak99/gone.webp";
    const r = checkDanglingRefs({ main: "products/ak99/foo.webp", gallery: [bad] },
      { main: "products/ak99/foo.webp", gallery: [bad] }, E, [], []);
    ck("⑫ 🔴 历史遗留的坏路径进 legacy", r.legacy.includes(bad), JSON.stringify(r));
    ck("⑫ 🔴 关键：它**不进** introduced ⇒ 那个产品仍然存得下去", r.introduced.length === 0, JSON.stringify(r));
  }
  // ── 本次删掉一个文件、却还引用它 ⇒ introduced（这次让它变坏了）──
  {
    const r = checkDanglingRefs({ main: "products/ak99/foo.webp", gallery: ["products/ak99/foo-2.webp"] },
      { main: "products/ak99/foo.webp", gallery: ["products/ak99/foo-2.webp"] }, E, [], ["products/ak99/foo-2.webp"]);
    ck("⑫ 🔴 删了文件却还引用它 ⇒ introduced（deleting 参与判定）",
      r.introduced.includes("products/ak99/foo-2.webp"), JSON.stringify(r));
  }
  // ── 本次要新建的文件此刻还不在仓里 ⇒ ⛔ 绝不能误报 ──
  {
    const r = checkDanglingRefs({ main: "products/ak99/foo.webp", gallery: ["products/ak99/foo-3.webp"] },
      { main: "products/ak99/foo.webp", gallery: [] }, E, ["products/ak99/foo-3.webp"], []);
    ck("⑫ 🔴 本次上传的新图不算悬空（creating 参与判定）", r.introduced.length === 0 && r.legacy.length === 0, JSON.stringify(r));
  }
  // ── 同一次里既删又建同一条路径（换图）⇒ 建赢，不算悬空 ──
  {
    const p = "products/ak99/foo.webp";
    const r = checkDanglingRefs({ main: p, gallery: [] }, { main: p, gallery: [] }, E, [p], [p]);
    ck("⑫ 🔴 同一路径先删后建（原地换图）⇒ 不算悬空", r.introduced.length === 0 && r.legacy.length === 0, JSON.stringify(r));
  }
  // ── 反向自证：判据不是"prev 里有过就永远放行" ──
  {
    const bad = "products/ak99/foo-2.webp";   // 它**在**仓里
    const r = checkDanglingRefs({ main: "products/ak99/foo.webp", gallery: [bad] },
      { main: "products/ak99/foo.webp", gallery: [bad] }, E, [], [bad]);
    ck("⑫ 🔴 反向自证：prev 里有过、但这次把它删了 ⇒ 仍算 introduced",
      r.introduced.includes(bad) && r.legacy.length === 0, JSON.stringify(r));
  }
  // ── null 主图 / 空 gallery 不炸，也不虚报 ──
  {
    const r = checkDanglingRefs({ gallery: [null, "products/ak99/foo.webp"] }, null, E, [], []);
    ck("⑫ gallery 里的空洞被跳过，不当成坏路径", r.introduced.length === 0 && r.legacy.length === 0, JSON.stringify(r));
  }
}

console.log(out.join("\n"));
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);


