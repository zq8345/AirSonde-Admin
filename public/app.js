// AirSonde Admin 界面 —— A2：读 + 校验 + dry-run 预览。**没有保存能力。**
//
// ⚠️ 枚举全部来自 /api/contract，前端**不抄第二份**：
//    抄一份的话，契约改了界面不会跟着变，而它看起来一切正常 —— 那是第二个真源。
//
// 无构建步骤、无框架：这个后台的逻辑量撑不起一条工具链，而工具链本身会漂。

const $ = (s, r = document) => r.querySelector(s);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

const state = {
  contract: null,   // { categories, sensors, statuses }
  list: [],         // /api/products 的 files
  listMeta: null,
  slug: null,       // 当前选中
  loaded: null,     // 当前产品的服务端原始响应
  draft: null,      // 编辑中的对象
  isNew: false,
  // 🔴 写能力是**服务端告诉我们的事实**，不是前端的一个开关。
  //    null = 还没问到。在问到之前界面不该假装知道自己能不能写。
  write: null,      // { enabled, gateOpen, tokenConfigured }
  lastPreview: null,
  repo: null, branch: null,
  tab: "all",                 // 状态 tab：all | published | draft
  selected: new Set(),        // 批量选中的 slug
  /** 每次成功保存后换成新的 commit sha —— 用来打穿 raw 的 CDN 缓存，见 rawUrl()。 */
  cacheBust: null,
  // 待上传/待删除的图 —— 只存在于内存，**保存之前一个字节都不会进仓**
  pending: { main: null, gallery: [], removed: new Set() },
};

/** 换产品、还原、新建时必须清空 —— 否则上一份的待上传图会跟着走到下一个产品身上。 */
function resetPending() {
  state.pending = { main: null, gallery: [], removed: new Set() };
}

// ── 通用请求：**失败要说出服务器的原话**，不要自己概括成"加载失败" ──
async function api(path, init) {
  const r = await fetch(path, init);
  const ct = r.headers.get("content-type") || "";
  const body = ct.includes("json") ? await r.json().catch(() => null) : await r.text();
  if (!r.ok && r.status !== 404 && r.status !== 422) {
    const detail = body && typeof body === "object" ? (body.detail || body.error || JSON.stringify(body)) : String(body).slice(0, 300);
    throw new Error(`${r.status} ${detail}`);
  }
  return { status: r.status, body };
}

// ═══════════════ 进程身份 ═══════════════
async function loadWho() {
  try {
    const { body: w } = await api("/api/_whoami");
    $("#who").innerHTML = "";
    const line1 = el("div");
    line1.append(el("b", null, w.operator || "(无身份)"));
    line1.append(document.createTextNode(`  ·  ${w.data.repo || "?"}`));
    const line2 = el("div", "muted", `${w.git.shortSha || "无 sha"}${w.git.dirty ? "（脏）" : ""} · ${w.deploy.versionId ? w.deploy.versionId.slice(0, 8) : "本地"} · ${w.request.colo || "-"}`);
    $("#who").append(line1, line2);
    // ⚠️ warnings 不是给日志看的，是给正在用后台的人看的
    if (w.warnings?.length) {
      const b = el("span", "banner-why", "⚠️ " + w.warnings.join("；"));
      $("#banner").append(b);
    }
    state.repo = w.data.repo; state.branch = w.data.branch;
    state.write = {
      enabled: !!w.data.writeEnabled,
      gateOpen: !!w.data.writeGateOpen,
      tokenConfigured: !!w.data.ghTokenConfigured,
    };
    applyWriteMode();
  } catch (e) {
    $("#who").textContent = "身份读取失败：" + e.message;
    // 🔴 问不到就**保持"未知"**，绝不默认成"能写"。
    //    默认能写的话，一次网络抖动就会让界面开始说它没有把握的话。
    $("#bannerTitle").textContent = "写入能力未知";
    $("#bannerText").textContent = "问不到服务端。在确认之前不要假设这里能保存。";
  }
}

/** 把「服务端到底能不能写」翻译成界面上的每一句话。**只有这一个地方决定文案。** */
function applyWriteMode() {
  const w = state.write;
  const banner = $("#banner"), title = $("#bannerTitle"), text = $("#bannerText"), why = $("#bannerWhy");
  // 删除按钮只在真能写时出现 —— 一个点了没反应的删除按钮比没有更糟
  $("#deleteBtn").hidden = !(w.enabled && state.slug);

  if (w.enabled) {
    banner.classList.add("banner-live");
    title.textContent = "写入已开启";
    text.innerHTML = "保存会<b>真的提交到官网数据仓</b>，并自动触发 airsonde.com 重建。";
    why.textContent = "提交前先看 diff —— 这是生产数据。";
    $("#actionsNote").textContent = "先校验预览，确认 diff 之后才会出现提交按钮。";
  } else {
    banner.classList.remove("banner-live");
    title.textContent = "预览模式";
    text.innerHTML = "校验与 diff 都是真的，但<b>不会写入任何文件</b>。";
    // 两个原因要分开说：闸没开 和 没有 token 是两件事，修法也不同。
    why.textContent = !w.gateOpen
      ? "原因：出站写闸未开启（ALLOW_GITHUB_WRITE 未配置）。"
      : !w.tokenConfigured ? "原因：GITHUB_TOKEN 未配置。" : "原因：未知。";
    $("#actionsNote").textContent = "当前无法保存，但可以复制预览里的完整内容。";
  }
}

// ═══════════════ 契约枚举 ═══════════════
async function loadContract() {
  const { body } = await api("/api/contract");
  state.contract = body;

  const cat = $("#f_category");
  cat.append(new Option("（请选择）", ""));
  body.categories.forEach((c) => cat.append(new Option(c, c)));

  const st = $("#f_status");
  body.statuses.forEach((s) => st.append(new Option(s, s)));

  const box = $("#f_sensors");
  body.sensors.forEach((s) => {
    const lab = el("label", "chip");
    const cb = el("input"); cb.type = "checkbox"; cb.value = s;
    lab.append(cb, document.createTextNode(s));
    box.append(lab);
  });
}

// ═══════════════ 列表 ═══════════════
async function loadList() {
  // ⚠️ 用 expanded：表格要缩略图/标题/状态/机型，光有文件名画不出来。
  //    前端逐个拉的话，列表会一行一行"长出来"，而且筛选与计数在数据到齐前都是错的。
  const { body } = await api("/api/products-expanded");
  state.listMeta = body;
  state.list = body.items || [];
  state.list.forEach((it) => { if (!it.error) cache.set(it.slug, it); });
  renderList();
}

/** 当前筛选下的行。tabs 计数与表格必须用**同一个函数**，否则数字和内容会对不上。 */
function filteredRows() {
  const q = $("#q").value.trim().toLowerCase();
  const cat = $("#catFilter").value;
  return state.list.filter((it) => {
    if (state.tab !== "all" && it.status !== state.tab) return false;
    if (cat && it.category !== cat) return false;
    if (q && !`${it.slug} ${it.name || ""} ${it.model || ""}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

function renderList() {
  // ── 机型下拉：选项从**真实数据**里长出来，不硬编码 ──
  const cats = [...new Set(state.list.map((i) => i.category).filter(Boolean))].sort();
  const sel = $("#catFilter"), keep = sel.value;
  sel.innerHTML = "";
  sel.append(new Option("全部机型", ""));
  cats.forEach((c) => sel.append(new Option(c, c)));
  sel.value = cats.includes(keep) ? keep : "";

  // ── 状态 tabs（带计数）──
  const counts = { all: state.list.length };
  (state.contract?.statuses || ["published", "draft"]).forEach((s) => {
    counts[s] = state.list.filter((i) => i.status === s).length;
  });
  const tabs = $("#statusTabs"); tabs.innerHTML = "";
  const label = { all: "全部", published: "在线", draft: "草稿箱" };
  ["all", ...(state.contract?.statuses || [])].forEach((k) => {
    const b = el("button", "stab" + (state.tab === k ? " is-on" : ""));
    b.type = "button";
    b.append(document.createTextNode(label[k] || k), el("span", "stab-n", String(counts[k] ?? 0)));
    b.onclick = () => { state.tab = k; state.selected.clear(); renderList(); };
    tabs.append(b);
  });

  const rows = filteredRows();
  const tb = $("#rows"); tb.innerHTML = "";

  rows.forEach((it) => {
    const tr = el("tr");
    if (it.error) tr.classList.add("row-bad");

    const ck = el("input"); ck.type = "checkbox"; ck.checked = state.selected.has(it.slug);
    ck.disabled = !!it.error;
    ck.onchange = () => { ck.checked ? state.selected.add(it.slug) : state.selected.delete(it.slug); renderBatch(); syncCkAll(); };
    // ⚠️ Element.append() 返回 undefined，不能链式接 .lastChild —— 那会抛 TypeError，
    //    而抛的位置在 tabs 渲染**之后**：于是 tabs 有数字、表格却是空的，
    //    看起来像"筛选没匹配到"，实际上是渲染半路挂了。
    const tdCk = el("td", "col-ck"); tdCk.append(ck); tr.append(tdCk);

    const tdImg = el("td", "col-img");
    const th = el("div", "thumb thumb-sm");
    setThumb(th, it.image ? rawUrl(it.image) : null, it.name || it.slug);
    tdImg.append(th); tr.append(tdImg);

    const tdName = el("td");
    if (it.error) {
      tdName.append(el("div", "li-name", it.slug));
      tdName.append(el("div", "li-sub bad", `🔴 ${it.error}${it.detail ? "：" + it.detail : ""}`));
    } else {
      const n = el("div", "li-name", it.name || it.slug);
      // 校验有问题的要在列表上就看得见，而不是点进去才发现
      if (!it.valid) n.append(el("span", "flag-bad", `${it.errorCount} 个错误`));
      else if (it.warnCount) n.append(el("span", "flag-warn", `${it.warnCount} 提示`));
      tdName.append(n, el("div", "li-sub", `${it.slug} · ${it.model || "—"}`));
    }
    tr.append(tdName);

    const tdSt = el("td", "col-st");
    tdSt.append(el("span", `badge badge-${it.status || "unknown"}`, it.status || "?"));
    tr.append(tdSt);

    tr.append(el("td", "col-cat", it.category || "—"));

    const tdAct = el("td", "col-act");
    const edit = el("button", "linkish", "编辑"); edit.type = "button";
    edit.onclick = () => select(it.slug);
    tdAct.append(edit);
    if (!it.error && state.write?.enabled) {
      const to = it.status === "published" ? "draft" : "published";
      const t = el("button", "linkish", it.status === "published" ? "下架" : "上架");
      t.type = "button";
      t.onclick = () => bulk([it.slug], to);
      tdAct.append(t);
    }
    tr.append(tdAct);
    tb.append(tr);
  });

  $("#navCount").textContent = String(state.list.length);
  syncCkAll(); renderBatch();

  const empty = $("#listEmpty");
  if (state.listMeta?.dirExists === false) {
    // 🔴 这是**正常状态**，不是错误。不说清楚的话，人会以为后台坏了。
    empty.hidden = false;
    empty.innerHTML = `<b>数据目录还不存在。</b><br><code>${state.listMeta.dir}</code> 归 AirSonde-Web 窗维护，它建出来之后这里会自动有内容。`;
  } else if (!rows.length) {
    empty.hidden = false;
    empty.textContent = state.list.length ? "没有匹配的产品。" : "目录是空的（存在，但里面没有产品 JSON）。";
  } else empty.hidden = true;
}

function syncCkAll() {
  const rows = filteredRows().filter((r) => !r.error);
  const all = rows.length > 0 && rows.every((r) => state.selected.has(r.slug));
  const some = rows.some((r) => state.selected.has(r.slug));
  const ck = $("#ckAll");
  ck.checked = all; ck.indeterminate = !all && some;
}

function renderBatch() {
  const n = state.selected.size;
  $("#batchBar").hidden = n === 0 || !state.write?.enabled;
  $("#batchCount").textContent = `已选 ${n} 个`;
}

/** 批量改状态。单行的"上架/下架"也走这里 —— 一条路径，行为不可能分叉。 */
async function bulk(slugs, value) {
  if (!slugs.length) return;
  const verb = value === "published" ? "上架" : "下架";
  if (!confirm(`确认${verb} ${slugs.length} 个产品？\n\n会产生一次 commit 并触发官网重建。`)) return;
  try {
    const r = await fetch("/api/products/batch", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ slugs, op: "status", value }),
    });
    const b = await r.json().catch(() => null);
    if (b?.wrote === true) {
      state.cacheBust = b.commitSha;
      state.selected.clear();
      await loadList();
      alert(`已${verb} ${b.changed.length} 个。commit ${String(b.commitSha).slice(0, 7)}\n` +
        (b.skipped?.length ? `跳过 ${b.skipped.length} 个：${b.skipped.map((s) => s.slug + "(" + s.why + ")").join("、")}` : ""));
    } else if (b?.rejected?.length) {
      // ⚠️ 整批未写要说明白，别让人以为"至少成了几个"
      alert(`未写入任何东西（整批中止）。\n\n以下产品没通过契约校验：\n` +
        b.rejected.map((x) => `· ${x.slug}：${x.codes.join(", ")}`).join("\n"));
    } else {
      alert(`未写入：${b?.reason || b?.detail || b?.error || r.status}`);
    }
  } catch (e) { alert("批量操作失败：" + e.message); }
}

/** slug → 已读到的产品对象，用来在列表里显示真实 name/status */
const cache = new Map();

// ═══════════════ 选中 / 读取 ═══════════════
async function select(slug) {
  state.slug = slug; state.isNew = false;
  resetPending();                       // 换产品必须清空待上传，否则上一份的图会跟过来
  $("#deleteBtn").hidden = !state.write?.enabled;
  $("#listView").hidden = true; $("#detailView").hidden = false;
  $("#preview").hidden = true;
  $("#dTitle").textContent = slug;
  $("#dPath").textContent = "读取中…";
  renderList();

  const { status, body } = await api(`/api/products/${encodeURIComponent(slug)}`);
  state.loaded = body;

  if (status === 422) {
    $("#dPath").textContent = body.path || "";
    renderIssues({ ok: false, errors: [{ field: "(文件)", code: "invalid_json", message: body.hint + " " + body.parseError }], warnings: [] });
    $("#viewPane").innerHTML = ""; $("#editPane").hidden = true;
    return;
  }

  const p = body.product || {};
  cache.set(slug, p);
  $("#dTitle").textContent = p.name || slug;
  $("#dPath").textContent = body.path;

  const v = body.validation || { ok: true, errors: [], warnings: [] };
  if (body.slugPathIssue) v.errors = [...v.errors, body.slugPathIssue];
  renderIssues(v);
  renderView(p);
  state.draft = JSON.parse(JSON.stringify(p));
  fillForm(state.draft);
  renderList();
}

function startNew() {
  state.isNew = true; state.slug = null; state.loaded = null;
  resetPending();
  $("#deleteBtn").hidden = true;        // 还不存在的东西没有"删除"可言
  $("#f_slug").readOnly = false;
  $("#listView").hidden = true; $("#detailView").hidden = false; $("#preview").hidden = true;
  $("#dTitle").textContent = "新建产品";
  $("#dPath").textContent = "（保存后会是 " + (state.listMeta?.dir || "…") + "/<slug>.json）";
  renderIssues(null);
  state.draft = { sensors: [], images: {}, status: "draft" };
  fillForm(state.draft);
  switchView("edit");
  renderList();
}

// ═══════════════ 校验结果 ═══════════════
function renderIssues(v) {
  const box = $("#issues"); box.innerHTML = ""; box.className = "issues";
  if (!v) return;
  if (v.ok && !v.warnings.length) {
    box.append(mkIssue("ok", "", "契约校验通过。"));
    return;
  }
  v.errors.forEach((i) => box.append(mkIssue("error", i.field, i.message)));
  v.warnings.forEach((i) => box.append(mkIssue("warn", i.field, i.message)));
}

/**
 * 把 `**粗体**` 渲染成真的粗体，并把文本安全地放进节点。
 *
 * ⚠️ 原来只有 mkNotice 会渲染，mkIssue 直接 textContent —— 于是校验消息里的
 *    `**内部字段**` 在界面上**原样漏出星号**。同一套消息被两个地方用不同方式渲染，
 *    迟早有一边露馅。合并成一个函数，两边不可能再不一致。
 * ⚠️ 用 createTextNode 而不是 innerHTML：消息里会带用户填的值（slug、路径、URL），
 *    拼进 innerHTML 就是把用户输入当 HTML 执行。
 */
function appendMd(node, text) {
  String(text).split(/\*\*(.+?)\*\*/g).forEach((part, i) => {
    node.append(i % 2 ? el("b", null, part) : document.createTextNode(part));
  });
  return node;
}

function mkIssue(kind, field, msg) {
  const d = el("div", `issue issue-${kind}`);
  if (field) d.append(el("span", "issue-field", field));
  return appendMd(d.appendChild(el("span")), msg), d;
}

// ═══════════════ 详情视图 ═══════════════
function renderView(p) {
  const t = el("table", "kvtable");
  const row = (k, valNode, cls) => {
    const tr = el("tr", cls);
    tr.append(el("th", null, k));
    const td = el("td");
    td.append(valNode);
    tr.append(td);
    t.append(tr);
  };
  const txt = (v) => el("span", null, v == null || v === "" ? "—" : String(v));
  const code = (v) => { const c = el("code", null, v); return c; };
  const tags = (arr) => {
    const w = el("div", "taglist");
    (arr || []).forEach((x) => w.append(el("span", "tag", x)));
    if (!arr || !arr.length) w.append(txt(null));
    return w;
  };

  row("slug", code(p.slug || "—"));
  row("name", txt(p.name));
  row("model", code(p.model || "—"));
  row("category", code(p.category || "—"));
  row("sensors", tags(p.sensors));
  row("status", (() => { const b = el("span", `badge badge-${p.status || "unknown"}`, p.status || "?"); return b; })());
  row("moq", txt(p.moq == null ? "面议（未设 moq）" : p.moq));
  row("images.main", code(p.images?.main || "—"));
  row("images.gallery", tags(p.images?.gallery));
  row("highlights", (() => {
    const w = el("div");
    (p.highlights || []).forEach((h) => w.append(el("div", null, "· " + h)));
    if (!p.highlights?.length) w.append(txt(null));
    return w;
  })());
  row("specs", (() => {
    const w = el("div");
    const e = Object.entries(p.specs || {});
    e.forEach(([k, v]) => { const d = el("div"); d.append(code(k), document.createTextNode("  " + v)); w.append(d); });
    if (!e.length) w.append(txt(null));
    return w;
  })());
  if (p.supplierRef) {
    row("supplierRef ⚠️内部", code(p.supplierRef), "internal-row");
  }

  const pane = $("#viewPane"); pane.innerHTML = ""; pane.append(t);
}

// ═══════════════ 表单 ═══════════════
// ═══════════════ 图片 ═══════════════
//
// 🔴 一律在浏览器里转成 WebP 再上传，服务端**只认 WebP 且按文件头判**。
//    收 png/jpg 的话，文件名是 `.webp` 而内容不是 —— 那种错**不会有任何症状**
//    （Astro 和浏览器多半照样显示），直到某天某个按扩展名解析的工具遇上它。
const MAX_UPLOAD = 2 * 1024 * 1024;

async function toWebp(file) {
  if (!/^image\//.test(file.type)) throw new Error("这不是图片文件。");
  const bmp = await createImageBitmap(file);
  // 产品图最长边 1600 足够 —— Astro 的 <Image> 会再出响应式尺寸，源图无需更大
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const cv = document.createElement("canvas");
  cv.width = Math.round(bmp.width * scale);
  cv.height = Math.round(bmp.height * scale);
  cv.getContext("2d").drawImage(bmp, 0, 0, cv.width, cv.height);

  // 逐档降质直到进 2MB。⚠️ 降到底仍超标就**报错，不静默上传**——
  //    静默截断或硬传会让服务端那道 2MB 闸来拒，而那时人已经等了一轮上传。
  for (const q of [0.85, 0.7, 0.55, 0.4]) {
    const blob = await new Promise((r) => cv.toBlob(r, "image/webp", q));
    if (!blob) throw new Error("这个浏览器的 canvas 导不出 WebP。");
    if (blob.size <= MAX_UPLOAD) return { blob, quality: q, w: cv.width, h: cv.height };
  }
  throw new Error("图片降到最低画质仍超过 2MB，请先自行压缩。");
}

const blobToBase64 = (blob) =>
  new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result).split(",")[1]);   // 去掉 data: 前缀
    fr.onerror = () => rej(new Error("读取文件失败"));
    fr.readAsDataURL(blob);
  });

/**
 * 仓内图片的可显示 URL（公开仓，raw 直连）。⚠️ 只用于预览，不是产物里的路径。
 *
 * 🔴 必须带 cache-bust：`raw.githubusercontent.com` 有 ≈300s 的 CDN 缓存。
 *    换了主图、保存成功、界面重新读一遍 —— **路径没变，于是缩略图还是旧图**。
 *    人看到旧图会以为上传没成功，**再传一次** —— 而那一次是真的会再产生一个 commit。
 *    ⇒ 每次成功保存后把 `cacheBust` 换成新的 commit sha，URL 就变了，强制重取。
 */
const rawUrl = (jsonPath) =>
  `https://raw.githubusercontent.com/${state.repo || "zq8345/AirSonde-Web"}/${state.branch || "main"}/src/assets/${jsonPath}`
  + (state.cacheBust ? `?v=${state.cacheBust}` : "");

function setThumb(node, src, alt) {
  node.innerHTML = "";
  if (!src) { node.append(el("span", "thumb-empty", "无图")); return; }
  const img = el("img");
  img.alt = alt || "";
  // 🔴 **不要 loading="lazy"**：renderImages() 是在编辑面板还 `hidden` 的时候跑的，
  //    惰性图在 display:none 的容器里永远不进视口 ⇒ 切到编辑页之后也**不补加载**，
  //    结果是一片空白缩略图。⚠️ 那个症状看起来像"图片路径错了 / raw 地址不可用"，
  //    而实际上 URL 完全正常（裸 new Image() 同一个地址秒开）。
  //    缩略图至多几张，lazy 一点收益都没有，却换来一个查错方向的 bug。
  img.onerror = () => { node.innerHTML = ""; node.append(el("span", "thumb-empty", "取不到")); };
  img.src = src;   // ⚠️ src 放在 onerror 之后：先设 src 的话，缓存命中时错误事件可能已经错过
  node.append(img);
}

/** 把当前草稿 + 待上传的图渲染成缩略图。 */
function renderImages() {
  const p = state.draft || {};
  const pend = state.pending;

  setThumb($("#mainThumb"), pend.main ? pend.main.url : (p.images?.main ? rawUrl(p.images.main) : null), "主图");
  $("#mainImgNote").textContent = pend.main
    ? `待上传：${pend.main.w}×${pend.main.h}，${(pend.main.size / 1024).toFixed(0)}KB（质量 ${pend.main.quality}）`
    : (p.images?.main ? "已有图片。选择新图会替换它，旧文件在同一个 commit 里删除。" : "还没有主图。");

  const box = $("#galleryBox"); box.innerHTML = "";
  (p.images?.gallery || []).forEach((g, i) => {
    const card = el("div", "gcard");
    if (pend.removed.has(i)) card.classList.add("is-removed");
    const t = el("div", "thumb"); setThumb(t, rawUrl(g), g);
    const del = el("button", "gdel", pend.removed.has(i) ? "↩" : "×");
    del.type = "button";
    del.title = pend.removed.has(i) ? "撤销删除" : "删除这张";
    del.onclick = () => { pend.removed.has(i) ? pend.removed.delete(i) : pend.removed.add(i); renderImages(); };
    card.append(del, t, el("span", "gtag", g.split("/").pop()));
    box.append(card);
  });
  pend.gallery.forEach((u, k) => {
    const card = el("div", "gcard is-new");
    const t = el("div", "thumb"); setThumb(t, u.url, "待上传");
    const del = el("button", "gdel", "×"); del.type = "button"; del.title = "取消这张";
    del.onclick = () => { pend.gallery.splice(k, 1); renderImages(); };
    card.append(del, t, el("span", "gtag", `待上传 ${(u.size / 1024).toFixed(0)}KB`));
    box.append(card);
  });
}

async function pickImage(input, target) {
  const file = input.files?.[0];
  input.value = "";                    // 允许连续选同一个文件
  if (!file) return;
  const note = $("#mainImgNote");
  const prev = note.textContent;
  note.textContent = "正在转成 WebP…";
  try {
    const { blob, quality, w, h } = await toWebp(file);
    const rec = { base64: await blobToBase64(blob), url: URL.createObjectURL(blob), size: blob.size, quality, w, h };
    if (target === "main") state.pending.main = rec;
    else state.pending.gallery.push(rec);
    renderImages();
  } catch (e) {
    note.textContent = prev;
    renderIssues({ ok: false, errors: [{ field: "图片", code: "image", message: e.message }], warnings: [] });
  }
}

function repeatRow(container, value) {
  const r = el("div", "repeat-row");
  const i = el("input"); i.value = value || "";
  const d = el("button", "del-row", "×"); d.type = "button"; d.onclick = () => r.remove();
  r.append(i, d); container.append(r);
}
function kvRow(container, k, v) {
  const r = el("div", "kv-row");
  const ik = el("input", "k"); ik.value = k || ""; ik.placeholder = "键";
  const iv = el("input", "v"); iv.value = v || ""; iv.placeholder = "值（字符串）";
  const d = el("button", "del-row", "×"); d.type = "button"; d.onclick = () => r.remove();
  r.append(ik, iv, d); container.append(r);
}

function fillForm(p) {
  $("#f_slug").value = p.slug || "";
  $("#f_slug").readOnly = !state.isNew;   // 改名＝改文件名，本阶段不支持
  $("#f_name").value = p.name || "";
  $("#f_model").value = p.model || "";
  $("#f_category").value = p.category || "";
  $("#f_status").value = p.status || "draft";
  $("#f_moq").value = p.moq == null ? "" : p.moq;
  $("#f_imgmain").value = p.images?.main || "";
  $("#f_supplier").value = p.supplierRef || "";

  $("#f_sensors").querySelectorAll("input").forEach((cb) => { cb.checked = (p.sensors || []).includes(cb.value); });

  const h = $("#f_highlights"); h.innerHTML = ""; (p.highlights || []).forEach((x) => repeatRow(h, x));
  const s = $("#f_specs"); s.innerHTML = ""; Object.entries(p.specs || {}).forEach(([k, v]) => kvRow(s, k, v));
  renderImages();
}

/**
 * 从表单读出补丁。
 *
 * 🔴 空 ≠ 没填。选填字段被清空时送 **null**（＝显式清空），而不是省略它 ——
 *    省略的语义是「我没收到」，服务端会保持原样，于是用户会看到"我明明删了它却还在"。
 *    这两个语义的区别正是契约硬规则 5 那条已经吃过亏的东西，界面这一侧也要守。
 */
function readForm() {
  const nz = (v) => (v.trim() === "" ? null : v.trim());
  const list = (sel) => {
    const a = [...$(sel).querySelectorAll("input")].map((i) => i.value.trim()).filter(Boolean);
    return a.length ? a : null;
  };
  // gallery 现在由缩略图管理，不再是一排文本框；把草稿里的原值原样带回去，
  // 具体搬到哪个目录由服务端的 planImages 决定 —— 前端不拼路径。
  const galleryFromDraft = state.draft?.images?.gallery || null;
  const specs = (() => {
    const o = {};
    $("#f_specs").querySelectorAll(".kv-row").forEach((r) => {
      const k = r.querySelector(".k").value.trim();
      const v = r.querySelector(".v").value.trim();
      if (k) o[k] = v;   // ⚠️ 值为空也保留：让校验器去报错，别在界面上悄悄丢掉一行
    });
    return Object.keys(o).length ? o : null;
  })();

  const sensors = [...$("#f_sensors").querySelectorAll("input:checked")].map((i) => i.value);
  const moqRaw = $("#f_moq").value.trim();
  const gallery = galleryFromDraft;
  const main = nz($("#f_imgmain").value);

  const patch = {
    slug: nz($("#f_slug").value),
    name: nz($("#f_name").value),
    model: nz($("#f_model").value),
    category: nz($("#f_category").value),
    sensors,                                   // 必填，空数组交给校验器报
    status: nz($("#f_status").value),
    moq: moqRaw === "" ? null : Number(moqRaw),
    highlights: list("#f_highlights"),
    specs,
    supplierRef: nz($("#f_supplier").value),
    // images 是个对象：整体送，缺 main 让校验器报
    images: gallery ? { main: main ?? "", gallery } : { main: main ?? "" },
  };
  return patch;
}

/** 组装发给服务端的信封：patch + 待上传 + 待删除。两个端点用同一个函数，形状不可能不一致。 */
function buildEnvelope(extra = {}) {
  const uploads = [];
  if (state.pending.main) uploads.push({ slot: "main", base64: state.pending.main.base64 });
  const galLen = (state.draft?.images?.gallery || []).length;
  state.pending.gallery.forEach((u, k) => uploads.push({ slot: galLen + k, base64: u.base64 }));
  return {
    patch: readForm(),
    uploads,
    removeGallery: [...state.pending.removed],
    ...extra,
  };
}

// ═══════════════ 预览（dry-run）═══════════════
async function doPreview(e) {
  e.preventDefault();
  const btn = $("#previewBtn");
  const slug = state.isNew ? ($("#f_slug").value.trim() || "unnamed") : state.slug;
  btn.disabled = true; btn.textContent = "校验中…";
  try {
    const { body } = await api(`/api/products/${encodeURIComponent(slug)}/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildEnvelope()),
    });
    renderPreview(body);
    renderIssues(body.validation);
  } catch (err) {
    renderIssues({ ok: false, errors: [{ field: "(请求)", code: "failed", message: err.message }], warnings: [] });
    $("#preview").hidden = true;
  } finally {
    btn.disabled = false; btn.textContent = "校验并预览（不会保存）";
  }
}

function renderPreview(r) {
  const box = $("#preview"); box.hidden = false; box.innerHTML = "";
  const wrap = el("div", "preview");

  const head = el("div", "preview-head");
  head.append(el("strong", null, r.target.exists ? "将要改动" : "将要新建"));
  head.append(el("code", null, r.target.path));
  const stat = el("span", "stat");
  stat.append(el("span", "plus", `+${r.change.added}`), document.createTextNode(" "), el("span", "minus", `−${r.change.removed}`));
  head.append(stat);
  head.append(el("span", "stat", `${r.wouldWrite.bytes}B`));
  wrap.append(head);

  // 🔴 三种结论要说不同的话。混成一句"预览完成"，最危险的那种（什么也没变）会被当成成功。
  if (r.change.identical) {
    wrap.append(mkNotice("warn", "内容与现有文件**逐字节相同** —— 这次即使真的保存，也什么都不会改。"));
  } else if (!r.validation.ok) {
    wrap.append(mkNotice("bad", `契约校验未通过（${r.validation.errors.length} 个错误），这份内容不允许写入。上方已逐条列出。`));
  } else {
    wrap.append(mkNotice("ok", state.write?.enabled
      ? "契约校验通过。以下是将要写入的改动 —— **确认无误后再点下面的提交**。"
      : "契约校验通过。以下是将要写入的改动 —— 但当前无法写入。"));
  }

  if (r.change.cleared?.length) {
    wrap.append(mkNotice("warn", `会被**清空**的字段：${r.change.cleared.join("、")}`));
  }

  // 🔴 图片动作必须显式列出来。它们和 JSON 在**同一个 commit** 里，
  //    不列出来的话，人以为自己只改了一个 status，实际上还搬动了几个文件。
  if (r.imageOps?.length) {
    const box = el("div", "notice notice-warn");
    box.append(el("b", null, `图片文件会有 ${r.imageOps.length} 项改动（与 JSON 同一个 commit）：`));
    const ul = el("div");
    const label = { upsert: "写入", copy: "搬动", delete: "删除" };
    r.imageOps.forEach((o) => {
      ul.append(el("div", null, `· ${label[o.op] || o.op} ${o.path.replace(/^src\/assets\//, "")}` +
        (o.fromPath ? ` ← ${o.fromPath.replace(/^src\/assets\//, "")}` : "") + `  —— ${o.why}`));
    });
    box.append(ul);
    wrap.append(box);
  }

  if (!r.change.identical) {
    const d = el("pre", "diff");
    r.diff.forEach((l) => {
      const row = el("div", l.type === "add" ? "l-add" : l.type === "del" ? "l-del" : "");
      const sign = l.type === "add" ? "+" : l.type === "del" ? "−" : " ";
      row.append(el("span", "no", `${l.oldNo ?? ""}  ${l.newNo ?? ""}`));
      row.append(el("span", "tx", `${sign} ${l.text}`));
      d.append(row);
    });
    wrap.append(d);
  }

  // ⚠️ 完整内容必须可取走：本阶段存不了，如果连内容都拿不出来，
  //    人编辑了半小时的东西就真的没了。
  const det = el("details", "raw");
  det.append(el("summary", null, "完整内容（本阶段存不了，可以复制走）"));
  const pre = el("pre", null, r.wouldWrite.text);
  det.append(pre);
  wrap.append(det);

  // ── 提交按钮：**只在真能写、且这份内容确实该写的时候才出现** ──
  // ⚠️ 不做成"永远显示但 disabled"：一个灰着的提交按钮会让人以为"再试试就能点"，
  //    而真实情况是这份内容根本不允许提交。不该出现的东西就不要出现。
  if (state.write?.enabled && r.validation.ok && !r.change.identical) {
    const bar = el("div", "commit-bar");
    const btn = el("button", "primary", `提交到数据仓（${r.target.exists ? "更新" : "新建"} ${r.target.path.split("/").pop()}）`);
    btn.type = "button";
    btn.onclick = () => doCommit(r, btn);
    bar.append(btn);
    bar.append(el("span", "actions-note", "提交会产生一次 commit 并触发 airsonde.com 重建。"));
    wrap.append(bar);
  } else {
    wrap.append(mkNotice("warn", r.note + `（写能力：${r.writeCapability}）`));
  }

  box.append(wrap);
  wrap.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ═══════════════ 真实提交 ═══════════════
async function doCommit(prev, btn) {
  const slug = state.isNew ? ($("#f_slug").value.trim() || "unnamed") : state.slug;
  btn.disabled = true;
  btn.textContent = "提交中…";
  try {
    const r = await fetch(`/api/products/${encodeURIComponent(slug)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildEnvelope({ mustCreate: state.isNew })),
    });
    const b = await r.json().catch(() => null);
    const box = $("#preview");

    if (b?.wrote === true) {
      const ok = el("div", "notice notice-ok");
      ok.append(el("b", null, "已提交。"));
      ok.append(document.createTextNode(` commit `));
      const a = el("a", null, b.commitSha.slice(0, 7));
      a.href = b.commitUrl; a.target = "_blank"; a.rel = "noopener";
      ok.append(a);
      ok.append(document.createTextNode(`  ·  ${b.bytes}B  ·  字节校验通过（blob ${b.blobSha.slice(0, 7)}）`));
      box.prepend(ok);
      // ⚠️ 必须说清楚"线上还没变" —— 不说的话，人会立刻去刷 airsonde.com，
      //    看到旧内容，然后以为没保存成功，于是**再存一次**。
      box.prepend(mkNotice("warn", "官网重建需要一两分钟。**现在去刷 airsonde.com 看到的仍是旧内容，这不是没保存成功。**"));
      btn.remove();
      // 🔴 待上传清单必须清空：不清的话，下一次保存会把同一批图**再传一遍**，
      //    而且如果这时切到别的产品，这批图会落到那个产品名下。
      resetPending();
      state.cacheBust = b.commitSha;   // ← 换掉图片 URL 的指纹，打穿 raw 的 CDN 缓存
      // 重新读一次：拿到新的 blob sha 与归一化后的图片路径，否则下一次编辑带着过期状态提交。
      await loadList();
      await select(slug);
    } else if (r.status === 409) {
      box.prepend(mkNotice("bad", `**并发冲突**：${b.detail}`));
      btn.disabled = false; btn.textContent = "重新提交";
    } else if (b?.wrote === "unknown") {
      // 🔴 这一条绝不能说成"保存失败" —— commit 可能已经产生了，说失败会让人再存一次。
      box.prepend(mkNotice("bad", `**状态未知，需要人工核对**：${b.detail}`));
    } else {
      box.prepend(mkNotice("bad", `**未提交**（没有产生 commit）：${b?.detail || b?.reason || b?.error || r.status}`));
      btn.disabled = false; btn.textContent = "重新提交";
    }
  } catch (e) {
    $("#preview").prepend(mkNotice("bad", "提交请求失败：" + e.message));
    btn.disabled = false; btn.textContent = "重新提交";
  }
}

function mkNotice(kind, msg) {
  return appendMd(el("div", `notice notice-${kind}`), msg);
}

// ═══════════════ 视图切换 / 事件 ═══════════════
function switchView(v) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("is-on", t.dataset.view === v));
  $("#viewPane").hidden = v !== "view";
  $("#editPane").hidden = v !== "edit";
}

document.querySelectorAll(".tab").forEach((t) => { t.onclick = () => switchView(t.dataset.view); });
$("#q").oninput = renderList;
$("#catFilter").onchange = renderList;
$("#newBtn").onclick = startNew;
$("#backBtn").onclick = () => {
  $("#detailView").hidden = true; $("#listView").hidden = false;
  state.slug = null; state.isNew = false; resetPending(); $("#preview").hidden = true;
  renderList();
};
// ⚠️ 全选只选**当前筛选结果**，不是全部 23 个 —— 筛完再全选却选中看不见的行，是最容易误操作的一种
$("#ckAll").onchange = (e) => {
  const rows = filteredRows().filter((r) => !r.error);
  rows.forEach((r) => e.target.checked ? state.selected.add(r.slug) : state.selected.delete(r.slug));
  renderList();
};
$("#batchClear").onclick = () => { state.selected.clear(); renderList(); };
document.querySelectorAll("[data-bulk]").forEach((b) => {
  b.onclick = () => bulk([...state.selected], b.dataset.bulk);
});
$("#editPane").onsubmit = doPreview;
$("#resetBtn").onclick = () => { resetPending(); if (state.draft) fillForm(state.draft); $("#preview").hidden = true; };
document.querySelectorAll(".add[data-add]").forEach((b) => {
  b.onclick = () => {
    if (b.dataset.add === "specs") kvRow($("#f_specs"), "", "");
    else repeatRow($("#f_highlights"), "");
  };
});
$("#f_mainfile").onchange = (e) => pickImage(e.target, "main");
$("#f_galfile").onchange = (e) => pickImage(e.target, "gallery");

// status 改了 ⇒ 图片路径会跟着搬家，立刻在界面上说出来，别等到预览才让人发现
$("#f_status").addEventListener("change", () => {
  const dir = $("#f_status").value === "published" ? "products/" : "products/_draft/";
  $("#mainImgNote").textContent = `⚠️ status 改为 ${$("#f_status").value} ⇒ 保存时图片会搬到 ${dir}（在同一个 commit 里）。`;
});

// ── 删除：二次确认要求打出 slug 本身 ──
// ⚠️ 不用"你确定吗"那种确认框：它训练人闭着眼睛点确定。要求打出名字，是让手停一下。
$("#deleteBtn").onclick = async () => {
  const slug = state.slug;
  if (!slug) return;
  const typed = prompt(`删除会同时删掉这个产品的 JSON 和它的图片，并触发官网重建。\n\n确认请输入 slug：\n${slug}`);
  if (typed !== slug) { if (typed !== null) alert("输入不匹配，已取消。"); return; }
  const btn = $("#deleteBtn"); btn.disabled = true; btn.textContent = "删除中…";
  try {
    const r = await fetch(`/api/products/${encodeURIComponent(slug)}`, { method: "DELETE" });
    const b = await r.json().catch(() => null);
    if (b?.wrote === true) {
      $("#detailView").hidden = true; $("#listView").hidden = false;
      state.slug = null; cache.delete(slug); state.selected.delete(slug); resetPending();
      state.cacheBust = b.commitSha;
      await loadList();
      alert(`已删除。commit ${String(b.commitSha).slice(0, 7)}\n${b.note || ""}`);
    } else {
      alert(`未删除：${b?.detail || b?.error || r.status}`);
    }
  } catch (e) {
    alert("删除请求失败：" + e.message);
  } finally {
    btn.disabled = false; btn.textContent = "删除这个产品…";
  }
};

// ── 起步 ──
(async () => {
  await loadWho();
  try {
    await loadContract();
    await loadList();
  } catch (e) {
    $("#listEmpty").hidden = false;
    $("#listEmpty").textContent = "加载失败：" + e.message;
  }
})();

