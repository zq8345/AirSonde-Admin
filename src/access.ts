// Cloudflare Access JWT 验签 —— **这个 worker 唯一的身份判据**。
//
// ══ 为什么从"读一个头"改成"验一个签名" ══
//
// 以前：直接读 `cf-access-authenticated-user-email`，再拿 `ALLOWED_EMAILS` 查一遍。
// 那份名单必须与 Access 策略**手工保持一致**，而 2026-08-27 就因为它们不同步吃了一次：
// Access 里有四个邮箱、`ALLOWED_EMAILS` 里只有三个 ⇒ 同事过了 Access 却拿到 403。
// Joe 的要求是「我自己定义哪个邮箱能登录，而不是加一个账号还要找你」
// ⇒ **Access 策略成为唯一名单**，`ALLOWED_EMAILS` 整个删掉，⛔ 不留回落
//   （留回落 = 两份名单的问题原样保留，只是藏起来了）。
//
// 🔴 但"删掉名单、继续裸读那个头"是**不安全的**：
//    那样安全性完全挂在两条配置不变上 —— `workers_dev:false`，以及所有路由都在 Access 后面。
//    **没有任何东西在检查这两条。** 谁哪天加一条不经 Access 的路由，那个头就可以随便伪造，
//    而后台会安静地把伪造者当成任何人。改一次路由就静默塌掉，且没有症状。
// ⇒ 把保证**做进代码**：验 `Cf-Access-Jwt-Assertion` 的签名。
//    验过 = 这个请求确实经过了我们这个 Access 应用，与路由怎么配无关。
//
// ══ `aud` 那一条不是形式 ══
// 🔴 同一个 Cloudflare 账号下现在有 **4 个 Access 应用**，它们**共用同一套签名公钥**
//    （同一个 team：wanewgroup.cloudflareaccess.com）。实测四个 AUD：
//      admin.airsonde.com  beea7666…
//      crm.airsonde.com    b7c3296b…
//      admin.wanew.com     9198c82b…
//      crm.wanew.com       9a9ae044…
//    ⇒ **只验签名不验 aud，等于接受任何一个兄弟应用的令牌**：
//      一个只该进 CRM 的人，拿着 CRM 发的合法令牌就能进这个能写官网仓的后台。
//    签名会是**有效的** —— 所以这个洞不会以"验签失败"的形式出现，它没有症状。

export class AccessDenied extends Error {}

export interface AccessClaims {
  email: string;
  sub?: string;
  aud: string[];
  exp: number;
  iat?: number;
  iss?: string;
  identity_nonce?: string;
}

/** 公钥缓存。⚠️ 公钥会轮换 ⇒ 不硬编码、按 kid 缓存、遇到没见过的 kid 就重取。 */
interface KeyCache { keys: Map<string, CryptoKey>; fetchedAt: number }
const CACHE_TTL_MS = 60 * 60 * 1000;   // 1 小时。轮换由"未知 kid 立刻重取"兜底，不靠这个数。
let cache: KeyCache | null = null;

/** 测试用：把缓存清掉，让下一次调用重新取公钥。⚠️ 生产代码路径不调它。 */
export function _resetKeyCache(): void { cache = null; }

const b64urlToBytes = (s: string): Uint8Array => {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const b64urlToText = (s: string): string => new TextDecoder().decode(b64urlToBytes(s));

export const certsUrl = (teamDomain: string): string =>
  `https://${teamDomain}/cdn-cgi/access/certs`;

async function loadKeys(teamDomain: string, fetchImpl: typeof fetch): Promise<Map<string, CryptoKey>> {
  const r = await fetchImpl(certsUrl(teamDomain));
  if (!r.ok) throw new AccessDenied(`取不到 Access 公钥（${certsUrl(teamDomain)} → HTTP ${r.status}）`);
  const body = (await r.json()) as { keys?: any[] };
  if (!body.keys || !body.keys.length) throw new AccessDenied("Access 公钥端点没有返回任何 key");
  const m = new Map<string, CryptoKey>();
  for (const jwk of body.keys) {
    if (jwk.kty !== "RSA" || (jwk.alg && jwk.alg !== "RS256")) continue;
    try {
      m.set(jwk.kid, await crypto.subtle.importKey(
        "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"],
      ));
    } catch { /* 单个 key 坏了不该让整份失效 */ }
  }
  if (!m.size) throw new AccessDenied("Access 公钥端点返回的 key 一个都导入不了");
  return m;
}

async function keyFor(kid: string, teamDomain: string, fetchImpl: typeof fetch, now: number): Promise<CryptoKey> {
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    const hit = cache.keys.get(kid);
    if (hit) return hit;
    // 🔴 缓存里没有这个 kid ⇒ **立刻重取**，不要等 TTL 到期。
    //    轮换发生时旧缓存里当然没有新 kid；等 TTL 的话，那一小时里**所有人都进不来**。
  }
  const keys = await loadKeys(teamDomain, fetchImpl);
  cache = { keys, fetchedAt: now };
  const k = keys.get(kid);
  if (!k) throw new AccessDenied(`令牌的 kid（${kid.slice(0, 12)}…）不在 Access 的公钥列表里`);
  return k;
}

export interface VerifyOpts {
  teamDomain: string;
  /** 本应用的 AUD tag。🔴 空 ⇒ 直接拒绝，绝不"不校验 aud 就放行"。 */
  aud: string;
  fetchImpl?: typeof fetch;
  /** 毫秒。注入是为了能测过期，生产不传。 */
  now?: number;
  /** 允许的时钟偏移（秒） */
  skewSec?: number;
}

/**
 * 验一个 Access JWT。**任何一步不确定都抛 AccessDenied**（fail closed）。
 * 返回值里的 email 才是这个请求的身份 —— ⛔ 别再去信那个明文头。
 */
export async function verifyAccessJwt(token: string, opts: VerifyOpts): Promise<AccessClaims> {
  const now = opts.now ?? Date.now();
  const skew = opts.skewSec ?? 60;

  if (!opts.teamDomain) throw new AccessDenied("没有配置 Access team 域名 —— 无法验证任何令牌，拒绝。");
  // 🔴 这一条单列：aud 没配时**不是"跳过 aud 校验"**，是拒绝。
  //    "配置缺失就降级成不检查"正是安全闸最常见的死法。
  if (!opts.aud) throw new AccessDenied("没有配置本应用的 Access AUD —— 无法区分兄弟应用的令牌，拒绝。");
  if (!token) throw new AccessDenied("请求没有带 Cf-Access-Jwt-Assertion");

  const parts = token.split(".");
  if (parts.length !== 3) throw new AccessDenied("令牌不是三段式 JWT");
  // ⚠️ 显式收窄：数组下标在本仓的 tsc 配置下是 `string | undefined`。
  //    用 `!` 断言的话，某天真的拿到空段时会在别处炸，而不是在这里被拒。
  const h64 = parts[0] || "", p64 = parts[1] || "", s64 = parts[2] || "";
  if (!h64 || !p64 || !s64) throw new AccessDenied("令牌有空的段");

  let header: any, claims: any;
  try { header = JSON.parse(b64urlToText(h64)); } catch { throw new AccessDenied("令牌头部不是合法 JSON"); }
  try { claims = JSON.parse(b64urlToText(p64)); } catch { throw new AccessDenied("令牌载荷不是合法 JSON"); }

  // ⚠️ 只认 RS256。`alg: none` 与 HS256 混淆是 JWT 的经典绕过 ——
  //    照着 header 说的算法去验，等于让攻击者自己选验签方式。
  if (header.alg !== "RS256") throw new AccessDenied(`只接受 RS256，令牌声明的是 ${header.alg}`);
  if (!header.kid) throw new AccessDenied("令牌头部没有 kid");

  const key = await keyFor(String(header.kid), opts.teamDomain, opts.fetchImpl ?? fetch, now);
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5", key,
    b64urlToBytes(s64),
    new TextEncoder().encode(`${h64}.${p64}`),
  );
  if (!ok) throw new AccessDenied("令牌签名无效");

  // ── aud ──
  const auds: string[] = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
  if (!auds.includes(opts.aud)) {
    throw new AccessDenied(
      `令牌是发给别的 Access 应用的（aud=${auds.map((a) => String(a).slice(0, 12) + "…").join(",") || "空"}，` +
      `本应用是 ${opts.aud.slice(0, 12)}…）。签名是有效的 —— 同一个 team 下几个应用共用公钥，` +
      `所以这一条只能靠 aud 分辨。`,
    );
  }

  // ── 时间 ──
  const nowSec = Math.floor(now / 1000);
  if (typeof claims.exp !== "number") throw new AccessDenied("令牌没有 exp");
  if (nowSec > claims.exp + skew) throw new AccessDenied("令牌已过期");
  if (typeof claims.nbf === "number" && nowSec + skew < claims.nbf) throw new AccessDenied("令牌还没到生效时间（nbf）");
  if (typeof claims.iat === "number" && nowSec + skew < claims.iat) throw new AccessDenied("令牌的签发时间在未来（iat）");

  // ── iss ──
  // ⚠️ 只在 iss 存在时比对：Access 一直会发它，但"缺了就拒"会让某天的格式变动直接把所有人挡在外面，
  //    而 aud + 签名已经把"是不是发给这个应用的"钉死了。
  const wantIss = `https://${opts.teamDomain}`;
  if (claims.iss && claims.iss !== wantIss) throw new AccessDenied(`令牌的 iss 是 ${claims.iss}，不是 ${wantIss}`);

  const email = String(claims.email || "").trim().toLowerCase();
  if (!email) throw new AccessDenied("令牌里没有 email");
  return { email, sub: claims.sub, aud: auds, exp: claims.exp, iat: claims.iat, iss: claims.iss };
}
