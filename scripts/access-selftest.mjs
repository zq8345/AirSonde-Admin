// Access JWT 验签自检。
//
// 🔴🔴 **这是这个 worker 唯一的身份判据。** 它错了，后台就是敞开的，而且没有症状 ——
//    错误的方向不是"报错"，是"放行了不该放行的人"，那件事在日志里长得跟正常登录一模一样。
//
// ⚠️ 用**真的 RSA 密钥**签真的令牌，不 mock 验签本身：
//    mock 掉 crypto 的话，测的是"我以为验签会怎么做"，而不是验签怎么做。
//    公钥端点用一个假的 fetch 顶替 —— **那是"指向哪里"，不是"验不验"**，两回事。
//
// 🔴 判据纪律：正对照 + 反向自证。
//    只测"坏令牌被拒"的话，一个 `throw` 的空壳也全绿；
//    只测"好令牌通过"的话，一个 `return true` 的空壳也全绿。
const SRC = new URL("../src/", import.meta.url).href;
const { verifyAccessJwt, AccessDenied, _resetKeyCache, certsUrl } = await import(SRC + "access.ts");

let pass = 0, fail = 0; const out = [];
const ck = (n, c, d = "") => { if (c) { pass++; out.push(`✅ ${n}`); } else { fail++; out.push(`🔴 ${n}${d ? "\n     " + d : ""}`); } };

const TEAM = "wanewgroup.cloudflareaccess.com";
// 实测取自各应用的 Access 登录跳转（`kid=` 参数就是该应用的 AUD tag）。
// ⚠️ 不是我编的：四个应用共用一个 team、共用签名公钥，只有 aud 不同。
const AUD_SELF = "beea7666916e9368410207758db96c17f5de6cccbe80394fe7be3d1466cbaa90";  // admin.airsonde.com
const AUD_CRM  = "b7c3296b15d1012a18800aee72f009e9d5a2910133715eb90958b0b947291233";  // crm.airsonde.com（兄弟应用）

const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const enc = new TextEncoder();

// ── 造一对真 RSA 密钥，扮演 Access 的签名密钥 ──
const kp = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true, ["sign", "verify"]);
const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
const KID = "test-kid-1";
const CERTS = { keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig" }] };

// 另一对：用来扮演"签名是别人签的"
const kpEvil = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true, ["sign", "verify"]);

let certsHits = 0;
const goodFetch = async (url) => {
  certsHits++;
  if (url !== certsUrl(TEAM)) return { ok: false, status: 404, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => CERTS };
};

async function mint({ aud = AUD_SELF, email = "joe@wanew.com", exp, iat, nbf, iss, alg = "RS256", kid = KID, signer = kp.privateKey } = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  const header = { alg, kid, typ: "JWT" };
  const claims = { aud, email, exp: exp ?? nowSec + 3600, iat: iat ?? nowSec, iss: iss ?? `https://${TEAM}` };
  if (nbf !== undefined) claims.nbf = nbf;
  const h = b64url(enc.encode(JSON.stringify(header)));
  const p = b64url(enc.encode(JSON.stringify(claims)));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signer, enc.encode(`${h}.${p}`));
  return `${h}.${p}.${b64url(sig)}`;
}

const V = (tok, extra = {}) => verifyAccessJwt(tok, { teamDomain: TEAM, aud: AUD_SELF, fetchImpl: goodFetch, ...extra });
const denied = async (tok, extra) => { try { await V(tok, extra); return null; } catch (e) { return e instanceof AccessDenied ? e.message : `非 AccessDenied：${e}`; } };

// ════════ ① 正对照：真实身份必须放行 ════════
{
  _resetKeyCache();
  const r = await V(await mint());
  ck("① 正对照：合法令牌放行，且 email 是令牌里那个", r.email === "joe@wanew.com", JSON.stringify(r));
  ck("① aud 原样带出来", r.aud.includes(AUD_SELF));
}
{
  const r = await V(await mint({ email: "  JOE@Wanew.COM " }));
  ck("① email 归一化（去空白、转小写）—— 否则同一个人大小写不同会被当成两个人", r.email === "joe@wanew.com", r.email);
}

// ════════ ② 无 JWT ════════
{
  ck("② 没有令牌 ⇒ 拒", (await denied("")) !== null);
  ck("② 不是三段式 ⇒ 拒", (await denied("abc.def")) !== null);
  ck("② 载荷不是合法 JSON ⇒ 拒", (await denied("eyJhbGciOiJSUzI1NiIsImtpZCI6InRlc3Qta2lkLTEifQ.!!!.x")) !== null);
}

// ════════ ③ 签名无效 ════════
{
  const good = await mint();
  // 改签名的一个字节
  const parts = good.split(".");
  const s = parts[2];
  // 🔴 **不要改最后一个字符** —— 那一位很可能落在 base64 的补位里，改了解码出来的字节不变，
  //    签名照样有效。第一版就是这么写的：这条断言当场变红，而红的是**仪器**不是被测对象。
  //    （2048 位签名 = 256 字节，base64 用 342 个字符编 2052 位 ⇒ 末尾 4 位是被忽略的。）
  //    ⇒ 改中间那个字符，它的 6 位全部落在有效字节里。
  const mid = Math.floor(s.length / 2);
  const flipped = s.slice(0, mid) + (s[mid] === "A" ? "B" : "A") + s.slice(mid + 1);
  const why = await denied(`${parts[0]}.${parts[1]}.${flipped}`);
  ck("③ 签名改一个字节 ⇒ 拒", why !== null, String(why));
}
{
  // 载荷被篡改（把 email 换成别人）⇒ 签名对不上
  const tok = await mint({ email: "attacker@example.com" });
  const mine = await mint();
  const bad = `${tok.split(".")[0]}.${tok.split(".")[1]}.${mine.split(".")[2]}`;
  ck("③ 换掉载荷、套用别的签名 ⇒ 拒", (await denied(bad)) !== null);
}
{
  ck("③ 用另一把私钥签的 ⇒ 拒", (await denied(await mint({ signer: kpEvil.privateKey }))) !== null);
}
{
  ck("③ kid 不在公钥列表里 ⇒ 拒", (await denied(await mint({ kid: "unknown-kid" }))) !== null);
}
{
  // 🔴 alg 混淆：照着 header 说的算法去验，等于让攻击者自己选验签方式
  ck("③ 🔴 alg=none ⇒ 拒（不照 header 说的算法走）", (await denied(await mint({ alg: "none" }))) !== null);
  ck("③ 🔴 alg=HS256 ⇒ 拒", (await denied(await mint({ alg: "HS256" }))) !== null);
}

// ════════ ④ 🔴🔴 签名有效、但 aud 是**兄弟应用**的 ⇒ 必须拒 ════════
//
// 这是这份自检里最重要的一条。四个 Access 应用共用同一个 team、同一套公钥 ⇒
// 一个只该进 CRM 的人，拿着 CRM 发的**合法**令牌，签名会验过。
// ⚠️ 所以这个洞不会以"验签失败"的形式出现 —— 它没有症状。
{
  const tok = await mint({ aud: AUD_CRM });
  const why = await denied(tok);
  ck("④ 🔴🔴 关键：aud 是 crm.airsonde.com 的合法令牌 ⇒ 拒", why !== null, "居然放行了");
  ck("④ 而且拒绝理由要指出是 aud 的问题（不能报成「签名无效」，那会让人去查错地方）",
    why !== null && /别的 Access 应用|aud/.test(why), String(why));
  // 反向自证：**同一个令牌**，只把"本应用 aud"改成 CRM 的，就必须放行 ——
  // 证明拒绝的原因确实是 aud 不匹配，而不是这个令牌本身哪里坏了
  const r = await V(tok, { aud: AUD_CRM });
  ck("④ 反向自证：同一个令牌，把本应用 aud 换成 crm 的就放行 ⇒ 拒的确实是 aud", r.email === "joe@wanew.com");
}
{
  ck("④ aud 是数组且不含本应用 ⇒ 拒", (await denied(await mint({ aud: [AUD_CRM, "x"] }))) !== null);
  const r = await V(await mint({ aud: [AUD_CRM, AUD_SELF] }));
  ck("④ aud 数组里含本应用 ⇒ 放行（Access 确实会发数组）", r.email === "joe@wanew.com");
}
{
  // 🔴 配置缺失**不等于**跳过检查
  const tok = await mint();
  ck("④ 🔴 本应用 aud 没配 ⇒ 拒（⛔ 不是「没配就不校验 aud」）",
    (await denied(tok, { aud: "" })) !== null);
  ck("④ 🔴 team 域名没配 ⇒ 拒", (await denied(tok, { teamDomain: "" })) !== null);
}

// ════════ ⑤ 过期 / 时间 ════════
{
  const nowSec = Math.floor(Date.now() / 1000);
  ck("⑤ 已过期 ⇒ 拒", (await denied(await mint({ exp: nowSec - 3600 }))) !== null);
  ck("⑤ 没有 exp ⇒ 拒（不是「没写就永不过期」）", (await denied(await mint({ exp: undefined, iat: nowSec }).then(async () => {
    // exp 必须真的缺席，mint 会补默认值 ⇒ 手工造一个无 exp 的
    const h = b64url(enc.encode(JSON.stringify({ alg: "RS256", kid: KID, typ: "JWT" })));
    const p = b64url(enc.encode(JSON.stringify({ aud: AUD_SELF, email: "joe@wanew.com", iss: `https://${TEAM}` })));
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", kp.privateKey, enc.encode(`${h}.${p}`));
    return `${h}.${p}.${b64url(sig)}`;
  }))) !== null);
  ck("⑤ nbf 在未来 ⇒ 拒", (await denied(await mint({ nbf: nowSec + 3600 }))) !== null);
  // 反向自证：刚好在有效期内的必须放行 —— 否则"全拒"也能让上面几条全绿
  const r = await V(await mint({ exp: nowSec + 30 }));
  ck("⑤ 反向自证：还有 30 秒到期的令牌仍然放行（不是一律拒）", r.email === "joe@wanew.com");
}
{
  ck("⑤ iss 不对 ⇒ 拒", (await denied(await mint({ iss: "https://evil.cloudflareaccess.com" }))) !== null);
}

// ════════ ⑥ 🔴 反向自证：公钥端点指错 ⇒ 所有人都被拒 ════════
//
// 这一条防的是"闸恒真放行"：只有 ① 全绿的话，一个 `return true` 也全绿。
// ⇒ 把公钥来源打掉，如果**仍然有人能进**，说明验签根本没在跑。
{
  _resetKeyCache();
  const badFetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const why = await denied(await mint(), { fetchImpl: badFetch });
  ck("⑥ 🔴 公钥端点取不到 ⇒ 拒（fail closed，不是「取不到就先放行」）", why !== null, "居然放行了 —— 验签没在跑");
}
{
  _resetKeyCache();
  const emptyFetch = async () => ({ ok: true, status: 200, json: async () => ({ keys: [] }) });
  ck("⑥ 🔴 公钥端点返回空列表 ⇒ 拒（空 ≠ 不限制）",
    (await denied(await mint(), { fetchImpl: emptyFetch })) !== null);
}
{
  _resetKeyCache();
  const otherKeyFetch = async () => {
    const j = await crypto.subtle.exportKey("jwk", kpEvil.publicKey);
    return { ok: true, status: 200, json: async () => ({ keys: [{ ...j, kid: KID, alg: "RS256", use: "sig" }] }) };
  };
  ck("⑥ 🔴 公钥换成别人的（kid 相同）⇒ 拒 —— 证明真的在用公钥算，不是只看 kid 对不对",
    (await denied(await mint(), { fetchImpl: otherKeyFetch })) !== null);
}

// ════════ ⑦ 公钥轮换：遇到没见过的 kid 要重取，⛔ 不能等 TTL ════════
{
  _resetKeyCache();
  await V(await mint());                       // 先把 KID 灌进缓存
  const before = certsHits;
  const kp2 = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"]);
  const jwk2 = await crypto.subtle.exportKey("jwk", kp2.publicKey);
  // ⚠️ 计数器要挂在**这一个** fetch 上。第一版我数的是 goodFetch 的命中数，
  //    而这里换了 fetchImpl ⇒ 读到 3 → 3，看起来像"没重取"。
  //    那是**仪器指错了地方**，不是被测对象的问题 —— 这条断言把它逼出来了。
  let rotatedHits = 0;
  const rotated = async () => { rotatedHits++; return { ok: true, status: 200,
    json: async () => ({ keys: [{ ...jwk2, kid: "test-kid-2", alg: "RS256", use: "sig" }] }) }; };
  const r = await verifyAccessJwt(await mint({ kid: "test-kid-2", signer: kp2.privateKey }),
    { teamDomain: TEAM, aud: AUD_SELF, fetchImpl: rotated });
  ck("⑦ 🔴 轮换后的新 kid 立刻重取公钥并放行（等 TTL 的话，那一小时里所有人都进不来）",
    r.email === "joe@wanew.com");
  ck("⑦ 而且确实重新取了一次（不是碰巧命中缓存）", rotatedHits === 1, `rotated 被调用 ${rotatedHits} 次`);
}
{
  // 反向自证：已知 kid 不该每次都去取 —— 否则每个请求一次外网往返
  _resetKeyCache();
  await V(await mint());
  const before = certsHits;
  await V(await mint());
  await V(await mint());
  ck("⑦ 反向自证：已知 kid 走缓存，不重复取公钥", certsHits === before, `${before} → ${certsHits}`);
}

console.log(out.join("\n"));
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
