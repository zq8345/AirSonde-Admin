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
  /** 人是否动过 slug。⚠️ 显式标记，不靠比值猜 —— 见 f_slug 的 input 监听。 */
  slugTouched: false,
  /** A10-R1：单一图片列表。第一项就是主图。见 renderImages()。 */
  imgList: [],
  dragFrom: null,
  // 🔴 写能力是**服务端告诉我们的事实**，不是前端的一个开关。
  //    null = 还没问到。在问到之前界面不该假装知道自己能不能写。
  write: null,      // { enabled, gateOpen, tokenConfigured }
  lastPreview: null,
  repo: null, branch: null,
  tab: "all",                 // 状态 tab：all | published | draft
  nav: "products",            // 左导航当前视图：products | media
  media: null, mediaTab: "all",
  audit: null,
  cats: null,       // /api/categories：枚举 + 官网显示名（计数不在里面，见 renderCats）
  who: null,        // /api/_whoami 的完整响应 —— 设置页整页由它渲染
  // 站点内容：首页/联系方式/SEO 三个视图共用**同一个 JSON**
  site: null,       // 服务端那一版（含 sha —— 保存时当乐观锁）
  siteDraft: null,  // 编辑中的那一份
  siteBase: null,   // 打开时的那一份：改动计数比的是它，不是"敲过几下键盘"
  siteSection: "home",
  /** /api/_whoami 报回来的部署警告 —— 有它就必须显示横幅（见 applyWriteMode）。 */
  deployWarnings: [],
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
    // ⚠️ warnings 不是给日志看的，是给正在用后台的人看的。
    // 🔴 A12-1 撤掉常驻横幅时**差点把这些一起藏掉** —— 它们（GIT_SHA 未注入 / 部署时工作区是脏的）
    //    正是"这一版不可信"的信号，属于**真警告**，不是那条被撤掉的装饰性红字。
    //    ⇒ 记下来，让 applyWriteMode 决定显隐时把它算进去。
    state.deployWarnings = w.warnings || [];
    if (state.deployWarnings.length) {
      $("#banner").append(el("span", "banner-why", "⚠️ " + state.deployWarnings.join("；")));
      $("#bannerTitle").textContent = "这一版有问题";
      $("#bannerText").textContent = "下面这些是部署本身的警告，不是你操作出的错。";
    }
    state.who = w;          // 设置页整页由它渲染 —— 不为同一份事实开第二个端点
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
    // 问不到服务端 ⇒ 这条必须看得见（横幅默认可见，这里显式再兜一次，防止别处藏过它）
    $("#banner").hidden = false;
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

  // ══ A12-1：能写的时候**不再常驻横幅**（Joe 当面定）══
  //
  // 它当初是防"以为在沙盒里点着玩"。Joe 现在天天用这个后台，那条红字已经变成噪音 ——
  // **一条永远亮着的警告和没有警告是一回事**，它只会把真正该看的东西挤下去。
  // ⛔ 只撤显示面，**判定逻辑一个字没动**：writeEnabled 仍是真闸，
  //    删除按钮 / 提交按钮 / 批量条照旧由它决定。
  // 🔴 写不了的时候**仍然要吼**（下面 else 分支）—— 那才是这条横幅真正的用处：
  //    "我改了半天存不进去"必须当场有解释，而不是等人自己发现提交按钮不出现。
  // ⚠️ 有部署警告时**照样显示** —— 那不是被撤掉的那条装饰红字，那是真警告。
  if (w.enabled) {
    banner.hidden = !(state.deployWarnings || []).length;
    $("#actionsNote").textContent = "先校验预览，确认 diff 之后才会出现提交按钮。";
  } else {
    banner.hidden = false;
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

  // 批量改机型的选项来自**契约**（/api/contract），不是从现有数据里长出来的：
  // ⚠️ 从数据里长的话，一个还没有任何产品的分类就永远选不到 —— 而"把第一个产品挪进空分类"
  //    恰恰是这个下拉唯一能做、别处做不了的事。
  const sel = $("#bulkCat");
  if (sel && !sel.dataset.filled && state.contract?.categories?.length) {
    state.contract.categories.forEach((k) => sel.append(new Option(k, k)));
    sel.dataset.filled = "1";
  }
}

/** 批量改字段。单行的"上架/下架"也走这里 —— 一条路径，行为不可能分叉。 */
async function bulk(slugs, value, op = "status") {
  if (!slugs.length) return;
  const verb = op === "category" ? `改机型为 ${value}` : (value === "published" ? "上架" : "下架");
  if (!confirm(`确认把 ${slugs.length} 个产品${verb}？\n\n会产生一次 commit 并触发官网重建。`)) return;
  try {
    const r = await fetch("/api/products/batch", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ slugs, op, value }),
    });
    const b = await r.json().catch(() => null);
    if (b?.wrote === true) {
      state.cacheBust = b.commitSha;
      state.selected.clear();
      await loadList();
      if (state.cats) renderCats();          // 分类页的计数与列表同源，改完要一起变
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
  // 编辑一个已存在的产品：**不简化**，全部展开。slug 也不再跟随标题（它已经是 URL 了）。
  state.slugTouched = true;
  setFormMode(false);
  renderList();
}

/**
 * 新建态 / 编辑态的**唯一开关**（A10-A）。
 *
 * 🔴 只有一张表，靠这里决定展开程度 —— 不复制成两张：
 *    复制的话，以后加一个字段要在两处加，而第二处一定会漏，
 *    症状是"新建出来的产品少一个字段"，很久都不会有人发现。
 *
 * · 新建：选填项收起（<details> 关着）、**status 整块不出现**（固定 draft）
 * · 编辑：全部展开 —— 人是冲着某个具体字段来的，简化反而害他
 */
function setFormMode(isNew) {
  const pane = $("#editPane");
  pane.classList.toggle("is-new", isNew);
  pane.classList.toggle("is-edit", !isNew);
  // status 只在编辑态出现：新建的东西必然还没核过图，
  // 给一个只有一个正确答案的下拉框 = 制造一次无谓的决策。
  $("#statusCard").hidden = isNew;
  // 编辑态把折叠区**打开**（不是删掉 details —— 结构一份，状态两种）
  document.querySelectorAll("#editPane details.more").forEach((d) => { d.open = !isNew; });
}

/** 标题 → slug。⚠️ 只做能确定的事：小写、非法字符换连字符、去掉首尾与重复连字符。 */
function slugify(s) {
  return String(s || "").toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function startNew() {
  state.isNew = true; state.slug = null; state.loaded = null;
  resetPending();
  state.slugTouched = false;            // 新建时 slug 跟随标题，直到人自己动它
  $("#deleteBtn").hidden = true;        // 还不存在的东西没有"删除"可言
  $("#f_slug").readOnly = false;
  $("#listView").hidden = true; $("#detailView").hidden = false; $("#preview").hidden = true;
  $("#dTitle").textContent = "新建产品";
  $("#dPath").textContent = "（保存后会是 " + (state.listMeta?.dir || "…") + "/<slug>.json）";
  renderIssues(null);
  state.draft = { sensors: [], images: {}, status: "draft" };
  fillForm(state.draft);
  setFormMode(true);
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
// ═══ A10-R1：单一图片列表，**第一张就是主图** ═══
//
// state.imgList 的每一项是二者之一：
//   { kind:"have", path }  —— 仓里已有的图
//   { kind:"new",  base64, url, size, quality, w, h } —— 本次待上传
// 保存时映射：list[0] → images.main、list[1..] → images.gallery。**契约不动。**
//
// ⛔ 明确不学 wanew 的四点（派单逐条给了理由）：
//    ① 不在 dragover 里整块 innerHTML 重绘（每秒几十次，会打断正在输入的框）
//       ⇒ 这里 dragover 只改一个 class，**换位才重绘**
//    ② 不用内联字符串事件处理器 —— 全部 el() 建节点 + 属性赋事件
//    ③ 删图**要确认**（尤其封面）
//    ④ **不做每张图的 alt 输入框** —— AirSonde 的 alt 从 name 派生，契约的 gallery 是
//       string[] 没有 alt 的位置。做了就是第二个 moq，而这一单正在删掉第一个。

/** 从草稿重建列表 —— 编辑一个产品或还原时调用。 */
function imgListFromDraft(p) {
  const out = [];
  if (p?.images?.main) out.push({ kind: "have", path: p.images.main });
  (p?.images?.gallery || []).forEach((g) => out.push({ kind: "have", path: g }));
  return out;
}

function renderImages() {
  // 图片增删改后同步刷新 sticky 条的计数（这里是所有图片变化的汇合点）
  setTimeout(() => { try { updateDirty(); } catch {} }, 0);
  const box = $("#imgList");
  if (!box) return;
  // ⚠️ 只清卡片，**不能 innerHTML=""** —— 那会把「＋」那一格连同它里面的
  //    <input type=file> 一起销毁，而事件就绑在那个 input 上（A12-5）。
  //    销毁重建的话绑定要么丢失、要么每次都得重绑 —— 那正是 wanew「整块重绘」的病。
  box.querySelectorAll(".icard").forEach((n) => n.remove());
  const addTile = $("#imgDrop");
  const list = state.imgList || [];

  list.forEach((it, i) => {
    const card = el("div", "icard" + (it.kind === "new" ? " is-new" : ""));
    card.draggable = true;
    card.dataset.i = String(i);

    const t = el("div", "thumb");
    setThumb(t, it.kind === "have" ? rawUrl(it.path) : it.url, it.kind === "have" ? it.path : "待上传");
    card.append(t);

    // i===0 就是主图 —— 角标不是装饰，它是这条规则**唯一**的可见处
    if (i === 0) card.append(el("span", "icover", "封面"));

    const del = el("button", "idel", "×");
    del.type = "button";
    del.title = i === 0 ? "删除封面" : "删除这张";
    del.onclick = (e) => {
      e.stopPropagation();
      // ⚠️ 删图要确认（wanew 那边是直接 splice）。封面单独说，因为它的后果不一样。
      const what = it.kind === "new" ? "这张还没上传的图" : it.path.split("/").pop();
      const msg = i === 0
        ? `删除封面「${what}」？\n\n删掉后**下一张会自动成为封面**。保存时仓里的旧文件会被删除。`
        : `删除「${what}」？\n\n保存时仓里的文件会被删除。`;
      if (!confirm(msg)) return;
      state.imgList.splice(i, 1);
      renderImages();
    };
    card.append(del);

    card.append(el("span", "itag", it.kind === "new"
      ? `待上传 ${(it.size / 1024).toFixed(0)}KB`
      : it.path.split("/").pop()));

    // ── 拖拽换位 ──
    card.addEventListener("dragstart", (e) => {
      state.dragFrom = i;
      card.classList.add("is-dragging");
      e.dataTransfer.effectAllowed = "move";
      // ⚠️ 必须 setData，否则 Firefox 不认这是一次拖拽
      e.dataTransfer.setData("text/plain", String(i));
    });
    card.addEventListener("dragend", () => { card.classList.remove("is-dragging"); state.dragFrom = null; });
    card.addEventListener("dragover", (e) => {
      if (state.dragFrom == null) return;    // 拖的是文件，不是卡片 —— 交给下面的投放区
      e.preventDefault();
      card.classList.add("is-over");          // ⭐ 只改一个 class，**不重绘**
    });
    card.addEventListener("dragleave", () => card.classList.remove("is-over"));
    card.addEventListener("drop", (e) => {
      if (state.dragFrom == null) return;
      e.preventDefault(); e.stopPropagation();
      card.classList.remove("is-over");
      const from = state.dragFrom, to = i;
      if (from === to) return;
      const [moved] = state.imgList.splice(from, 1);
      state.imgList.splice(to, 0, moved);
      state.dragFrom = null;
      renderImages();                          // 换位了才重绘
    });

    // ⚠️ 插在「＋」那一格**之前**，它永远是最后一格
    box.insertBefore(card, addTile);
  });

  const note = $("#mainImgNote");
  if (note) note.textContent = list.length ? "" : "还没有图片。第一张会成为封面（主图）。";
}

/** 把一批文件转成 WebP 并追加到列表末尾。多选、拖文件进来都走这里。 */
async function addImageFiles(files) {
  const arr = [...(files || [])];
  if (!arr.length) return;
  // ⚠️ 投放区是**整个网格**，不只那一格 —— 派单明确要求。
  //    只绑那一格的话，人把文件拖到缩略图之间会毫无反应，而那看起来像拖拽坏了。
  // 进度显示在「＋」那一格里 —— 就在人刚点过的地方，不用他去别处找。
  // ⚠️ 转 WebP 是会卡几秒的一段，多选十几张更明显。不报进度的话，
  //    人会以为点了没反应，然后再点一次。
  const tile = $("#imgDrop");
  const plus = tile ? tile.querySelector(".iadd-plus") : null;
  const setTip = (t) => { if (plus) plus.textContent = t; };
  if (tile) tile.dataset.busy = "1";
  setTip(`0/${arr.length}`);
  try {
    for (let k = 0; k < arr.length; k++) {
      const { blob, quality, w, h } = await toWebp(arr[k]);
      state.imgList.push({
        kind: "new", base64: await blobToBase64(blob),
        url: URL.createObjectURL(blob), size: blob.size, quality, w, h,
      });
      setTip(`${k + 1}/${arr.length}`);
      renderImages();
    }
  } catch (e) {
    renderIssues({ ok: false, errors: [{ field: "图片", code: "image", message: e.message }], warnings: [] });
  } finally {
    if (tile) delete tile.dataset.busy;
    setTip("＋");
  }
}

// ⚠️ 旧的 pickImage(input, "main"|"gallery") 已删除：A10-R1 之后只有一个列表，
//    "主图"和"更多图片"不再是两个入口 —— 留着它就是留一条**没人走但仍能写 state 的**路径。
//    上传统一走 addImageFiles()。

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
  // ⚠️ moq 的输入框已撤（A10-C：它是死字段，官网渲染层 0 处引用）。
  //    **契约字段没动**，现存值也不会被碰 —— 见 readForm 里那段。
  $("#f_imgmain").value = p.images?.main || "";
  $("#f_supplier").value = p.supplierRef || "";

  $("#f_sensors").querySelectorAll("input").forEach((cb) => { cb.checked = (p.sensors || []).includes(cb.value); });

  const h = $("#f_highlights"); h.innerHTML = ""; (p.highlights || []).forEach((x) => repeatRow(h, x));
  const s = $("#f_specs"); s.innerHTML = ""; Object.entries(p.specs || {}).forEach(([k, v]) => kvRow(s, k, v));
  // 🔴 每次填表都从草稿**重建**图片列表：留着上一个产品的列表会把它的图带到这一个身上
  state.imgList = imgListFromDraft(p);
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
  const gallery = galleryFromDraft;
  const main = nz($("#f_imgmain").value);

  const patch = {
    slug: nz($("#f_slug").value),
    name: nz($("#f_name").value),
    model: nz($("#f_model").value),
    category: nz($("#f_category").value),
    sensors,                                   // 必填，空数组交给校验器报
    status: nz($("#f_status").value),
    // 🔴 **`moq` 这个键完全不出现** —— 这不是省事，是唯一正确的做法：
    //    送 `null` 的语义是「显式清空」，那会把现存产品的 moq 静默抹掉；
    //    键不出现的语义是「我没收到」，mergeProduct 会保持原样。
    //    输入框撤了 ≠ 数据该被清掉。（A10 验收第 4 条量的就是这件事：diff 里不许有 -"moq"。）
    highlights: list("#f_highlights"),
    specs,
    supplierRef: nz($("#f_supplier").value),
    // images 是个对象：整体送，缺 main 让校验器报
    images: gallery ? { main: main ?? "", gallery } : { main: main ?? "" },
  };
  return patch;
}

/**
 * 组装发给服务端的信封：patch + 待上传。两个端点用同一个函数，形状不可能不一致。
 *
 * ═══ A10-R1：单一列表 → 契约形状的映射就在这里，**只有这一处** ═══
 * list[0] → images.main，list[1..] → images.gallery。
 * 新上传的那一位在 gallery 里送 **null 占位** + 一条 slot=该下标的 upload ——
 * 这样"新图排在第 2 位"能被原样表达，而不是被迫排到末尾。
 * ⚠️ 不再送 removeGallery：删掉 = 它不在列表里了。服务端按"最终引用集合"兜底删孤儿。
 */
function buildEnvelope(extra = {}) {
  const list = state.imgList || [];
  const uploads = [];
  const patch = readForm();

  const first = list[0];
  const rest = list.slice(1);
  if (first?.kind === "new") uploads.push({ slot: "main", base64: first.base64 });
  rest.forEach((it, i) => { if (it.kind === "new") uploads.push({ slot: i, base64: it.base64 }); });

  patch.images = {
    // 新封面的路径由服务端算（planImages），这里给空串占位
    main: first ? (first.kind === "have" ? first.path : "") : "",
    ...(rest.length ? { gallery: rest.map((it) => (it.kind === "have" ? it.path : null)) } : {}),
  };

  return { patch, uploads, ...extra };
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
// 搜索框常驻顶栏 ⇒ 在别的视图里也看得见。
// ⚠️ 不切视图的话，人在设置页打字会**什么都不发生** —— 而那看起来像搜索坏了。
$("#q").oninput = () => {
  if (state.nav !== "products") showNav("products");
  renderList();
};
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
// ⚠️ 选完立刻回到占位项：不回的话，下拉停在刚用过的值上，看起来像"当前筛选是它"。
$("#bulkCat").onchange = (e) => {
  const v = e.target.value; e.target.value = "";
  if (v) bulk([...state.selected], v, "category");
};
$("#editPane").onsubmit = doPreview;
$("#resetBtn").onclick = () => { resetPending(); if (state.draft) fillForm(state.draft); $("#preview").hidden = true; };
document.querySelectorAll(".add[data-add]").forEach((b) => {
  b.onclick = () => {
    if (b.dataset.add === "specs") kvRow($("#f_specs"), "", "");
    else repeatRow($("#f_highlights"), "");
  };
});
// ═══════════════ A8 媒体库 ═══════════════
//
// ⛔ **只报告，绝不提供"一键清理孤儿"。** 判错一张在用的图 = 官网当场缺图，而删除不可逆。
//    要删就去那个产品的编辑页逐张确认 —— 多点两下，换的是"删错了没法撤"这件事不会发生。
async function loadMedia() {
  const grid = $("#mediaGrid"); grid.innerHTML = "";
  $("#mediaSummary").innerHTML = '<div class="notice notice-warn">读取中…</div>';
  try {
    const { body } = await api("/api/media");
    state.media = body;
    renderMedia();
  } catch (e) {
    $("#mediaSummary").innerHTML = "";
    $("#mediaSummary").append(mkNotice("bad", "读取失败：" + e.message));
  }
}

function renderMedia() {
  const m = state.media; if (!m) return;
  $("#navMediaCount").textContent = String(m.total);

  const sum = $("#mediaSummary"); sum.innerHTML = "";
  // 🔴 对账不成立 ⇒ 这次扫描本身有问题，结论不可用。放最前面，红着说。
  if (!m.reconciled) sum.append(mkNotice("bad", "🔴 **对账不成立**（被引用 + 孤儿 ≠ 总数）—— 本次扫描结果不可用。"));
  // 🔴 有产品读不出来 ⇒ 它声明的引用看不见 ⇒ 那些图会被误判成孤儿
  if (!m.orphansTrustworthy) sum.append(mkNotice("bad", m.note));
  sum.append(mkNotice(m.orphans ? "warn" : "ok",
    `在用 **${m.referenced}** · 未被引用 **${m.orphans}** · 原图存档 **${m.archived}**（有意保留，不算孤儿）· 共 ${m.total} 张` +
    (m.missing?.length ? ` · ⚠️ 产品声明了但仓里没有：**${m.missing.length}** 处` : "")));
  if (m.missing?.length) {
    // ⚠️ 这是与孤儿**相反**的一种病：不是"图没人要"，是"要的图不在"。修法也不同。
    sum.append(mkNotice("bad", "以下引用指向不存在的文件（官网会缺图）：" +
      m.missing.map((x) => `${x.slug} → ${x.rel}`).join("；")));
  }

  const tabs = $("#mediaTabs"); tabs.innerHTML = "";
  const defs = [["all", "全部", m.total], ["orphan", "未被引用", m.orphans],
                ["originals", "原图存档", m.archived],
                ["published", "在线", m.files.filter((f) => f.area === "published").length],
                ["draft", "草稿", m.files.filter((f) => f.area === "draft").length]];
  defs.forEach(([k, label, n]) => {
    const b = el("button", "stab" + (state.mediaTab === k ? " is-on" : "")); b.type = "button";
    b.append(document.createTextNode(label), el("span", "stab-n", String(n)));
    b.onclick = () => { state.mediaTab = k; renderMedia(); };
    tabs.append(b);
  });

  const rows = m.files.filter((f) => {
    if (state.mediaTab === "orphan") return f.referencedBy.length === 0 && f.area !== "originals";
    if (["published","draft","originals"].includes(state.mediaTab)) return f.area === state.mediaTab;
    return true;
  });

  const grid = $("#mediaGrid"); grid.innerHTML = "";
  rows.forEach((f) => {
    const card = el("div", "gcard mcard");
    if (!f.referencedBy.length) card.classList.add("is-orphan");
    const t = el("div", "thumb"); setThumb(t, rawUrl(f.rel), f.rel);
    card.append(t);
    card.append(el("span", "gtag", f.rel.replace(/^products\//, "").replace(/^_draft\//, "")));
    const use = el("span", "gtag");
    if (f.referencedBy.length) {
      use.textContent = "用于 " + f.referencedBy.join("、");
      // 点一下直接跳到引用它的产品 —— 想删它就得从那里改
      card.style.cursor = "pointer";
      card.onclick = () => { showNav("products"); select(f.referencedBy[0]); };
    } else {
      use.textContent = "未被引用";
      use.style.color = "var(--warn)";
    }
    card.append(use, el("span", "gtag", `${(f.size / 1024).toFixed(0)}KB · ${f.area}`));
    grid.append(card);
  });

  const empty = $("#mediaEmpty");
  empty.hidden = rows.length > 0;
  if (!rows.length) empty.textContent = state.mediaTab === "orphan" ? "没有未被引用的图片 —— 干净。" : "没有匹配的图片。";
}

// ═══════════════ 站点内容：首页 / 联系方式 / SEO ═══════════════
//
// 三个视图编辑**同一个 JSON**，每次只提交自己那一节（section）。
// 🔴 只提交自己那一节 ⇒ 服务端的合并必须把"没收到的字段"当成"不动"。
//    当成"清空"的话，保存联系方式就会把首页文案抹掉，而两边都显示保存成功。
// ⚠️ 字段清单不是我照着源码列的，是**照产出页实测过**的：每一条都在构建产物里
//    渲染得出来。渲染不出来的（那两个 heading、整个 CAPABILITIES）**故意没放进来**。
const SITE_SECTIONS = {
  home: { title: "首页文案", key: "home" },
  contact: { title: "联系方式", key: "contact" },
  seo: { title: "站级 SEO", key: "seo" },
};

async function loadSite(which) {
  state.siteSection = which;
  $("#siteTitle").textContent = SITE_SECTIONS[which].title;
  $("#siteNotes").innerHTML = '<div class="notice notice-warn">读取中…</div>';
  $("#siteForm").innerHTML = "";
  // ⚠️ 读取期间必须**禁用**保存：一个空表单配一个看起来可点的保存按钮，
  //    会让人以为"这里本来就是空的、存一下就好"。（点了其实是空转，但界面不该这么说话。）
  state.site = null; state.siteDraft = null; state.siteBase = null;
  const btn = $("#siteSave"); btn.disabled = true; btn.textContent = "读取中…";
  try {
    const { status, body } = await api("/api/site-content");
    if (status === 404 || status === 422) {
      state.site = null;
      $("#siteNotes").innerHTML = "";
      $("#siteNotes").append(mkNotice("bad", `读不到站点内容：${body.hint || body.error || status}`));
      btn.textContent = "保存";   // 仍然 disabled —— 读不到就绝不允许写
      return;
    }
    state.site = body;
    renderSite();
  } catch (e) {
    $("#siteNotes").innerHTML = "";
    $("#siteNotes").append(mkNotice("bad", "读取失败：" + e.message));
  }
}

/** 表单控件：一行 label + input/textarea，带说明。值写回 state.siteDraft。 */
function siteField(parent, path, label, hint, opts = {}) {
  const wrap = el("div", "field");
  const id = "sf_" + path.replace(/\W/g, "_");
  const lab = el("label", null, label); lab.htmlFor = id;
  wrap.append(lab);
  const cur = path.split(".").reduce((o, k) => (o == null ? o : o[k]), state.siteDraft) ?? "";
  const input = el(opts.multiline ? "textarea" : "input");
  input.id = id; input.value = cur;
  if (opts.multiline) input.rows = opts.rows || 3;
  input.oninput = () => {
    // 写回草稿：一路建出中间对象，缺哪层补哪层
    const parts = path.split("."); let o = state.siteDraft;
    for (let i = 0; i < parts.length - 1; i++) o = (o[parts[i]] ??= {});
    o[parts[parts.length - 1]] = input.value;
    updateSiteDirty();
  };
  wrap.append(input);
  if (opts.counter) {
    const cnt = el("div", "shint");
    const paint = () => {
      const n = input.value.trim().length;
      cnt.textContent = `${n} / ${opts.counter} 字符${n > opts.counter ? "（超出会在搜索结果里被截断）" : ""}`;
      cnt.style.color = n > opts.counter ? "var(--warn)" : "";
    };
    input.addEventListener("input", paint); paint();
    wrap.append(cnt);
  }
  if (hint) wrap.append(appendMd(el("p", "hint"), hint));
  parent.append(wrap);
}

function siteCard(title, sub) {
  const s = el("section", "card");
  const h = el("h3", null, title);
  if (sub) h.append(el("span", "h3sub", " " + sub));
  s.append(h);
  return s;
}

/**
 * @param keepDraft true = 重画界面但**保留当前草稿**（增删卖点卡时用）。
 *   ⚠️ 默认 false：每次进视图都从服务端那份重新拷一份草稿 ——
 *      留着上次的草稿会让人在**旧数据**上继续编辑，然后把旧值存回去。
 */
function renderSite(keepDraft = false) {
  const b = state.site; if (!b) return;
  if (!keepDraft) {
    state.siteDraft = JSON.parse(JSON.stringify(b.content));
    state.siteBase = JSON.parse(JSON.stringify(b.content));
  }

  const notes = $("#siteNotes"); notes.innerHTML = "";
  if (!state.write?.enabled) notes.append(mkNotice("warn", "当前**不能保存**（写入闸或 token 未就绪）——改动不会提交。"));
  notes.append(mkNotice("ok",
    `真源：官网仓 ${b.path}。保存 = 一次 commit ⇒ Cloudflare Pages 重建 ⇒ **约 1 分钟后**站上可见。` +
    `**保存成功不等于站上已经变了**，中间隔着一次构建。`));

  const form = $("#siteForm"); form.innerHTML = "";
  const sec = state.siteSection;

  if (sec === "contact") {
    const c = siteCard("联系数据", "站上的链接由它们派生");
    siteField(c, "contact.email", "邮箱", "页面上的 **mailto:** 链接由它拼出来。写错 = 死链接，而页面看不出异常。");
    siteField(c, "contact.phone", "电话", "🔴 **WhatsApp 与拨号链接都由这一个号码派生**（wa.me / tel:）。所以号码只存这一处，不可能出现「号码改了链接没改」。建议以 + 和国家码开头。");
    siteField(c, "contact.wechatId", "微信号", "联系页那个「复制微信号」按钮复制的就是它。");
    siteField(c, "contact.address", "地址", "⭐ Google 地图链接**由地址算出来**，不单独存 —— 改了地址，地图自动跟着走。");
    siteField(c, "contact.hours", "营业时间");
    siteField(c, "contact.response", "响应时间");
    form.append(c);
  } else if (sec === "home") {
    const h = siteCard("Hero", "首页第一屏");
    siteField(h, "home.hero.eyebrow", "小标（eyebrow）");
    siteField(h, "home.hero.headline", "大标题（H1）", "⚠️ 这是首页的 H1，搜索引擎最看重的一行。");
    siteField(h, "home.hero.body", "副文案", null, { multiline: true, rows: 2 });
    siteField(h, "home.hero.primaryCtaLabel", "主按钮文字", "⚠️ 只能改**文字**。按钮指向哪里（/contact）留在代码里 —— 链接改错是 404，文案改错只是难看。");
    siteField(h, "home.hero.secondaryCtaLabel", "次按钮文字");
    form.append(h);

    const v = siteCard("卖点卡", "首页那几张小卡");
    const box = el("div", "repeat");
    (state.siteDraft.home.valueProps || []).forEach((_, i) => {
      const row = el("div", "card");
      siteField(row, `home.valueProps.${i}.title`, `第 ${i + 1} 张 · 标题`);
      siteField(row, `home.valueProps.${i}.body`, `第 ${i + 1} 张 · 正文`, null, { multiline: true, rows: 2 });
      const del = el("button", "linkish", "删掉这张"); del.type = "button";
      del.onclick = () => {
        // ⚠️ 数组是整块提交的，所以这里真删一条，保存后站上就少一张卡
        state.siteDraft.home.valueProps.splice(i, 1);
        if (!state.siteDraft.home.valueProps.length) { alert("至少要留一张 —— 全删掉首页那一段会整块空掉。"); state.siteDraft.home.valueProps = state.siteBase.home.valueProps.slice(0, 1); }
        renderSite(true);
      };
      row.append(del);
      box.append(row);
    });
    v.append(box);
    const add = el("button", "add", "+ 加一张"); add.type = "button";
    add.onclick = () => { state.siteDraft.home.valueProps.push({ title: "", body: "" }); renderSite(true); };
    v.append(add);
    form.append(v);

    const o = siteCard("其它段落");
    siteField(o, "home.sections.capabilitiesIntro", "能力段小字");
    siteField(o, "home.contactBlock.title", "首页联系区块 · 标题");
    siteField(o, "home.contactBlock.body", "首页联系区块 · 正文", null, { multiline: true, rows: 2 });
    form.append(o);
  } else {
    const lim = b.limits || { title: 60, description: 160 };
    const d = siteCard("站点默认", "没有单独设置时用这些");
    siteField(d, "seo.defaultTitle", "默认标题", null, { counter: lim.title });
    siteField(d, "seo.defaultDescription", "默认描述", null, { multiline: true, counter: lim.description });
    siteField(d, "seo.organisationDescription", "组织描述", "进 JSON-LD 的 Organization —— AI 与搜索引擎读的是这一条。", { multiline: true });
    form.append(d);

    const p = siteCard("各页", "title 必须互不相同");
    p.append(appendMd(el("p", "hint"),
      "🔴 **两页 title 相同会让官网构建直接失败**（构建时会数唯一 title 数）—— 也就是这次改动根本上不了线。后台会先拦住。" +
      "描述**留空**表示「用站点默认描述」，不是「没有描述」。"));
    Object.entries(b.pages || {}).forEach(([key, url]) => {
      const box = el("div", "card");
      box.append(el("div", "li-sub", url));
      siteField(box, `seo.pages.${key}.title`, `${key} · 标题`, null, { counter: lim.title });
      siteField(box, `seo.pages.${key}.description`, `${key} · 描述`, null, { multiline: true, counter: lim.description });
      p.append(box);
    });
    form.append(p);
  }
  updateSiteDirty();
}

function updateSiteDirty() {
  const changed = siteChangedPaths();
  const btn = $("#siteSave");
  btn.disabled = !changed.length || !state.write?.enabled;
  btn.textContent = changed.length ? `保存（${changed.length} 处改动）` : "保存";
}

/** 与服务端那一版的实际差异 —— 不是"你敲过几下键盘"。 */
function siteChangedPaths() {
  const out = [];
  const walk = (a, b, path) => {
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[k], b[k], path ? `${path}.${k}` : k);
      return;
    }
    if (path) out.push(path);
  };
  const sec = SITE_SECTIONS[state.siteSection]?.key;
  if (!state.siteDraft || !state.siteBase || !sec) return out;
  walk(state.siteBase[sec], state.siteDraft[sec], sec);
  return out;
}

$("#siteSave").onclick = async () => {
  const sec = SITE_SECTIONS[state.siteSection].key;
  const changed = siteChangedPaths();
  if (!changed.length) return;
  if (!confirm(`确认保存 ${changed.length} 处改动？\n\n${changed.join("\n")}\n\n会产生一次 commit 并触发官网重建。`)) return;
  const btn = $("#siteSave"); btn.disabled = true; btn.textContent = "提交中…";
  try {
    const r = await fetch("/api/site-content", {
      method: "PUT", headers: { "content-type": "application/json" },
      // ⚠️ 只提交自己这一节 + 基线 sha（乐观锁）
      body: JSON.stringify({ patch: { [sec]: state.siteDraft[sec] }, expectedSha: state.site.sha, section: sec }),
    });
    const b = await r.json().catch(() => null);
    if (b?.wrote === true) {
      alert(`已提交。commit ${String(b.commitSha).slice(0, 7)}\n改了：${(b.changedFields || []).join(", ")}\n\n${b.note || ""}`);
      await loadSite(state.siteSection);
    } else if (b?.validation && !b.validation.ok) {
      // 🔴 校验不过 = **零 commit**，要说清楚，别让人以为"存了一半"
      alert("未写入任何东西（没有产生 commit）。以下没通过校验：\n\n" +
        b.validation.errors.map((e) => `· ${e.field}：${e.message}`).join("\n"));
    } else {
      alert(`未写入：${b?.detail || b?.reason || b?.error || r.status}`);
    }
  } catch (e) {
    alert("提交失败：" + e.message);
  } finally { updateSiteDirty(); }
};

// ═══════════════ 设置（只读运行口径）═══════════════
//
// ⛔ **一个可写的控件都没有**，这是有意的：这里的每一项都是部署命脉
//    （写入闸、token、允许名单、发布目标）。后台若能改它们，就等于后台能给自己开权限 ——
//    那道闸从此不是闸。改它们要动仓库配置 / secret 并重新部署，那是一次看得见的动作。
//
// 🔴 这一页要回答的是两个真会发生的问题：
//    ①「为什么保存不了」—— 答案是写入闸与 token 的组合，原本散在环境变量和源码注释里。
//    ②「为什么他进不来」—— 答案要区分**两道门**中的哪一道，而症状完全不同。
function renderSettings() {
  const w = state.who;
  const box = $("#settingsBody"); box.innerHTML = "";
  if (!w) { box.append(mkNotice("bad", "拿不到 /api/_whoami —— 这一页的每一项都来自它，因此什么都不显示，而不是显示一堆空格子。")); return; }

  const card = (title, sub) => {
    const s = el("section", "card");
    const h = el("h3", null, title);
    if (sub) h.append(el("span", "h3sub", " " + sub));
    s.append(h);
    return s;
  };
  // 一行：名字 + 值（+ 可选说明）。值用等宽，方便与配置文件逐字比对。
  const row = (parent, k, valNode, hint) => {
    const r = el("div", "srow");
    r.append(el("span", "sk", k));
    const v = el("span", "sv");
    v.append(typeof valNode === "string" ? document.createTextNode(valNode) : valNode);
    r.append(v);
    parent.append(r);
    if (hint) parent.append(appendMd(el("div", "shint"), hint));
  };
  const yes = (t) => el("span", "badge badge-published", t);
  const no = (t) => el("span", "badge badge-draft", t);
  const grid = el("div", "settings-grid");

  // ── ① 写入能力：把「为什么保存不了」拆成它真正的两个因子 ──
  {
    const c = card("写入能力", "「为什么保存不了」看这里");
    row(c, "结论", w.data.writeEnabled ? yes("可以保存") : no("不能保存"),
      "**两个条件缺一不可**：闸开着、且 token 在。界面上的按钮与横幅都由这一个字段决定，不是各写各的文案。");
    row(c, "写入闸 ALLOW_GITHUB_WRITE", w.data.writeGateOpen ? yes("已开") : no("未开"),
      "闸装在**唯一的出站口**（src/github.ts），不在各个端点里。放在端点上的话，端点越加越多，第五个一定会漏。");
    row(c, "GitHub token", w.data.ghTokenConfigured ? yes("已配置") : no("未配置"),
      "⚠️ 只报**有无**，任何界面和接口都不回显它的值，连前缀也不。");
    if (w.request.isLocalDev) {
      row(c, "本机额外一道闸", no("本机只能写靶子仓"),
        "🔴 本机**永远**写不到官网数据仓（zq8345/AirSonde-Web 硬编码在出站闸的黑名单里，不是开关）。" +
        "所以本地看到「可以保存」不代表能改官网 —— 真按下去会被这道闸拦住并说明理由。");
    }
    grid.append(c);
  }

  // ── ② 谁能进来：**两道门**，而这里只看得见一道 ──
  {
    const a = w.access || {};
    const c = card("谁能进来", "两道独立的门");
    row(c, "当前操作人", el("b", null, w.operator || "(无身份)"),
      "来自 Access 的身份头，**伪造不了**（边缘会剥掉客户端自带的 Cf-Access-* 头）。");
    const list = el("div", "sv-list");
    (a.allowlist || []).forEach((e) => list.append(el("span", "chip", e)));
    if (!(a.allowlist || []).length) list.append(el("span", "badge badge-draft", "空 —— 空名单=拒绝所有"));
    row(c, `后台名单（${(a.allowlist || []).length} 人）`, list, a.allowlistSource);
    row(c, "Access 策略名单", no("本后台看不见"), a.accessPolicyNote);
    row(c, "两道门必须一致", "集合相等",
      "Access 放行而这份名单没有 ⇒ 那个人看到 **403**；这份名单有而 Access 没有 ⇒ 那个人**连登录页都过不去**。" +
      "两种症状不同、修的地方也不同，所以不能只补一边。");
    grid.append(c);
  }

  // ── ③ 发布目标：改动最终落到哪、多久上线 ──
  {
    const c = card("发布目标", "改动落到哪里");
    row(c, "数据仓", el("code", null, w.data.repo || "—"));
    row(c, "分支", el("code", null, w.data.branch || "—"));
    row(c, "产品目录", el("code", null, w.data.productsDir || "—"),
      "⚠️ 本后台在官网仓的**写入范围只有这一个目录**。页面、模板、样式、配置都不归它管。");
    const site = el("a", "linkish", "airsonde.com/products/");
    site.href = "https://airsonde.com/products/"; site.target = "_blank"; site.rel = "noopener";
    row(c, "官网", site,
      "链路：后台保存 → 官网仓产生一个 commit → Cloudflare Pages 自动重建 ≈1 分钟 → 站上可见。" +
      "**保存成功 ≠ 站上已经变了**，中间隔着一次构建。");
    grid.append(c);
  }

  // ── ④ 这一版是什么：出事时第一个要问的问题 ──
  {
    const g = w.git, d = w.deploy;
    const c = card("这一版是什么", "联调/排障的第一步");
    const sha = el("span");
    sha.append(el("code", null, g.shortSha || "无 sha"));
    if (g.dirty) sha.append(el("span", "flag-bad", "部署时工作区是脏的"));
    row(c, "代码 commit", sha,
      g.sha ? "" : "⚠️ 没有 sha ⇒ 这次部署不是走 npm run deploy 发的，**无法确认它对应哪个 commit**。");
    row(c, "谁发的", el("code", null, g.deploySource || (w.request.isLocalDev ? "本地 dev" : "未知")),
      "CI 接上后仍出现 local ⇒ 有人绕过了自动部署，而那正是「生产上跑的到底是哪一版」开始说不清的时刻。");
    row(c, "构建时间", el("code", null, g.buildTime || "—"));
    row(c, "平台版本 ID", el("code", null, d.versionId || "（无此绑定）"),
      "**Cloudflare 写的，代码碰不到** —— 三个来源里最伪造不了的一个。" +
      "⚠️ 本地 dev 也有这个 id（每次重载换一个），所以它**不能**用来判断「这是不是生产」，那要看下面的接入节点。");
    row(c, "接入节点", el("code", null, `${w.request.host} · ${w.request.colo || "-"}`));
    grid.append(c);
  }

  // ── ⑤ 契约：数据的形状由它定，不由界面定 ──
  {
    const ct = state.contract;
    const c = card("契约", "数据的形状由它定");
    row(c, "版本", el("code", null, ct?.version || "—"),
      "界面上所有下拉/多选框的选项**都来自它**，前端不抄第二份 —— 抄一份的话契约改了界面不会跟着变，而且看起来一切正常。");
    row(c, "机型", `${ct?.categories?.length ?? "—"} 个（冻结）`,
      "增删或改名要改两个仓的源码并改契约。详见「分类」页。");
    row(c, "传感器", `${ct?.sensors?.length ?? "—"} 种`);
    // ⚠️ 这里不用反引号：appendMd 只认 **粗体**，而给它加反引号语法是危险的 ——
    //    同一个函数还要渲染**用户填的 specs 值**，那些值里出现一个反引号就会被吃掉半句。
    row(c, "状态", (ct?.statuses || []).join(" / ") || "—",
      "**draft 的产品绝不允许出现在构建产物里**；它的图也物理隔离在 products/_draft/（那个子目录不参与打包）。");
    grid.append(c);
  }

  box.append(grid);

  if (w.warnings?.length) box.append(mkNotice("warn", "⚠️ " + w.warnings.join("；")));
  box.append(mkNotice("ok",
    "**这一页全部只读，没有一个可写控件 —— 这是有意的。** 上面每一项都是部署命脉：" +
    "后台若能改它们，就等于后台能给自己开权限，那道闸从此不是闸。" +
    "改它们要动仓库配置 / secret 并重新部署 —— 那是一次看得见、留得下痕迹的动作。"));
}

// ═══════════════ 分类（机型轴）═══════════════
//
// 这一页做三件事，**没有第四件**：
//   ① 每个分类的实况（已上架/草稿/**官网筛选栏上是否出现**）
//   ② 点一行 → 回列表并套上这个分类的筛选（计数与筛选结果**同源**：都出自 state.list）
//   ③ 说清楚为什么这里不能加分类/改名
// ⛔ 不提供"改名/增删分类"：那不是数据，是两个仓的源码 + 契约。放个会报错的按钮比没有更糟。
async function loadCats() {
  $("#catsSummary").innerHTML = '<div class="notice notice-warn">读取中…</div>';
  try {
    const { body } = await api("/api/categories");
    state.cats = body;
    renderCats();
  } catch (e) {
    $("#catsSummary").innerHTML = "";
    $("#catsSummary").append(mkNotice("bad", "读取失败：" + e.message));
  }
}

function renderCats() {
  const c = state.cats; if (!c) return;
  const sum = $("#catsSummary"); sum.innerHTML = "";

  // 🔴 显示名读不到 ⇒ 明说读不到，**不回退到后台自己抄的一份**。
  //    抄一份的话官网改了名这里永远显示旧的，而且没有任何症状。
  if (!c.labels.ok) {
    sum.append(mkNotice("warn",
      `⚠️ 读不到官网的分类显示名（真源：\`${c.labels.path}\`），下表只能显示 slug。原因：${c.labels.why}`));
  }

  // ⭐ 对账：逐分类计数之和必须等于产品总数。
  //    不等 ⇒ 有产品的 category 不在契约枚举里，而那种产品在这张表上**根本不出现**——
  //    一张"看起来完整"的表把它藏掉了。宁可红着说，也不要静默漏。
  const known = new Set(c.categories.map((x) => x.slug));
  const good = state.list.filter((p) => !p.error);
  const strays = good.filter((p) => !known.has(p.category));
  if (strays.length) {
    sum.append(mkNotice("bad",
      `🔴 有 **${strays.length}** 个产品的 category 不在契约枚举里，下表统计不到它们：` +
      strays.map((p) => `${p.slug}(${p.category || "空"})`).join("、")));
  } else {
    // ⚠️ 对账成立时也要**出一行**。什么都不显示的话，"查过了，没问题"和"这个检查根本没跑"
    //    在界面上长得一模一样 —— 而那正是一道闸失效之后最不容易被发现的样子。
    const onSite = c.categories.filter((cat) => good.some((p) => p.category === cat.slug && p.status === "published")).length;
    sum.append(mkNotice("ok",
      `${good.length} 个产品全部落在契约的 ${c.categories.length} 个机型里（对账成立）· ` +
      `官网筛选栏上会出现 **${onSite}** 个机型`));
  }

  const tb = $("#catsRows"); tb.innerHTML = "";
  c.categories.forEach((cat) => {
    const mine = state.list.filter((p) => !p.error && p.category === cat.slug);
    const pub = mine.filter((p) => p.status === "published").length;
    const draft = mine.filter((p) => p.status === "draft").length;

    const tr = el("tr");
    const tdName = el("td");
    tdName.append(el("div", "li-name", cat.label || cat.slug));
    tdName.append(el("div", "li-sub", cat.label ? cat.slug : "（官网显示名未知）"));
    tr.append(tdName);

    tr.append(el("td", "col-st", String(pub)));
    tr.append(el("td", "col-st li-sub", String(draft)));

    // 🔴 判据取自官网自己的规则（lib/products.ts 的 categoriesOf 只收有已上架产品的分类），
    //    不是我按"看起来应该"编的。⇒ 0 个已上架 = 站上根本没有这个筛选按钮。
    const tdOn = el("td", "col-cat");
    if (pub > 0) tdOn.append(el("span", "badge badge-published", "显示"));
    else {
      tdOn.append(el("span", "badge badge-unknown", "不显示"));
      tdOn.append(el("div", "li-sub", "没有已上架产品"));
    }
    tr.append(tdOn);

    const tdAct = el("td", "col-act");
    if (mine.length) {
      const b = el("button", "linkish", `查看 ${mine.length} 个`); b.type = "button";
      b.onclick = () => { showNav("products"); $("#catFilter").value = cat.slug; state.tab = "all"; renderList(); };
      tdAct.append(b);
    } else tdAct.append(el("span", "li-sub", "空"));
    tr.append(tdAct);
    tb.append(tr);
  });

  // ⚠️ 这一段回答的是"加分类的按钮在哪" —— 不写的话，人会以为是自己没找到，
  //    而不是它按设计不存在。⇒ 它必须在页面上，不是只在文档里。
  const note = $("#catsNote"); note.innerHTML = "";
  note.append(mkNotice("warn", `**这一轴是冻结的：这里不能加分类、改名或删分类。** ${c.whyFrozen}`));
  const ul = el("ul", "catnote");
  [
    "**改某个产品的归属**（把它从一个机型挪到另一个）：可以 —— 列表里勾选后用「批量改机型」，或在产品编辑页改 category。",
    "**官网筛选栏**只列有已上架产品的分类。一个 0 个已上架的分类，在站上是看不见的。",
    `显示名的真源是官网仓 ${c.labels.path} 的 CATEGORY_LABELS，本后台**只读不写**（所以这里不会与官网漂移）。`,
  ].forEach((t) => ul.append(appendMd(el("li"), t)));
  note.append(ul);
}

// ═══════════════ 审计日志 ═══════════════
async function loadAudit() {
  $("#auditSummary").innerHTML = '<div class="notice notice-warn">读取中…</div>';
  try {
    const { body } = await api("/api/audit?limit=60");
    state.audit = body;
    renderAudit();
  } catch (e) {
    $("#auditSummary").innerHTML = "";
    $("#auditSummary").append(mkNotice("bad", "读取失败：" + e.message));
  }
}

function renderAudit() {
  const a = state.audit; if (!a) return;
  const sum = $("#auditSummary"); sum.innerHTML = "";
  // ⚠️ 必须说清楚日志**包含别处推的改动**，否则人会以为"这就是后台干的全部"
  sum.append(mkNotice("ok", `最近 **${a.total}** 条改动 · 本后台写的 **${a.fromAdmin}** · 别处推的 **${a.fromOther}**`));
  sum.append(mkNotice("warn", a.note));

  const tb = $("#auditRows"); tb.innerHTML = "";
  a.entries.forEach((e) => {
    const tr = el("tr");
    const d = new Date(e.date);
    tr.append(el("td", "col-st li-sub", isNaN(d) ? e.date : d.toLocaleString("zh-CN", { hour12: false })));

    const src = el("td", "col-cat");
    src.append(el("span", `badge badge-${e.source === "admin" ? "published" : "unknown"}`, e.source === "admin" ? "后台" : "别处"));
    tr.append(src);

    const act = el("td");
    if (e.action) {
      const label = { create: "新建", update: "修改", delete: "删除", bulk: "批量" }[e.action] || e.action;
      const line = el("div", "li-name", `${label} ${e.slugs.join("、") || "—"}`);
      act.append(line);
      if (e.fields) act.append(el("div", "li-sub", "字段：" + e.fields));
    } else {
      // 🔴 解析不出来就**原样显示 commit 标题**，不猜 —— 猜错的审计条目会被当成事实引用
      act.append(el("div", "li-name", e.subject || "(无标题)"));
      act.append(el("div", "li-sub", "未按后台格式记录，只能显示原始标题"));
    }
    tr.append(act);

    tr.append(el("td", "col-cat li-sub", e.operator || "—"));

    const sha = el("td", "col-st");
    const link = el("a", "linkish", e.shortSha);
    link.href = e.url; link.target = "_blank"; link.rel = "noopener";
    sha.append(link); tr.append(sha);
    tb.append(tr);
  });
}

/** 左导航切视图。⚠️ 只切实做出来的这几个，SOON 项不可点（见 index.html 的 .soon）。 */
function showNav(which) {
  state.nav = which;
  $("#listView").hidden = which !== "products";
  $("#mediaView").hidden = which !== "media";
  $("#auditView").hidden = which !== "audit";
  $("#catsView").hidden = which !== "cats";
  $("#settingsView").hidden = which !== "settings";
  $("#siteView").hidden = !SITE_SECTIONS[which];
  $("#detailView").hidden = true;
  document.querySelectorAll(".nav-item[data-nav]").forEach((b) => b.classList.toggle("is-on", b.dataset.nav === which));
  if (which === "media" && !state.media) loadMedia();
  if (which === "audit" && !state.audit) loadAudit();
  // ⚠️ 分类页的计数每次都要重算（列表可能刚被批量改过），但接口只在第一次拉。
  if (which === "cats") { if (state.cats) renderCats(); else loadCats(); }
  if (which === "settings") renderSettings();   // 起步时已经拉过 _whoami，不重复请求
  // ⚠️ 站点内容每次进都**重新拉**：三个视图共用一个文件，别人（或我自己在另一个视图里）
  //    刚存过的话，拿旧的 sha 去保存会撞乐观锁；更糟的是在旧值上编辑。
  if (SITE_SECTIONS[which]) loadSite(which);
}
document.querySelectorAll(".nav-item[data-nav]").forEach((b) => { b.onclick = () => showNav(b.dataset.nav); });

// ── sticky 条上的改动计数 ──
// 🔴 数的是**与已保存内容的实际差异**，不是"你敲过几下键盘"：
//    敲进去又改回来，那不算改动；只报"有未保存改动"的话，人分不清自己动了什么。
function updateDirty() {
  const n = $("#dirtyCount");
  if (!n) return;
  if (state.isNew) { n.innerHTML = "<b>新产品</b>（尚未创建）"; return; }
  if (!state.draft) { n.textContent = "未改动"; return; }
  let changed = [];
  try {
    const now = readForm(), base = state.draft;
    for (const k of Object.keys(now)) {
      // images 由服务端按 status 归一化，前端比它没意义 —— 图片的改动用下面的待上传计数表达
      if (k === "images") continue;
      if (JSON.stringify(now[k] ?? null) !== JSON.stringify(base[k] ?? null)) changed.push(k);
    }
  } catch { /* 表单还没填好时不报错，保持上一次的显示 */ }
  // 图片的改动 = 待上传张数 + 顺序/删除是否与打开时不同。
  // ⚠️ 顺序也算改动：只数"待上传"的话，纯拖顺序会显示"未改动"，
  //    而人明明动了东西 —— 那种"我改了它说没改"最伤信任。
  const orig = imgListFromDraft(state.draft).map((x) => x.path).join("|");
  const nowList = (state.imgList || []).map((x) => (x.kind === "have" ? x.path : "«new»")).join("|");
  const imgs = (state.imgList || []).filter((x) => x.kind === "new").length + (orig !== nowList ? 1 : 0);
  if (!changed.length && !imgs) { n.textContent = "未改动"; return; }
  const parts = [];
  if (changed.length) parts.push(`<b>${changed.length}</b> 个字段（${changed.join("、")}）`);
  if (imgs) parts.push(`<b>${imgs}</b> 项图片`);
  n.innerHTML = "已改：" + parts.join(" · ");
}
$("#editPane").addEventListener("input", updateDirty);
$("#editPane").addEventListener("change", updateDirty);

// ══ A10-B：slug 跟随标题，人一动就停 ══
//
// 🔴 「停止跟随」不能靠"值不等于 slugify(标题)"去猜 —— 那样人手改成一个恰好等于
//    自动值的串之后，跟随会**悄悄复活**，然后在他下一次改标题时把他的 slug 冲掉。
//    ⇒ 用一个显式的脏标记：**人碰过就是碰过**，与值是什么无关。
// ⚠️ 只在新建态跟随：已存在的产品 slug 就是它的 URL，本阶段不支持改名。
$("#f_slug").addEventListener("input", () => { state.slugTouched = true; });
$("#f_name").addEventListener("input", () => {
  if (!state.isNew || state.slugTouched) return;
  $("#f_slug").value = slugify($("#f_name").value);
  updateDirty();
});

// ── 图片：多选 + 拖文件进来 ──
$("#f_imgfile").onchange = (e) => { const f = e.target.files; e.target.value = ""; addImageFiles(f); };
{
  // ⚠️ 投放区是**整个网格**，不只那一格 —— 派单明确要求。
  //    只绑那一格的话，人把文件拖到缩略图之间会毫无反应，而那看起来像拖拽坏了。
  const drop = $("#imgList");
  // ⚠️ dragover 只切一个 class，绝不重绘 —— 它每秒触发几十次
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => {
    if (state.dragFrom != null) return;              // 拖的是卡片换位，不是文件
    e.preventDefault(); drop.classList.add("is-over");
  }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove("is-over")));
  drop.addEventListener("drop", (e) => {
    if (state.dragFrom != null) return;
    e.preventDefault();
    const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith("image/"));
    if (files.length) addImageFiles(files);
  });
}

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





