const SRC = new URL("../src/", import.meta.url).href;   // ⚠️ 绝不写绝对路径：CI 是 Linux
// 分类显示名解析自检。
//
// 🔴 这个解析器守的是一件很具体的事：**后台不许自己抄一份显示名**（那会与官网漂移）。
//    ⇒ 它去读官网源码。而"读源码 + 正则"天然有一种失败方式最难发现：
//      **抽出来一份少了几条、但看起来正常的表**。
//      少的那几条会在界面上显示成 slug，没人会觉得那是解析漏了。
//    ⇒ 所以判据不是"匹配上了几条"，而是 **键集必须与契约双向相等**，不等就整份作废。
//
// 下面每一组都成对：**正对照**（该认出来的认出来）+ **反向自证**（该作废的真的作废）。
const { parseCategoryLabels } = await import(SRC + "catlabels.ts");
const { CATEGORIES } = await import(SRC + "contract.ts");

let pass = 0, fail = 0; const out = [];
const ck = (n, c, d = "") => { if (c) { pass++; out.push(`✅ ${n}`); } else { fail++; out.push(`🔴 ${n}\n     ${d}`); } };

// ── ① 正对照：**官网仓里真实的那段源码**，不是我编的形状 ──
const REAL = `
export const CATEGORY_LABELS: Record<string, string> = {
  desktop: 'Desktop',
  portable: 'Portable',
  'wall-mounted': 'Wall-mounted',
  wearable: 'Wearable',
  industrial: 'Industrial',
  other: 'Other',
};

export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category;
}
`;
{
  const r = parseCategoryLabels(REAL, CATEGORIES);
  ck("① 真实源码：解析成功", r.ok, r.why);
  ck("① 带引号的键也认得（'wall-mounted'）", r.labels?.["wall-mounted"] === "Wall-mounted", JSON.stringify(r.labels));
  ck("① 六个全在", r.ok && Object.keys(r.labels).length === CATEGORIES.length, JSON.stringify(r.labels));
}

// ── ② 🔴 核心反向自证：源码少一条 ⇒ **整份作废**，而不是"给你五条" ──
{
  const r = parseCategoryLabels(REAL.replace(/\s*wearable: 'Wearable',\n/, "\n"), CATEGORIES);
  ck("② 关键：少一条就整份作废（labels=null，不是给半份）", r.ok === false && r.labels === null, JSON.stringify(r));
  ck("② 且说出少的是谁", /wearable/.test(r.why), r.why);
}

// ── ③ 官网多出一个分类 ⇒ 也作废，并提示契约要跟进 ──
{
  const r = parseCategoryLabels(REAL.replace("other: 'Other',", "other: 'Other',\n  vehicle: 'Vehicle',"), CATEGORIES);
  ck("③ 官网多一个分类 ⇒ 作废", r.ok === false && r.labels === null);
  ck("③ 且指出是官网多出来的（契约需要跟进）", /vehicle/.test(r.why) && /契约/.test(r.why), r.why);
}

// ── ④ 读不到源码 ⇒ 说读不到，**绝不回落到一份副本** ──
{
  const r = parseCategoryLabels(null, CATEGORIES);
  ck("④ 读不到 ⇒ ok=false 且 labels=null（不猜、不抄副本）", r.ok === false && r.labels === null, JSON.stringify(r));
}
{
  const r = parseCategoryLabels("export const SOMETHING_ELSE = {};", CATEGORIES);
  ck("④ 常量被改名/搬走 ⇒ 作废并说明", r.ok === false && /CATEGORY_LABELS/.test(r.why), r.why);
}

// ── ⑤ 花括号扫描：值里带 } 时不能提前截断（/\{([^}]*)\}/ 会在这里错） ──
{
  const tricky = REAL.replace("other: 'Other',", "other: 'Other } weird',");
  const r = parseCategoryLabels(tricky, CATEGORIES);
  ck("⑤ 值里含 } 仍能读全（配平扫描，不是 [^}]*）", r.ok && r.labels.other === "Other } weird", JSON.stringify(r));
}

// ── ⑥ 空显示名 = 解析对了但数据坏了，同样不该被当成好的 ──
{
  const r = parseCategoryLabels(REAL.replace("wearable: 'Wearable'", "wearable: ''"), CATEGORIES);
  ck("⑥ 显示名为空 ⇒ 作废（不要在界面上显示一个空格子）", r.ok === false && /wearable/.test(r.why), r.why);
}

// ── ⑦ 双引号写法（官网哪天换 prettier 配置就会变成这样）──
{
  const r = parseCategoryLabels(REAL.replace(/'/g, '"'), CATEGORIES);
  ck("⑦ 双引号写法照样认得（引号风格不该影响结论）", r.ok && r.labels.desktop === "Desktop", JSON.stringify(r));
}

console.log(out.join("\n"));
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
