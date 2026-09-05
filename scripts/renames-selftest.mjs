const SRC = new URL("../src/", import.meta.url).href;   // ⚠️ 绝不写绝对路径：CI 是 Linux
// 型号重命名台账自检。
//
// 🔴 这条路上的失败**没有任何症状**：改名成功、构建成功、页面正常，
//    只有旧网址从此 404 —— 而那要等 GSC 抓到（今天就是这么发现的，隔了 5 天）。
//    ⇒ 每条都成对测：该记的记（正对照）+ 该放过的放过（反向自证）。
//
// ⭐ 最要害的一组是 ⑤：拿**官网仓此刻真实那份台账**当输入，
//    要求「已有条目一个字节都不动」。整份重新序列化会把每条 route 从一行拆成五行 ——
//    那违反这份文件的第一条规矩（⛔ 只追加，不修改已有条目），而且 diff 会淹掉真正的改动。

const { modelUrl, decideRename, appendRoute, RENAMES_PATH, LedgerError } = await import(SRC + "renames.ts");

let pass = 0, fail = 0; const out = [];
const ck = (n, c, d = "") => { if (c) { pass++; out.push(`✅ ${n}`); } else { fail++; out.push(`🔴 ${n}\n     ${d}`); } };
const threw = (fn) => { try { fn(); return false; } catch (e) { return e instanceof LedgerError; } };

// 官网仓 `src/data/model-renames.json` 的**真实内容**（origin/main，2026-09-05 取）。
// ⚠️ 逐字节照抄，包括每条 route 占一行这个格式 —— 这一组测的就是这个格式不被破坏。
const REAL = `{
  "$comment": [
    "W30-A · 型号重命名台账。产品页的地址就是型号，所以改型号 = 换网址。",
    "⛔ 只追加，不修改、不删除已有条目。它是历史，不是当前状态的映射。"
  ],
  "routes": [
    { "from": "/products/ak23/", "to": "/products/ak23a/", "at": "2026-08-31" },
    { "from": "/products/ak16/", "to": "/products/ak16a/", "at": "2026-09-03" },
    { "from": "/products/ak16d/", "to": "/products/ak16d-co/", "at": "2026-09-04" },
    { "from": "/products/ak34-1/", "to": "/products/ak34/", "at": "2026-09-01" }
  ]
}
`;
const EMPTY = `{
  "$comment": ["说明"],
  "routes": []
}
`;

// ══════ ① modelUrl 与官网 modelPath 同规则 ══════
{
  ck("① AK16 → /products/ak16/", modelUrl("AK16") === "/products/ak16/");
  ck("① 斜杠换成横杠（与官网 replace(/\\//g,'-') 一致）", modelUrl("AK16/D") === "/products/ak16-d/");
  ck("① 已经是小写也一样", modelUrl("ak16a") === "/products/ak16a/");
  // 🔴 反向自证：**官网构建不出来的型号，这里必须返回 null**。
  //    台账里写一个官网不会生成的地址 = 一条永远指不到东西的 301。
  ck("① 带空格 ⇒ null（官网 modelPath 对它是 throw）", modelUrl("AK19 ") === null);
  ck("① 中文 / 下划线 ⇒ null", modelUrl("AK_19") === null && modelUrl("型号") === null);
  ck("① 空 / 非字符串 ⇒ null", modelUrl("") === null && modelUrl(null) === null && modelUrl(42) === null);
  // ⚠️ 这条钉住"这里故意不 trim"这个决定：它与同仓 modelKey() 不同，且**不是笔误**。
  ck("① 🔴 故意不 trim —— 与判重用的 modelKey 不是同一个函数", modelUrl(" AK16") === null);
}

// ══════ ② 该不该记 ══════
const PUB = (m) => ({ model: m, status: "published" });
{
  const r = decideRename(PUB("AK16"), { model: "AK16A" }, "2026-09-05");
  ck("② 上线中的产品改型号 ⇒ 记", r.record === true && r.entry.from === "/products/ak16/" && r.entry.to === "/products/ak16a/", JSON.stringify(r));
  ck("② 日期原样带进条目", r.record && r.entry.at === "2026-09-05");
}
{
  ck("② 新建产品 ⇒ 不记（没有旧地址）", decideRename(null, { model: "AK99" }, "2026-09-05").record === false);
}
{
  const r = decideRename(PUB("AK16"), { model: "AK16" }, "2026-09-05");
  ck("② 型号没变 ⇒ 不记", r.record === false);
}
{
  // 🔴 反向自证：只是**写法**变了、算出来是同一个地址 ⇒ 不是改名，⛔ 不许记一条自指的 301。
  ck("② 只有大小写不同 ⇒ 不记（地址相同）", decideRename(PUB("AK16"), { model: "ak16" }, "2026-09-05").record === false);
  ck("② AK16/D 与 AK16-D 是同一个地址 ⇒ 不记", decideRename(PUB("AK16/D"), { model: "AK16-D" }, "2026-09-05").record === false);
}
{
  const r = decideRename({ model: "AK16", status: "draft" }, { model: "AK16A" }, "2026-09-05");
  ck("② 🔴 改名前是草稿 ⇒ 不记（那个地址从来没构建过）", r.record === false);
  ck("② 草稿情形要**说出来**，⛔ 不静默跳过", typeof r.note === "string" && r.note.includes("/products/ak16/"));
}
{
  ck("② 新型号算不出地址 ⇒ 不记", decideRename(PUB("AK16"), { model: "AK 16" }, "2026-09-05").record === false);
  ck("② 日期格式不对 ⇒ 不记（宁可不记，也不往只追加的历史里写坏日期）",
    decideRename(PUB("AK16"), { model: "AK16A" }, "2026/09/05").record === false);
}

// ══════ ③ 🔴 拿真实发生过的三次改名当对照物 ══════
//
// 这三条是官网窗**手工**补进台账的（我这边独立复核过 commit）。
// ⇒ 我的函数必须**算出一模一样的 from/to**。⛔ 不用我自己编的例子——
//    编的例子只能证明代码自洽，证不了它与那份历史一致。
{
  const HIST = [
    ["AK23", "AK23A", "/products/ak23/", "/products/ak23a/"],
    ["AK16", "AK16A", "/products/ak16/", "/products/ak16a/"],
    ["AK16D", "AK16D-CO", "/products/ak16d/", "/products/ak16d-co/"],
  ];
  for (const [oldM, newM, from, to] of HIST) {
    const r = decideRename(PUB(oldM), { model: newM }, "2026-09-05");
    ck(`③ 真实改名 ${oldM}→${newM} 复现出台账里那一条`,
      r.record === true && r.entry.from === from && r.entry.to === to, JSON.stringify(r));
  }
}

// ══════ ④ 追加：空数组 ══════
{
  const out2 = appendRoute(EMPTY, { from: "/products/a/", to: "/products/b/", at: "2026-09-05" });
  const doc = JSON.parse(out2);
  ck("④ 空 routes ⇒ 加进去一条", doc.routes.length === 1 && doc.routes[0].to === "/products/b/");
  ck("④ 每条仍占一行（与仓里格式一致）", /\n    \{ "from": .+ \}\n/.test(out2), JSON.stringify(out2));
  ck("④ $comment 原样", JSON.stringify(doc.$comment) === JSON.stringify(["说明"]));
  ck("④ 末尾有换行", out2.endsWith("}\n"));
}

// ══════ ⑤ 🔴 追加：已有条目一个字节都不许动 ══════
{
  const entry = { from: "/products/ak28/", to: "/products/ak28a/", at: "2026-09-05" };
  const out2 = appendRoute(REAL, entry);

  // 判据一：原文里**每一条已有 route 的整行**，在新文本里逐字节仍在。
  const oldLines = REAL.split("\n").filter((l) => l.trim().startsWith('{ "from"'));
  ck("⑤ 原文确实有 4 条已有记录（材料有效性）", oldLines.length === 4, String(oldLines.length));
  const kept = oldLines.filter((l) => out2.includes(l.replace(/,$/, "")));
  ck("⑤ 🔴 4 条已有记录逐字节仍在", kept.length === 4, `只剩 ${kept.length} 条`);

  // 判据二：**改动只有一处**——新文本比原文多且只多一行，且那一行就是新记录。
  const a = REAL.split("\n"), b = out2.split("\n");
  const added = b.filter((l) => !a.includes(l));
  const lost = a.filter((l) => !b.includes(l));
  // ⚠️ 允许的变化**只有两种**，其它一律算破坏：
  //    ① 新加的那一行；② 原来的**末条**补上一个逗号（JSON 里躲不掉）。
  //    ⛔ 不能只写 `added.length <= 2` —— 那会放过"两行都被改坏"。逐条说出它是哪一种。
  const isNew = (l) => l.includes('"/products/ak28a/"') && l.includes('"2026-09-05"');
  const isOldPlusComma = (l) => l.endsWith(",") && a.includes(l.slice(0, -1));
  ck("⑤ 🔴 新增的行只有「那一条新记录」和「旧末条补逗号」两种",
    added.length === 2 && added.filter(isNew).length === 1 && added.filter(isOldPlusComma).length === 1,
    JSON.stringify(added));
  ck("⑤ 🔴 消失的行只有「旧末条（补逗号前的样子）」那一行",
    lost.length === 1 && added.some((l) => l === lost[0] + ","), JSON.stringify(lost));

  // 判据三：语义上也对。
  const doc = JSON.parse(out2), was = JSON.parse(REAL);
  ck("⑤ 条数 4 → 5", doc.routes.length === 5);
  ck("⑤ 前 4 条深比不变", JSON.stringify(doc.routes.slice(0, 4)) === JSON.stringify(was.routes));
  ck("⑤ $comment 不变", JSON.stringify(doc.$comment) === JSON.stringify(was.$comment));
}

// ══════ ⑥ 拒绝与幂等 ══════
{
  const dup = { from: "/products/ak16/", to: "/products/ak16a/", at: "2026-09-05" };
  ck("⑥ 已经在里面的条目 ⇒ 原样返回原文（重试是安全的）", appendRoute(REAL, dup) === REAL);
  // ⚠️ 反向自证：换个日期仍算同一条历史 —— ⛔ 不许因为 at 不同就再加一条。
  ck("⑥ 同一条改名换个日期 ⇒ 仍不重复加",
    appendRoute(REAL, { ...dup, at: "2026-01-01" }) === REAL);
}
{
  ck("⑥ from === to ⇒ 抛", threw(() => appendRoute(REAL, { from: "/products/x/", to: "/products/x/", at: "2026-09-05" })));
  ck("⑥ 台账不是合法 JSON ⇒ 抛（⛔ 不在看不懂的东西上追加）",
    threw(() => appendRoute("{ 坏", { from: "/products/a/", to: "/products/b/", at: "2026-09-05" })));
  ck("⑥ 没有 routes 数组 ⇒ 抛（⛔ 不顺手建一个：读不到 ≠ 本来就空）",
    threw(() => appendRoute('{ "$comment": [] }\n', { from: "/products/a/", to: "/products/b/", at: "2026-09-05" })));
  ck("⑥ routes 不是数组 ⇒ 抛",
    threw(() => appendRoute('{ "routes": {} }\n', { from: "/products/a/", to: "/products/b/", at: "2026-09-05" })));
}
{
  // 🔴 反向自证：`"routes"` 这四个字**先出现在 $comment 里**时，定位不能被它骗走。
  //    仓里那份的说明文字里就写着 routes 相关的话 ⇒ 这不是假想的输入。
  const tricky = `{
  "$comment": ["格式：往 \\"routes\\" 里追加 [ 这种括号也照写 ]"],
  "routes": [
    { "from": "/products/a/", "to": "/products/b/", "at": "2026-01-01" }
  ]
}
`;
  const out2 = appendRoute(tricky, { from: "/products/c/", to: "/products/d/", at: "2026-09-05" });
  const doc = JSON.parse(out2);
  ck("⑥ 🔴 $comment 里出现 routes / 括号也不影响定位", doc.routes.length === 2 && doc.routes[1].to === "/products/d/", out2);
  ck("⑥ 说明文字原样", doc.$comment[0].includes("追加"));
}

// ══════ ⑦ 常量 ══════
ck("⑦ 台账路径与官网 build-redirects.mjs 读的是同一份", RENAMES_PATH === "src/data/model-renames.json");

console.log(out.join("\n"));
console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
