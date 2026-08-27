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

/**
 * 🔴 **这两个数组不再是真源**（契约 v1.4 / A13）。真源是官网仓的
 *    `src/data/taxonomy.json`，官网的 content.config.ts 与本后台都从它读。
 *
 * ⚠️ 那为什么还留着？—— 它们是**仅供自检使用的样例轴**，让纯函数测试不必联网。
 *    🔴 **服务端的每一次校验都必须显式传入真实的轴**（见 validateProduct 的 axes 参数）。
 *       不传就退回这里的话，Joe 在后台新增一个机型之后，产品会因为"不在枚举里"被拒 ——
 *       而症状是"我明明加了这个分类却存不了"，没有人会想到是校验器还在看一份旧副本。
 *    ⇒ 所以 axes 是**必填参数**，不做默认回退。
 */
/**
 * 🔴🔴 **这些值是故意与真源不同的（AU2 ⑧：把陷阱变成绊线）。**
 *
 * 它们只给自检当"一份不会随官网改动而漂的固定轴"用，**不是运行时的取值来源** ——
 * 运行时每次校验都从 taxonomy.json 现读（src/index.ts 的 loadAxes）。
 *
 * ⚠️ 以前它们与真源**逐字相同**（desktop/portable/…）。那样不是 bug，但很危险：
 *    我自己就差点把「/api/contract 返回的 6 个机型与 taxonomy.json 一致」当成
 *    "它确实读了 taxonomy.json"的证据 —— 而那条观测在两种成因下**完全同形**
 *    （真读了 / 回落到了这份常量），所以它什么都证明不了。
 * ⇒ 改成 `sample-*` 这种真源里绝不会出现的值：
 *    **任何误用它们的代码或测试会立刻红，而不是静默通过。**
 *    观测值不同形了，它才开始携带信息。
 */
export const SAMPLE_CATEGORIES = ["sample-desktop", "sample-portable", "sample-other"] as const;

// ⚠️ `CO` 是契约 v1.1 §① 新增的（2026-08-10，总工批准）：素材里有家用 CO 报警器，
//    而枚举里原本只有 `CO2` 和 `combustible-gas`，两个都不是它。
//    🔴 这一行漏掉的话，后果不是"少个选项"，是**带 CO 的产品在后台根本存不了**
//       —— 而报出来的会是"sensors 含契约外的值"，看起来像数据错了，其实是校验器过时了。
/** 同上：**故意与真源不同**。真源里没有任何一个 `SAMPLE-` 开头的传感器。 */
export const SAMPLE_SENSORS = [
  "SAMPLE-CO2", "SAMPLE-PM2.5", "SAMPLE-TVOC", "SAMPLE-temperature",
] as const;

export const STATUSES = ["draft", "published"] as const;



export type Category = string;
export type Sensor = string;
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

/**
 * **状态说明**类 warning 的 code —— 不是待办。
 *
 * 🔴 判据写在这里，不写在消费端：**列表上的 badge 只报"需要人做点什么"的东西。**
 *    `internal_field` 说的是"这个字段不会上站"，那是一条恒真的状态说明 ——
 *    23 个产品全都有 supplierRef，于是 23 行全亮「1 提示」。
 *    **一个在 100% 的行上都亮的警告，不携带任何区分信息**，它只会把真正需要注意的那些淹掉。
 *
 * ⚠️ 被排除的只是**列表计数**。详情页仍要照常显示这条 warning ——
 *    对着单个产品它是有用的信息，两者不是一回事。
 * ⚠️ 以后再加"状态说明"类的 warning，**把 code 加进这个集合**，
 *    而不是去列表渲染层写 `if (code === "…")`：判据藏在消费端的话，
 *    下一个加同类 warning 的人根本不会知道有这条规矩。
 */
export const INFO_CODES: ReadonlySet<string> = new Set(["internal_field"]);

/** 需要人做点什么的 warning 条数 —— 列表 badge 用它，不用 warnings.length。 */
export const actionableWarnCount = (warnings: Issue[]): number =>
  warnings.filter((w) => !INFO_CODES.has(w.code)).length;

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
 * 🔴 这里原来有 `KNOWN_MODEL_PREFIXES` + `checkModelPrefix()`：model 不以 `AK` 开头
 *    就出一条 `unknown_series_prefix` warning。**契约 v1.5 整条删除**（Joe 2026-08-26
 *    指着编辑页那句话说「这句话删掉」）。
 *
 * ⚠️ **删而不是藏**：黄色「N 提示」角标当天已撤，编辑页那段文字是这条 warning
 *    **唯一的显示位**。文字再撤掉，它就是一条**永远不会被任何人看到的告警** —— 死代码。
 *    而本仓的死代码是会复活的：`.topbar` 那条死规则一加顶栏就当场覆盖了我的 padding，
 *    `.flag-warn` 也是撤了显示留着规则。⇒ 用不上就整条删。
 *
 * ⚠️ **删它不放开真风险**：它防的是误填供应商型号，而真正的闸是硬规则 1 的
 *    `scanSupplierLeak`（覆盖所有公开字段，含 model）—— **那道闸一个字没动**。
 *    这一条从来就只是"吼一声"，不阻断，也不构成任何防线。
 */

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
export interface Axes { categories: readonly string[]; sensors: readonly string[] }

export function validateProduct(input: unknown, axes: Axes): ValidationResult {
  // 🔴 轴必须显式传进来（见 SAMPLE_CATEGORIES 上方的理由）。
  //    不传就用旧副本的话，新增的分类会让产品**存不进去**，而症状指向数据不指向校验器。
  if (!axes || !Array.isArray(axes.categories) || !Array.isArray(axes.sensors)) {
    throw new Error("validateProduct 需要显式传入 axes（来自 taxonomy.json）—— 不做默认回退，见 contract.ts 顶部说明。");
  }
  const CATEGORIES = axes.categories;
  const SENSORS = axes.sensors;
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
  }
  // ⚠️ 这里原来接一句 `checkModelPrefix(p.model, warnings)`（契约 v1.5 删）。
  //    model 现在的判据只有：必填 + 非空 + 不含供应商痕迹（后者由 scanSupplierLeak 统一扫）。

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
