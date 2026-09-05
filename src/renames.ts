// 型号重命名台账 —— 后台改 model 时**同一个 commit** 里追加一条。
//
// 🔴 为什么必须是后台写：产品页的地址就是型号 ⇒ 改型号 = 换网址。
//    「改之前那个地址是什么」这个信息，**只有改名发生的那一刻存在** ——
//    改完之后，当前产品数据里再也没有旧型号，任何脚本都**重建不出来**这份历史。
//    ⇒ 官网仓的 `model-renames.json` 从上线起就写着"写它的只有后台"，
//      而后台**从来没写过**（2026-09-05 实测：全仓 0 处引用）。这个文件就是补这个洞。
//
// 🔴 实际代价（GSC 抓到的）：三次改名没记账 ⇒ `slug-migration.json` 里指向旧型号地址的
//    301 全部落到 404（`/products/8in1-desktop-monitor/` → `/products/ak16/` → 404）。
//    ⚠️ 而 `check-dist.mjs` 有一道**专门查这个**的闸（第 403/408 行）——
//       名单为空 ⇒ 检查项 0 条 ⇒ 全绿。**它照着一份空名单跑了十几天，一次都没响过。**
//
// ⛔ 只追加，不修改、不删除已有条目 —— 它是历史，不是当前状态的映射。
// ⛔ 不回填历史：09-05 之前那几条已由官网窗手工补齐，这里再补一次就是重复条目。

/** 台账在官网仓里的路径。⚠️ 与 `build-redirects.mjs` / `check-dist.mjs` 读的是同一份。 */
export const RENAMES_PATH = "src/data/model-renames.json";

export interface RenameRoute {
  /** 旧地址，形如 `/products/ak16/`，前后都带斜杠 */
  from: string;
  to: string;
  /** YYYY-MM-DD */
  at: string;
}

/**
 * 型号 → 产品页地址。**逐字照抄官网 `src/lib/products.ts` 的 `modelPath()`**：
 *   `String(model).toLowerCase().replace(/\//g, '-')`，再校验 `^[a-z0-9-]+$`。
 *
 * ⚠️ 🔴 **这里故意不 `trim()`**，与同仓的 `modelKey()` 不同 —— 那不是笔误：
 *    `modelKey` 是**判重**用的，多一个 trim 是为了让 `"AK19 "` 与 `"AK19"` 当场判为相撞；
 *    而这里要算的是**官网真的会构建出哪个地址**，所以必须跟官网一模一样。
 *    官网对 `"AK19 "` 是 throw（unusable-model），⇒ 这里返回 `null`，**不猜**。
 * ⛔ 台账里写一个官网根本不会生成的地址，会造出一条永远指不到东西的 301。
 */
export function modelUrl(model: unknown): string | null {
  if (typeof model !== "string" || !model) return null;
  const path = model.toLowerCase().replace(/\//g, "-");
  if (!/^[a-z0-9-]+$/.test(path)) return null;
  return `/products/${path}/`;
}

export type RenameDecision =
  | { record: true; entry: RenameRoute }
  | { record: false; why: string; note?: string };

/**
 * 这次保存该不该记一条改名。
 *
 * 🔴 判据是「**旧地址此刻是不是真的活着**」，⛔ 不是「model 字段变没变」：
 *    草稿产品的页面根本不构建 ⇒ 旧地址从来没存在过 ⇒ 记一条 301 是在为一个
 *    **从未存在的地址**造规则。台账是只追加的历史，⛔ 污染了修不回去。
 *    ⇒ 条件里带上 `existing.status === "published"`。
 *
 * ⚠️ 已知缺口，**明写不假装它没有**：产品先下架、下架之后再改名 ⇒ 这里不记。
 *    旧地址在历史上确实存在过（GSC 可能还留着），但"它曾经上过线"这件事
 *    后台此刻**判不出来**（要读整条 git 历史）。⇒ 这种情况返回 `note`，让操作人看得见。
 *
 * ⚠️ 链式改名（A→B 再 B→C）**照实追加两条**，⛔ 不在这里合并 ——
 *    官网 `build-redirects.mjs` 会自己解析到终点，产出永远是 A→C 和 B→C。
 *    在这里合并等于把"解析"这件事复制到第二个地方，两边迟早不一致。
 */
export function decideRename(
  existing: Record<string, unknown> | null,
  merged: Record<string, unknown>,
  today: string,
): RenameDecision {
  if (!existing) return { record: false, why: "新建产品，没有旧地址" };

  const from = modelUrl(existing.model);
  const to = modelUrl(merged.model);
  if (!from) return { record: false, why: "旧型号算不出可用地址（官网也构建不出它）" };
  if (!to) return { record: false, why: "新型号算不出可用地址" };
  if (from === to) return { record: false, why: "型号没变（或只是大小写 / 斜杠写法变了，地址相同）" };

  if (existing.status !== "published") {
    return {
      record: false,
      why: "改名前是草稿",
      note:
        `型号从 ${JSON.stringify(existing.model)} 改成了 ${JSON.stringify(merged.model)}，` +
        `但改名前它是草稿（status=${JSON.stringify(existing.status)}）—— 草稿页不构建，` +
        `所以 ${from} 这个地址此刻并不存在，没有记进重命名台账。` +
        `⚠️ 如果它**以前上过线**（后来才下架），那 ${from} 可能仍被搜索引擎收录着，` +
        `需要有人手工往 ${RENAMES_PATH} 补一条 —— 后台判不出这一点。`,
    };
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) {
    // ⛔ 宁可不记，也不记一个格式不对的日期 —— 它进的是只追加的历史。
    return { record: false, why: `日期格式不对：${JSON.stringify(today)}` };
  }

  return { record: true, entry: { from, to, at: today } };
}

export class LedgerError extends Error {}

/** 找出 `"routes": [` 那个数组的 `[` 与配对 `]` 的下标。带字符串/转义感知，⛔ 不用正则数括号。 */
function locateRoutes(text: string): { open: number; close: number } {
  const key = text.indexOf('"routes"');
  if (key < 0) throw new LedgerError(`${RENAMES_PATH} 里找不到 "routes" —— 拒绝在看不懂的结构上追加。`);
  const open = text.indexOf("[", key);
  if (open < 0) throw new LedgerError(`${RENAMES_PATH} 的 "routes" 后面没有 [。`);
  let depth = 0, inStr = false, esc = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "[") depth++;
    else if (ch === "]") { depth--; if (depth === 0) return { open, close: i }; }
  }
  throw new LedgerError(`${RENAMES_PATH} 的 routes 数组没有闭合。`);
}

/**
 * 把一条追加进台账文本，返回新的文件文本。
 *
 * 🔴 **外科插入，⛔ 不整份重新序列化。**
 *    仓里那份每条 route **占一行**（`{ "from": …, "to": …, "at": … }`），
 *    而 `JSON.stringify(doc, null, 2)` 只会把每个字段拆成一行 ——
 *    实测：往返一次，1176 字符变 1264，**每一条已有记录都会被改写**。
 *    这份文件的第一条规矩就是「⛔ 只追加，不修改已有条目」⇒ 重排整份是直接违反它，
 *    而且 diff 里那些 `-`/`+` 会把"这次到底加了什么"完全淹掉。
 *
 * ⭐ 但**校验仍然走 JSON**：文本插入完之后再 parse 一遍，要求
 *    ① 已有条目**逐条一字不差**（`slice(0,-1)` 与原来的深比）② `$comment` 没变
 *    ③ 最后一条正是要加的那条。
 *    ⇒ 文本插入负责"不动别人"，语义校验负责"真的加对了"。两个都过才返回。
 */
export function appendRoute(ledgerText: string, entry: RenameRoute): string {
  let before: any;
  try { before = JSON.parse(ledgerText); }
  catch (e) { throw new LedgerError(`${RENAMES_PATH} 不是合法 JSON，拒绝在它上面追加：${String(e)}`); }

  if (!before || typeof before !== "object" || Array.isArray(before)) {
    throw new LedgerError(`${RENAMES_PATH} 顶层不是对象。`);
  }
  if (!Array.isArray(before.routes)) {
    // ⛔ 不"顺手建一个 routes 数组"：读不到它 ≠ 它本来就是空的（见"我没收到≠想清空"）。
    throw new LedgerError(`${RENAMES_PATH} 里没有 routes 数组 —— 拒绝在看不懂的结构上追加。`);
  }
  if (entry.from === entry.to) throw new LedgerError(`from 与 to 相同（${entry.from}），不是一次改名。`);

  // 幂等：同一条已经在里面就**原样返回原文**（重试 / 同一次改名被保存两次）。
  // ⚠️ 只比 from+to，⛔ 不比 at —— 同一次改名在不同日期重放，仍然是同一条历史。
  if (before.routes.some((r: any) => r && r.from === entry.from && r.to === entry.to)) return ledgerText;

  const { open, close } = locateRoutes(ledgerText);
  const inner = ledgerText.slice(open + 1, close);
  const line = `{ "from": ${JSON.stringify(entry.from)}, "to": ${JSON.stringify(entry.to)}, "at": ${JSON.stringify(entry.at)} }`;
  const body = inner.replace(/\s+$/, "");
  const newInner = body.trim() === ""
    ? `\n    ${line}\n  `
    : `${body},\n    ${line}\n  `;
  const out = ledgerText.slice(0, open + 1) + newInner + ledgerText.slice(close);

  // ── 语义自证：插完之后必须仍是同一份文件 + 末尾多了这一条 ──
  let after: any;
  try { after = JSON.parse(out); }
  catch (e) { throw new LedgerError(`追加之后不是合法 JSON（这是本函数的 bug，不是输入的问题）：${String(e)}`); }
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (!Array.isArray(after.routes) || after.routes.length !== before.routes.length + 1) {
    throw new LedgerError(`追加之后条数不对（${before.routes.length} → ${after.routes?.length}）。`);
  }
  if (!same(after.routes.slice(0, -1), before.routes)) {
    throw new LedgerError("追加动到了已有条目 —— 已中止。这份文件只许追加。");
  }
  if (!same(after.$comment, before.$comment)) throw new LedgerError("追加动到了 $comment —— 已中止。");
  if (!same(after.routes[after.routes.length - 1], entry)) throw new LedgerError("追加进去的那条与要加的不一致。");
  return out;
}
