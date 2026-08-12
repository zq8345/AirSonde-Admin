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
} as const;

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
 */
export function validateSiteContent(c: any): { ok: boolean; errors: Issue[]; warnings: Issue[] } {
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

  // ── 未知的顶层结构：拒收，不静默吞 ──
  for (const k of Object.keys(c)) {
    if (k === "_readme") continue;
    if (!(k in SHAPE)) {
      errors.push(err(k, "unknown_section", `未知的顶层字段「${k}」。后台不认识它 ⇒ 它不会被渲染，也不该被悄悄写进去。`));
    }
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
