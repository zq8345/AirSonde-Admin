// 两个分类轴（机型 category / 传感器 sensors）—— **纯函数，不碰网络**。
//
// 真源是官网仓的 `src/data/taxonomy.json`（契约 v1.4）。官网的 `content.config.ts`
// 与 `lib/products.ts` 都从它读；本后台从 A13 起可以增删改它。
//
// 🔴🔴 **这里的删除闸不是兜底，它是唯一的防线。** 这一条与直觉相反，必须写清楚：
//    原来大家（包括派单）都假设"删掉在用的取值 ⇒ 官网构建失败"。**W18 实测推翻了它**：
//      · 删掉在用的 CO2 → 直接重建 **通过**
//      · 清 `.astro/collections` 再建 → **仍通过**
//      · 删整个 `.astro/` 再建 → **仍通过**（"CI 全新克隆就安全"这个推断也是错的）
//      · 只有删 `node_modules/.astro/data-store.json` 才失败
//    Astro 只在**内容配置文件本身变化**时才重新校验；单改 taxonomy.json 不算配置变化，
//    整批产品**跳过校验**。
//
//    ⇒ 后果不是"晚一点报错"，是**因果链被切断**：删完之后官网下一次构建可能照常通过，
//      直到某次**毫不相关的提交**才爆 —— 那时现场已经不在，没有人会想到是几天前
//      有人在后台删了一个分类。
//    ⚠️ 所以 refsOf() 报出来的"谁在用"必须是**准确的**，不能漏。漏一个 = 放行一次删除。

export interface TaxonomyItem { value: string; label: string; order: number }
export interface Taxonomy { categories: TaxonomyItem[]; sensors: TaxonomyItem[]; $comment?: string }
export type Axis = "categories" | "sensors";

export interface Issue { field: string; code: string; message: string }
const err = (field: string, code: string, message: string): Issue => ({ field, code, message });

/** 两个轴的名字 —— 用在消息里，别在各处各写一遍中文。 */
export const AXIS_LABEL: Record<Axis, string> = { categories: "机型", sensors: "传感器" };
/** 产品 JSON 里，这个轴对应哪个字段。 */
export const AXIS_FIELD: Record<Axis, "category" | "sensors"> = { categories: "category", sensors: "sensors" };

/** `value` 的形状：小写字母/数字/连字符 —— 它会进产品 JSON，也会进官网 URL 的筛选参数。 */
const VALUE_RE = /^[a-z0-9]+([.\-/][a-z0-9]+)*$/i;

/**
 * 校验一整份 taxonomy。
 * ⚠️ 校验的是**整份**，不是某一次操作 —— 操作先合成完整对象再来这里，
 *    否则"这次没提交 sensors"会被当成"sensors 没了"。
 */
export function validateTaxonomy(t: any): { ok: boolean; errors: Issue[] } {
  const errors: Issue[] = [];
  if (!t || typeof t !== "object" || Array.isArray(t)) {
    return { ok: false, errors: [err("(根)", "not_object", "taxonomy 必须是一个 JSON 对象。")] };
  }
  for (const axis of ["categories", "sensors"] as Axis[]) {
    const arr = t[axis];
    if (!Array.isArray(arr)) { errors.push(err(axis, "required", `${axis} 必须是数组。`)); continue; }
    if (!arr.length) {
      // 空轴 = 所有产品的那个字段都失效。这不是"清空了一个列表"，是让 23 个产品全变非法。
      errors.push(err(axis, "empty", `${AXIS_LABEL[axis]}不能一条都没有 —— 那会让所有产品的该字段变成非法值。`));
      continue;
    }
    const seen = new Set<string>();
    arr.forEach((it: any, i: number) => {
      const p = `${axis}[${i}]`;
      if (!it || typeof it !== "object") { errors.push(err(p, "type", `${p} 必须是对象。`)); return; }
      if (typeof it.value !== "string" || !it.value.trim()) {
        errors.push(err(`${p}.value`, "required", "value 必填。"));
      } else if (!VALUE_RE.test(it.value)) {
        errors.push(err(`${p}.value`, "format",
          `「${it.value}」不是合法的取值：只能用字母、数字，以及中间的 - . /（它会进产品数据和官网筛选）。`));
      } else if (seen.has(it.value)) {
        // 🔴 重复 value ⇒ 两条记录抢同一个键，谁生效取决于遍历顺序 —— 那是最难查的一类。
        errors.push(err(`${p}.value`, "duplicate", `「${it.value}」重复了 —— 同一个取值只能有一条。`));
      } else seen.add(it.value);

      if (typeof it.label !== "string" || !it.label.trim()) {
        errors.push(err(`${p}.label`, "required", "显示名必填 —— 官网上就是拿它显示的。"));
      }
      if (typeof it.order !== "number" || !Number.isFinite(it.order)) {
        errors.push(err(`${p}.order`, "type", "order 必须是数字。"));
      }
      for (const k of Object.keys(it)) {
        if (!["value", "label", "order"].includes(k)) {
          errors.push(err(`${p}.${k}`, "unknown_field", `taxonomy 只有 value / label / order 三个字段。`));
        }
      }
    });
  }
  return { ok: errors.length === 0, errors };
}

/** 排好序的取值列表 —— 校验产品时用的就是它。 */
export const valuesOf = (t: Taxonomy, axis: Axis): string[] =>
  (t[axis] || []).slice().sort((a, b) => a.order - b.order).map((x) => x.value);

/** 两个轴的取值，喂给 validateProduct。 */
export const axesOf = (t: Taxonomy) => ({ categories: valuesOf(t, "categories"), sensors: valuesOf(t, "sensors") });

/**
 * 谁在用这个取值 —— 返回产品 slug 列表。
 *
 * 🔴 这是删除闸的**全部依据**（见文件顶部：官网构建不会兜底）。
 * ⚠️ 两个轴的形状不同：category 是单值，sensors 是数组。写成一条通用逻辑而不是两份，
 *    否则将来加第三个轴时，漏掉的那一份会**静默放行删除**。
 */
export function refsOf(products: any[], axis: Axis, value: string): string[] {
  const field = AXIS_FIELD[axis];
  const out: string[] = [];
  for (const p of products || []) {
    if (!p || p.error) continue;          // 读不出来的产品**不算"没在用"**，见下面的 note
    const v = (p as any)[field];
    const hit = Array.isArray(v) ? v.includes(value) : v === value;
    if (hit) out.push(p.slug);
  }
  return out;
}

/**
 * 有多少个产品**读不出来** —— 它们的引用是看不见的。
 * 🔴 有读不出来的产品时，"0 个在用"这个结论**不成立**：那不是"没人用"，是"我没看全"。
 *    ⇒ 调用方必须据此拒绝删除，而不是放行。
 */
export const unreadableCount = (products: any[]): number => (products || []).filter((p) => p && p.error).length;

/** 追加一条。value 由调用方给定，**创建后不可改**。 */
export function addItem(t: Taxonomy, axis: Axis, item: { value: string; label: string }): Taxonomy {
  const next = clone(t);
  const maxOrder = next[axis].reduce((m, x) => Math.max(m, x.order || 0), 0);
  next[axis] = [...next[axis], { value: item.value.trim(), label: item.label.trim(), order: maxOrder + 1 }];
  return next;
}

/**
 * 改一条。**只改 label 与 order**。
 * ⛔ 不许改 value：它已经写进 23 个产品的 JSON，改它 = 改数据。
 *    真要改是"新增 + 批量迁移 + 删旧"三步，那是另一张单。
 */
export function editItem(t: Taxonomy, axis: Axis, value: string, patch: { label?: string; order?: number }): Taxonomy {
  const next = clone(t);
  const i = next[axis].findIndex((x) => x.value === value);
  if (i < 0) throw new Error(`${AXIS_LABEL[axis]}里没有「${value}」这一条。`);
  if (patch.label !== undefined) next[axis][i]!.label = String(patch.label).trim();
  if (patch.order !== undefined) next[axis][i]!.order = Number(patch.order);
  return next;
}

/** 删一条。⚠️ **调用方必须先用 refsOf 确认没人在用** —— 这里不做那个检查，它需要产品数据。 */
export function deleteItem(t: Taxonomy, axis: Axis, value: string): Taxonomy {
  const next = clone(t);
  const before = next[axis].length;
  next[axis] = next[axis].filter((x) => x.value !== value);
  if (next[axis].length === before) throw new Error(`${AXIS_LABEL[axis]}里没有「${value}」这一条。`);
  return next;
}

const clone = (t: Taxonomy): Taxonomy => JSON.parse(JSON.stringify(t));

/**
 * 稳定序列化。⚠️ `$comment` 原样保留并排在最前 —— 它是给下一个读这个文件的人看的说明。
 * ⚠️ 每个轴按 order 排序后写出：文件顺序与显示顺序一致，diff 才读得懂。
 */
export function serializeTaxonomy(t: Taxonomy): string {
  const out: Record<string, unknown> = {};
  if (t.$comment) out.$comment = t.$comment;
  for (const axis of ["categories", "sensors"] as Axis[]) {
    out[axis] = (t[axis] || []).slice().sort((a, b) => a.order - b.order)
      .map((x) => ({ value: x.value, label: x.label, order: x.order }));
  }
  return JSON.stringify(out, null, 2) + "\n";
}
