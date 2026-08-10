// 契约校验器自检。
//
// 🔴 判据纪律：**正对照 + 反向自证**，缺一不可。
//    只测"坏数据被拒"的话，一个 `return {ok:false}` 的空壳也全绿；
//    只测"好数据通过"的话，一个 `return {ok:true}` 的空壳也全绿。
//    所以每一条规则都要有一个**只差那一处**的坏样本，和一个通过的好样本。
//
// ⚠️ 反例不是我编的：`STUFFED_NAME` 与 alibaba 链接都直接取自契约 C1 原文。
//    自己编的缺陷只能证明"我认得我自己写的错法"。
//
// 跑：node scripts/contract-selftest.mjs   （Node ≥22.6 直接吃 .ts，无需构建）
import { validateProduct, mergeProduct, checkSlugMatchesPath, serializeProduct } from "../src/contract.ts";

let pass = 0, fail = 0;
const results = [];

function check(name, cond, detail = "") {
  if (cond) { pass++; results.push(`✅ ${name}`); }
  else { fail++; results.push(`🔴 ${name}${detail ? "\n     " + detail : ""}`); }
}

const codes = (r) => r.errors.map((e) => `${e.field}:${e.code}`);
const wcodes = (r) => r.warnings.map((e) => `${e.field}:${e.code}`);
const hasErr = (r, c) => codes(r).some((x) => x.endsWith(":" + c) || x === c);
const hasWarn = (r, c) => wcodes(r).some((x) => x.endsWith(":" + c) || x === c);

// ── 好样本（正对照）：契约文档里那份示例，逐字照抄 ──────────────────
const GOOD = {
  slug: "desktop-16in1-monitor",
  name: "16-in-1 Desktop Air Quality Monitor",
  model: "AS-D16",
  category: "desktop",
  sensors: ["CO2", "PM2.5", "PM10", "HCHO", "TVOC", "temperature", "humidity"],
  highlights: ["7-inch TFT display", "USB-C powered"],
  specs: { display: "7-inch TFT", power: "USB-C / built-in battery", connectivity: "Wi-Fi + mobile app" },
  moq: 1000,
  images: { main: "products/desktop-16in1-monitor.webp", gallery: ["products/desktop-16in1-monitor-2.webp"] },
  status: "published",
};

const clone = (o) => JSON.parse(JSON.stringify(o));
/** 只改一处，其余与 GOOD 完全相同 —— 这样"报红"只能归因于那一处。 */
const mut = (fn) => { const p = clone(GOOD); fn(p); return validateProduct(p); };

// ════════ 正对照 ════════
{
  const r = validateProduct(GOOD);
  check("① 契约示例数据必须通过（正对照）", r.ok && r.errors.length === 0,
    `errors=${JSON.stringify(codes(r))} warnings=${JSON.stringify(wcodes(r))}`);
  check("① 且不该有任何 warning", r.warnings.length === 0, `warnings=${JSON.stringify(wcodes(r))}`);
}

// 只留必填字段也必须通过（选填字段缺失 ≠ 错误）
{
  const minimal = { slug: "portable-co2", name: "Portable CO2 Meter", model: "AS-P02",
    category: "portable", sensors: ["CO2"], images: { main: "products/portable-co2.webp" }, status: "draft" };
  const r = validateProduct(minimal);
  check("② 只有必填字段也必须通过（选填缺失不是错）", r.ok, JSON.stringify(codes(r)));
}

// ════════ 必填缺失（硬规则 4：缺就是缺，不兜底）════════
for (const f of ["slug", "name", "model", "category", "sensors", "status", "images"]) {
  const r = mut((p) => { delete p[f]; });
  check(`③ 缺 ${f} 必须报 required/型别错`, !r.ok && codes(r).some((c) => c.startsWith(f)), JSON.stringify(codes(r)));
}
{
  const r = mut((p) => { delete p.images.main; });
  check("③ 缺 images.main 必须报错", hasErr(r, "required"), JSON.stringify(codes(r)));
}
// ⚠️ 空串不许当"填了"
{
  const r = mut((p) => { p.name = "   "; });
  check("③ name 是空白串必须报 required（不是「填了」）", hasErr(r, "required"), JSON.stringify(codes(r)));
}

// ════════ 硬规则 3：我方型号 ════════
{
  const r = mut((p) => { p.model = "JT-168"; });   // 供应商型号形态
  check("④ 供应商型号必须被拒", hasErr(r, "must_be_our_model"), JSON.stringify(codes(r)));
}
{
  const r = mut((p) => { p.model = "AS-W7"; });
  check("④ 正对照：AS- 前缀必须放行", r.ok, JSON.stringify(codes(r)));
}

// ════════ 枚举 ════════
{
  const r = mut((p) => { p.category = "handheld"; });   // 像模像样但不在枚举里
  check("⑤ category 枚举外必须被拒", hasErr(r, "enum"), JSON.stringify(codes(r)));
}
{
  const r = mut((p) => { p.sensors = ["CO2", "PM2.5+"]; });
  check("⑤ sensors 枚举外必须被拒", hasErr(r, "enum"), JSON.stringify(codes(r)));
}
{
  const r = mut((p) => { p.sensors = ["CO2", "CO2"]; });
  check("⑤ sensors 重复必须被拒", hasErr(r, "duplicate"), JSON.stringify(codes(r)));
}
{
  const r = mut((p) => { p.sensors = []; });
  check("⑤ sensors 空数组必须被拒", hasErr(r, "empty"), JSON.stringify(codes(r)));
}
{
  const r = mut((p) => { p.status = "archived"; });
  check("⑤ status 枚举外必须被拒", hasErr(r, "enum"), JSON.stringify(codes(r)));
}

// ════════ 硬规则 1：供应商痕迹（这道闸拦在写入之前，不靠渲染层）════════
const ALIBABA = "https://www.alibaba.com/product-detail/16-in-1-Air-Quality_1601234567890.html";
{
  // 🔴 关键用例：链接被粘进 **specs** —— 对渲染层来说它只是个普通字符串，
  //    渲染层没有理由过滤它，于是会一路走到 dist/。
  const r = mut((p) => { p.specs.source = ALIBABA; });
  check("⑥ specs 里的 alibaba 链接必须硬拒（渲染层拦不住这种）", hasErr(r, "supplier_leak"), JSON.stringify(codes(r)));
}
{
  const r = mut((p) => { p.highlights.push("Same as " + ALIBABA); });
  check("⑥ highlights 里的 alibaba 链接必须硬拒", hasErr(r, "supplier_leak"), JSON.stringify(codes(r)));
}
{
  const r = mut((p) => { p.images.gallery.push("https://sc04.alicdn.com/kf/H123.jpg"); });
  check("⑥ gallery 里的 alicdn 图必须硬拒", hasErr(r, "supplier_leak"), JSON.stringify(codes(r)));
}
{
  // 🔴 反向自证：豁免必须真的生效，否则这道闸是"恒报红"，等于没判据。
  const r = mut((p) => { p.supplierRef = ALIBABA; });
  check("⑥ 反向自证：supplierRef 里放同一条链接必须放行（豁免生效，闸不是恒真）",
    r.ok && !hasErr(r, "supplier_leak"), JSON.stringify(codes(r)));
  check("⑥ 但要提示它是内部字段", hasWarn(r, "internal_field"), JSON.stringify(wcodes(r)));
}

// ════════ 硬规则 2：listing 标题（warning，不阻塞）════════
{
  // 契约原文里的反面例子，逐字照抄
  const STUFFED = "Air Gas Analyzer Monitor Quality Detector Tester System Indoor Equipment Pm 2.5 10 Device Aire Pollution Multi Smart 4G Desktop";
  const r = mut((p) => { p.name = STUFFED; });
  check("⑦ 契约原文那个反例标题必须被吼", hasWarn(r, "looks_like_listing_title"), JSON.stringify(wcodes(r)));
  check("⑦ 但只是 warning，不阻塞（判不了的事不硬拦）", r.ok, JSON.stringify(codes(r)));
}
{
  // 反向自证：正常长名字不该被吼，否则这条 warning 天天误报，人就不看它了
  const r = mut((p) => { p.name = "Wall-Mounted Indoor Air Quality Monitor with Display"; });
  check("⑦ 反向自证：正常的长产品名不该被吼", !hasWarn(r, "looks_like_listing_title"), JSON.stringify(wcodes(r)));
}

// ════════ 其它字段规则 ════════
{
  const r = mut((p) => { p.moq = 0; });
  check("⑧ moq=0 必须被拒（「面议」是删掉字段，不是填 0）", hasErr(r, "type"), JSON.stringify(codes(r)));
}
{
  const r = mut((p) => { delete p.moq; });
  check("⑧ 正对照：没有 moq 字段＝面议，必须放行", r.ok, JSON.stringify(codes(r)));
}
{
  const r = mut((p) => { p.images.main = "https://example.com/a.webp"; });
  check("⑧ images.main 外链必须被拒", hasErr(r, "must_be_relative"), JSON.stringify(codes(r)));
}
{
  const r = mut((p) => { p.specs.moq = 1000; });
  check("⑧ specs 的值不是字符串必须被拒", hasErr(r, "type"), JSON.stringify(codes(r)));
}
{
  const r = mut((p) => { p.price = 99; });
  check("⑨ 契约外的字段（price）必须被拒，不静默丢也不静默留", hasErr(r, "unknown_field"), JSON.stringify(codes(r)));
}
{
  const r = mut((p) => { p.slug = "Desktop_16in1"; });
  check("⑨ slug 大写/下划线必须被拒", hasErr(r, "format"), JSON.stringify(codes(r)));
}

// ════════ mergeProduct：`undefined` ≠ 清空 ════════
{
  const { merged, cleared, touched } = mergeProduct(GOOD, { name: "New Name", model: undefined });
  check("⑩ 补丁里 undefined 的字段必须保持原样（「我没收到」≠「要清空」）",
    merged.model === "AS-D16" && merged.name === "New Name", JSON.stringify({ model: merged.model, name: merged.name }));
  check("⑩ touched 只记真的变了的", touched.length === 1 && touched[0] === "name", JSON.stringify(touched));
  check("⑩ 没有东西被清空", cleared.length === 0, JSON.stringify(cleared));
}
{
  const { merged, cleared } = mergeProduct(GOOD, { moq: null });
  check("⑩ 显式 null 才是清空", !("moq" in merged) && cleared.includes("moq"), JSON.stringify({ has: "moq" in merged, cleared }));
}
{
  // 反向自证：同值补丁不该被记成"改过了"（否则审计日志会把没改的也算上）
  const { touched } = mergeProduct(GOOD, { name: GOOD.name });
  check("⑩ 反向自证：值没变就不算 touched", touched.length === 0, JSON.stringify(touched));
}

// ════════ slug 与文件名 ════════
{
  check("⑪ slug 与文件名一致时不报", checkSlugMatchesPath("desktop-16in1-monitor", "desktop-16in1-monitor.json") === null);
  const i = checkSlugMatchesPath("desktop-16in1-monitor", "desktop-16in1.json");
  check("⑪ slug 与文件名不一致必须报", i !== null && i.code === "slug_path_mismatch", JSON.stringify(i));
}

// ════════ 序列化：键序稳定 ════════
{
  const shuffled = { status: "published", images: GOOD.images, slug: GOOD.slug, sensors: GOOD.sensors,
    category: GOOD.category, model: GOOD.model, name: GOOD.name };
  const a = serializeProduct(shuffled);
  const b = serializeProduct({ slug: GOOD.slug, name: GOOD.name, model: GOOD.model, category: GOOD.category,
    sensors: GOOD.sensors, images: GOOD.images, status: "published" });
  check("⑫ 键序被打乱也序列化成同一份字节（否则改一个字段会产生整体重排的 diff）", a === b);
  check("⑫ 末尾有换行", a.endsWith("}\n"));
}

console.log(results.join("\n"));
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
