const SRC = new URL("../src/", import.meta.url).href;   // ⚠️ 绝不写绝对路径：CI 是 Linux
// 站点内容契约自检。
//
// 这份校验器是"后台改站点文案"这条路上**唯一**的闸：它坏了没有任何症状 ——
// 直到一个空的 title、一个畸形号码、或两个重复 title 进了官网仓
// （最后一个会让官网构建**直接失败**，也就是那次改动根本上不了线）。
//
// 🔴 每条规则都成对测：**该拒的拒**（反向自证）+ **该放的放**（正对照）。
//    只测"坏数据被拒"的话，一个"什么都拒"的校验器也全绿。
const { validateSiteContent, mergeSiteContent, serializeSiteContent, changedFields, SEO_LIMITS } =
  await import(SRC + "sitecontent.ts");

let pass = 0, fail = 0; const out = [];
const ck = (n, c, d = "") => { if (c) { pass++; out.push(`✅ ${n}`); } else { fail++; out.push(`🔴 ${n}\n     ${d}`); } };
const codes = (r) => r.errors.map((e) => e.code);
const has = (r, code) => r.errors.some((e) => e.code === code);

/** 一份**合法**的内容 —— 直接照官网仓真实文件的形状写，不是我编的。 */
const GOOD = () => ({
  _readme: ["说明行"],
  seo: {
    defaultTitle: "AirSonde — OEM / ODM Indoor Air Quality Monitors",
    defaultDescription: "AirSonde manufactures white-label indoor air quality monitors.",
    organisationDescription: "AirSonde is an OEM and ODM manufacturer of indoor air quality monitors.",
    pages: {
      home: { title: "AirSonde — OEM / ODM Indoor Air Quality Monitors", description: "" },
      products: { title: "Products | AirSonde", description: "Desktop and portable monitors." },
      contact: { title: "Contact | AirSonde", description: "Start an OEM programme." },
      notFound: { title: "Page not found — AirSonde", description: "That page does not exist." },
    },
  },
  contact: {
    email: "sales@airsonde.com",
    phone: "+86 186 8116 0111",
    wechatId: "18681160111",
    address: "No. 62, Baotian 1st Road, Shenzhen, China",
    hours: "Mon–Fri 9:00–18:00 (GMT+8)",
    response: "Within 1 business day",
  },
  home: {
    hero: { eyebrow: "Independent manufacturer", headline: "Built for Your Brand",
            body: "Shipped under your name.", primaryCtaLabel: "Request a quote", secondaryCtaLabel: "Browse products" },
    sections: { capabilitiesIntro: "Every unit is specified with you up front." },
    valueProps: [{ title: "White-label ready", body: "Your brand on the housing." }],
    contactBlock: { title: "Tell us what you want", body: "Send the market and volumes." },
  },
});

// ══════ ① 正对照：真实形状必须通过（否则下面所有"拒绝"都没有意义）══════
{
  const r = validateSiteContent(GOOD());
  ck("① 关键正对照：官网真实内容的形状必须通过", r.ok, JSON.stringify(r.errors));
  ck("① 且不产生莫名其妙的警告", r.warnings.length === 0, JSON.stringify(r.warnings));
}

// ══════ ② 重复 title ⇒ 硬错误（官网 dist 闸会因此构建失败）══════
{
  const c = GOOD();
  c.seo.pages.contact.title = c.seo.pages.products.title;
  const r = validateSiteContent(c);
  ck("② 🔴 两页 title 相同必须拒（官网构建会红）", has(r, "duplicate_title"), JSON.stringify(codes(r)));
  ck("② 且说得出是跟哪一页撞了", r.errors.some((e) => /\/products\//.test(e.message)), JSON.stringify(r.errors.map((e) => e.message)));
}
{
  // 正对照：大小写不同但实质相同也要抓（官网数唯一 title 时不会替我做归一化，
  // 但两个只差大小写的 title 对搜索引擎与人来说就是重复，属于该拦的）
  const c = GOOD();
  c.seo.pages.contact.title = "PRODUCTS | AIRSONDE";
  ck("② 只差大小写也算重复", has(validateSiteContent(c), "duplicate_title"));
}

// ══════ ③ 空值：空字符串**不算填了** ══════
{
  const c = GOOD(); c.seo.pages.home.title = "   ";
  ck("③ title 只有空格 ⇒ 拒（会渲染成空标题）", has(validateSiteContent(c), "required"), JSON.stringify(codes(validateSiteContent(c))));
}
{
  const c = GOOD(); c.contact.address = "";
  ck("③ 必填项空字符串 ⇒ 拒", has(validateSiteContent(c), "empty"));
}
{
  // 正对照：description 允许是空字符串（= 用站点默认描述），**不能**跟着一起拒
  const c = GOOD(); c.seo.pages.products.description = "";
  ck("③ 关键：description 空字符串是合法的（表示用默认描述），不许误拒", validateSiteContent(c).ok,
    JSON.stringify(validateSiteContent(c).errors));
}

// ══════ ④ 联系方式 = 链接的来源，畸形值是死链接不是"难看" ══════
{
  const c = GOOD(); c.contact.email = "sales.airsonde.com";
  const r = validateSiteContent(c);
  ck("④ 缺 @ 的邮箱 ⇒ 拒", has(r, "email_shape"), JSON.stringify(codes(r)));
  ck("④ 且解释清楚后果是 mailto 死链", r.errors.some((e) => /mailto/.test(e.message)));
}
{
  const c = GOOD(); c.contact.phone = "12345";
  const r = validateSiteContent(c);
  ck("④ 位数不够的号码 ⇒ 拒（wa.me / tel: 都由它拼）", has(r, "phone_digits"), JSON.stringify(codes(r)));
}
{
  const c = GOOD(); c.contact.phone = "186 8116 0111";   // 位数够但没有国家码
  const r = validateSiteContent(c);
  ck("④ 无国家码 ⇒ 只警告不拒（它仍是可用的）", r.ok && r.warnings.some((w) => w.code === "no_country_code"),
    `ok=${r.ok} warns=${JSON.stringify(r.warnings.map((w) => w.code))}`);
}

// ══════ ⑤ 供应商痕迹：任何公开文案里都是硬错误（这里没有 supplierRef 那种豁免）══════
{
  const c = GOOD(); c.home.valueProps[0].body = "See our store at https://shop.1688.com/x";
  ck("⑤ 首页文案里的 1688 链接 ⇒ 拒", has(validateSiteContent(c), "supplier_leak"));
}
{
  const c = GOOD(); c.seo.pages.products.description = "Sourced via en.alibaba listings";
  ck("⑤ meta description 里的 alibaba ⇒ 拒（它会进 <head> 上线）", has(validateSiteContent(c), "supplier_leak"));
}
{
  // 正对照：_readme 里出现这些词不该被拦 —— 它不是站上的文案
  const c = GOOD(); c._readme = ["别把 alibaba.com 链接粘进公开字段"];
  ck("⑤ 关键：_readme 里提到 alibaba.com 不算泄漏（它不上站）", validateSiteContent(c).ok,
    JSON.stringify(validateSiteContent(c).errors));
}

// ══════ ⑥ 未知字段：静默吞掉 = "改了没反应"，最难查 ══════
{
  const c = GOOD(); c.seo.pages.about = { title: "About", description: "x" };
  ck("⑥ 站上没有的页面 ⇒ 拒并说明改了不会有效果", has(validateSiteContent(c), "unknown_page"));
}
{
  const c = GOOD(); c.footer = { text: "x" };
  ck("⑥ 未知顶层节 ⇒ 拒", has(validateSiteContent(c), "unknown_section"));
}
{
  const c = GOOD(); c.home.valueProps[0].icon = "star";
  ck("⑥ valueProps 里的未知字段 ⇒ 拒", has(validateSiteContent(c), "unknown_field"));
}

// ══════ ⑦ 合并：「我没收到」≠「用户要清空」 ══════
{
  const before = GOOD();
  // 只提交 contact 一节（编辑页就是这么干的）
  const merged = mergeSiteContent(before, { contact: { phone: "+86 138 0000 0000" } });
  ck("⑦ 🔴 关键：只提交 contact，seo 与 home 必须原样还在",
    merged.seo?.pages?.products?.title === before.seo.pages.products.title
    && merged.home?.hero?.headline === before.home.hero.headline,
    JSON.stringify({ seo: !!merged.seo, home: !!merged.home }));
  ck("⑦ 同一节里没提交的字段也不许丢", merged.contact.email === before.contact.email, JSON.stringify(merged.contact));
  ck("⑦ 提交了的字段确实改了", merged.contact.phone === "+86 138 0000 0000");
  ck("⑦ _readme 原样保留", JSON.stringify(merged._readme) === JSON.stringify(before._readme));
}
{
  // 数组是整块替换：那才是"这就是现在的全部条目"的意思（删掉一条要能真删掉）
  const merged = mergeSiteContent(GOOD(), { home: { valueProps: [{ title: "A", body: "B" }] } });
  ck("⑦ valueProps 整块替换（删条目要真能删）", merged.home.valueProps.length === 1 && merged.home.valueProps[0].title === "A",
    JSON.stringify(merged.home.valueProps));
}

// ══════ ⑧ 序列化：键序固定，否则每次改一个字都产生整体重排的 diff ══════
{
  const s = serializeSiteContent(GOOD());
  const keys = Object.keys(JSON.parse(s));
  ck("⑧ 顶层键序固定为 _readme/seo/contact/home", JSON.stringify(keys) === '["_readme","seo","contact","home"]', JSON.stringify(keys));
  ck("⑧ 2 空格缩进 + 末尾换行", s.includes('\n  "seo"') && s.endsWith("\n"));
  ck("⑧ 往返不丢内容", JSON.stringify(JSON.parse(s)) === JSON.stringify(GOOD()));
}

// ══════ ⑨ 改动字段清单：commit message 要说得出改了什么 ══════
{
  const a = GOOD(), b = GOOD();
  b.contact.phone = "+86 138 0000 0000";
  b.seo.pages.home.title = "New title";
  const f = changedFields(a, b);
  ck("⑨ 列出全部改动路径", f.includes("contact.phone") && f.includes("seo.pages.home.title"), JSON.stringify(f));
  ck("⑨ 没改的东西不进清单", !f.some((x) => x.startsWith("home.hero")), JSON.stringify(f));
  ck("⑨ 完全没改 ⇒ 空清单", changedFields(a, GOOD()).length === 0, JSON.stringify(changedFields(a, GOOD())));
  ck("⑨ _readme 不算内容改动", changedFields(a, { ...b, _readme: ["变了"] }).every((x) => !x.startsWith("_readme")));
}

// ══════ ⑩ 超长只警告不拒（它不会让构建失败，只是被搜索结果截断）══════
{
  const c = GOOD(); c.seo.pages.home.title = "x".repeat(SEO_LIMITS.title + 5);
  const r = validateSiteContent(c);
  ck("⑩ title 超长 ⇒ 警告，不是错误", r.ok && r.warnings.some((w) => w.code === "too_long"),
    `ok=${r.ok} warns=${JSON.stringify(r.warnings.map((w) => w.code))}`);
}

console.log(out.join("\n"));
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
