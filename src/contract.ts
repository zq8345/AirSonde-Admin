// 契约 C1 v1 的**可执行**形态。
// 真源是 `C:\开发\airsonde\airsonde文件\契约\产品数据schema-v1.md`（总工 2026-08-09 冻结）。
//   ⚠️ 路径 2026-08-10 更新过：文档目录从 `C:\开发\airsonde文件\` 迁到了 `C:\开发\airsonde\airsonde文件\`。
//      旧路径已不存在（实测），指着它的注释会把人送到空目录。
// ⚠️ 要改字段先回报总工 —— Web 窗按同一份契约读，单方面改会把官网构建搞挂。
//
// 本文件当前对齐到 **v1.1**（2026-08-10）：
//   ① sensors 新增 `CO`
//   ② images 路径基准 `public/` → `src/assets/`（字段形状不变，只是它指向仓内哪里）
//
// 🔴 本文件的全部立场：**缺就是缺，不兜底。**
//    契约硬规则 4 原话："必填字段缺失 = 构建失败，不要用 `|| ""` 兜底静默通过。"
//    所以这里没有任何默认值、没有任何 coercion。校验不过就拒绝，不"尽量修好它"。

export const CATEGORIES = ["desktop", "portable", "wall-mounted", "wearable", "industrial", "other"] as const;

// ⚠️ `CO` 是契约 v1.1 §① 新增的（2026-08-10，总工批准）：素材里有家用 CO 报警器，
//    而枚举里原本只有 `CO2` 和 `combustible-gas`，两个都不是它。
//    🔴 这一行漏掉的话，后果不是"少个选项"，是**带 CO 的产品在后台根本存不了**
//       —— 而报出来的会是"sensors 含契约外的值"，看起来像数据错了，其实是校验器过时了。
export const SENSORS = [
  "CO2", "CO", "PM1.0", "PM2.5", "PM10", "HCHO", "TVOC",
  "temperature", "humidity", "AQI", "radiation", "alcohol", "WBGT", "combustible-gas",
] as const;

export const STATUSES = ["draft", "published"] as const;

export type Category = (typeof CATEGORIES)[number];
export type Sensor = (typeof SENSORS)[number];
export type Status = (typeof STATUSES)[number];

export interface Product {
  slug: string;
  name: string;
  model: string;
  category: Category;
  sensors: Sensor[];
  highlights?: string[];
  specs?: Record<string, string>;
  moq?: number;
  images: { main: string; gallery?: string[] };
  supplierRef?: string;
  status: Status;
}

/** 契约 v1 的**全部**顶层键。多一个都算错（见 checkUnknownKeys 的理由）。 */
const TOP_LEVEL_KEYS = new Set([
  "slug", "name", "model", "category", "sensors",
  "highlights", "specs", "moq", "images", "supplierRef", "status",
]);

export interface Issue {
  field: string;
  code: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  /** 阻塞。有一条就不许写。 */
  errors: Issue[];
  /** 不阻塞，但要显示给人看。 */
  warnings: Issue[];
}

const err = (field: string, code: string, message: string): Issue => ({ field, code, message });

// ─────────────────────────────────────────────────────────────
// 硬规则 1 的闸：供应商痕迹绝不允许进入**会被渲染的字段**
//
// 契约原话："我们是给欧美客户做贴牌的，产物里带着供应商链接=把底牌递给客户。"
// ⚠️ 契约把这道闸放在 Web 的渲染层 + `grep -r dist/` 验收。那是**最后一道**。
//    这里再装一道，位置在**写入之前** —— 理由：渲染层只过滤它认识的字段
//    （`supplierRef`、`status:draft`），而一条 alibaba 链接被粘进 `specs.source`
//    或 `highlights[2]` 时，它是个**普通字符串**，渲染层没有理由过滤它，
//    于是它会一路走到 dist/。等 grep 报出来时，东西已经上线过了。
//
// 🔴 `supplierRef` 是**唯一**允许放供应商链接的地方（契约明示它是内部字段）。
//    其它任何公开字段里出现这些域名 = 硬错误，不是警告。
const SUPPLIER_MARKERS = ["alibaba.com", "alicdn.com", "1688.com", "aliexpress.com", "en.alibaba"];

function scanSupplierLeak(p: any, out: Issue[]): void {
  const walk = (v: unknown, path: string) => {
    if (typeof v === "string") {
      const low = v.toLowerCase();
      for (const m of SUPPLIER_MARKERS) {
        if (low.includes(m)) {
          out.push(err(path, "supplier_leak",
            `公开字段里出现供应商痕迹「${m}」。这会跟着构建产物上线，等于把底牌递给客户。` +
            `供应商链接只允许放在内部字段 supplierRef 里。`));
          return;
        }
      }
      return;
    }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`)); return; }
    if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
    }
  };
  for (const [k, v] of Object.entries(p || {})) {
    if (k === "supplierRef") continue; // ← 唯一豁免
    walk(v, k);
  }
}

// ─────────────────────────────────────────────────────────────
// 硬规则 2 的闸：`name` 不许照抄供应商 listing 标题
//
// ⚠️ 这一条**做不成硬判据**，所以它是 warning 不是 error —— 并且我说明白为什么：
//    "是不是照抄的"没有可判定的形式特征，真源（供应商标题）也不在我们手里。
//    硬拦的话，一个正当的长产品名会被永久挡住，而人会去想办法绕过闸 —— 绕过之后就没人看了。
//    ⇒ 这里只认**关键词堆砌的形态特征**，命中就吼一声让人自己看，不替他决定。
//    契约里那个反面例子（"Air Gas Analyzer Monitor Quality Detector Tester System Indoor
//    Equipment Pm 2.5 10 Device Aire Pollution Multi Smart 4G Desktop"）能被下面三条全部命中。
const STUFFING_WORDS = [
  "analyzer", "monitor", "detector", "tester", "device", "equipment",
  "system", "meter", "sensor", "quality", "indoor", "smart", "multi",
];

function checkNameStuffing(name: string, out: Issue[]): void {
  const words = name.trim().split(/\s+/);
  const low = name.toLowerCase();
  const hits = STUFFING_WORDS.filter((w) => low.includes(w));
  const reasons: string[] = [];
  if (words.length > 10) reasons.push(`${words.length} 个词`);
  if (name.length > 70) reasons.push(`${name.length} 个字符`);
  if (hits.length >= 4) reasons.push(`同义堆砌词 ${hits.length} 个（${hits.slice(0, 5).join("/")}）`);

  // 三条特征命中两条才吼 —— 只中一条的多半是正当的长名字，吼了会变成噪音，
  // 而一个天天误报的闸，人很快就不看它了。
  if (reasons.length >= 2) {
    out.push(err("name", "looks_like_listing_title",
      `这个名字像是从供应商 listing 直接抄来的（${reasons.join("；")}）。` +
      `供应商标题是给阿里站内搜索堆关键词的，放到自己官网上是灾难 —— 请改写成正常英文产品名。`));
  }
}

/**
 * 已知的系列前缀。**当前只有 `AK`**（Joe 2026-08-25 确认的我方真实编码）。
 * ⚠️ 这张表是会长的（Joe 原话「以后或许有别的系列编码」）—— 所以它只用来**吼**，不用来拦。
 *    拿一张"当前已知"的表去做硬闸，等于赌"以后不会有新系列"，而那个赌注写在数据里。
 */
const KNOWN_MODEL_PREFIXES = ["AK"];

/**
 * model 前缀检查 —— **warning，不阻断**。与 checkNameStuffing 同一条道理。
 * ⚠️ 站上现存 23 个 `AS-xxx` 全是冻结契约时编的值（真实 AK 对照表还没拿到）。
 *    它们必须仍然能在后台打开和保存 —— 改闸不能把存量数据变成不可保存，
 *    那会把"闸更宽松了"变成"一批产品打不开了"。
 */
function checkModelPrefix(model: string, out: Issue[]): void {
  const m = model.trim();
  if (KNOWN_MODEL_PREFIXES.some((p) => m.toUpperCase().startsWith(p))) return;
  out.push(err("model", "unknown_series_prefix",
    `「${m}」不在已知系列前缀里（当前已知：${KNOWN_MODEL_PREFIXES.join(" / ")}）。` +
    `如果这是一个新系列，直接存就行 —— 这条只是提醒，不阻断。` +
    `⚠️ 但如果它是**供应商的型号**，请换成我方型号：贴牌生意，型号是我们的资产。`));
}

// ─────────────────────────────────────────────────────────────

function checkUnknownKeys(p: any, out: Issue[]): void {
  for (const k of Object.keys(p || {})) {
    if (!TOP_LEVEL_KEYS.has(k)) {
      // 🔴 不静默丢弃：静默丢弃 = 用户以为存下去了，其实没有。
      //    也不静默保留：那等于单方面扩了契约，而 Web 窗按 v1 读。
      out.push(err(k, "unknown_field",
        `契约 v1 没有 \`${k}\` 这个字段。要加字段先回报总工 —— Web 窗按同一份契约读，单方面加会把官网构建搞挂。`));
    }
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** 数组里每一项都必须是非空字符串。返回坏项的下标。 */
function badStringItems(arr: unknown[]): number[] {
  const bad: number[] = [];
  arr.forEach((v, i) => { if (typeof v !== "string" || !v.trim()) bad.push(i); });
  return bad;
}

/**
 * 校验一份完整的产品数据。
 *
 * ⚠️ 校验的是**完整对象**，不是补丁。补丁要先经 mergeProduct 合成完整对象再来这里 ——
 *    否则"这次没提交 name"会被当成"name 缺失"，那正是 [[missing-input-is-not-intent-to-clear]] 那个病。
 */
export function validateProduct(input: unknown): ValidationResult {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];

  if (!isPlainObject(input)) {
    return { ok: false, errors: [err("(root)", "not_an_object", "产品数据必须是一个 JSON 对象。")], warnings };
  }
  const p = input as Record<string, unknown>;

  checkUnknownKeys(p, errors);

  // ---- slug（必填）----
  if (typeof p.slug !== "string" || !p.slug.trim()) {
    errors.push(err("slug", "required", "slug 必填（URL 用）。"));
  } else if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(p.slug)) {
    errors.push(err("slug", "format",
      `slug 只能是小写字母、数字和连字符，且不能以连字符开头/结尾或连续出现（当前：${p.slug}）。`));
  }

  // ---- name（必填）----
  if (typeof p.name !== "string" || !p.name.trim()) {
    errors.push(err("name", "required", "name 必填（展示名）。"));
  } else {
    checkNameStuffing(p.name, warnings);
  }

  // ---- model（必填。硬规则 3，契约 v1.3 修订）----
  //
  // 🔴 原来这里是 `^AS-` 硬闸。**它作废了**，理由不是"太严"，是**它守的那个前缀是编的**：
  //    冻结契约时并不知道我方真实编码，`AS-` 是当时造出来的；Joe 2026-08-25 确认
  //    真实编码是 `AK` + 数字，且「以后或许有别的系列编码」。
  //    ⇒ 一个照着编造值去拦真实值的闸，拦下的全是对的东西。
  //
  // 现在的判据：必填 + 非空 + 不含供应商痕迹（供应商痕迹由 scanSupplierLeak 统一扫，
  // 它覆盖所有公开字段，model 不需要自己再写一遍）。
  // 前缀只**吼一声**，不阻断 —— 与 checkNameStuffing 同构：
  // 闸拦的是"确定错的"，吼的是"看着可疑但可能正当"。一个天天误报的闸，人很快就不看它了。
  if (typeof p.model !== "string" || !p.model.trim()) {
    errors.push(err("model", "required", "model 必填。"));
  } else {
    checkModelPrefix(p.model, warnings);
  }

  // ---- category（必填，枚举）----
  if (typeof p.category !== "string" || !p.category) {
    errors.push(err("category", "required", "category 必填。"));
  } else if (!(CATEGORIES as readonly string[]).includes(p.category)) {
    errors.push(err("category", "enum",
      `category 只能是：${CATEGORIES.join(" | ")}（当前：${p.category}）。`));
  }

  // ---- sensors（必填，枚举数组）----
  if (!Array.isArray(p.sensors)) {
    errors.push(err("sensors", "required", "sensors 必填，且必须是数组。"));
  } else if (p.sensors.length === 0) {
    // 空数组 ≠ 没填。但对一台检测仪来说"一个传感器都没有"是错的，所以照样拒。
    errors.push(err("sensors", "empty", "sensors 不能是空数组 —— 一台检测仪至少有一个传感器。"));
  } else {
    const unknown = p.sensors.filter((s) => !(SENSORS as readonly string[]).includes(s as string));
    if (unknown.length) {
      errors.push(err("sensors", "enum",
        `sensors 含契约外的值：${unknown.join(", ")}。允许的是：${SENSORS.join(" | ")}。`));
    }
    const seen = new Set<unknown>();
    const dupes = p.sensors.filter((s) => (seen.has(s) ? true : (seen.add(s), false)));
    if (dupes.length) errors.push(err("sensors", "duplicate", `sensors 有重复项：${[...new Set(dupes)].join(", ")}。`));
  }

  // ---- status（必填，枚举）----
  if (typeof p.status !== "string" || !p.status) {
    errors.push(err("status", "required", "status 必填。"));
  } else if (!(STATUSES as readonly string[]).includes(p.status)) {
    errors.push(err("status", "enum", `status 只能是 ${STATUSES.join(" | ")}（当前：${p.status}）。`));
  }

  // ---- images（必填；images.main 必填）----
  if (!isPlainObject(p.images)) {
    errors.push(err("images", "required", "images 必填，且必须是对象（至少含 main）。"));
  } else {
    const main = p.images.main;
    if (typeof main !== "string" || !main.trim()) {
      errors.push(err("images.main", "required", "images.main 必填（相对 src/assets/ 的路径，例如 products/xxx.webp）。"));
    } else {
      if (/^https?:\/\//i.test(main)) {
        errors.push(err("images.main", "must_be_relative",
          `images.main 必须是相对 src/assets/ 的路径，不是外链（当前：${main}）。外链＝图片在别人服务器上，随时会消失。`));
      } else if (main.startsWith("/")) {
        errors.push(err("images.main", "leading_slash", `images.main 不要以 / 开头（当前：${main}）。`));
      }
    }
    if (p.images.gallery !== undefined) {
      if (!Array.isArray(p.images.gallery)) {
        errors.push(err("images.gallery", "type", "images.gallery 必须是数组。"));
      } else {
        const bad = badStringItems(p.images.gallery);
        if (bad.length) errors.push(err("images.gallery", "type", `images.gallery 第 ${bad.join(", ")} 项不是非空字符串。`));
        p.images.gallery.forEach((g, i) => {
          if (typeof g === "string" && /^https?:\/\//i.test(g)) {
            errors.push(err(`images.gallery[${i}]`, "must_be_relative", `必须是相对 src/assets/ 的路径，不是外链（当前：${g}）。`));
          }
        });
      }
    }
    for (const k of Object.keys(p.images)) {
      if (k !== "main" && k !== "gallery") {
        errors.push(err(`images.${k}`, "unknown_field", `契约 v1 的 images 只有 main 和 gallery。`));
      }
    }
  }

  // ---- highlights（选填，短句数组）----
  if (p.highlights !== undefined) {
    if (!Array.isArray(p.highlights)) {
      errors.push(err("highlights", "type", "highlights 必须是数组（选填）。"));
    } else {
      const bad = badStringItems(p.highlights);
      if (bad.length) errors.push(err("highlights", "type", `highlights 第 ${bad.join(", ")} 项不是非空字符串。`));
      p.highlights.forEach((h, i) => {
        if (typeof h === "string" && h.length > 80) {
          warnings.push(err(`highlights[${i}]`, "too_long", `${h.length} 个字符，契约说的是"短句"。详情页参数表用 specs，别塞进 highlights。`));
        }
      });
    }
  }

  // ---- specs（选填，自由键值；值必须是字符串）----
  if (p.specs !== undefined) {
    if (!isPlainObject(p.specs)) {
      errors.push(err("specs", "type", "specs 必须是对象（选填，自由键值）。"));
    } else {
      for (const [k, v] of Object.entries(p.specs)) {
        if (typeof v !== "string" || !v.trim()) {
          // 数字/布尔会在详情页参数表里渲染成 "1000"/"true"，那是给客户看的表格。
          // 强制字符串 = 让人自己决定单位和写法，而不是让渲染层去猜。
          errors.push(err(`specs.${k}`, "type", `specs 的值必须是非空字符串（当前 ${JSON.stringify(v)}）。单位和写法请自己写全，别让渲染层去猜。`));
        }
      }
    }
  }

  // ---- moq（选填，正整数；缺省＝面议）----
  if (p.moq !== undefined) {
    if (typeof p.moq !== "number" || !Number.isInteger(p.moq) || p.moq <= 0) {
      errors.push(err("moq", "type", `moq 必须是正整数（当前 ${JSON.stringify(p.moq)}）。⚠️ 想表达"面议"就**不要这个字段**，不要填 0 或空串。`));
    }
  }

  // ---- supplierRef（选填，内部字段）----
  if (p.supplierRef !== undefined) {
    if (typeof p.supplierRef !== "string" || !p.supplierRef.trim()) {
      errors.push(err("supplierRef", "type", "supplierRef 必须是非空字符串（选填）。"));
    } else {
      // ⚠️ 这句是给**使用后台的人**看的，不是给开发者看的。
      //    原来写的是契约原文（"Web 侧必须在渲染层过滤，验收要 grep dist/ 断言 0 命中"）——
      //    那是实现细节，对着屏幕填表的人既看不懂也做不了什么。
      //    ⚠️ 也不要在句首重复字段名：界面已经把字段名单独显示在左边了，重复会变成
      //       "supplierRef supplierRef 是……"。
      warnings.push(err("supplierRef", "internal_field",
        "这是内部字段，**不会出现在官网上**。供应商链接只能放这里 —— 粘进 specs 或 highlights 会被直接拒绝。"));
    }
  }

  // ---- 硬规则 1 的闸（放在最后，让它扫到上面所有字段）----
  scanSupplierLeak(p, errors);

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * 把补丁合进现有产品，得到一份**完整**对象。
 *
 * 🔴 这个函数存在的全部理由是一条已经吃过亏的规矩：
 *    **`undefined` 表示"我没收到"，不表示"用户要清空"。**（契约硬规则 5）
 *    解析失败返 `{}` + 无条件覆盖 = 静默清空还返 ok —— 两层单看都合理，
 *    错在相遇处，所以 code review 永远看不出来。这里把它变成一条显式规则。
 *
 * ⇒ 要**清空**一个选填字段，必须显式传 `null`（不是 `undefined`、不是 `""`）。
 *   必填字段传 `null` 是错误，不是清空 —— 交给 validateProduct 拦。
 */
export function mergeProduct(
  existing: Record<string, unknown> | null,
  patch: Record<string, unknown>,
): { merged: Record<string, unknown>; cleared: string[]; touched: string[] } {
  const merged: Record<string, unknown> = { ...(existing || {}) };
  const cleared: string[] = [];
  const touched: string[] = [];

  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;              // ← "我没收到"：保持原样
    if (v === null) {                           // ← 显式清空
      if (k in merged) { delete merged[k]; cleared.push(k); }
      continue;
    }
    if (JSON.stringify(merged[k]) !== JSON.stringify(v)) touched.push(k);
    merged[k] = v;
  }
  return { merged, cleared, touched };
}

/**
 * 契约 C1：一个产品一个文件，`src/content/products/<slug>.json`。
 * ⇒ 文件名与 slug 必须一致，否则 URL 和数据会指向两个不同的东西。
 */
export function checkSlugMatchesPath(slug: string, filename: string): Issue | null {
  const stem = filename.replace(/\.json$/i, "");
  if (stem !== slug) {
    return err("slug", "slug_path_mismatch",
      `文件名是 ${filename}，而 slug 是 "${slug}" —— 两者必须一致（契约：一个产品一个文件，文件名即 slug）。`);
  }
  return null;
}

/** 稳定的 JSON 序列化：键按契约顺序排，2 空格缩进，末尾换行。 */
export function serializeProduct(p: Record<string, unknown>): string {
  // ⚠️ 固定键序不是洁癖：不固定的话，改一个字段会产生一份**整体重排**的 diff，
  //    于是 review 的人看不出这次到底改了什么，而 git 历史也失去价值。
  const ORDER = ["slug", "name", "model", "category", "sensors", "highlights", "specs", "moq", "images", "supplierRef", "status"];
  const out: Record<string, unknown> = {};
  for (const k of ORDER) if (k in p) out[k] = p[k];
  for (const k of Object.keys(p)) if (!(k in out)) out[k] = p[k];  // 契约外的键（校验会拒，但序列化不静默吞）
  return JSON.stringify(out, null, 2) + "\n";
}
