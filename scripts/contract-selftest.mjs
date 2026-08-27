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
import {
  validateProduct as validateProductRaw, mergeProduct, checkSlugMatchesPath, serializeProduct,
  actionableWarnCount, SAMPLE_CATEGORIES, SAMPLE_SENSORS,
} from "../src/contract.ts";

// 契约 v1.4 起，两个轴的取值不再是契约里的常量，而是 taxonomy.json（官网真源）。
// ⚠️ 这里的 SAMPLE_* 只是**自检用的固定轴**，不是运行时的取值来源 ——
//    运行时的每一次校验都从 taxonomy.json 现读（src/index.ts 的 loadAxes）。
//    自检要的是一个**不随官网改动而漂的轴**，否则某天 Joe 在后台删掉一个机型，
//    这份自检就会红，而红的原因是样本过时，不是被测对象坏了。
const AXES = { categories: [...SAMPLE_CATEGORIES], sensors: [...SAMPLE_SENSORS] };
const validateProduct = (p) => validateProductRaw(p, AXES);

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
  // ⚠️ 与契约真源的示例保持一致（v1.3 起真源写的是 AK101）。
  //    留着 AS-D16 的话，「示例数据零 warning」这条会红 —— 而红的原因是**样例过时**，
  //    不是被测对象有问题。样例必须是一份"完全正确"的数据，否则它证明不了任何事。
  model: "AK101",
  // ⚠️ 机型/传感器用 SAMPLE_* 里的值 —— 它们**故意与官网真源不同**（AU2 ⑧）。
  //    看起来"不像真数据"正是要的效果：这份样本测的是校验器，不是官网的轴，
  //    而"样本长得像真数据"曾经让我把一次同形观测误当成证据。
  category: SAMPLE_CATEGORIES[0],
  sensors: [SAMPLE_SENSORS[0], SAMPLE_SENSORS[1]],
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
    category: SAMPLE_CATEGORIES[1], sensors: [SAMPLE_SENSORS[0]],
    images: { main: "products/portable-co2.webp" }, status: "draft" };
  const r = validateProduct(minimal);
  check("② 只有必填字段也必须通过（选填缺失不是错）", r.ok, JSON.stringify(codes(r)));
}

// ════════ ②' 轴必须真的是**传进来的那一份**（契约 v1.4） ════════
// 🔴 这两条防的是同一件事：校验器偷偷用了自己内置的一份轴。
//    那样的话后台新增一个机型，产品还是会被判"未知机型"——而且 100% 全绿的自检
//    看不出来，因为内置的那份恰好和 SAMPLE_* 一样。
{
  let threw = false;
  try { validateProductRaw(GOOD); } catch { threw = true; }
  check("②' 不传轴 ⇒ 抛错，不静默回落到内置常量", threw);
}
{
  // 反向自证：换一份**不含 desktop、却含 mycat** 的轴，判定必须跟着翻过来。
  const other = { categories: ["mycat"], sensors: [...SAMPLE_SENSORS] };
  const a = validateProductRaw(GOOD, other);
  const b = validateProductRaw({ ...clone(GOOD), category: "mycat" }, other);
  check("②' 换一份轴，desktop 变非法（说明用的是传进来的那份）", hasErr(a, "enum"),
    JSON.stringify(codes(a)));
  check("②' 同一份轴里，mycat 合法（说明不是「换轴就一律报错」）", b.ok, JSON.stringify(codes(b)));
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

// ════════ 硬规则 3（契约 v1.5）：model 只有"必填 + 不含供应商痕迹" ════════
//
// 这条规则被削过两次，两次的理由不一样，都值得记着：
//   · v1.3：删掉 `^AS-` 硬闸 —— **它守的那个前缀是编的**。冻结契约时不知道我方真实
//     编码，`AS-` 是当时造出来的；真实编码是 `AK`+数字。照着编造值去拦真实值的闸，
//     拦下的全是对的东西。
//   · v1.5：删掉 `unknown_series_prefix` warning（Joe 2026-08-26「这句话删掉」）——
//     黄色角标当天已撤，编辑页那段文字是它**唯一的显示位**，文字再撤它就是一条
//     永远没人看得到的告警。**用不上就整条删，别留死代码。**
//
// ⚠️ 两次削的都是"猜前缀"这条线，**从来没碰过 `scanSupplierLeak`** ——
//    那才是真正防误填供应商型号的闸，下面有反向自证。
{
  const r = mut((p) => { p.model = "AK101"; });
  check("④ 真实编码 AK101 通过，零 error", r.ok && r.errors.length === 0, JSON.stringify(codes(r)));
}
{
  // 🔴 契约 v1.5（Joe 2026-08-26「这句话删掉」）：`unknown_series_prefix` 整条 warning 删除。
  //    存量那 23 个 `AS-xxx` 现在**保存时零 warning**。
  //    ⚠️ 判据是"一条都没有"，不是"没有 unknown_series_prefix 这一条" ——
  //       后者在 warning 被改名之后照样绿，那就成了一条认得出旧错法、认不出新错法的判据。
  const r = mut((p) => { p.model = "AS-D16"; });
  check("④ AS-D16 通过", r.ok, JSON.stringify(codes(r)));
  check("④ 🔴 且 warning **一条都没有**（那句话已整条删除，不是藏起来）",
    r.warnings.length === 0, JSON.stringify(wcodes(r)));
}
{
  // 🔴 反向自证之一：删的是那条 warning，**不是整条 model 闸**。
  //    供应商痕迹仍是硬拒 —— 那才是真正防误填供应商型号的东西（硬规则 1 的 scanSupplierLeak）。
  const r = mut((p) => { p.model = "alibaba.com/JT-168"; });
  check("④ 🔴 反向自证：model 里的供应商痕迹**仍被硬拒**（真闸一个字没动）",
    hasErr(r, "supplier_leak"), JSON.stringify(codes(r)));
}
{
  // 反向自证之二：必填还在
  const r = mut((p) => { p.model = "   "; });
  check("④ 反向自证：空 model 仍被拒", hasErr(r, "required"), JSON.stringify(codes(r)));
}
{
  // 反向自证之三：删掉这条之后，warning 机制**本身**还活着 ——
  // 否则"AS-D16 零 warning"也可能是因为整个 warning 通道坏了。
  const r = mut((p) => { p.model = "AS-D16"; p.supplierRef = "https://www.alibaba.com/x"; });
  check("④ 🔴 反向自证：warning 通道本身还活着（同一份数据仍产生 internal_field）",
    r.warnings.some((w) => w.code === "internal_field"), JSON.stringify(wcodes(r)));
}

// ════════ ④-b A10-R3-b：列表 badge 只报"需要人做点什么"的东西 ════════
//
// 🔴 23 个产品全都有 supplierRef ⇒ 全都会亮一条 internal_field。
//    一个在 **100% 的行**上都亮的警告不携带任何区分信息，它只会把真正要注意的淹掉。
{
  // ⚠️ 必须显式给上 supplierRef —— 这才是那 23 个产品的真实形态（它们全都有）。
  const r = mut((p) => { p.model = "AK101"; p.supplierRef = "https://www.alibaba.com/x"; });
  check("④-b 只剩状态说明时，可操作计数 = 0",
    actionableWarnCount(r.warnings) === 0 && r.warnings.some((w) => w.code === "internal_field"),
    `warnings=${JSON.stringify(wcodes(r))} actionable=${actionableWarnCount(r.warnings)}`);
}
{
  // ⚠️ 契约 v1.5 之后，AS- 型号**不再**产生可操作 warning ——
  //    这条原来断言 =1，那个 1 就是被删掉的 unknown_series_prefix。
  const r = mut((p) => { p.model = "AS-D16"; p.supplierRef = "https://www.alibaba.com/x"; });
  check("④-b AS- 型号现在也是 0（unknown_series_prefix 已删）",
    actionableWarnCount(r.warnings) === 0, `warnings=${JSON.stringify(wcodes(r))}`);
}
{
  // ⚠️ 被排除的只是**列表计数**：完整 warnings 里那条必须还在，详情页要照常显示它
  const r = mut((p) => { p.model = "AK101"; p.supplierRef = "https://www.alibaba.com/x"; });
  check("④-b 关键：internal_field 仍然在 warnings 里（详情页要显示，只是不计入 badge）",
    r.warnings.some((w) => w.code === "internal_field"), JSON.stringify(wcodes(r)));
}
{
  // 反向自证：这不是"把 warning 计数关掉了" —— 非状态说明类照常计数
  const r = mut((p) => { p.model = "AK101"; p.name = "Air Gas Analyzer Monitor Quality Detector Tester System Indoor Equipment Pm 2.5 10 Device Aire Pollution Multi Smart 4G Desktop"; });
  check("④-b 反向自证：真正需要处理的 warning 照常计数（不是把计数关掉了）",
    actionableWarnCount(r.warnings) >= 1, `warnings=${JSON.stringify(wcodes(r))}`);
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
    merged.model === "AK101" && merged.name === "New Name", JSON.stringify({ model: merged.model, name: merged.name }));
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
