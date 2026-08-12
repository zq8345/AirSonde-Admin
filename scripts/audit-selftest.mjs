const SRC = new URL("../src/", import.meta.url).href;   // ⚠️ 绝不写绝对路径：CI 是 Linux
// 审计日志解析自检。
//
// 🔴 这里的错法有两种，方向相反，都要防：
//    ① **漏**：只认 `admin:` 开头的 commit ⇒ 日志给人"这就是全部改动"的印象，而 Web 窗直接推的没进来。
//    ② **猜**：message 形状对不上还硬解析出一个 slug/操作人 ⇒ 错的审计条目会被当成事实引用。
//    ⇒ 判据：**全部列出来**（①），**解析不出来就留空**（②）。
const { classify, mergeCommits } = await import(SRC + "audit.ts");

let pass = 0, fail = 0; const out = [];
const ck = (n, c, d = "") => { if (c) { pass++; out.push(`✅ ${n}`); } else { fail++; out.push(`🔴 ${n}\n     ${d}`); } };
const D = "2026-08-12T10:00:00Z", U = "https://x";

// ── ① 单产品：用**真实产生过的 message**，不是我编的格式 ──
{
  const msg = "admin: update 16in1-large-display-monitor (joe@wanew.com)\n\n字段：moq\n来源：admin.airsonde.com";
  const e = classify("99e52ba0a484fce3dcf01ac1fc4fa26c9a038157", msg, D, U);
  ck("① 解析出 action/slug/operator/字段", e.action === "update" && e.slugs[0] === "16in1-large-display-monitor"
    && e.operator === "joe@wanew.com" && e.fields === "moq", JSON.stringify(e));
  ck("① source=admin", e.source === "admin");
}
{
  const e = classify("a".repeat(40), "admin: create a6-selftest-widget (dev-bypass)\n\n字段：(无字段变化)，图片 1 项\n来源：admin.airsonde.com", D, U);
  ck("① create 也认得", e.action === "create" && e.slugs[0] === "a6-selftest-widget" && e.operator === "dev-bypass");
}
{
  const e = classify("b".repeat(40), "admin: delete a6-selftest-widget (dev-bypass)\n\n删除：content/products/x.json\n来源：admin.airsonde.com", D, U);
  ck("① delete 也认得", e.action === "delete" && e.slugs[0] === "a6-selftest-widget");
}

// ── ② 批量：正文里逐行列 slug，全部要抓到 ──
{
  const msg = "admin: bulk status=draft · 3 个产品 (joe@wanew.com)\n\n- a\n- b\n- c\n\n图片 3 项改动（随状态搬家）\n来源：admin.airsonde.com";
  const e = classify("c".repeat(40), msg, D, U);
  ck("② 批量：action=bulk、3 个 slug 全抓到、operator 正确",
    e.action === "bulk" && JSON.stringify(e.slugs) === '["a","b","c"]' && e.operator === "joe@wanew.com" && e.fields === "status=draft",
    JSON.stringify(e));
}

// ── ③ 🔴 不漏：别处推的 commit 必须**出现**，只是标 other ──
{
  const e = classify("d".repeat(40), "feat: add 11 new products from supplier catalog", D, U);
  ck("③ 关键：非 admin 的 commit 仍然是一条记录（不漏）", e.source === "other" && e.subject.startsWith("feat:"), JSON.stringify(e));
  ck("③ 且不猜 action/slug/operator（不编）", e.action === null && e.slugs.length === 0 && e.operator === null, JSON.stringify(e));
}

// ── ④ 🔴 不猜：admin: 开头但形状对不上 ⇒ 标 admin，其余留空 ──
{
  const e = classify("e".repeat(40), "admin: 手改了点东西", D, U);
  ck("④ 关键：形状对不上就留空，绝不猜出一个 slug",
    e.source === "admin" && e.action === null && e.slugs.length === 0 && e.operator === null, JSON.stringify(e));
}

// ── ⑤ 合并去重 + 时间倒序（数据与图片两条来源会有同一个 commit）──
{
  const a = [classify("1".repeat(40), "admin: update x (o)", "2026-08-12T09:00:00Z", U)];
  const b = [classify("1".repeat(40), "admin: update x (o)", "2026-08-12T09:00:00Z", U),
             classify("2".repeat(40), "admin: update y (o)", "2026-08-12T11:00:00Z", U)];
  const m = mergeCommits(a, b);
  ck("⑤ 同一个 commit 出现在两条来源里只保留一条", m.length === 2, JSON.stringify(m.map((x) => x.shortSha)));
  ck("⑤ 时间倒序（新的在前）", m[0].date > m[1].date, m.map((x) => x.date).join(" | "));
}

console.log(out.join("\n"));
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
