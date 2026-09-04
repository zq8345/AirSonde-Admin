const SRC = new URL("../src/", import.meta.url).href;   // ⚠️ 绝不写绝对路径：CI 是 Linux
// 分类轴自检（契约 v1.4 / A13）。
//
// 🔴🔴 **这里测的删除闸是唯一防线，不是兜底。**
//    W18 四层实验实测：删掉在用的取值后，官网构建**照常通过**
//    （直接重建通过 / 清 .astro/collections 通过 / 删整个 .astro/ 仍通过，
//     只有删 node_modules/.astro/data-store.json 才失败）。
//    Astro 只在**内容配置文件本身变化**时才重新校验；单改 taxonomy.json 不算。
//    ⇒ 引用统计漏一个 = 放行一次删除，而后果要到某次**毫不相关的提交**才爆 ——
//      那时现场已经不在。所以下面每一条都要有反向自证。
const {
  validateTaxonomy, valuesOf, axesOf, refsOf, unreadableCount,
  addItem, editItem, deleteItem, serializeTaxonomy, applyOps, OpFailed,
} = await import(SRC + "taxonomy.ts");

let pass = 0, fail = 0; const out = [];
const ck = (n, c, d = "") => { if (c) { pass++; out.push(`✅ ${n}`); } else { fail++; out.push(`🔴 ${n}\n     ${d}`); } };

/** 照官网真实 taxonomy.json 的形状写，不是我编的。 */
const TAX = () => ({
  $comment: "说明行",
  categories: [
    { value: "desktop", label: "Desktop", order: 1 },
    { value: "portable", label: "Portable", order: 2 },
    { value: "wearable", label: "Wearable", order: 3 },
  ],
  sensors: [
    { value: "CO2", label: "CO2", order: 1 },
    { value: "PM2.5", label: "PM2.5", order: 2 },
    { value: "radiation", label: "radiation", order: 3 },
  ],
});

const PRODUCTS = [
  { slug: "a", category: "desktop", sensors: ["CO2", "PM2.5"] },
  { slug: "b", category: "desktop", sensors: ["CO2"] },
  { slug: "c", category: "portable", sensors: ["radiation"] },
];

// ══════ ① 正对照：真实形状必须通过 ══════
{
  const r = validateTaxonomy(TAX());
  ck("① 真实形状通过", r.ok, JSON.stringify(r.errors));
  ck("① axesOf 给出两个轴的取值", JSON.stringify(axesOf(TAX())) ===
    '{"categories":["desktop","portable","wearable"],"sensors":["CO2","PM2.5","radiation"]}',
    JSON.stringify(axesOf(TAX())));
}

// ══════ ② 🔴 引用统计：删除闸的**全部依据** ══════
{
  ck("② desktop 被 2 个产品在用", JSON.stringify(refsOf(PRODUCTS, "categories", "desktop")) === '["a","b"]',
    JSON.stringify(refsOf(PRODUCTS, "categories", "desktop")));
  ck("② 🔴 关键：sensors 是**数组字段**，也要数得到（两个轴形状不同，写成两份的那一份会漏）",
    JSON.stringify(refsOf(PRODUCTS, "sensors", "CO2")) === '["a","b"]',
    JSON.stringify(refsOf(PRODUCTS, "sensors", "CO2")));
  ck("② 零引用的取值确实是 0", refsOf(PRODUCTS, "categories", "wearable").length === 0);
  ck("② 反向自证：不存在的取值也是 0（不是「什么都算在用」）",
    refsOf(PRODUCTS, "categories", "nope").length === 0);
}
{
  // 🔴 读不出来的产品：它引用了什么**看不见** ⇒ "0 个在用"这个结论不成立
  const withBad = [...PRODUCTS, { slug: "x", error: "不是合法 JSON" }];
  ck("② 🔴🔴 关键：读不出来的产品要被数出来（此时任何删除都必须先拒绝）",
    unreadableCount(withBad) === 1, String(unreadableCount(withBad)));
  ck("② 且它不会被当成「在用 wearable」而误报", refsOf(withBad, "categories", "wearable").length === 0);
}

// ══════ ③ 新增 ══════
{
  const next = addItem(TAX(), "categories", { value: "industrial", label: "Industrial" });
  ck("③ 新增追加一条", next.categories.length === 4 && next.categories[3].value === "industrial");
  ck("③ order 接在最大值之后", next.categories[3].order === 4, String(next.categories[3].order));
  ck("③ 新增后仍合法", validateTaxonomy(next).ok, JSON.stringify(validateTaxonomy(next).errors));
  ck("③ 反向自证：不动另一个轴", JSON.stringify(next.sensors) === JSON.stringify(TAX().sensors));
}
{
  const dup = addItem(TAX(), "categories", { value: "desktop", label: "又一个" });
  ck("③ 🔴 重复 value 必须被校验拒（两条抢同一个键，谁生效取决于遍历顺序）",
    !validateTaxonomy(dup).ok, JSON.stringify(validateTaxonomy(dup).errors.map((e) => e.code)));
}

// ══════ ④ 编辑：只改 label / order，⛔ value 不可改 ══════
{
  const next = editItem(TAX(), "categories", "desktop", { label: "桌面式" });
  ck("④ label 改了", next.categories[0].label === "桌面式");
  ck("④ 🔴 关键：value 一个字没变（它已经写进产品 JSON，改它 = 改数据）",
    next.categories[0].value === "desktop", next.categories[0].value);
  ck("④ 别的条目不受影响", next.categories[1].label === "Portable");
  const vals = valuesOf(next, "categories");
  ck("④ 取值集合不变 ⇒ 现有产品仍全部合法",
    JSON.stringify(vals) === JSON.stringify(valuesOf(TAX(), "categories")), JSON.stringify(vals));
}
{
  let threw = false;
  try { editItem(TAX(), "categories", "nope", { label: "x" }); } catch { threw = true; }
  ck("④ 改一条不存在的 ⇒ 抛错，不静默无事发生", threw);
}

// ══════ ⑤ 删除 ══════
{
  const next = deleteItem(TAX(), "categories", "wearable");
  ck("⑤ 删零引用的成功", next.categories.length === 2 && !next.categories.some((x) => x.value === "wearable"));
  ck("⑤ 删完仍合法", validateTaxonomy(next).ok);
}
{
  let threw = false;
  try { deleteItem(TAX(), "categories", "nope"); } catch { threw = true; }
  ck("⑤ 删一条不存在的 ⇒ 抛错", threw);
}
{
  // 🔴 空轴 = 所有产品的该字段全变非法。这不是「清空一个列表」。
  let t = TAX();
  for (const v of ["desktop", "portable", "wearable"]) t = deleteItem(t, "categories", v);
  ck("⑤ 🔴 把一个轴删空必须被校验拒", !validateTaxonomy(t).ok,
    JSON.stringify(validateTaxonomy(t).errors.map((e) => e.code)));
}

// ══════ ⑥ 校验器本身 ══════
{
  const t = TAX(); t.categories[0].label = "  ";
  ck("⑥ 空白显示名被拒（官网就是拿它显示的）", !validateTaxonomy(t).ok);
}
{
  const t = TAX(); t.categories[0].value = "Bad Value!";
  ck("⑥ 非法 value 被拒", !validateTaxonomy(t).ok, JSON.stringify(validateTaxonomy(t).errors.map((e) => e.code)));
}
{
  const t = TAX(); t.categories[0].color = "red";
  ck("⑥ 契约外的字段被拒（不静默留，也不静默丢）", !validateTaxonomy(t).ok);
}
{
  // 反向自证：`PM2.5` / `wall-mounted` 这类真实取值**不能**被 value 格式误杀
  const t = TAX(); t.sensors.push({ value: "PM1.0", label: "PM1.0", order: 4 });
  t.categories.push({ value: "wall-mounted", label: "Wall-mounted", order: 9 });
  ck("⑥ 反向自证：真实取值 PM1.0 / wall-mounted 不被格式误杀", validateTaxonomy(t).ok,
    JSON.stringify(validateTaxonomy(t).errors));
}

// ══════ ⑦ 序列化 ══════
{
  const s = serializeTaxonomy(addItem(TAX(), "categories", { value: "zzz", label: "Z" }));
  const j = JSON.parse(s);
  ck("⑦ $comment 原样保留并排在最前", Object.keys(j)[0] === "$comment");
  ck("⑦ 按 order 写出（文件顺序 = 显示顺序，diff 才读得懂）",
    j.categories.map((x) => x.value).join(",") === "desktop,portable,wearable,zzz");
  ck("⑦ 2 空格 + 末尾换行", s.includes('\n  "categories"') && s.endsWith("\n"));
  ck("⑦ 每条只有三个字段", j.categories.every((x) => JSON.stringify(Object.keys(x)) === '["value","label","order"]'));
}

{
  // ⑧ 批量：一次保存 = 一个 commit（Joe 2026-09-04「编辑 / 保存」）。
  //
  // 🔴 用**真的 `refsOf` + 真的产品形状**跑，⛔ 不用桩 ——
  //    桩只能证明"我以为的协议"，而这一批里真正危险的恰恰是引用判定。
  // 🔴 任何一处失败 ⇒ **整批不生效**。下面每条都要能分清
  //    「拒了」与「拒了但改了一半」——后者在屏幕上与成功同形。
  const PRODUCTS = [
    { slug: "a", category: "desktop", sensors: ["CO2"] },
    { slug: "b", category: "portable", sensors: ["CO2", "PM2.5"] },
  ];
  const refs = (axis, value) => refsOf(PRODUCTS, axis, value);
  const vals = (t, axis) => t[axis].map((x) => x.value).join(",");
  const labelOf = (t, axis, v) => (t[axis].find((x) => x.value === v) || {}).label;

  // ── 正对照：改 2 个 + 删 1 个（删的是没人用的 wearable）──
  {
    const r = applyOps(TAX(), [
      { axis: "categories", op: "edit", value: "desktop", label: "台式机" },
      { axis: "categories", op: "edit", value: "portable", label: "便携" },
      { axis: "categories", op: "delete", value: "wearable" },
    ], refs);
    ck("⑧ 正对照：一批 3 处全部生效", r.done.length === 3, JSON.stringify(r.done));
    ck("⑧ 两处改名都落到 label 上",
      labelOf(r.tax, "categories", "desktop") === "台式机" && labelOf(r.tax, "categories", "portable") === "便携",
      JSON.stringify(r.tax.categories));
    ck("⑧ 被删的那条真的没了", !r.tax.categories.some((x) => x.value === "wearable"), vals(r.tax, "categories"));
    ck("⑧ 🔴 输入那份没被改坏（纯函数，⛔ 不许原地改）", vals(TAX(), "categories") === "desktop,portable,wearable",
      vals(TAX(), "categories"));
  }

  // ── 顺序敏感：同一批里先 add 再 edit 同一个 value ──
  {
    const r = applyOps(TAX(), [
      { axis: "categories", op: "add", value: "rack", label: "Rack" },
      { axis: "categories", op: "edit", value: "rack", label: "机架式" },
    ], refs);
    ck("⑧ 🔴 同一批：先 add 再 edit 同一个 value ⇒ 成立（顺序有意义）",
      labelOf(r.tax, "categories", "rack") === "机架式", JSON.stringify(r.tax.categories));
  }
  // ── 反过来就该挂：先 edit 一个还不存在的，再 add ──
  {
    let caught = null;
    try { applyOps(TAX(), [
      { axis: "categories", op: "edit", value: "rack", label: "机架式" },
      { axis: "categories", op: "add", value: "rack", label: "Rack" },
    ], refs); } catch (e) { caught = e; }
    ck("⑧ 🔴 反向自证：顺序反过来必须挂（证明它真的按序执行，⛔ 不是先排序）",
      caught instanceof OpFailed && caught.index === 0, String(caught && caught.message));
  }

  // ── 删掉本批新增的 ──
  {
    const r = applyOps(TAX(), [
      { axis: "categories", op: "add", value: "tmp", label: "Tmp" },
      { axis: "categories", op: "delete", value: "tmp" },
    ], refs);
    ck("⑧ 删掉本批刚新增的 ⇒ 允许（它没有任何产品在用）",
      !r.tax.categories.some((x) => x.value === "tmp") && r.done.length === 2, JSON.stringify(r.done));
  }

  // ── 🔴🔴 引用闸：删在用的必须拒，且**整批不生效** ──
  {
    let caught = null;
    try { applyOps(TAX(), [
      { axis: "categories", op: "edit", value: "wearable", label: "改了但不该落地" },
      { axis: "categories", op: "delete", value: "desktop" },   // a 在用
    ], refs); } catch (e) { caught = e; }
    ck("⑧ 🔴 删在用的取值必须拒", caught instanceof OpFailed, String(caught && caught.message));
    ck("⑧ 🔴 拒的时候说得出是第几处（第 2 处 ⇒ index 1）", caught && caught.index === 1, String(caught && caught.index));
    ck("⑧ 🔴 而且带出在用它的产品（人要照着它去改）", caught && Array.isArray(caught.refs) && caught.refs.includes("a"),
      JSON.stringify(caught && caught.refs));
    ck("⑧ 🔴🔴 关键：**整批不生效** —— 前面那处改名⛔ 不许落到原 tax 上",
      labelOf(TAX(), "categories", "wearable") === "Wearable", labelOf(TAX(), "categories", "wearable"));
  }

  // ── 同一个 value 被两条 op 碰：add 两次 ──
  {
    let caught = null;
    try { applyOps(TAX(), [
      { axis: "categories", op: "add", value: "dup", label: "A" },
      { axis: "categories", op: "add", value: "dup", label: "B" },
    ], refs); } catch (e) { caught = e; }
    ck("⑧ 同一批 add 两次同一个 value ⇒ 第 2 处挂（⛔ 不静默合并成一条）",
      caught instanceof OpFailed && caught.index === 1, String(caught && caught.message));
  }

  // ── edit 一个不存在的 ──
  {
    let caught = null;
    try { applyOps(TAX(), [{ axis: "sensors", op: "edit", value: "没有这个", label: "x" }], refs); }
    catch (e) { caught = e; }
    ck("⑧ edit 不存在的取值 ⇒ 抛且 index=0", caught instanceof OpFailed && caught.index === 0,
      String(caught && caught.message));
  }

  // ── 空批 ──
  {
    const r = applyOps(TAX(), [], refs);
    ck("⑧ 空批 ⇒ 零改动且轴原样（⛔ 不抛、⛔ 不产生 commit 的理由由调用方判）",
      r.done.length === 0 && vals(r.tax, "categories") === vals(TAX(), "categories"), JSON.stringify(r.done));
  }

  // ── 两个轴混在一批里 ──
  {
    const r = applyOps(TAX(), [
      { axis: "categories", op: "edit", value: "desktop", label: "台式" },
      { axis: "sensors", op: "add", value: "NO2", label: "NO2" },
    ], refs);
    ck("⑧ 一批里可以同时改两个轴", labelOf(r.tax, "categories", "desktop") === "台式"
      && r.tax.sensors.some((x) => x.value === "NO2"), JSON.stringify(r.done));
  }

  // ── 反向自证：引用闸不是恒拒 ──
  {
    const r = applyOps(TAX(), [{ axis: "sensors", op: "delete", value: "radiation" }], refs);
    ck("⑧ 🔴 反向自证：删一个真没人用的传感器（radiation）必须放行（否则闸恒拒，等于删不掉任何东西）",
      !r.tax.sensors.some((x) => x.value === "radiation"), vals(r.tax, "sensors"));
  }
}

console.log(out.join("\n"));
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
