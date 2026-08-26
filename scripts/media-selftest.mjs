const SRC = new URL("../src/", import.meta.url).href;   // ⚠️ 绝不写绝对路径：CI 是 Linux
// 媒体库交叉比对自检。
//
// 🔴 这道闸判错的代价是**不可逆**的：把在用的图判成孤儿 ⇒ 删掉 ⇒ 官网当场缺图。
//    所以下面每一条都成对：**判得出孤儿**（否则闸没用）× **绝不把在用的判成孤儿**（否则闸有害）。
// ⚠️ wanew 的教训是"引用扫描正则漏了逗号，被引图当孤儿删"，所以这里专门放了一组
//    **文件名带刁钻字符**的用例 —— 我们走的是结构化字段比对，它们必须全部安全。
const { crossReference } = await import(SRC + "media.ts");

let pass = 0, fail = 0; const out = [];
const ck = (n, c, d = "") => { if (c) { pass++; out.push(`✅ ${n}`); } else { fail++; out.push(`🔴 ${n}\n     ${d}`); } };
const blob = (p, size = 100) => ({ path: p, size, sha: "x".repeat(40) });
const P = (r) => "src/assets/" + r;

// ── ① 基本：一张被引、一张没被引 ──
{
  const r = crossReference(
    [blob(P("products/a.webp")), blob(P("products/b.webp"))],
    [{ slug: "a", images: { main: "products/a.webp" } }],
  );
  ck("① 被引用的算 referenced", r.files.find((f) => f.rel === "products/a.webp").referencedBy.join() === "a");
  ck("① 没被引用的算 orphan", r.orphans === 1 && r.referenced === 1);
  ck("① 对账成立（referenced + orphans === total）", r.reconciled && r.total === 2);
}

// ── ② 🔴 反向自证：文件名带刁钻字符也**绝不**被误判成孤儿 ──
//    （正则实现正是死在这里：字符类漏一个，这张在用的图就成了孤儿）
{
  const tricky = [
    "products/a,b.webp",          // 逗号 —— wanew 真实踩过的那个
    "products/a b.webp",          // 空格
    "products/a(1).webp",         // 括号
    "products/a+b.webp",          // 加号
    "products/a[1].webp",         // 方括号
    "products/中文名.webp",        // 非 ASCII
    "products/a'b.webp",          // 单引号
  ];
  const r = crossReference(
    tricky.map((t) => blob(P(t))),
    tricky.map((t, i) => ({ slug: "p" + i, images: { main: t } })),
  );
  ck("② 关键：7 个刁钻文件名全部被认出是「在用」，孤儿数必须为 0",
    r.orphans === 0 && r.referenced === 7,
    `orphans=${r.orphans} referenced=${r.referenced} 未认出的=${r.files.filter((f) => !f.referencedBy.length).map((f) => f.rel).join(", ")}`);
}

// ── ③ 正对照：闸不是"恒说没有孤儿" ──
{
  const r = crossReference([blob(P("products/lonely.webp"))], []);
  ck("③ 正对照：真没人引用时必须报出孤儿（否则这道闸恒绿，等于没有）",
    r.orphans === 1 && r.files[0].referencedBy.length === 0);
}

// ── ④ gallery 也算引用（只看 main 会把 gallery 图全判成孤儿）──
{
  const r = crossReference(
    [blob(P("products/m.webp")), blob(P("products/g2.webp"))],
    [{ slug: "x", images: { main: "products/m.webp", gallery: ["products/g2.webp"] } }],
  );
  ck("④ gallery 里的图也算被引用", r.orphans === 0, JSON.stringify(r.files.map((f) => f.rel + ":" + f.referencedBy.length)));
}

// ── ⑤ 一张图被多个产品引用 ──
{
  const r = crossReference(
    [blob(P("products/shared.webp"))],
    [{ slug: "a", images: { main: "products/shared.webp" } }, { slug: "b", images: { main: "products/shared.webp" } }],
  );
  ck("⑤ 共用图记下所有引用方（删它之前要知道会影响谁）",
    r.files[0].referencedBy.length === 2 && r.orphans === 0, JSON.stringify(r.files[0].referencedBy));
}
{
  // 同一产品 main 与 gallery 指向同一张 ⇒ 只记一次，否则"被几个产品引用"会说谎
  const r = crossReference(
    [blob(P("products/dup.webp"))],
    [{ slug: "a", images: { main: "products/dup.webp", gallery: ["products/dup.webp"] } }],
  );
  ck("⑤ 同产品重复引用只记一次", r.files[0].referencedBy.length === 1, JSON.stringify(r.files[0].referencedBy));
}

// ── ⑥ 声明了但文件不在 ⇒ 是另一种病，要单独报，不能混进孤儿 ──
{
  const r = crossReference(
    [blob(P("products/exists.webp"))],
    [{ slug: "a", images: { main: "products/exists.webp", gallery: ["products/gone.webp"] } }],
  );
  ck("⑥ 引用了不存在的文件 ⇒ 进 missing，不进 orphans",
    r.missing.length === 1 && r.missing[0].rel === "products/gone.webp" && r.orphans === 0,
    JSON.stringify({ missing: r.missing, orphans: r.orphans }));
}

// ── ⑦ 分区：draft / originals 要分得出来 ──
{
  const r = crossReference(
    [blob(P("products/p.webp")), blob(P("products/_draft/d.webp")), blob(P("products/originals/o.jpg"))],
    [],
  );
  const area = (rel) => r.files.find((f) => f.rel === rel).area;
  ck("⑦ 分区判别正确（published / draft / originals）",
    area("products/p.webp") === "published" && area("products/_draft/d.webp") === "draft"
      && area("products/originals/o.jpg") === "originals",
    r.files.map((f) => f.rel + "=" + f.area).join(", "));
}

// ── ⑧ 非图片、非产品目录的文件不该进清单 ──
{
  const r = crossReference(
    [blob(P("products/a.webp")), blob(P("products/readme.txt")), blob("src/assets/brand/logo.svg"), blob("src/pages/index.astro")],
    [],
  );
  ck("⑧ 只收 src/assets/products/ 下的图片（不误收 txt / 品牌图 / 源码）",
    r.total === 1 && r.files[0].rel === "products/a.webp", r.files.map((f) => f.rel).join(", "));
}

// ── ⑨ 🔴 「孤儿」这个词**只能有一个定义**：每个文件身上的 f.orphan ──
//    这一组防的是真出过的那个事：顶部计数排除 originals（说「未被引用 0」），
//    卡片黄标不排除（38 张原图全被标成「未被引用」）—— 同一个词、同一屏、两个定义。
//    而人会照卡片去删原图，删掉的是整条图片管线的源材料。
{
  const r = crossReference(
    [blob(P("products/used.webp")), blob(P("products/lonely.webp")),
     blob(P("products/_draft/d.webp")), blob(P("products/originals/o1.jpg")), blob(P("products/originals/o2.jpg"))],
    [{ slug: "x", images: { main: "products/used.webp" } }],
  );
  const of = (rel) => r.files.find((f) => f.rel === rel);
  ck("⑨ 零引用的 published 图 = 孤儿", of("products/lonely.webp").orphan === true);
  ck("⑨ 零引用的 draft 图 = 孤儿（草稿区也参与判定）", of("products/_draft/d.webp").orphan === true);
  ck("⑨ 🔴 关键：零引用的 originals **不是**孤儿（它是有意存档的源材料）",
    of("products/originals/o1.jpg").orphan === false && of("products/originals/o2.jpg").orphan === false,
    JSON.stringify(r.files.map((f) => f.rel + "=" + f.orphan)));
  ck("⑨ 被引用的图不是孤儿", of("products/used.webp").orphan === false);
  ck("⑨ 🔴 计数与逐张的标**同源**：orphans === 数出来的 f.orphan 个数",
    r.orphans === r.files.filter((f) => f.orphan).length && r.orphans === 2,
    JSON.stringify({ orphans: r.orphans, counted: r.files.filter((f) => f.orphan).length }));
  ck("⑨ 对账仍成立", r.reconciled === true,
    JSON.stringify({ referenced: r.referenced, orphans: r.orphans, liveTotal: r.liveTotal, archived: r.archived, total: r.total }));
  // 反向自证：判据不是"零引用"本身 —— originals 两张都零引用，却都不是孤儿。
  ck("⑨ 反向自证：判据不是「零引用」本身（originals 零引用但 orphan=false）",
    of("products/originals/o1.jpg").referencedBy.length === 0 && of("products/originals/o1.jpg").orphan === false);
}

console.log(out.join("\n"));
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
