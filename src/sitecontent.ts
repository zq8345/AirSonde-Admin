// 站点内容（联系方式 / 首页文案 / 站级 SEO）的契约 —— **纯函数，不碰网络**。
//
// 真源是官网仓的 `src/data/site-content.json`，官网 `src/data/site.ts` 从它读。
// 🔴 后台**只写这一个 JSON**，永远不写 .ts：重写 TS 的出错方式是产出一个
//    语法合法但语义变了的文件，而任何闸都看不出来。
//
// ⚠️ 这个文件里的每条规则都对应一个**已经确认过的耦合**，不是我想象的风险：
//    · 页面 title 必须互不相同 —— 官网自己的 dist 闸就在数
//      （"37 unique title(s) across 37 page(s)"）。这里不拦，就是让官网构建红着上线。
//    · 电话/邮箱是**链接的来源**（site.ts 从它们派生 mailto:/wa.me/tel:）⇒
//      一个畸形的号码不是"文案难看"，是三个死链接。
//    · `_readme` 必须原样保留：它写着"哪些东西有意不放进来"，丢了它，
//      下一个人会以为那些字段是漏了。

export interface Issue { field: string; code: string; message: string }
const err = (field: string, code: string, message: string): Issue => ({ field, code, message });

/** 与产品契约同一份名单 —— 供应商痕迹在任何公开文案里都是硬错误。 */
const SUPPLIER_MARKERS = ["alibaba.com", "alicdn.com", "1688.com", "aliexpress.com", "en.alibaba"];

/** 页面 key ⇒ 它在站上的地址，报错时要说得出是哪一页。 */
export const SEO_PAGES: Record<string, string> = {
  home: "/",
  products: "/products/",
  contact: "/contact/",
  notFound: "404",
};

/** 可编辑的字段全集。**白名单**——不在这里的键一律拒收。 */
const SHAPE = {
  seo: {
    defaultTitle: "s!",
    defaultDescription: "s!",
    organisationDescription: "s!",
    pages: "pages",
  },
  contact: {
    email: "s!", phone: "s!", wechatId: "s!",
    address: "s!", hours: "s!", response: "s!",
  },
  home: {
    hero: { eyebrow: "s!", headline: "s!", body: "s!", primaryCtaLabel: "s!", secondaryCtaLabel: "s!" },
    sections: { capabilitiesIntro: "s!" },
    valueProps: "list",
    contactBlock: { title: "s!", body: "s!" },
  },
  // 首页 v4（2026-09-05 上线）。后台**只写 `products.featured` 这一处**；
  // 其余子块（hero/marquee/factory/…）是官网仓维护的，从这里原样穿过去。
  homeV4: { products: { featured: "list" } },
  // 证书槽（About 页认证板块）。后台整块拥有它 —— 值是 public/ 下的 URL 路径或 null。
  certificates: "map",
} as const;

/**
 * 证书槽的键 —— **全仓唯一定义**（index.ts 从这里 import，只在那边补显示文案）。
 * ⛔ 别在别处再抄一份同形的字面量：抄一份就有两个真源，而两边不一致时
 *    "少一个槽"这件事不会有任何报错 —— 那个槽只是安静地不出现。
 */
export const CERT_SLOTS = ["ce", "fcc", "rohs", "un38-3"] as const;
export type CertSlot = (typeof CERT_SLOTS)[number];
/** 证书文件允许的类型（按文件头认，见 index.ts 的 sniffFileType）。 */
export const CERT_EXTS = ["pdf", "png", "jpg", "webp"] as const;
/** 一个槽的值长什么样：`/certificates/<slot>.<ext>`，或 null = 没传。 */
export const certPathRe = new RegExp(`^/certificates/(${CERT_SLOTS.join("|")})\\.(${CERT_EXTS.join("|")})$`);

/** SEO 长度只给**警告**不给错误：超长不会让构建失败，只是搜索结果里被截断。 */
export const SEO_LIMITS = { title: 60, description: 160 };

function walkStrings(v: unknown, path: string, fn: (s: string, p: string) => void): void {
  if (typeof v === "string") return fn(v, path);
  if (Array.isArray(v)) return v.forEach((x, i) => walkStrings(x, `${path}[${i}]`, fn));
  if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) walkStrings(x, path ? `${path}.${k}` : k, fn);
  }
}

/**
 * 校验一份完整的 site-content。
 * 返回 `{ok, errors, warnings}`；**errors 非空 ⇒ 绝不允许写入**。
 *
 * @param baseline 仓里**现在**那一份（写入路径必传）。只有一个用处：判断"后台不认识的顶层块"
 *   是被原样带过还是被改动了 —— 见文件末尾那段。⛔ 别拿它做别的比较，
 *   已知字段一律按自身规则严校验，不因为"跟原来一样"就放过。
 */
export function validateSiteContent(c: any, baseline?: any): { ok: boolean; errors: Issue[]; warnings: Issue[] } {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];

  if (!c || typeof c !== "object" || Array.isArray(c)) {
    return { ok: false, errors: [err("(根)", "not_object", "内容必须是一个 JSON 对象。")], warnings };
  }

  // ── 必填字符串：空字符串**不算填了** ──
  const need = (obj: any, base: string, keys: readonly string[]) => {
    for (const k of keys) {
      const v = obj?.[k];
      const p = `${base}.${k}`;
      if (typeof v !== "string") errors.push(err(p, "required", `${p} 必填，且必须是字符串。`));
      else if (!v.trim()) errors.push(err(p, "empty", `${p} 是空的。想留空的话这个字段就不该存在 —— 空字符串会原样渲染成空白。`));
    }
  };

  need(c.seo, "seo", ["defaultTitle", "defaultDescription", "organisationDescription"]);
  need(c.contact, "contact", ["email", "phone", "wechatId", "address", "hours", "response"]);
  need(c.home?.hero, "home.hero", ["eyebrow", "headline", "body", "primaryCtaLabel", "secondaryCtaLabel"]);
  need(c.home?.sections, "home.sections", ["capabilitiesIntro"]);
  need(c.home?.contactBlock, "home.contactBlock", ["title", "body"]);

  // ── 联系方式：它们是**链接的来源**，畸形值 = 死链接，不是"难看" ──
  const email = c.contact?.email;
  if (typeof email === "string" && email.trim()) {
    // 不做花哨的 RFC 正则（那个永远写不对），只挡真正会产生死 mailto: 的形状
    if (!/^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(email.trim())) {
      errors.push(err("contact.email", "email_shape",
        `「${email}」不像一个邮箱地址。页面上的 mailto: 链接由它拼出来 —— 写错的话那个链接是死的，而页面看不出异常。`));
    }
  }
  const phone = c.contact?.phone;
  if (typeof phone === "string" && phone.trim()) {
    const digits = phone.replace(/\D/g, "");
    if (digits.length < 7) {
      errors.push(err("contact.phone", "phone_digits",
        `「${phone}」里只有 ${digits.length} 位数字。WhatsApp 与拨号链接都由这些数字拼出来（wa.me/${digits} · tel:+${digits}），位数不够 = 两个死链接。`));
    } else if (!phone.trim().startsWith("+")) {
      warnings.push(err("contact.phone", "no_country_code",
        `建议以 + 和国家码开头（现在是「${phone}」）。国际号码没有国家码时，WhatsApp 可能打不通。`));
    }
  }

  // ── SEO：每页 title 必填；**互不相同**是硬要求（官网 dist 闸自己在数） ──
  const pages = c.seo?.pages;
  if (!pages || typeof pages !== "object") {
    errors.push(err("seo.pages", "required", "seo.pages 必填。"));
  } else {
    const seen = new Map<string, string>();
    for (const key of Object.keys(SEO_PAGES)) {
      const pg = pages[key];
      const p = `seo.pages.${key}`;
      if (!pg || typeof pg !== "object") { errors.push(err(p, "required", `${p} 必填（对应页面 ${SEO_PAGES[key]}）。`)); continue; }
      if (typeof pg.title !== "string" || !pg.title.trim()) {
        errors.push(err(`${p}.title`, "required", `${SEO_PAGES[key]} 的 title 必填 —— 它是搜索结果里的那行标题。`));
      } else {
        const t = pg.title.trim();
        // 🔴 重复 title 会让官网的 dist 闸直接 FAIL（它数 unique title 数）⇒ 构建红。
        //    在这里拦下来，比让人在 CI 日志里发现要早一整个构建。
        const prev = seen.get(t.toLowerCase());
        if (prev) {
          errors.push(err(`${p}.title`, "duplicate_title",
            `与 ${SEO_PAGES[prev]} 的 title 完全相同。官网构建时会数「唯一 title 数」，重复会让构建直接失败 —— 也就是这次改动上不了线。`));
        } else seen.set(t.toLowerCase(), key);
        if (t.length > SEO_LIMITS.title) {
          warnings.push(err(`${p}.title`, "too_long", `${t.length} 字符，超过 ${SEO_LIMITS.title} 通常会在搜索结果里被截断。`));
        }
      }
      if (pg.description != null && typeof pg.description !== "string") {
        errors.push(err(`${p}.description`, "type", `description 必须是字符串（留空字符串表示"用站点默认描述"）。`));
      } else if (typeof pg.description === "string" && pg.description.trim().length > SEO_LIMITS.description) {
        warnings.push(err(`${p}.description`, "too_long",
          `${pg.description.trim().length} 字符，超过 ${SEO_LIMITS.description} 通常会被截断。`));
      }
    }
    for (const k of Object.keys(pages)) {
      if (!(k in SEO_PAGES)) {
        errors.push(err(`seo.pages.${k}`, "unknown_page",
          `站上没有叫「${k}」的页面。改这里不会有任何效果 —— 而"改了没反应"最难查。`));
      }
    }
  }

  // ── valueProps：首页那两张卡 ──
  const vp = c.home?.valueProps;
  if (!Array.isArray(vp)) {
    errors.push(err("home.valueProps", "type", "home.valueProps 必须是数组。"));
  } else if (!vp.length) {
    errors.push(err("home.valueProps", "empty", "至少留一条 —— 首页那一段会整块空掉。"));
  } else {
    vp.forEach((item: any, i: number) => {
      const p = `home.valueProps[${i}]`;
      if (!item || typeof item !== "object") { errors.push(err(p, "type", `${p} 必须是对象。`)); return; }
      need(item, p, ["title", "body"]);
      for (const k of Object.keys(item)) {
        if (k !== "title" && k !== "body") errors.push(err(`${p}.${k}`, "unknown_field", `只支持 title 和 body。`));
      }
    });
  }

  // ── featuredSlugs：首页那一排精选产品（顺序即展示顺序）──
  //
  // ⚠️ 这里只管**形状**。「这个 slug 存不存在 / 是不是已上架」查不了 ——
  //    这个模块不认识产品数据。那一层在 /api/site-content 里做（它有产品清单），
  //    而且是**警告不是错误**：一个产品被下架不该把整页锁死到存不了别的字段。
  const fs = c.home?.featuredSlugs;
  if (fs !== undefined) {
    if (!Array.isArray(fs)) {
      errors.push(err("home.featuredSlugs", "type", "home.featuredSlugs 必须是数组（顺序即首页展示顺序）。"));
    } else {
      fs.forEach((v: any, i: number) => {
        if (typeof v !== "string" || !v.trim()) {
          errors.push(err(`home.featuredSlugs[${i}]`, "type", "每一项必须是非空的产品 slug。"));
        }
      });
      // 🔴 重复不是小事：同一个产品会在首页出现两次，而**看起来像是"某个产品没排上"** ——
      //    人会去找丢掉的那个，而真正的问题是多了一个。
      const seen = new Set<string>(); const dup = new Set<string>();
      fs.forEach((v: any) => { const k = String(v).trim(); if (seen.has(k)) dup.add(k); seen.add(k); });
      if (dup.size) {
        errors.push(err("home.featuredSlugs", "duplicate",
          `有重复的 slug：${[...dup].join("、")}。同一个产品会在首页出现两次。`));
      }
    }
  }

  // ── homeV4.products.featured：首页 v4 那六张产品卡（**现在的真源**）──
  //
  // 🔴 上面那个 `home.featuredSlugs` 已经是死字段：首页 v4 不读它了（2026-09-05 合 main）。
  //    ⚠️ 但**本轮不删它**（派单明写）—— 删数据是另一件事，而且删错了没有回头路。
  //    这里两条都校验：旧的还在文件里，坏了照样要说话。
  //
  // ⚠️ 与旧字段的形状差别是**实打实的**，⛔ 不能当成"数组换了个名字"：
  //    旧：`["slug", …]`　新：`[{slug, tagline, chips[]}, …]`
  //    ⇒ 少写一个 tagline，首页上就是一张**没有说明文字**的卡（渲染得出来，只是空着）。
  const fv = c.homeV4?.products?.featured;
  if (fv !== undefined) {
    if (!Array.isArray(fv)) {
      errors.push(err("homeV4.products.featured", "type", "必须是数组（顺序即首页展示顺序）。"));
    } else {
      const seenV = new Set<string>(); const dupV = new Set<string>();
      fv.forEach((it: any, i: number) => {
        const p = `homeV4.products.featured[${i}]`;
        if (!it || typeof it !== "object" || Array.isArray(it)) {
          errors.push(err(p, "type", `第 ${i + 1} 张必须是一个对象（含 slug / tagline / chips）。`));
          return;
        }
        if (typeof it.slug !== "string" || !it.slug.trim()) {
          errors.push(err(`${p}.slug`, "required", `第 ${i + 1} 张没有选产品 —— 首页会拿不到图和型号。`));
        } else {
          const k = it.slug.trim();
          if (seenV.has(k)) dupV.add(k);
          seenV.add(k);
        }
        // tagline 空不算错（官网渲染得出来，只是那张卡少一行字）⇒ **警告**，让人看得见但存得下去
        if (it.tagline != null && typeof it.tagline !== "string") {
          errors.push(err(`${p}.tagline`, "type", "一句话说明必须是文字。"));
        } else if (!String(it.tagline || "").trim()) {
          warnings.push(err(`${p}.tagline`, "empty", `第 ${i + 1} 张没写那一句话 —— 首页上这张卡会少一行说明。`));
        }
        if (it.chips != null && (!Array.isArray(it.chips) || it.chips.some((x: any) => typeof x !== "string" || !x.trim()))) {
          errors.push(err(`${p}.chips`, "type", "chips 必须是一组非空文字（如 CO₂ / PM2.5）。"));
        }
        for (const k of Object.keys(it)) {
          if (k !== "slug" && k !== "tagline" && k !== "chips") {
            errors.push(err(`${p}.${k}`, "unknown_field", `只支持 slug / tagline / chips —— 官网不读别的键。`));
          }
        }
      });
      if (dupV.size) {
        // 与旧字段同一个理由：重复看起来像"某个产品没排上"，人会去找丢掉的那个。
        errors.push(err("homeV4.products.featured", "duplicate",
          `有重复的产品：${[...dupV].join("、")}。同一个产品会在首页出现两次。`));
      }
    }
  }

  // ── certificates：About 页那四张认证卡指向的文件 ──
  //
  // 🔴 值是**给页面直接用的 URL 路径**（带头斜杠），不是仓内路径 ——
  //    两者只差一个斜杠，而拼错的症状是 404，不是报错。⇒ 用正则钉死形状，⛔ 不"大致像就行"。
  // ⚠️ `null` 是**合法值**且有确切含义：这个槽没传文件 ⇒ 官网不渲染那条链接。
  //    ⛔ 不能用"键不存在"表示同一件事：那样"没传"和"这个槽被误删了"长得一模一样。
  const certs = c.certificates;
  if (certs !== undefined) {
    if (!certs || typeof certs !== "object" || Array.isArray(certs)) {
      errors.push(err("certificates", "type", "certificates 必须是一个对象（四个槽 → 路径或 null）。"));
    } else {
      for (const k of Object.keys(certs)) {
        // ⚠️ `_readme` 在这里也放行 —— 与顶层那个 `_readme` 是**同一条规则**，⛔ 不是给证书开的特例：
        //    它是给人看的说明（这里装的是与 Web 窗对齐的契约文本：值为什么带头斜杠、
        //    换扩展名为什么要同 commit 删旧文件），不是站上的数据。
        // 🔴 实测过它的代价（2026-09-05）：漏了这条豁免，Web 窗把契约文本写进
        //    `certificates._readme` 的那一刻起，**后台每一次站点内容保存都会 422** ——
        //    与当天上午刚修掉的那个生产故障是同一个病：闸在拦一件它不该管的事。
        if (k === "_readme") continue;
        if (!(CERT_SLOTS as readonly string[]).includes(k)) {
          errors.push(err(`certificates.${k}`, "unknown_field",
            `没有叫「${k}」的证书槽。只有 ${CERT_SLOTS.join(" / ")} —— 官网不读别的键，填了不会有任何效果。`));
        }
      }
      for (const k of CERT_SLOTS) {
        const v = (certs as any)[k];
        if (v === null || v === undefined) continue;          // 没传，合法
        if (typeof v !== "string") {
          errors.push(err(`certificates.${k}`, "type", `必须是路径字符串或 null。`));
        } else if (!certPathRe.test(v)) {
          errors.push(err(`certificates.${k}`, "cert_path",
            `「${v}」不是这个槽的合法路径。应当形如 /certificates/${k}.pdf（允许 ${CERT_EXTS.join(" / ")}）—— ` +
            `路径错的后果是官网上那个「View certificate」点开是 404，而页面本身看不出异常。`));
        } else if (!v.startsWith(`/certificates/${k}.`)) {
          // 🔴 槽名与文件名必须对上：`certificates.ce` 指向 fcc.pdf 会让 CE 那张卡点开是 FCC 证书 ——
          //    数据"合法"、页面"正常"，而客户拿到的是错的合规文件。
          errors.push(err(`certificates.${k}`, "cert_slot_mismatch",
            `${k} 这个槽指向的是「${v}」—— 文件名和槽名对不上。那会让 ${k.toUpperCase()} 那张卡点开是别的证书。`));
        }
      }
    }
  }

  // ── 供应商痕迹：与产品同一条硬规则。这里**没有** supplierRef 那样的豁免字段。 ──
  walkStrings(stripReadme(c), "", (s, path) => {
    const low = s.toLowerCase();
    for (const m of SUPPLIER_MARKERS) {
      if (low.includes(m)) {
        errors.push(err(path || "(根)", "supplier_leak",
          `文案里出现供应商痕迹「${m}」。这会跟着构建产物上线，等于把底牌递给客户。`));
        return;
      }
    }
  });

  // ── 未知的顶层结构 ──
  //
  // 🔴 这条闸挡的是「**后台**悄悄写进一个它不认识的块」，⛔ 不是「文件里存在后台不认识的块」。
  //    这两件事以前是同一个判据，而 2026-09-05 它把自己变成了一次生产故障：
  //    官网仓陆续多了 `homeV4` / `productsV1` / `solutionsV3` / `contactV1` 四个块（Web 窗加的，
  //    官网自己在读），于是**后台的每一次保存都 422** —— 改个邮箱都存不进去，而且
  //    错误说的是"未知的顶层字段"，看起来像数据坏了，实际上是这道闸在拦一件它不该管的事。
  //
  // ⇒ 判据换成：**这个未知的块，和仓里原本那份一样吗？**
  //    · 一样 ⇒ 后台只是把它原样带过（mergeSiteContent 不碰没收到的字段）—— 放行。
  //    · 不一样 / 仓里原本没有 ⇒ 那就是后台在新增或改动一个它不认识的东西 —— 拒。
  //    这样闸的**原意一个字没松**，而它不再因为别人往文件里加东西就把后台锁死。
  //
  // ⚠️ ⛔ 不采用"把这四个名字加进白名单"：那是给症状打补丁 ——
  //    Web 窗下次再落一个 `aboutV2`，同一个生产故障会原样重演，而且照样没有征兆。
  // ⚠️ `baseline` 缺省时（GET 只是要显示一份体检报告，没有"改动"这回事）**不报错**：
  //    那种场景下"未知"不代表任何人做错了什么。
  for (const k of Object.keys(c)) {
    if (k === "_readme") continue;
    if (k in SHAPE) continue;
    if (!baseline) continue;                       // 没有基线 ⇒ 判不了"变没变"，就别下结论
    const before = (baseline as any)[k];
    if (JSON.stringify(before) === JSON.stringify((c as any)[k])) continue;   // 原样带过
    errors.push(err(k, "unknown_section",
      before === undefined
        ? `后台想新增一个它不认识的顶层字段「${k}」。它不会被后台渲染，也不该被悄悄写进去。`
        : `后台改动了它不认识的顶层字段「${k}」。这一块由官网仓维护，后台只该原样带过。`));
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** `_readme` 不参与任何内容校验 —— 它是给人看的说明，不是站上的文案。 */
function stripReadme(c: any): any {
  const { _readme, ...rest } = c || {};
  return rest;
}

/**
 * 把补丁并进现有内容。
 *
 * 🔴 `undefined` = **我没收到这个字段**，不是"用户要清空它"。
 *    后台的编辑页一次只提交一节（联系方式 / 首页 / SEO），其余两节根本不在请求里 ——
 *    把"没收到"当成"清空"，就是保存联系方式顺手把首页文案抹掉，而接口还回 ok。
 * ⚠️ `_readme` 永远原样保留：它写着"哪些东西有意没放进来"，丢了它，
 *    下一个人会以为那些字段是漏掉的。
 */
export function mergeSiteContent(existing: any, patch: any): any {
  const out: any = { ...(existing || {}) };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v === undefined) continue;
    // 顶层各节做**浅合并**，这样只提交 contact 时不会把 seo 整节换掉
    if (v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object" && !Array.isArray(out[k])) {
      out[k] = mergeSiteContent(out[k], v);
    } else {
      out[k] = v;   // 数组（valueProps）整块替换：那才是"这就是现在的全部条目"的意思
    }
  }
  return out;
}

/** 稳定序列化：键序固定，2 空格，末尾换行 —— 否则改一个字会产生整体重排的 diff。 */
export function serializeSiteContent(c: any): string {
  const ORDER = ["_readme", "seo", "contact", "home"];
  const out: Record<string, unknown> = {};
  for (const k of ORDER) if (k in c) out[k] = c[k];
  for (const k of Object.keys(c)) if (!(k in out)) out[k] = c[k];
  return JSON.stringify(out, null, 2) + "\n";
}

/** 改了哪些字段 —— commit message 要说得出来，否则审计日志只有"改了站点内容"。 */
export function changedFields(before: any, after: any): string[] {
  const out: string[] = [];
  const walk = (a: any, b: any, path: string) => {
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
        walk(a[k], b[k], path ? `${path}.${k}` : k);
      }
      return;
    }
    if (path) out.push(path);
  };
  walk(stripReadme(before || {}), stripReadme(after || {}), "");
  return out;
}
