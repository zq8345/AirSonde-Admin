// 行级 diff。用于 dry-run 预览「将要写入的内容」。
//
// ⚠️ 为什么不直接把新旧两份 JSON 都丢给人看：**人看不出两份 60 行 JSON 的区别**。
//    看不出就会点确认，那这个预览等于没有。预览的价值全在"只显示变了的那几行"。
//
// 产品 JSON 是小文件（几十行），所以用最朴素的 LCS，不做启发式优化 —— 代码短、行为可预测。

export interface DiffLine {
  type: "ctx" | "add" | "del";
  /** 旧文件里的行号（1 起）；新增行为 null */
  oldNo: number | null;
  /** 新文件里的行号（1 起）；删除行为 null */
  newNo: number | null;
  text: string;
}

function lcsTable(a: string[], b: string[]): number[][] {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  return dp;
}

/** 全量行 diff（不折叠上下文——文件本来就小，折叠反而藏东西）。 */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  // ⚠️ 用 split("\n") 而不是按 /\r?\n/ 归一化：CRLF 与 LF 的差别**是真实差别**，
  //    它会改变文件字节、改变 git blob sha。把它悄悄抹平，diff 就会显示"没变化"
  //    而实际上产生了一次全文件改动。
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const dp = lcsTable(a, b);
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ type: "ctx", oldNo: i + 1, newNo: j + 1, text: a[i]! });
      i++; j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ type: "del", oldNo: i + 1, newNo: null, text: a[i]! });
      i++;
    } else {
      out.push({ type: "add", oldNo: null, newNo: j + 1, text: b[j]! });
      j++;
    }
  }
  while (i < a.length) { out.push({ type: "del", oldNo: i + 1, newNo: null, text: a[i]! }); i++; }
  while (j < b.length) { out.push({ type: "add", oldNo: null, newNo: j + 1, text: b[j]! }); j++; }
  return out;
}

export interface DiffSummary {
  added: number;
  removed: number;
  /** 🔴 两边字节完全一致 ⇒ 这次保存什么也不会改。**必须显式说出来**，不能让人以为存进去了。 */
  identical: boolean;
  lines: DiffLine[];
}

export function summarizeDiff(oldText: string, newText: string): DiffSummary {
  const lines = diffLines(oldText, newText);
  const added = lines.filter((l) => l.type === "add").length;
  const removed = lines.filter((l) => l.type === "del").length;
  return { added, removed, identical: oldText === newText, lines };
}
