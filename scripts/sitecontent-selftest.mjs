const SRC = new URL("../src/", import.meta.url).href;   // ⚠️ 绝不写绝对路径：CI 是 Linux
// 站点内容契约自检。
//
// 这份校验器是"后台改站点文案"这条路上**唯一**的闸：它坏了没有任何症状 ——
// 直到一个空的 title、一个畸形号码、或两个重复 title 进了官网仓
// （最后一个会让官网构建**直接失败**，也就是那次改动根本上不了线）。
//
// 🔴 每条规则都成对测：**该拒的拒**（反向自证）+ **该放的放**（正对照）。
//    只测"坏数据被拒"的话，一个"什么都拒"的校验器也全绿。
const { validateSiteContent, mergeSiteContent, serializeSiteContent, changedFields, SEO_LIMITS, CERT_SLOTS } =
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
  // ⚠️ 这一条**改过**（2026-09-05）：原来断言的是「不传基线也拒未知页面」，
  //    而规则已换成「后台动了才判」⇒ 不传基线（GET 那种"只是显示一份体检报告"的用法）不下结论。
  //    ⛔ 留着旧断言就是留一条测已废行为的检查 —— 它会在下一次改动时把人指向错的方向。
  //    真正的判据搬到 ⑥c 那一组（新增/改动 ⇒ 拒；原样带过 ⇒ 放行）。
  const c = GOOD(); c.seo.pages.about = { title: "About", description: "x" };
  ck("⑥ 不传基线（GET 的用法）⇒ 不报 unknown_page", !has(validateSiteContent(c), "unknown_page"));
}
{
  // 但**说明必须仍然到位**：后台真去新增一页时，错误里要说清"改了不会有效果"
  const base = GOOD(); const c = GOOD(); c.seo.pages.about = { title: "About", description: "x" };
  const r = validateSiteContent(c, base);
  ck("⑥ 后台新增未知页面时，理由要说清后台不会渲染它",
    r.errors.some((e) => e.code === "unknown_page" && /不会渲染|不该悄悄/.test(e.message)),
    JSON.stringify(r.errors.map((e) => e.message)));
}
// ── ⑥b 未知顶层节：判据是「**后台动没动它**」，不是「它存不存在」（2026-09-05 改）──
//
// 🔴 这条判据被改过一次，起因是它自己造成的一次生产故障：官网仓陆续多了
//    homeV4 / productsV1 / solutionsV3 / contactV1 四个块（官网自己在读），
//    而旧判据「文件里有后台不认识的块就拒」⇒ **后台每一次保存都 422**，改个邮箱都存不进去，
//    而且错误说的是"未知的顶层字段"，看起来像数据坏了。
// ⇒ 现在：原样带过放行；新增或改动 ⇒ 拒。下面把**两个方向**都钉住。
{
  const base = GOOD(); base.footer = { text: "官网仓自己加的块" };
  const same = JSON.parse(JSON.stringify(base));
  const r = validateSiteContent(same, base);
  ck("⑥b 🔴 未知顶层节**原样带过** ⇒ 放行（生产上那四个块就是这个情形）", r.ok, JSON.stringify(r.errors));
}
{
  const base = GOOD();
  const c = GOOD(); c.footer = { text: "后台自己加的" };
  ck("⑥b 反向：后台**新增**一个不认识的顶层节 ⇒ 拒", has(validateSiteContent(c, base), "unknown_section"));
}
{
  const base = GOOD(); base.footer = { text: "原值" };
  const c = JSON.parse(JSON.stringify(base)); c.footer.text = "被后台改了";
  ck("⑥b 反向：后台**改动**一个不认识的顶层节 ⇒ 拒", has(validateSiteContent(c, base), "unknown_section"));
}
{
  // GET 只是显示一份体检报告，没有"改动"这回事 ⇒ 不传基线时不该报这个错
  const c = GOOD(); c.footer = { text: "x" };
  ck("⑥b 不传基线（GET 的用法）⇒ 不报 unknown_section", !has(validateSiteContent(c), "unknown_section"));
}
{
  // 🔴 反向自证：放宽的**只有**未知顶层节这一条 —— 已知字段照旧严校验。
  //    ⛔ 少了这条，"传了基线就一路放行"这种改坏法会全绿。
  const base = GOOD(); base.footer = { text: "x" };
  const c = JSON.parse(JSON.stringify(base)); c.contact.email = "不是邮箱";
  ck("⑥b 🔴 反向自证：带了基线也不放过已知字段的错（email 仍被拒）",
    has(validateSiteContent(c, base), "email_shape"));
}
{
  const c = GOOD(); c.home.valueProps[0].icon = "star";
  ck("⑥ valueProps 里的未知字段 ⇒ 拒", has(validateSiteContent(c), "unknown_field"));
}
// ── ⑥c `seo.pages` 里的未知页面：同一条「动了才判」（2026-09-05，同族第三次）──
//
// 🔴 前两次改的是顶层那道闸，而 `seo.pages` 里**还有第二道白名单**（SEO_PAGES 那张表）。
//    官网仓往 seo.pages 加一页（about）⇒ 后台每一次保存都被 unknown_page 拦掉。
//    ⚠️ "把外层放宽了" ≠ "里面每一道都放宽了" —— 每一道白名单都要单独过一遍。
{
  const base = GOOD(); base.seo.pages.about = { title: "About | AirSonde", description: "d" };
  const same = JSON.parse(JSON.stringify(base));
  const r = validateSiteContent(same, base);
  ck("⑥c 🔴 官网仓加的页面**原样带过** ⇒ 放行（否则后台一次都存不了）", r.ok, JSON.stringify(r.errors));
}
{
  const base = GOOD();
  const c = GOOD(); c.seo.pages.about = { title: "后台自己加的", description: "d" };
  ck("⑥c 反向：后台**新增**一个它不认识的页面 ⇒ 拒", has(validateSiteContent(c, base), "unknown_page"));
}
{
  const base = GOOD(); base.seo.pages.about = { title: "原值", description: "d" };
  const c = JSON.parse(JSON.stringify(base)); c.seo.pages.about.title = "被后台改了";
  ck("⑥c 反向：后台**改动**它不认识的页面 ⇒ 拒", has(validateSiteContent(c, base), "unknown_page"));
}
{
  // 🔴 反向自证：放宽的只有"未知页面"这一条 —— **已知四页照旧严校验**
  //    ⛔ 少了这条，"传了基线就一路放行"这种改坏法会全绿。
  const base = GOOD(); base.seo.pages.about = { title: "x", description: "d" };
  const c = JSON.parse(JSON.stringify(base)); c.seo.pages.home.title = "   ";
  ck("⑥c 🔴 反向自证：已知页面的空 title 仍被拒", has(validateSiteContent(c, base), "required"));
}
{
  // ⚠️ 另一向仍是硬错误：SEO_PAGES 里有、JSON 里没有 ⇒ required。
  //    这条决定了加新页面的**顺序**：官网仓先落键、后台再进表，⛔ 反过来会 422。
  const base = GOOD(); const c = GOOD(); delete c.seo.pages.contact;
  ck("⑥c 已知页面在 JSON 里缺失 ⇒ 仍拒（搜索结果里会是一行空白）",
    has(validateSiteContent(c, base), "required"));
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

// ══════ ⑪ homeV4.products.featured —— 首页 v4 的产品位（2026-09-05 起的真源）══════
//
// ⚠️ 与旧的 `home.featuredSlugs` **形状不同**，⛔ 不是"数组换了个名字"：
//    旧 `["slug", …]`　新 `[{slug, tagline, chips[]}, …]`。
const V4 = (items) => { const c = GOOD(); c.homeV4 = { products: { featured: items } }; return c; };
const OKITEM = { slug: "ak35", tagline: "18-in-1 desktop", chips: ["CO₂", "PM2.5"] };
{
  const c = V4([OKITEM, { slug: "ak36", tagline: "x", chips: [] }]);
  const r = validateSiteContent(c, c);   // 正对照：合法的一份必须放行
  ck("⑪ 正对照：合法的 featured ⇒ 放行", r.ok, JSON.stringify(r.errors));
}
{
  const c = V4(["ak35"]);   // 旧形状塞进新字段
  ck("⑪ 条目是裸字符串（旧形状）⇒ 拒", has(validateSiteContent(c, c), "type"));
}
{
  const c = V4([{ slug: "", tagline: "x", chips: [] }]);
  ck("⑪ 没选产品（slug 空）⇒ 拒 —— 首页会拿不到图和型号", has(validateSiteContent(c, c), "required"));
}
{
  const c = V4([OKITEM, { ...OKITEM }]);
  ck("⑪ 🔴 同一个产品出现两次 ⇒ 拒（看起来像「少了一个」，人会去找丢掉的那个）",
    has(validateSiteContent(c, c), "duplicate"));
}
{
  const c = V4([{ slug: "ak35", tagline: "", chips: [] }]);
  const r = validateSiteContent(c, c);
  ck("⑪ tagline 空 ⇒ **警告不是错误**（首页渲染得出来，只是少一行字）",
    r.ok && r.warnings.some((w) => w.code === "empty"), `ok=${r.ok} ${JSON.stringify(r.warnings.map((w) => w.code))}`);
}
{
  const c = V4([{ slug: "ak35", tagline: "x", chips: ["CO₂", ""] }]);
  ck("⑪ chips 里有空串 ⇒ 拒（首页会渲染一个空标签）", has(validateSiteContent(c, c), "type"));
}
{
  const c = V4([{ ...OKITEM, icon: "star" }]);
  ck("⑪ 条目里的未知字段 ⇒ 拒（官网不读它 ⇒ 填了没反应）", has(validateSiteContent(c, c), "unknown_field"));
}
{
  // 🔴 迁移的关键一条：旧字段**还在文件里**（本轮不清理），它不能因此把保存挡住。
  const c = V4([OKITEM]); c.home.featuredSlugs = ["ak35", "ak36"];
  ck("⑪ 🔴 旧字段 home.featuredSlugs 仍在 ⇒ 照旧合法（本轮不做数据清理）",
    validateSiteContent(c, c).ok, JSON.stringify(validateSiteContent(c, c).errors));
}
{
  // ⚠️ 反向：新字段整个不存在也合法 —— 官网仓那份可能还没落 homeV4
  const c = GOOD();
  ck("⑪ 反向：没有 homeV4 也合法（不是必填）", validateSiteContent(c, c).ok);
}

// ══════ ⑬ homeV4.hero / homeV4.why.cards —— 后台 2026-09-05 起真正在写的两块 ══════
//
// 🔴 背景：后台原来编 `home.hero` / `home.valueProps`，而官网 v4 渲染 `homeV4.*`
//    （实测：`HOME_V4` 25 处消费方，`HOME`/`VALUE_PROPS` 各 0 处）⇒ 后台一直接在死开关上。
const HERO_OK = { eyebrow: "e", headline: "h", headlineEm: "em", primaryCta: "p", secondaryCta: "s" };
const CARD_OK = { icon: "factory", fig: "Since 2015", title: "t", body: "b" };
const V4HW = (hero, cards) => { const c = GOOD(); c.homeV4 = { hero, why: { cards } }; return c; };
{
  const c = V4HW(HERO_OK, [CARD_OK]);
  ck("⑬ 正对照：合法的 hero + why.cards ⇒ 放行", validateSiteContent(c, c).ok,
    JSON.stringify(validateSiteContent(c, c).errors));
}
{
  const { headlineEm, ...noEm } = HERO_OK;
  const c = V4HW(noEm, [CARD_OK]);
  ck("⑬ hero 缺 headlineEm ⇒ 拒（官网 H1 的后半句会空掉，而构建不会失败）",
    has(validateSiteContent(c, c), "required"));
}
{
  // 🔴 旧字段名塞进新块：官网不读它 ⇒ 改了永远没反应。这正是这一整单要消灭的形状。
  const c = V4HW({ ...HERO_OK, body: "副文案" }, [CARD_OK]);
  ck("⑬ 🔴 hero 里出现 v4 不渲染的 body ⇒ 拒（填了不会有任何效果）",
    has(validateSiteContent(c, c), "unknown_field"));
}
{
  // 🔴🔴 最要紧的一条：官网是 `ICONS[c.icon] ?? ICONS.doc` —— 认不出**静默变 doc**。
  //    这道闸是唯一会说话的地方。
  const c = V4HW(HERO_OK, [{ ...CARD_OK, icon: "rocket" }]);
  ck("⑬ 🔴 icon 不在官网闭集里 ⇒ 拒（官网会静默显示成 doc，没有任何报错）",
    has(validateSiteContent(c, c), "unknown_icon"));
}
{
  // ⚠️ 反向自证：闭集里的每一个都必须放行 —— ⛔ 否则"一律拒"也能让上面那条全绿
  const bad = ["factory", "chat", "doc", "star", "send", "reply", "box"].filter((k) => {
    const c = V4HW(HERO_OK, [{ ...CARD_OK, icon: k }]);
    return !validateSiteContent(c, c).ok;
  });
  ck("⑬ 🔴 反向自证：闭集里那七个图标**逐个**都放行", bad.length === 0, "被拒的：" + bad.join(","));
}
{
  const c = V4HW(HERO_OK, []);
  ck("⑬ why.cards 空数组 ⇒ 拒（官网那段只剩标题、下面空一片）", has(validateSiteContent(c, c), "empty"));
}
{
  const c = V4HW(HERO_OK, [{ ...CARD_OK, subtitle: "x" }]);
  ck("⑬ 卡里的未知键 ⇒ 拒（官网不读它）", has(validateSiteContent(c, c), "unknown_field"));
}
{
  const c = V4HW(HERO_OK, [{ icon: "doc", fig: "", title: "t", body: "b" }]);
  ck("⑬ fig 是空串 ⇒ 拒（卡片顶部那个大字会空着）", has(validateSiteContent(c, c), "empty"));
}
{
  // 🔴 迁移的关键一条：旧 `home` 块**还在文件里**（本轮只解绑不删），不能因此把保存挡住。
  const c = V4HW(HERO_OK, [CARD_OK]);
  ck("⑬ 🔴 旧 home.hero / home.valueProps 仍在 ⇒ 照旧合法（只解绑不删数据）",
    validateSiteContent(c, c).ok && !!c.home.hero && !!c.home.valueProps);
}

// ══════ ⑭ 这一批新暴露的 homeV4 键 —— 只对**会静默失效**的两处加了闸 ══════
{
  const c = GOOD(); c.homeV4 = { programme: { steps: [{ icon: "send", when: "Day 0", title: "t", body: "b" }] } };
  ck("⑭ 正对照：programme.steps 图标在闭集里 ⇒ 放行", validateSiteContent(c, c).ok,
    JSON.stringify(validateSiteContent(c, c).errors));
}
{
  const c = GOOD(); c.homeV4 = { programme: { steps: [{ icon: "rocket", when: "x", title: "t", body: "b" }] } };
  ck("⑭ 🔴 programme.steps 的图标不在闭集 ⇒ 拒（官网会静默变 doc）",
    has(validateSiteContent(c, c), "unknown_icon"));
}
{
  const c = GOOD(); c.homeV4 = { cta: { items: ["Your market", ""] } };
  ck("⑭ cta.items 有空条目 ⇒ 拒（官网会渲染出一行空白）", has(validateSiteContent(c, c), "empty"));
}
{
  const c = GOOD(); c.homeV4 = { cta: { items: ["a", "b"] } };
  ck("⑭ 正对照：cta.items 都非空 ⇒ 放行", validateSiteContent(c, c).ok);
}
{
  // 🔴 反向自证：这一批**纯文字**字段有意不加校验 —— 随便填也不该被拦。
  //    ⛔ 少了这条，"顺手给每个文本框加个必填"会悄悄溜进来并在 Web 调结构时挡住保存。
  const c = GOOD();
  c.homeV4 = { solutions: { kicker: "", heading: "x", lines: { home: "" } },
               factory: { kicker: "", floor: { assembly: "" } },
               guides: { read: "" } };
  ck("⑭ 🔴 反向自证：新暴露的纯文字字段不加校验（空着也放行）", validateSiteContent(c, c).ok,
    JSON.stringify(validateSiteContent(c, c).errors));
}

// ══════ ⑫ certificates —— About 页四张认证卡指向的文件 ══════
const CT = (certs) => { const c = GOOD(); c.certificates = certs; return c; };
const FULL = { ce: "/certificates/ce.pdf", fcc: null, rohs: null, "un38-3": null };
{
  const c = CT(FULL);
  ck("⑫ 正对照：一个槽有文件、其余是 null ⇒ 放行", validateSiteContent(c, c).ok,
    JSON.stringify(validateSiteContent(c, c).errors));
}
{
  const c = CT({ ce: null, fcc: null, rohs: null, "un38-3": null });
  ck("⑫ 正对照：四个槽全空 ⇒ 放行（官网四条链接都不渲染）", validateSiteContent(c, c).ok);
}
{
  const c = CT({ ...FULL, ce: "certificates/ce.pdf" });   // 少了头斜杠
  ck("⑫ 🔴 少一个头斜杠 ⇒ 拒（页面上点开是 404，而页面本身看不出异常）",
    has(validateSiteContent(c, c), "cert_path"));
}
{
  const c = CT({ ...FULL, ce: "/certificates/ce.exe" });
  ck("⑫ 不许的扩展名 ⇒ 拒", has(validateSiteContent(c, c), "cert_path"));
}
{
  // 🔴 这一条防的是最坏的一种"数据合法、页面正常、内容是错的"：
  //    CE 那张卡点开是 FCC 的证书。
  const c = CT({ ...FULL, ce: "/certificates/fcc.pdf" });
  ck("⑫ 🔴 槽名与文件名对不上 ⇒ 拒（CE 卡点开会是别人的证书）",
    has(validateSiteContent(c, c), "cert_slot_mismatch"));
}
{
  // 🔴 Web 窗 2026-09-05 把**契约文本写进 `certificates._readme`**（同顶层 `_readme` 的用法）。
  //    它必须放行 —— 拦下它的话，那一支合 main 的当天，后台的**每一次站点内容保存**又会 422，
  //    正是我今天上午刚修掉的那个生产故障换个位置重演。
  // ⚠️ 与顶层 `_readme` 是**同一条规则**，⛔ 不是给证书开的特例：
  //    `_readme` 是给人看的说明，不是站上的数据。
  const c = CT({ _readme: ["值 = 带头斜杠的 URL 路径；换扩展名时旧文件同 commit 删掉"], ...FULL });
  const r = validateSiteContent(c, c);
  ck("⑫ 🔴 certificates._readme 放行（Web 窗把契约文本写在这里）", r.ok, JSON.stringify(r.errors));
}
{
  const c = CT({ ...FULL, iso9001: "/certificates/iso9001.pdf" });
  ck("⑫ 不存在的槽 ⇒ 拒（官网不读它 ⇒ 传了不会有任何效果）",
    has(validateSiteContent(c, c), "unknown_field"));
}
{
  const c = CT(["/certificates/ce.pdf"]);
  ck("⑫ certificates 是数组 ⇒ 拒", has(validateSiteContent(c, c), "type"));
}
{
  // ⚠️ 反向：整个块不存在也合法 —— 官网仓那份现在就还没有它
  const c = GOOD();
  ck("⑫ 反向：没有 certificates 块也合法（不是必填）", validateSiteContent(c, c).ok);
}
{
  // 🔴 四个槽名是**唯一定义**，⛔ 别在别处抄第二份 —— 这条把它钉住
  ck("⑫ 槽名就是这四个（真源 CERT_SLOTS）", CERT_SLOTS.join(",") === "ce,fcc,rohs,un38-3", CERT_SLOTS.join(","));
}

console.log(out.join("\n"));
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
