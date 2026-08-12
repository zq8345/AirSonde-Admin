// 分类的**英文显示名**从哪来。
//
// 🔴 官网上那六个筛选按钮的字（Desktop / Portable / …）不在数据里，
//    它们写在官网源码 `src/lib/products.ts` 的 `CATEGORY_LABELS` 里。
//
// ⚠️ 所以这里有一个诱人的错误做法：在后台也写一份同样的表。
//    那就是**第二个真源** —— 官网哪天改了 'Wall-mounted' → 'Wall mount'，
//    后台会继续理直气壮地显示旧的那个，而且没有任何症状。
//    ⇒ 这里**运行时去官网仓读那个文件并解析**。读不到就说读不到，
//      **绝不回退到一份本地副本假装知道** —— "不知道"是诚实的，猜是不诚实的。
//
// ⚠️ 这是**只读**。后台在官网仓的写入范围只有 `src/content/products/`，
//    读源码只是为了不复制它。

export interface LabelParse {
  ok: boolean;
  /** ok 时是 slug→显示名；不 ok 时**是 null**，不是半份 */
  labels: Record<string, string> | null;
  /** 为什么不 ok —— 要能直接读懂，不是 "parse error" */
  why: string;
}

/**
 * 从官网源码文本里解析出 CATEGORY_LABELS。
 *
 * 🔴 判据不是"正则匹配上了几条"，而是 **抽出来的键集必须恰好等于契约里的分类集**。
 *    只数命中数的话：官网加了一个分类、或者我的正则漏了一种写法（模板串、注释里的括号），
 *    都会得到一份**看起来正常的、少一条的表** —— 而少的那条会在界面上显示成 slug，
 *    没人会发现那是解析漏了，只会以为"这个分类没起名字"。
 *    ⇒ 集合不相等 = 这次解析不可信 = 整份作废，一个都不用。
 */
export function parseCategoryLabels(source: string | null, expected: readonly string[]): LabelParse {
  if (source == null) {
    return { ok: false, labels: null, why: "读不到官网源码文件（见 path），因此不知道官网把这些分类叫什么。" };
  }

  const at = source.indexOf("CATEGORY_LABELS");
  if (at < 0) {
    return { ok: false, labels: null, why: "官网源码里找不到 CATEGORY_LABELS —— 它可能被改名或搬走了。" };
  }
  const open = source.indexOf("{", at);
  if (open < 0) {
    return { ok: false, labels: null, why: "找到了 CATEGORY_LABELS 但后面没有对象字面量。" };
  }

  // 花括号配平扫描，**且跳过字符串字面量内部**。
  // ⚠️ 只数括号是不够的：显示名里出现一个 } 就会让扫描提前收尾，
  //    于是它后面的那些分类被整段截掉 —— 而截掉的部分正好长得像"官网没定义它们"。
  //    （自检 ⑤ 就是拿这个错法当反向自证的：不跳字符串的版本在那条上必红。）
  let depth = 0, close = -1, quote = "";
  for (let i = open; i < source.length; i++) {
    const ch = source[i]!;
    if (quote) {
      if (ch === "\\") i++;                 // 转义：下一个字符不参与判断
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") { quote = ch; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) { close = i; break; } }
  }
  if (close < 0) {
    return { ok: false, labels: null, why: "CATEGORY_LABELS 的对象字面量没有闭合（源码被截断了？）。" };
  }

  const body = source.slice(open + 1, close);
  const labels: Record<string, string> = {};
  for (const m of body.matchAll(/(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*:\s*(?:'([^']*)'|"([^"]*)")/g)) {
    const key = m[1] ?? m[2] ?? m[3]!;
    const val = m[4] ?? m[5]!;
    labels[key] = val;
  }

  // ⭐ 正对照：键集必须与契约**双向相等**。少一个、多一个都是"这份解析不可信"。
  const got = Object.keys(labels).sort();
  const want = [...expected].sort();
  const missing = want.filter((k) => !got.includes(k));
  const extra = got.filter((k) => !want.includes(k));
  if (missing.length || extra.length) {
    return {
      ok: false,
      labels: null,
      why:
        "解析出来的分类集与契约对不上，整份作废（宁可不显示，也不显示一份少了几条的表）。" +
        (missing.length ? ` 契约有而源码里没解析到：${missing.join("、")}。` : "") +
        (extra.length ? ` 源码里有而契约没有：${extra.join("、")}——官网可能已经加了新分类，契约需要跟进。` : ""),
    };
  }
  // 空字符串的显示名也是"解析对了但数据坏了"，一样不该被当成好的
  const blank = want.filter((k) => !labels[k]!.trim());
  if (blank.length) {
    return { ok: false, labels: null, why: `这些分类的显示名是空的：${blank.join("、")}。` };
  }

  return { ok: true, labels, why: "" };
}
