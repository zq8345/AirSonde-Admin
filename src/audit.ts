// 审计日志：谁在什么时候改了哪个产品。**纯函数部分，不碰网络。**
//
// 数据源是 git commit 链本身 —— 不另存一份审计表。
// 🔴 理由不是省事：另存一份就有**两个真源**，而"审计表说改过、git 说没改过"这种分歧
//    恰恰会在出事时出现（写审计表那一步失败、或者有人绕过后台直接推）。
//    git 是唯一不可能被绕过的记录：**改动本身就是记录**。
//
// ⚠️ 但这带来一个必须处理的诚实性问题，见 classify() 的注释。

export interface AuditEntry {
  sha: string;
  shortSha: string;
  date: string;
  /** 来自 commit message 的解析结果；解析不出来就是 null，**不猜** */
  action: "create" | "update" | "delete" | "bulk" | null;
  slugs: string[];
  operator: string | null;
  fields: string | null;
  /** admin=本后台写的；other=别处推的（Web 窗、直接 git push、CI…） */
  source: "admin" | "other";
  subject: string;
  url: string;
}

/**
 * 从 commit message 解析出后台操作。
 *
 * 🔴 **不是所有改动都来自这个后台。** Web 窗会直接推、人也可能直接 git push。
 *    如果这个日志只显示 `admin:` 开头的 commit，它给人的印象是"这就是全部改动" ——
 *    而那是假的。⇒ **全部列出来，只是标清楚哪些是后台写的、哪些是别处来的。**
 *    ⚠️ 一个只显示自己那部分的审计日志，比没有审计日志更危险：它让人以为自己看全了。
 */
export function classify(sha: string, message: string, date: string, url: string): AuditEntry {
  const subject = (message || "").split("\n")[0] || "";
  const base = {
    sha, shortSha: sha.slice(0, 7), date, subject, url,
    action: null as AuditEntry["action"], slugs: [] as string[],
    operator: null as string | null, fields: null as string | null,
    source: "other" as AuditEntry["source"],
  };
  if (!subject.startsWith("admin: ")) return base;

  base.source = "admin";

  // 批量：`admin: bulk status=published · N 个产品 (operator)`，正文逐行列 `- slug`
  const bulk = /^admin: bulk\s+(\S+)\s+·\s+(\d+)\s+个产品\s+\(([^)]+)\)/.exec(subject);
  if (bulk) {
    base.action = "bulk";
    base.operator = bulk[3]!;
    base.fields = bulk[1]!;
    base.slugs = [...message.matchAll(/^- (\S+)$/gm)].map((m) => m[1]!);
    return base;
  }

  // 单产品：`admin: update <slug> (<operator>)`
  const one = /^admin: (create|update|delete)\s+(\S+)\s+\(([^)]+)\)/.exec(subject);
  if (one) {
    base.action = one[1] as AuditEntry["action"];
    base.slugs = [one[2]!];
    base.operator = one[3]!;
    const f = /^字段：(.+)$/m.exec(message);
    if (f) base.fields = f[1]!.trim();
    return base;
  }

  // 形状对不上 ⇒ 只标成 admin，**不猜** action/slug。
  // ⚠️ 猜错的审计条目比没有条目更坏：它会被当成事实引用。
  return base;
}

/** 合并两条来源（数据文件 + 图片）的 commit，按 sha 去重、按时间倒序。 */
export function mergeCommits(...lists: AuditEntry[][]): AuditEntry[] {
  const by = new Map<string, AuditEntry>();
  for (const l of lists) for (const e of l) if (!by.has(e.sha)) by.set(e.sha, e);
  return [...by.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}
