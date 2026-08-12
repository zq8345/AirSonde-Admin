// 写入路径的顺序验收（8 条）。前提同 dryrun-e2e.mjs：.dev.vars 指向 fixtures + 另一终端跑着 `npm run dev`。
//
// 🔴 它验的不是"写成功了"，而是**没写成的原因对不对**：
//    坏数据 422（还没碰出站口）；合法数据 403 且理由是"本地开发禁止"（走到出站口才被拦）。
//    两者都没写成，但原因不同 —— 如果坏数据也回 403，说明校验根本没跑，
//    是被出站口顺手挡下的，那校验闸就从来没有被验证过。
//
// ⚠️ 第 ⓪ 条先证明写闸这次确实开着：闸没开的话，下面所有"被拒"都可以由"闸没开"解释，什么都证明不了。
// 验「校验拦在写之前」的**顺序**，以及本地那道闸在写闸开着时仍然生效。
//
// ⭐ 判别式：坏数据与好数据走到**不同的深度**，返回码不同 ——
//    坏数据 422（还没碰出站口）；好数据 403 且错误里带"本地开发禁止"（走到了出站口才被拦）。
//    两者都"没写成"，但**没写成的原因不同**，而那正是要证明的东西。
//    如果坏数据也回 403，说明校验根本没跑，是被出站口顺手挡下的 —— 那闸就没有被验证过。
const B = "http://localhost:8788";
let pass = 0, fail = 0; const out = [];
const ck = (n, c, d = "") => { if (c) { pass++; out.push(`✅ ${n}\n     ${d}`); } else { fail++; out.push(`🔴 ${n}\n     ${d}`); } };

const put = async (slug, body) => {
  const r = await fetch(`${B}/api/products/${slug}`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ patch: body }),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

const t0 = Date.now(); let who = null;
while (Date.now() - t0 < 90000) {
  try { const r = await fetch(`${B}/api/_whoami`); if (r.ok) { who = await r.json(); break; } } catch {}
  await new Promise(r => setTimeout(r, 800));
}
if (!who) { console.log("🔴 dev 起不来"); process.exit(2); }
console.log(`进程身份：repo=${who.data.repo} dir=${who.data.productsDir} gateOpen=${who.data.writeGateOpen} writeEnabled=${who.data.writeEnabled} token=${who.data.ghTokenConfigured}\n`);

// ⓪ 先证明写闸这次确实是**开着**的 —— 否则下面的"被拒"全都可以由"闸没开"解释，什么都证明不了
ck("⓪ 本次写闸确实开着（否则下面的被拒说明不了任何事）", who.data.writeGateOpen === true, `writeGateOpen=${who.data.writeGateOpen}`);

const GOOD = {
  slug: "fixture-desktop-16in1", name: "16-in-1 Desktop Air Quality Monitor", model: "AS-D16",
  category: "desktop", sensors: ["CO2", "PM2.5"], images: { main: "products/x.webp" }, status: "published",
};

// ① 坏数据：契约违规 —— 必须 422，且**根本没走到出站口**
{
  const r = await put("fixture-desktop-16in1", { ...GOOD, specs: { src: "https://www.alibaba.com/x" } });
  const codes = (r.body?.validation?.errors || []).map(e => e.code);
  ck("① specs 里塞 alibaba 链接 → 422 且明说没产生 commit",
    r.status === 422 && r.body?.wrote === false && codes.includes("supplier_leak"),
    `status=${r.status} wrote=${r.body?.wrote} codes=${JSON.stringify(codes)} reason=${r.body?.reason}`);
  ck("① 判别式：错误来自**校验**而不是出站口（不含「本地开发禁止」）",
    !JSON.stringify(r.body).includes("本地开发禁止"),
    `body 里${JSON.stringify(r.body).includes("本地开发禁止") ? "含" : "不含"}出站口的话`);
}

// ② 枚举违规
{
  const r = await put("fixture-desktop-16in1", { ...GOOD, category: "handheld" });
  ck("② category 枚举外 → 422，未产生 commit", r.status === 422 && r.body?.wrote === false,
    `status=${r.status} wrote=${r.body?.wrote}`);
}

// ③ 必填缺失
{
  const bad = { ...GOOD }; delete bad.model;
  const r = await put("fixture-desktop-16in1", { ...bad, model: null });
  ck("③ 必填 model 被显式清空 → 422，未产生 commit", r.status === 422 && r.body?.wrote === false,
    `status=${r.status} codes=${JSON.stringify((r.body?.validation?.errors||[]).map(e=>e.code))}`);
}

// ④ 好数据：校验通过 ⇒ 走到出站口 ⇒ **本地那道闸必须拦住**（写闸开着也拦）
{
  const r = await put("fixture-desktop-16in1", { ...GOOD, name: "Renamed For Local Test" });
  const s = JSON.stringify(r.body);
  ck("④ 合法数据在本地必须被**出站口**拦下（403，且理由是本地开发禁止）",
    r.status === 403 && s.includes("本地开发禁止"),
    `status=${r.status} detail=${(r.body?.detail || "").slice(0, 80)}`);
  ck("④ 关键：写闸开着，本地这道闸**仍然**生效 —— 两道闸互不为前提",
    who.data.writeGateOpen === true && r.status === 403, `gateOpen=${who.data.writeGateOpen} status=${r.status}`);
}

// ⑤ 内容没变 → 不提交（不产生空 commit）
{
  const cur = await (await fetch(`${B}/api/products/fixture-desktop-16in1`)).json();
  const r = await put("fixture-desktop-16in1", cur.product);
  ck("⑤ 内容逐字节相同 → 不写，明说原因（避免堆一串空 commit 反复触发官网重建）",
    r.body?.wrote === false && r.body?.change?.identical === true,
    `wrote=${r.body?.wrote} reason=${r.body?.reason}`);
}

console.log(out.join("\n"));
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);


