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
import { validateProduct, mergeProduct, checkSlugMatchesPath, serializeProduct, actionableWarnCount } from "../src/contract.ts";

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

// ════════ 硬规则 3（契约 v1.3）：model 必填，前缀只吼不拦 ════════
//
// 🔴 v1.3 之前这里是 `^AS-` 硬闸。作废的理由不是"太严"，是**它守的那个前缀是编的** ——
//    冻结契约时并不知道我方真实编码，`AS-` 是当时造出来的；真实编码是 `AK`+数字。
//    一个照着编造值去拦真实值的闸，拦下的全是对的东西。
{
  const r = mut((p) => { p.model = "AK101"; });
  check("④ 真实编码 AK101 通过，零 error", r.ok && r.errors.length === 0, JSON.stringify(codes(r)));
  check("④ 且不吼（AK 在已知系列表里）",
    !r.warnings.some((w) => w.code === "unknown_series_prefix"), JSON.stringify(r.warnings.map((w) => w.code)));
}
{
  // 🔴 存量那 23 个产品全是 AS-xxx。改闸**不能把它们变成不可保存** ——
  //    那会把"闸放宽了"变成"一批产品打不开了"，而症状完全不像是改闸引起的。
  const r = mut((p) => { p.model = "AS-D16"; });
  check("④ 关键：存量 AS-D16 仍然通过（改闸不许弄坏存量数据）", r.ok, JSON.stringify(codes(r)));
  check("④ 但要吼一声（不在已知系列表里）",
    r.warnings.some((w) => w.code === "unknown_series_prefix"), JSON.stringify(r.warnings.map((w) => w.code)));
}
{
  // 供应商痕迹仍是**硬拒** —— 放开前缀不等于放开这条红线
  const r = mut((p) => { p.model = "alibaba.com/JT-168"; });
  check("④ 关键：model 里的供应商痕迹仍被硬拒", hasErr(r, "supplier_leak"), JSON.stringify(codes(r)));
}
{
  // 反向自证：不是把整条闸拆了 —— 必填还在
  const r = mut((p) => { p.model = "   "; });
  check("④ 反向自证：空 model 仍被拒", hasErr(r, "required"), JSON.stringify(codes(r)));
}
{
  // A10-R2-b：文案要对"正在逐个换型号的人"有用，而不只是报个分类
  const r = mut((p) => { p.model = "AS-D16"; });
  const w = r.warnings.find((x) => x.code === "unknown_series_prefix");
  check("④ warning 说清了为什么亮（占位值）以及怎么消失",
    !!w && /占位值/.test(w.message) && /自动消失/.test(w.message), w?.message);
}

// ════════ ④-b A10-R3-b：列表 badge 只报"需要人做点什么"的东西 ════════
//
// 🔴 23 个产品全都有 supplierRef ⇒ 全都会亮一条 internal_field。
//    一个在 **100% 的行**上都亮的警告不携带任何区分信息，它只会把真正要注意的淹掉；
//    而 Joe 正要靠 badge 当"哪些型号还没换"的清单。
{
  // ⚠️ 必须显式给上 supplierRef —— 这才是那 23 个产品的真实形态（它们全都有）。
  //    不给的话这条用例根本产生不出 internal_field，测的就不是要测的东西。
  const r = mut((p) => { p.model = "AK101"; p.supplierRef = "https://www.alibaba.com/x"; });
  check("④-b 只剩状态说明时，可操作计数 = 0（badge 消失 —— 这就是 Joe 要的清单）",
    actionableWarnCount(r.warnings) === 0 && r.warnings.some((w) => w.code === "internal_field"),
    `warnings=${JSON.stringify(wcodes(r))} actionable=${actionableWarnCount(r.warnings)}`);
}
{
  const r = mut((p) => { p.model = "AS-D16"; p.supplierRef = "https://www.alibaba.com/x"; });
  check("④-b 型号没换时可操作计数 = 1（不是 2 —— 状态说明不占名额）",
    actionableWarnCount(r.warnings) === 1, `warnings=${JSON.stringify(wcodes(r))}`);
  check("④-b 且那一条正是 unknown_series_prefix",
    r.warnings.filter((w) => !["internal_field"].includes(w.code))[0]?.code === "unknown_series_prefix",
    JSON.stringify(wcodes(r)));
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
