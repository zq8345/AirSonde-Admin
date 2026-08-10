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
};

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
    $("#bannerWhy").textContent = `写能力：${w.data.ghTokenConfigured ? "token 已配" : "无 token"}，写入等 M2 放行。`;
  } catch (e) {
    $("#who").textContent = "身份读取失败：" + e.message;
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
  const { body } = await api("/api/products");
  state.listMeta = body;
  state.list = body.files || [];
  renderList();
}

function renderList() {
  const ul = $("#list"); ul.innerHTML = "";
  const q = $("#q").value.trim().toLowerCase();
  const sf = $("#statusFilter").value;

  // ⚠️ 列表项来自目录清单，此时还没读过每个文件的内容 ⇒ **status 是未知的**，
  //    不是 "unknown 状态"。选中过的会被缓存下来，那时才显示真实 status。
  const rows = state.list.filter((f) => {
    if (q && !(`${f.slug} ${f.name}`.toLowerCase().includes(q))) return false;
    if (sf) { const s = cache.get(f.slug)?.status; if (s !== sf) return false; }
    return true;
  });

  rows.forEach((f) => {
    const li = el("li");
    const b = el("button");
    if (f.slug === state.slug) b.classList.add("is-on");
    const top = el("div", "li-top");
    top.append(el("span", "li-name", cache.get(f.slug)?.name || f.slug));
    const st = cache.get(f.slug)?.status;
    top.append(el("span", `badge badge-${st || "unknown"}`, st || "?"));
    b.append(top, el("div", "li-sub", `${f.slug}.json · ${f.size}B`));
    b.onclick = () => select(f.slug);
    li.append(b);
    ul.append(li);
  });

  $("#listCount").textContent = state.listMeta?.dirExists === false ? "目录不存在" : `${rows.length}/${state.list.length}`;

  const empty = $("#listEmpty");
  if (state.listMeta?.dirExists === false) {
    // 🔴 这是当前的**正常状态**，不是错误。不说清楚的话，人会以为后台坏了。
    empty.hidden = false;
    empty.innerHTML = `<b>数据目录还不存在。</b><br>
      <code>${state.listMeta.dir}</code> 归 AirSonde-Web 窗维护，它建出来之后这里会自动有内容。
      <br><span class="muted">这不是故障，也不需要在这边创建它。</span>`;
  } else if (!rows.length) {
    empty.hidden = false;
    empty.textContent = state.list.length ? "没有匹配的产品。" : "目录是空的（存在，但里面没有产品 JSON）。";
  } else {
    empty.hidden = true;
  }
}

/** slug → 已读到的产品对象，用来在列表里显示真实 name/status */
const cache = new Map();

// ═══════════════ 选中 / 读取 ═══════════════
async function select(slug) {
  state.slug = slug; state.isNew = false;
  $("#placeholder").hidden = true; $("#detail").hidden = false;
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
  $("#placeholder").hidden = true; $("#detail").hidden = false; $("#preview").hidden = true;
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

function mkIssue(kind, field, msg) {
  const d = el("div", `issue issue-${kind}`);
  if (field) d.append(el("span", "issue-field", field));
  d.append(el("span", null, msg));
  return d;
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

  const g = $("#f_gallery"); g.innerHTML = ""; (p.images?.gallery || []).forEach((x) => repeatRow(g, x));
  const h = $("#f_highlights"); h.innerHTML = ""; (p.highlights || []).forEach((x) => repeatRow(h, x));
  const s = $("#f_specs"); s.innerHTML = ""; Object.entries(p.specs || {}).forEach(([k, v]) => kvRow(s, k, v));
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
  const gallery = list("#f_gallery");
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
      body: JSON.stringify(readForm()),
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
    wrap.append(mkNotice("ok", "契约校验通过。以下是将要写入的改动 —— 但本阶段不会写入。"));
  }

  if (r.change.cleared?.length) {
    wrap.append(mkNotice("warn", `会被**清空**的字段：${r.change.cleared.join("、")}`));
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

  wrap.append(mkNotice("warn", r.note + `（写能力：${r.writeCapability}）`));
  box.append(wrap);
  wrap.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function mkNotice(kind, msg) {
  const d = el("div", `notice notice-${kind}`);
  // 支持 **粗体**
  msg.split(/\*\*(.+?)\*\*/g).forEach((part, i) => d.append(i % 2 ? el("b", null, part) : document.createTextNode(part)));
  return d;
}

// ═══════════════ 视图切换 / 事件 ═══════════════
function switchView(v) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("is-on", t.dataset.view === v));
  $("#viewPane").hidden = v !== "view";
  $("#editPane").hidden = v !== "edit";
}

document.querySelectorAll(".tab").forEach((t) => { t.onclick = () => switchView(t.dataset.view); });
$("#q").oninput = renderList;
$("#statusFilter").onchange = renderList;
$("#newBtn").onclick = startNew;
$("#editPane").onsubmit = doPreview;
$("#resetBtn").onclick = () => { if (state.draft) fillForm(state.draft); $("#preview").hidden = true; };
document.querySelectorAll(".add").forEach((b) => {
  b.onclick = () => {
    if (b.dataset.add === "specs") kvRow($("#f_specs"), "", "");
    else repeatRow($(b.dataset.add === "gallery" ? "#f_gallery" : "#f_highlights"), "");
  };
});

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
