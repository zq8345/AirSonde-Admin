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
  /**
   * 型号列排序（Joe 2026-08-28：「产品列表加一个按照型号排序」）。
   * 0 = 不排（保持仓里的文件顺序）· 1 = 升序 · -1 = 降序。点表头在 1/-1 间切换。
   * ⛔ 只有型号这一列 —— 别的列他没要，不加。
   */
  modelSort: 0,
  nav: "products",            // 左导航当前视图：products | media
  media: null, mediaTab: "all",
  audit: null,
  cats: null,       // /api/taxonomy：两个轴 + 每条的 refs/refCount/canDelete（引用计数由服务端数）
  /**
   * 分类页两个轴各自的管理态（Joe 2026-08-26：改名/删除/新增要点「管理」才出现）。
   * 🔴 **两个键，不是一个布尔**：管机型时不该把传感器那栏也解锁。
   * ⚠️ 不持久化。破坏性入口的默认态必须是关的 —— 记住上次开着的话，
   *    下次进来就又是一屏删除按钮，那正是这个开关要解决的事。
   */
  axisManage: { categories: false, sensors: false },
  who: null,        // /api/_whoami 的完整响应 —— 设置页整页由它渲染
  // 站点内容：首页/联系方式/SEO 三个视图共用**同一个 JSON**
  site: null,       // 服务端那一版（含 sha —— 保存时当乐观锁）
  siteDraft: null,  // 编辑中的那一份
  siteBase: null,   // 打开时的那一份：改动计数比的是它，不是"敲过几下键盘"
  siteSection: "home",
  /** 当前详情页 tab（view | edit）。提示贴在顶部还是字段旁，取决于它。 */
  activeView: "view",
  /** 最近一次校验结果 —— 切 tab 时用它重画提示，不重新校验。 */
  lastValidation: undefined,
  /** 数据文件在仓里的路径。⚠️ 不再显示在顶部（Joe 不看仓）—— 收进详情态底部的内部信息区。 */
  filePath: "",
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

    // 🔴 登出（Joe 点名）。位置就挨着"当前是谁"—— 换人这件事在同一个地方看和做。
    //
    // ⚠️ 它不只是"共用设备换个人"：**这个后台自己写下的对账程序需要它**。
    //    设置页与 /api/_whoami 都写着：Access 名单与 ALLOWED_EMAILS 必须集合相等，
    //    而 worker 看不见 Access 的策略列表 ⇒ **唯一的对账办法是让人真去登一次**。
    //    没有登出，那条程序在同一台机器上根本执行不了 —— 后台要求的事它自己不让你做。
    //
    // ⚠️ `/cdn-cgi/access/logout` 是 Cloudflare 边缘的端点，不经过这个 worker。
    //    ⇒ 本地开发（旁路模式、根本没有 Access）点它只会 404。
    //      所以不是"显示但点了没反应"，而是**禁用并说明为什么** —— 那正是这一批在修的病。
    const out = el("button", "logoutbtn"); out.type = "button";
    out.textContent = "登出";
    if (w.request.isLocalDev) {
      out.disabled = true;
      out.title = "本地开发是旁路模式，前面没有 Access 门，也就没有会话可以登出";
    } else {
      out.title = `以 ${w.operator} 登入中 · 登出后回到 Cloudflare Access 登录页（可用来核对 Access 名单与 ALLOWED_EMAILS 是否一致）`;
      out.onclick = () => { location.href = "/cdn-cgi/access/logout"; };
    }
    $("#who").append(out);
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
    $("#actionsNote").textContent = "点「保存」后会先让你确认一遍，确认了才真的写。";
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
  // 🔴 契约 v1.4 起这两个轴来自官网仓的 taxonomy.json ⇒ 它读不出来是**有可能的**，
  //    而症状（两个选择器都是空的）与"还没加载完"一模一样。⇒ 必须明说。
  //    ⛔ 不回落到任何一份后台自己抄的枚举：那会让界面看起来正常，而值与官网无关。
  // ⚠️ api() 对 502 是**抛**而不是返回 —— 所以这里要接住，不能只判 status。
  let body;
  try {
    const r = await api("/api/contract");
    body = r.body;
    if (!body || !Array.isArray(body.categories)) throw new Error("响应里没有 categories");
  } catch (e) {
    $("#banner").append(el("span", "banner-why",
      `🔴 读不到机型/传感器选项（官网仓的 taxonomy.json）：${e.message}`));
    throw e;
  }
  state.contract = body;

  // ⚠️ 先清空：轴改完之后会**再调一次**这个函数。不清的话选项会一份一份叠上去，
  //    而下拉框里出现两个 desktop 时，人只会以为数据坏了。
  // 🔴 显示 label、存 value。`new Option(c, c)` 那种写法是把 value 当文字用 ——
  //    分类页显示「Desktop」、官网显示「Desktop」，而这里写着「desktop」；
  //    更糟的是 Joe 在分类页改了显示名，这里不会跟着变。
  const cat = $("#f_category");
  cat.innerHTML = "";
  cat.append(new Option("（请选择）", ""));
  body.categories.forEach((c) => cat.append(new Option(c.label, c.value)));

  // ⚠️ status 走 statusLabel()，与 tab / 徽章 / 行内**同一张表**。
  //    这里原来是 `new Option(s, s)` ⇒ 全站四处说中文、唯独下拉直出 draft/published。
  const st = $("#f_status");
  st.innerHTML = "";
  body.statuses.forEach((s) => st.append(new Option(statusLabel(s), s)));

  const box = $("#f_sensors");
  box.innerHTML = "";
  body.sensors.forEach((s0) => {
    const s = s0.value;
    const lab = el("label", "chip");
    const cb = el("input"); cb.type = "checkbox"; cb.value = s;
    // 存 value、显示 label（传感器现在两者多半相同，但 Joe 一改显示名就会分开）
    lab.append(cb, document.createTextNode(s0.label || s));
    box.append(lab);
  });
}

// 🔴🔴 `/api/products-expanded` **不返回 `highlights` / `specs` / `moq` 这些正文字段。**
//    它给的是列表要画的那几样：slug/name/model/category/sensors/status/image/size
//    + valid/errorCount/warnCount/hasSupplierRef。
//
// ⚠️ 记在这里是因为它已经骗过一次（2026-08-27）：
//    我拿它扫"有没有 highlight 超过 80 字符"，写的是
//      `list.filter(p => p && p.highlights)` → 这个字段根本不存在
//    ⇒ 过滤出**空数组** ⇒ 我据此报告"全部 23 个产品里没有任何一条超过 80"。
//    而真相是 `ak34-18-…` 那个产品有 **7 条 188–382 字符**的，早就存进仓、也渲染在官网上了。
//    🔴 **空结果与真·零在结论里长得一模一样** —— 这是本仓反复出现的那个形状。
//    ⇒ 要按正文字段扫，走 `GET /api/products/<slug>`（单个产品带全字段），
//      或者直接读官网仓的 JSON。⛔ 别拿列表接口当全量真源。
//
// ⚠️ 还有一条同样咬过我：**先对账再下结论**。那次我写"扫了 23 个"，
//    而侧栏当时显示 24 —— 不自洽就摆在我自己那份数据里，我没核就往下走了。

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

/**
 * 型号的比较器：**自然排序**，不是字符串排序。
 * 🔴 型号是 AK3 / AK8 / AK13B 这种 —— 字符串排序会把 AK3、AK8 甩到 AK13B 后面
 *    （字符 '3' > '1'），那一眼看上去就是乱的。numeric:true 让 3 < 8 < 13 按数比。
 * ⛔ 不自己写正则拆数字（总工点名）—— Collator 是现成的、带 locale 语义的实现。
 */
const modelCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** 当前筛选下的行。tabs 计数与表格必须用**同一个函数**，否则数字和内容会对不上。 */
function filteredRows() {
  const q = $("#q").value.trim().toLowerCase();
  const cat = $("#catFilter").value;
  const rows = state.list.filter((it) => {
    if (state.tab !== "all" && it.status !== state.tab) return false;
    if (cat && it.category !== cat) return false;
    if (q && !`${it.slug} ${it.name || ""} ${it.model || ""}`.toLowerCase().includes(q)) return false;
    return true;
  });
  // 排序也在这里做，⛔ 不在别处另排一遍 —— 全选/批量取的都是这同一个函数的结果。
  if (state.modelSort) {
    rows.sort((a, b) => {
      const am = String(a.model || "").trim(), bm = String(b.model || "").trim();
      // ⚠️ 没填型号的（列表显示 —，含读坏的行）一律沉底，**升序降序都沉底** ——
      //    所以空值判断不乘方向；否则降序时一排 — 会顶到最上面。
      if (!am && !bm) return 0;
      if (!am) return 1;
      if (!bm) return -1;
      return modelCollator.compare(am, bm) * state.modelSort;
    });
  }
  return rows;
}

// ══ 状态口径的**单一真源**（A11-4 / A12-2 / A12-④）══
//
// 🔴 以前 tab 有一张中文映射表、而行内状态列**直接把枚举原值渲染出来** ——
//    同一个状态在同一屏上有中英两个名字。两处各写一份的话，将来加一个 status
//    只会改一处，另一处静默显示英文原值，而那看起来像"数据错了"。
// ⚠️ `draft` 的显示名是「未上架」不是「草稿箱」：它要同时覆盖两种来源 ——
//    从没上架过的（新建）和上架后撤下来的。Joe 点了「下架」却在「草稿箱」里找，
//    正是因为这两个词看起来是两件事。
//    ⭐ 动词保持「上架/下架」不变：**动词描述动作，tab 描述状态**，本来就不必同词。
const STATUS_LABEL = { all: "全部", published: "在线", draft: "未上架" };
/** tab 的显示顺序（Joe 定：全部 / 在线 / 未上架），与契约枚举顺序无关。 */
const TAB_ORDER = ["published", "draft"];
/**
 * ⚠️ 认不出的值**原样显示**，不显示空白也不显示"未知" ——
 *    一个超出枚举的 status 是**数据出问题的信号**，把它吞成空白等于把信号删掉。
 */
const statusLabel = (s) => STATUS_LABEL[s] ?? (s || "?");

/**
 * 机型 / 传感器的显示名。**唯一来源是 /api/contract**（它转发 taxonomy.json 的 label）。
 *
 * 🔴 与 STATUS_LABEL 的区别要说清楚，否则下一个人会把两者混成一件事：
 *    · status 的中文说法（在线 / 未上架）是**界面词汇** ⇒ 表在前端，就是上面那一张。
 *    · 机型/传感器的显示名是**数据** ⇒ 表在 taxonomy.json，前端**只能问服务端要**。
 *    ⛔ 绝不在前端写死一份 value→label —— Joe 在分类页改完显示名，那份会立刻过期，
 *       而且没有任何症状：下拉框照常有值，只是写着旧名字。
 *
 * ⚠️ 认不出的取值**原样显示 value**（与 statusLabel 同一条规矩）：
 *    轴里没有的机型是**数据脏了的信号**，吞成空白等于把信号删掉。
 */
/**
 * 传感器显示名。与下面的 catLabel **同一条规矩**：唯一来源是 /api/contract
 * （它转发 taxonomy.json 的 label）。
 * ⛔ 绝不在前端写死一份 value→label —— Joe 在分类页改完显示名，那份会立刻过期，
 *    而且**没有任何症状**：下拉框照常有值，只是写着旧名字。
 * ⚠️ 认不出的取值**原样显示 value**：轴里没有的传感器是数据脏了的信号，吞掉等于删信号。
 */
const sensorLabel = (v) => state.contract?.sensors?.find((x) => x.value === v)?.label ?? (v || "?");

const catLabel = (v) => state.contract?.categories?.find((c) => c.value === v)?.label ?? (v || "?");

/** 官网上这个产品的地址。⚠️ 只有已上架的才有这一页。 */
const siteUrl = (slug) => `https://airsonde.com/products/${slug}/`;

/**
 * 产品标题 —— 已上架的做成指向官网的链接，未上架的**不给链接**。
 *
 * 🔴 未上架的产品官网上**根本不存在**（getStaticPaths 不产出它）⇒ 点过去是 404。
 *    给一个必然 404 的链接，会让人以为官网坏了，而不是"这东西还没上架"。
 * ⚠️ slug 用**已保存的那个**，不跟着输入框实时变：刚改完 slug 还没提交时，
 *    官网上仍然是旧那页，链接跟着新值走就会指向一个不存在的地址。
 */
function siteLink(slug, status, text) {
  if (status !== "published") {
    const s = el("span", "", text);
    s.title = "未上架 —— 官网上还没有这一页";
    return s;
  }
  const a = el("a", "ttl-link", text);
  a.href = siteUrl(slug);
  a.target = "_blank"; a.rel = "noopener";
  a.title = "在官网打开（新标签）";
  return a;
}

function renderList() {
  // ── 机型筛选：**选项**从真实数据里长（筛一个没有产品的机型只会得到空列表），
  //    但**显示名**取自契约。两件事分开：谁可筛 ← 数据；叫什么 ← taxonomy.json。
  // ⚠️ 轴里没有的散值（数据脏了才会出现）就原样显示 value —— 那时看见原值正是我们要的。
  const cats = [...new Set(state.list.map((i) => i.category).filter(Boolean))].sort();
  const sel = $("#catFilter"), keep = sel.value;
  sel.innerHTML = "";
  sel.append(new Option("全部机型", ""));
  cats.forEach((c) => sel.append(new Option(catLabel(c), c)));
  sel.value = cats.includes(keep) ? keep : "";

  // ── 状态 tabs（带计数）──
  const counts = { all: state.list.length };
  (state.contract?.statuses || ["published", "draft"]).forEach((s) => {
    counts[s] = state.list.filter((i) => i.status === s).length;
  });
  const tabs = $("#statusTabs"); tabs.innerHTML = "";
  // ⚠️ tab 顺序由 TAB_ORDER 定，**不跟着契约枚举的顺序走**：
  //    契约里是 draft|published（数据顺序），而人要的是 全部/在线/未上架（Joe 定）。
  //    只列契约里真有的状态 —— 枚举将来加一个，这里不会凭空多出一个空 tab。
  const known = new Set(state.contract?.statuses || []);
  ["all", ...TAB_ORDER.filter((k) => known.has(k))].forEach((k) => {
    const b = el("button", "stab" + (state.tab === k ? " is-on" : ""));
    b.setAttribute("aria-pressed", String(state.tab === k));
    b.type = "button";
    b.append(document.createTextNode(statusLabel(k)), el("span", "stab-n", String(counts[k] ?? 0)));
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
      const n = el("div", "li-name");
      n.append(siteLink(it.slug, it.status, it.name || it.slug));
      // 校验有问题的要在列表上就看得见，而不是点进去才发现
      if (!it.valid) n.append(el("span", "flag-bad", `${it.errorCount} 个错误`));
      // ⛔ 黄色的「N 提示」角标已撤（总工 2026-08-26）：23 个产品里几乎每个都有，
      //    一个 100% 命中的信号零区分信息 —— 它只是把红色那几个淹掉。
      //    🔴 撤的是**这一块**，不是这一类：红色「N 个错误」保留，
      //       服务端的 warnCount / actionableWarnCount 一个字不动（详情页仍在用）。
      // 🔴 slug 不再显示在列表里（Joe 2026-08-27：「产品列表不要显示 slug 标题」）。
      //    ⛔ 撤的是**这一处的显示**，不是 slug 本身：
      //      · 顶部搜索**仍按 slug 匹配**（占位符写着「搜标题 / slug / 型号」，那句话得继续为真）
      //      · 标题本身就是链接（A12-3）⇒ "这个产品的网址是什么"仍然回答得出
      //      · 编辑页的 slug 输入框、详情页内部信息区的 slug **都保留**
      //      · 数据里的 slug 一个字节不动
      // ⭐ 文字列分成两块并**撑满缩略图高度**（Joe 2026-08-27）：
      //    标题与缩略图【上】对齐、传感器与缩略图【下】对齐。
      //    ⛔ 对齐靠 `min-height + space-between` 撑，**不用固定 px 去凑** ——
      //      字号一跳档那个数就错，而且没有症状（`.topbar` 的 top:40px、
      //      批量条的 margin-top 都是这么坏的）。
      // ⚠️ 标题**恒占 2 行**：短的补足、长的截断带省略号 —— 高度才可能行行相等。
      const stack = el("div", "namestack");
      stack.append(n);
      // 传感器：**显示 label 不是 value**（与机型同一条规矩，走 sensorLabel）。
      const sens = el("div", "senrow");
      (it.sensors || []).forEach((v) => {
        const c = el("span", "senchip", sensorLabel(v));
        c.dataset.v = v;
        sens.append(c);
      });
      if (!(it.sensors || []).length) sens.append(el("span", "senchip sen-none", "未填传感器"));
      // `+N` 由布局量出来（见 fitSensorRows）——先放个空壳，值等测量后再填。
      const more = el("span", "senmore"); more.hidden = true;
      sens.append(more);
      stack.append(sens);
      tdName.append(stack);
    }
    tr.append(tdName);

    const tdSt = el("td", "col-st");
    // ⚠️ 类名保持 badge-published / badge-draft（它承载颜色，与显示文本无关）——
    //    ⛔ 不把类名也改成中文。文本走 statusLabel，与 tab **同一张表**。
    tdSt.append(el("span", `badge badge-${it.status || "unknown"}`, statusLabel(it.status)));
    tr.append(tdSt);

    // A12-③ 型号独立成列：Joe 要逐个核对 23 个型号，
    // 独立一列他扫一眼就知道哪些还是 AS- —— 挤在 slug 后面做不到。
    tr.append(el("td", "col-model", it.model || "—"));
    // 列表这一格也走 catLabel —— 否则同一屏上：筛选下拉写「Desktop」、行内写「desktop」。
    tr.append(el("td", "col-cat", it.category ? catLabel(it.category) : "—"));

    const tdAct = el("td", "col-act");
    // A12-①：按钮说"编辑"就要进编辑态。原来它落在默认的「详情」tab ——
    // 按钮名与它做的事对不上，是最容易让人以为"点错了"的一种。
    const edit = el("button", "linkish", "编辑"); edit.type = "button";
    edit.onclick = () => select(it.slug, { view: "edit" });
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

  // ⚠️ 必须在**表格已经在文档里、且列宽定下来之后**才量 —— 量早了 clientWidth 是 0，
  //    收出来的结果是"每行只显示 1 个 +N"，而且看起来像功能坏了。
  fitSensorRows(tb);
}

function syncCkAll() {
  const rows = filteredRows().filter((r) => !r.error);
  const all = rows.length > 0 && rows.every((r) => state.selected.has(r.slug));
  const some = rows.some((r) => state.selected.has(r.slug));
  const ck = $("#ckAll");
  ck.checked = all; ck.indeterminate = !all && some;
}

/**
 * 传感器行放不下时收尾成 `+N`。
 *
 * 🔴 为什么要量而不是按字数估：chip 宽度取决于**每个 label 的实际渲染宽度**
 *    （`PM2.5` 与 `temperature` 差一倍），按字符数估必然在某些行上估错，
 *    而估错的表现是**换行** —— 一换行行高就被顶起来，等高当场就没了。
 * ⛔ 不换行是硬要求，所以这里必须真量。
 * ⚠️ `+N` 里的 N 是**被藏起来的个数**，不是"还有更多"——「…」说不出数量，`+3` 说得出。
 *
 * ⚠️ 一次性读完所有几何、再一次性写 DOM：边读边写会把布局抖成 N 次回流。
 */
function fitSensorRows(root) {
  const rows = [...(root || document).querySelectorAll(".senrow")];
  // ① 先全部复位成"都显示"，否则第二次调用会在上一次的结果上继续收
  rows.forEach((r) => {
    r.querySelectorAll(".senchip").forEach((c) => { c.hidden = false; });
    const m = r.querySelector(".senmore"); if (m) { m.hidden = true; m.textContent = ""; }
  });
  // ② 读 chip 宽度 —— **必须在可见时读**（隐藏元素量出来是 0）
  const plan = rows.map((r) => {
    const chips = [...r.querySelectorAll(".senchip")];
    return { r, chips, w: chips.map((c) => c.getBoundingClientRect().width) };
  });

  // ③ 🔴 **量可用宽之前，先把所有 chip 藏起来。**
  //
  // ⚠️ 这一步是 2026-08-28 补的，它修的是一个**测量改变了被测对象**的缺陷：
  //    原来直接在 ② 里读 `r.clientWidth` —— 而那时所有 chip 都是展开的，
  //    表格是 `auto` 布局 ⇒ **列已经被这些 chip 自己撑宽了**，
  //    于是量到的是"展开后的宽度"，而那正是这个函数要防止的东西。
  //    ⇒ 后果不是行高（`nowrap` 保证了行高），是**列被撑宽、表格出横滚**：
  //      实测 20 个 chip 时列 683→935、表格 1167→1409、横滚出现（与「零横滚」直接冲突）。
  //
  // 🔴 先隐藏再量 ⇒ `avail` 由**列本身**决定，与 chip 数无关 —— 不是"量得更准"，是**让它量不到自己**。
  // ⚠️ 这条成立有个前提，已实测：全表所有行一起隐藏时，列宽**不塌**（仍 683px，由产品标题撑着）。
  //    ⛔ 若哪天名称列改成由 chip 撑宽，这个前提就没了 —— 那时要给列设上限，而不是回到旧写法。
  rows.forEach((r) => { r.querySelectorAll(".senchip").forEach((c) => { c.hidden = true; }); });
  plan.forEach((p) => { p.avail = p.r.clientWidth; });
  // ③ 写
  const GAP = 4;
  plan.forEach(({ r, chips, avail, w }) => {
    if (!chips.length || !avail) return;
    const more = r.querySelector(".senmore");
    let used = 0, shown = 0;
    for (let i = 0; i < chips.length; i++) {
      const next = used + (shown ? GAP : 0) + w[i];
      // 还有没显示完的话要给 `+N` 留位置（估 34px，宁可少显示一个也不许换行）
      const reserve = i < chips.length - 1 ? 38 : 0;
      if (next + reserve > avail) break;
      used = next; shown++;
    }
    if (shown === 0) shown = 1;           // 一个都放不下也至少露一个，否则那一格是空的
    const hidden = chips.length - shown;
    chips.forEach((c, i) => { c.hidden = i >= shown; });
    if (more) {
      more.hidden = hidden <= 0;
      more.textContent = hidden > 0 ? `+${hidden}` : "";
      if (hidden > 0) more.title = chips.slice(shown).map((c) => c.textContent).join("、");
    }
  });
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
    // 显示 label、存 value（与编辑器那个下拉同一条规矩）
    state.contract.categories.forEach((k) => sel.append(new Option(k.label, k.value)));
    sel.dataset.filled = "1";
  }
}

/**
 * 🔴 这些 slug 里，哪些正挂在首页精选上？
 *
 * 下架或删除一个在精选里的产品，**官网构建只打印警告、不失败** ——
 * 首页就安静地少一张卡，而人不会知道。这是这一整块的主要价值所在。
 * ⚠️ **提示不是阻断**：他有权下架，只是要知道代价。
 *
 * ⚠️ 数据可能还没读过（没进过「首页」那一页）⇒ 这时**说"没核过"，不说"没有"** ——
 *    把"我不知道"报成"没问题"，正是这一单要防的那种沉默。
 */
function featuredAmong(slugs) {
  const list = state.site?.content?.home?.featuredSlugs;
  if (!Array.isArray(list)) return { known: false, hit: [] };
  return { known: true, hit: slugs.filter((s) => list.includes(s)) };
}

/** 把"会影响首页"这件事拼成一句人话，接在确认框后面。没影响就返回空串。 */
function featuredWarning(slugs, what) {
  const f = featuredAmong(slugs);
  const NL = "\n";
  if (!f.known) {
    return NL + NL + "⚠️ 还没读过站点内容，无法确认这些产品在不在首页精选里（进一次「首页」那一页就能核）。";
  }
  if (!f.hit.length) return "";
  return NL + NL + "🔴 其中 " + f.hit.length + " 个正挂在【首页精选】上：" + NL
    + f.hit.map((x) => "· " + x).join(NL) + NL
    + what + "之后官网首页会少 " + f.hit.length + " 张卡"
    + "（构建只打印警告、不会失败，所以站上不报错，只是安静地少一张）。"
    + "要补回来，去「首页」那一页改精选列表。";
}

/**
 * 这一批 slug 各自的文件 sha —— 取自**列表那一次**读到的 `files[]`。
 * ⚠️ `products-expanded` 的 `items[]` **没有** sha，`files[]` 才有（两者不是同一份东西）。
 * ⛔ 取不到的就不放进去：⛔ 绝不编一个 sha —— 缺了顶多是"这一条没锁"，编错了是"锁在错的东西上"。
 */
function shasFor(slugs) {
  const files = state.listMeta?.files || [];
  const by = new Map(files.map((f) => [f.slug, f.sha]));
  const out = {};
  for (const s of slugs) { const sha = by.get(s); if (sha) out[s] = sha; }
  return out;
}

/** 批量改字段。单行的"上架/下架"也走这里 —— 一条路径，行为不可能分叉。 */
async function bulk(slugs, value, op = "status") {
  if (!slugs.length) return;
  const verb = op === "category" ? `改机型为 ${value}` : (value === "published" ? "上架" : "下架");
  // ⚠️ 只有**下架**才需要问首页 —— 上架不会让首页少东西。
  //    ⛔ 不做成"改状态就弹"：那样它在 100% 的场合出现 = 零信息（这一单里已经修过同族的两次）。
  const feat = value === "draft" ? featuredWarning(slugs, "下架") : "";
  if (!confirm(`确认把 ${slugs.length} 个产品${verb}？\n\n会产生一次 commit 并触发官网重建。${feat}`)) return;
  // 🔴 与 doCommit 同一条规矩：拿到 wrote:true 之后，"失败"这个词就不许再出现。
  let wroteOk = false, commitSha = null;
  try {
    const r = await fetch("/api/products/batch", {
      method: "POST", headers: { "content-type": "application/json" },
      // 🔴 逐个文件的锁：sha 取自列表那一次读到的 `files[]`（`state.listMeta.files`）——
      //    ⛔ 不另发请求去取，那会引入"取的时候已经不是刚才那份"的缝隙。
      body: JSON.stringify({ slugs, op, value, expectedShas: shasFor(slugs) }),
    });
    const b = await r.json().catch(() => null);
    if (b?.wrote === true) {
      wroteOk = true; commitSha = b.commitSha;
      state.cacheBust = b.commitSha;
      state.selected.clear();
      await loadList();
      // 🔴 必须**重读**，不能只 renderCats()：契约 v1.4 起「在用 N 个」和 canDelete
      //    都出自服务端此刻数的引用，不再是前端拿 state.list 现算的。批量改完机型后
      //    只重渲染的话，页面上会留着改之前的引用数 —— 而那个数正是删除闸给人看的依据。
      if (state.cats) loadCats();
      alert(`已${verb} ${b.changed.length} 个。commit ${String(b.commitSha).slice(0, 7)}\n` +
        (b.skipped?.length ? `跳过 ${b.skipped.length} 个：${b.skipped.map((s) => s.slug + "(" + s.why + ")").join("、")}` : ""));
    } else if (b?.rejected?.length) {
      // ⚠️ 整批未写要说明白，别让人以为"至少成了几个"
      alert(`未写入任何东西（整批中止）。\n\n以下产品没通过契约校验：\n` +
        b.rejected.map((x) => `· ${x.slug}：${x.codes.join(", ")}`).join("\n"));
    } else {
      alert(`未写入：${b?.reason || b?.detail || b?.error || r.status}`);
    }
  } catch (e) {
    if (wroteOk) { alert(wroteButRenderFailed(commitSha, e).replace(/\*\*/g, "")); await loadList().catch(() => {}); }
    else alert("批量操作失败：" + e.message);
  }
}

/** slug → 已读到的产品对象，用来在列表里显示真实 name/status */
const cache = new Map();

// ═══════════════ 选中 / 读取 ═══════════════
/**
 * @param opts.view "edit" = 打开后直接停在编辑态（列表的「编辑」按钮走这条）。
 *   ⚠️ 原来它落在默认的「详情」tab —— 按钮说编辑、进的是详情，
 *      **按钮名与它做的事对不上**，是最容易让人以为自己点错了的一种。
 */
/**
 * 离开一个产品时要清掉的**全部**面板与状态 —— 收在一处（A12 追加①）。
 *
 * 🔴 Joe 实测：在「新建产品」页点「详情」，看到的是**上一个产品的全部字段，包括 supplierRef**。
 *    根因是 `startNew()` 从不清 `#viewPane`。
 * ⚠️ 但那**不止一处** —— 我按总工的提醒系统排查了一遍，实测还有两个：
 *      · `#preview` 残留 1036 字符（虽然 hidden，但内容还在：谁一 un-hide 就露出上一个产品的 diff）
 *      · `state.lastValidation` 残留（切 tab 会拿它重画 —— 画的是上一个产品的提示）
 * ⇒ 所以不逐个补洞：**"离开一个产品该清什么"只写在这一个函数里**，
 *   select() 和 startNew() 都调它。以后新增一个面板，只需要在这里加一行 ——
 *   而漏加的话两条路径**一起**漏，不会出现"编辑页清了、新建页没清"这种半修状态。
 */
function clearProductPanes() {
  $("#viewPane").innerHTML = "";
  const pv = $("#preview"); pv.innerHTML = ""; pv.hidden = true;
  $("#issues").innerHTML = "";
  clearFieldIssues();
  state.lastValidation = undefined;
  state.lastPreview = null;
}

async function select(slug, opts = {}) {
  state.slug = slug; state.isNew = false;
  resetPending();                       // 换产品必须清空待上传，否则上一份的图会跟过来
  clearProductPanes();                  // ⚠️ 上一份的预览/diff/提示也一样要清
  $("#deleteBtn").hidden = !state.write?.enabled;
  $("#listView").hidden = true; $("#detailView").hidden = false;
  $("#preview").hidden = true;
  $("#dTitle").textContent = slug;
  state.filePath = "读取中…";
  renderList();

  const { status, body } = await api(`/api/products/${encodeURIComponent(slug)}`);
  state.loaded = body;

  if (status === 422) {
    state.filePath = body.path || "";
    renderIssues({ ok: false, errors: [{ field: "(文件)", code: "invalid_json", message: body.hint + " " + body.parseError }], warnings: [] });
    $("#viewPane").innerHTML = ""; $("#editPane").hidden = true;
    return;
  }

  const p = body.product || {};
  cache.set(slug, p);
  // A12-3：详情页标题也链官网。⚠️ 用**已保存的** state.slug，不是输入框里的值 ——
  //    刚改完 slug 还没提交时，官网上仍是旧那页，跟着新值走会指向一个不存在的地址。
  $("#dTitle").textContent = "";
  $("#dTitle").append(siteLink(state.slug, p.status, p.name || slug));
  state.filePath = body.path;

  const v = body.validation || { ok: true, errors: [], warnings: [] };
  if (body.slugPathIssue) v.errors = [...v.errors, body.slugPathIssue];
  renderIssues(v);
  renderView(p);
  state.draft = JSON.parse(JSON.stringify(p));
  fillForm(state.draft);
  // 编辑一个已存在的产品：**不简化**，全部展开。slug 也不再跟随标题（它已经是 URL 了）。
  state.slugTouched = true;
  setFormMode(false);
  setPreviewTabEnabled(true);
  if (opts.view === "edit") switchView("edit");
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
  // ⚠️ 进入某一态时就把主按钮文案设对 —— 只在校验完才更新的话，
  //    人第一眼看到的是上一态的词（新建页写着"保存"、编辑页写着"保存草稿"）。
  const sb = $("#previewBtn"); if (sb) sb.textContent = saveBtnLabel();
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
  clearProductPanes();
  state.slugTouched = false;            // 新建时 slug 跟随标题，直到人自己动它
  $("#deleteBtn").hidden = true;        // 还不存在的东西没有"删除"可言
  $("#f_slug").readOnly = false;
  $("#listView").hidden = true; $("#detailView").hidden = false; $("#preview").hidden = true;
  $("#dTitle").textContent = "新建产品";
  state.filePath = "（保存后会是 " + (state.listMeta?.dir || "…") + "/<slug>.json）";
  renderIssues(null);
  state.draft = { sensors: [], images: {}, status: "draft" };
  fillForm(state.draft);
  setFormMode(true);
  // 🔴 新建态**没有预览可言** —— 东西还不存在。留着那个 tab 只会让人点进一个
  //    要么空、要么装着上一个产品的面板。禁用它，比清空它更诚实。
  setPreviewTabEnabled(false);
  switchView("edit");
  renderList();
}

/** 「预览」tab 能不能点。新建态不能 —— 还不存在的东西没有预览。 */
function setPreviewTabEnabled(on) {
  const t = document.querySelector('.tab[data-view="view"]');
  if (!t) return;
  t.disabled = !on;
  t.title = on ? "" : "新建的产品还没有内容可预览 —— 先保存一次";
}

// ═══════════════ 校验结果 ═══════════════
/** 哪个字段的提示贴到哪个输入框下面。不在表里的留在顶部。 */
/**
 * 卖点的"短句"上限 —— **从服务端拿**（/api/contract 的 limits.highlight）。
 * 🔴 我第一版在这里写了个常量 90，而校验器里是 80：**当场就是两个真源**。
 *    那种分家的症状是"界面上是绿的、保存后服务端仍报警"，人只会觉得后台在骗他。
 * ⇒ 不抄数字，问服务端要。⚠️ 拿不到时返回 0 = **不显示计数**，
 *    ⛔ 绝不猜一个默认值——猜错的那个数会安静地误导人。
 */
const hlLimit = () => state.contract?.limits?.highlight || 0;

const FIELD_ANCHOR = { model: "f_model", name: "f_name", slug: "f_slug", category: "f_category", sensors: "f_sensors" };

/**
 * 🔴 带下标 / 带键的字段名也要找得到自己的那一行（Joe 2026-08-27）。
 *
 * 原来这里只有一张**精确字段名**的表 ⇒ `highlights[0]`、`specs.power`、
 * `images.gallery[2]` 这种**永远查不到**，于是全部堆在顶部：
 * 编辑页顶上曾经是一整块黄条，7 条 `highlights[N] 382 个字符…` 挤在一起。
 * ⚠️ 我们自己在下面原则②里写着"字段级的提示贴到那个字段的输入框下面"——
 *    **规矩写了，但贴附逻辑认不出这类名字**，等于没落实。
 * ⛔ 修法不是给 highlights 开特例：`specs.<key>` 与 `images.gallery[N]` 是同一个洞。
 *
 * 约定：重复行容器里第 N 行的输入框，可以用 `data-anchor="highlights[N]"` 认领自己。
 * 找不到就仍然回顶部 —— **回不去的提示不能凭空消失**。
 */
function anchorFor(field) {
  const exact = FIELD_ANCHOR[field];
  if (exact) { const e = document.getElementById(exact); if (e) return e; }
  // data-anchor 精确匹配（highlights[0] / specs.power / images.gallery[2] 都走这条）
  const byData = document.querySelector(`[data-anchor="${CSS.escape(field)}"]`);
  if (byData) return byData;
  return null;
}

function clearFieldIssues() {
  document.querySelectorAll(".field-issue").forEach((n) => n.remove());
}

/**
 * 顶部只留**真正需要占那个位置**的东西。
 *
 * 🔴 两条都是"100% 命中的提示零区分信息"这同一个病（我们刚在列表 badge 上修过）：
 *    ① `INFO_CODES` 里的（当前是 `internal_field`）**不进顶部** —— 23 个产品全都有
 *       supplierRef ⇒ 它在详情页也是永远亮着。而编辑页 supplierRef 输入框旁边
 *       **本来就有一句红字**说同样的事，顶部这条是纯重复。
 *       ⚠️ 判据落在**集合**上（服务端 /api/contract 给的 infoCodes），
 *          ⛔ 不写 `if (code === "internal_field")` —— 那把判据藏在了消费端。
 *       ⚠️ 输入框旁那句红字**保留**：它在人真要粘链接的地方，那才是它该在的位置。
 *    ② 字段级的提示**贴到那个字段的输入框下面**（如 model 那条是 Joe 的待办信号，
 *       改完就消失，但不该占顶部一整条）。
 * ⇒ 顶部最终只剩：错误、以及找不到归属控件的提示。
 */
function renderIssues(v) {
  // ⚠️ 记下来：提示"贴在哪里"取决于**当前在哪个 tab**，而 tab 是会切的 ⇒
  //    切 tab 时要能用同一份结果重画一次（见 switchView）。
  if (v !== undefined) state.lastValidation = v;
  const box = $("#issues"); box.innerHTML = ""; box.className = "issues";
  clearFieldIssues();
  if (!v) return;

  const info = new Set(state.contract?.infoCodes || []);
  const warns = (v.warnings || []).filter((i) => !info.has(i.code));

  if (v.ok && !warns.length) {
    // ⚠️ 只在**没有任何要处理的东西**时说"通过" —— 有 info 类提示时也算通过，
    //    它们不是待办。但那句"通过"不该顶掉别的内容，所以放最小形态。
    box.append(mkIssue("ok", "", "契约校验通过。"));
  }

  v.errors.forEach((i) => box.append(mkIssue("error", i.field, i.message)));

  warns.forEach((i) => {
    const anchor = anchorFor(i.field);
    // 编辑态才有输入框可贴；详情（预览）态贴不了就回到顶部
    // ⛔ 不用 offsetParent 判可见（这一单已反复证明它判不准）；
    //    这里要问的本来也不是"现在可见吗"，而是**"当前是不是编辑态"** —— 用 state 判。
    if (anchor && state.activeView === "edit") {
      const n = appendMd(el("p", "hint field-issue"), "⚠️ " + i.message);
      anchor.insertAdjacentElement("afterend", n);
    } else {
      box.append(mkIssue("warn", i.field, i.message));
    }
  });
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
/**
 * 「预览」态 —— **接近官网产品页的排版**，不是字段表（A12-4）。
 *
 * 🔴 为什么不 iframe 官网：
 *    ① 未上架的产品官网上**没有那一页**；
 *    ② 线上是**上一次部署**的版本，与手里这份数据不一致 —— 那会让人以为自己的改动没生效。
 * ⛔ `supplierRef` **绝不进预览区**：预览的定义就是"官网上看得到的样子"，而它不上站。
 *    它只出现在下方那块视觉上分开的内部信息区。
 * ⚠️ 不追求像素级还原官网（官网样式会变，追了也守不住）。
 *    目标是**"看得出是不是对的"**，不是"看起来一样"。
 */
function renderView(p) {
  const pane = $("#viewPane"); pane.innerHTML = "";
  const wrap = el("div", "pv");

  // ── 图：主图大，其余排成一行小图 ──
  const imgs = [p.images?.main, ...(p.images?.gallery || [])].filter(Boolean);
  if (imgs.length) {
    const hero = el("div", "pv-hero");
    setThumb(hero, rawUrl(imgs[0]), p.name || p.slug);
    wrap.append(hero);
    if (imgs.length > 1) {
      const strip = el("div", "pv-strip");
      imgs.slice(1).forEach((g) => { const t = el("div", "pv-thumb"); setThumb(t, rawUrl(g), g); strip.append(t); });
      wrap.append(strip);
    }
  } else {
    wrap.append(el("div", "pv-noimg", "还没有图片 —— 官网上这个产品会没有主图。"));
  }

  // ── 标题 / 机型·型号 ──
  wrap.append(el("h1", "pv-title", p.name || p.slug || "（未命名）"));
  const meta = el("div", "pv-meta");
  if (p.category) meta.append(el("span", "pv-cat", p.category));
  if (p.model) meta.append(el("span", "pv-model", p.model));
  // ⚠️ 预览态没有输入框可贴，model 那条提示就贴在型号旁边（见 renderIssues 的回落）
  wrap.append(meta);

  // ── 传感器 chip ──
  if (p.sensors?.length) {
    const sec = el("section", "pv-sec");
    sec.append(el("h3", "pv-h3", "传感器"));
    const chips = el("div", "taglist");
    p.sensors.forEach((x) => chips.append(el("span", "tag", x)));
    sec.append(chips); wrap.append(sec);
  }

  // ── 卖点 ──
  if (p.highlights?.length) {
    const sec = el("section", "pv-sec");
    sec.append(el("h3", "pv-h3", "卖点"));
    const ul = el("ul", "pv-list");
    p.highlights.forEach((h) => ul.append(el("li", null, h)));
    sec.append(ul); wrap.append(sec);
  }

  // ── 参数表 ──
  const specEntries = Object.entries(p.specs || {});
  if (specEntries.length) {
    const sec = el("section", "pv-sec");
    sec.append(el("h3", "pv-h3", "参数"));
    const t = el("table", "pv-specs");
    specEntries.forEach(([k, v]) => {
      const tr = el("tr"); tr.append(el("th", null, k), el("td", null, v)); t.append(tr);
    });
    sec.append(t); wrap.append(sec);
  }

  pane.append(wrap);

  // ── 内部信息区：**与预览区在视觉上分开** ──
  // ⚠️ 这些东西官网上看不到，所以它们不能待在"预览"里面 —— 否则"预览"这个词就是假的。
  const internal = el("section", "pv-internal");
  internal.append(el("h3", "pv-h3", "内部信息 · 官网上看不到"));
  const t = el("table", "kvtable");
  const row = (k, v, cls) => {
    const tr = el("tr", cls); tr.append(el("th", null, k));
    const td = el("td"); td.append(typeof v === "string" ? el("code", null, v) : v); tr.append(td); t.append(tr);
  };
  row("slug", p.slug || "—");
  row("状态", el("span", `badge badge-${p.status || "unknown"}`, statusLabel(p.status)));
  row("moq", p.moq == null ? "面议（未设 moq）" : String(p.moq));
  if (p.supplierRef) row("supplierRef", p.supplierRef, "internal-row");
  // A12-③：文件路径从顶部挪到这里 —— Joe 不看仓，但排查时它有用
  if (state.filePath) row("数据文件", state.filePath);
  internal.append(t);
  pane.append(internal);
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
    // 🔴 `ow/oh` = **原图**尺寸，纯增量返回，⛔ 不参与任何计算 ——
    //    它只用来在卡片上说清"已从 W×H 缩到 …"。⛔ blob 的字节由 scale 与 q 决定，这两个字段碰不到它。
    if (blob.size <= MAX_UPLOAD) return { blob, quality: q, w: cv.width, h: cv.height, ow: bmp.width, oh: bmp.height };
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

/**
 * 图片这一块**除了增删，还要说清封面和顺序**。
 *
 * 🔴 病根：`imageOps` 数的是**文件增删**，而换封面/拖顺序一个文件都不动 ——
 *    它只改 JSON 里的 `images.main` / `images.gallery`。
 *    于是拖完封面，面板写「图片 **无改动**」。
 * ⚠️ 那句话**在它自己的口径下是真的**（确实没有文件增删），**在读者的口径下是假的**
 *    （他刚把封面换了，屏幕告诉他图片没变）。
 *    ⇒ 与今天修过的同族：「逐字节相同」在只换图时、「什么都不会改」在有图片操作时 ——
 *      **一句只在自己口径下为真的话，就是假话。**
 *
 * ⛔ 判据不落在 `imageOps` 上（它天然看不见这件事），落在**列表本身**：
 *    仓里的 `[main, ...gallery]` ↔ 编辑器里的 `state.imgList`。
 *
 * @returns {{cover: null|{gone:true}|{from:string,to:string}, reordered:boolean} | null}
 *          新建时返回 null —— 那时"全都是新增"，说"换封面"没有意义。
 */
function describeImageMoves() {
  if (state.isNew) return null;
  const old = state.loaded?.product?.images;
  if (!old) return null;
  const oldList = [old.main, ...(old.gallery || [])].filter(Boolean);
  const list = state.imgList || [];
  const base = (p) => String(p).split("/").pop();

  // ── 封面 ──
  let cover = null;
  const oldCover = oldList[0] ?? null;
  const first = list[0];
  if (oldCover && !first) cover = { gone: true };
  else if (oldCover && first) {
    // 新上传的那张此刻还没有路径（服务端算），所以只能按"这次新上传的"来称呼它。
    if (first.kind === "new") cover = { from: base(oldCover), to: "这次新上传的那张" };
    else if (first.path !== oldCover) cover = { from: base(oldCover), to: base(first.path) };
  }
  // ⚠️ 原来一张图都没有 ⇒ 现在有了，那是**新增**不是"换封面"，`imageOps` 已经说过了。

  // ── 顺序：只比**两边都还在**的老图的相对次序 ──
  // ⚠️ 这样：纯删除不算换序（剩下的相对次序没变）；
  //    中间插一张新图也不算（老图彼此的次序没变）。
  const keptNew = list.filter((it) => it.kind === "have").map((it) => it.path);
  const keptSet = new Set(keptNew);
  const keptOld = oldList.filter((p) => keptSet.has(p));
  const reordered = keptNew.length === keptOld.length && keptNew.some((p, i) => p !== keptOld[i]);

  return { cover, reordered };
}

function renderImages() {
  // 图片增删改后同步刷新 sticky 条的计数（这里是所有图片变化的汇合点）
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

    // ── 待上传的图：把**上传时实际做了什么**摆出来（Joe 2026-08-28 批）──
    //
    // 🔴 ⛔ 这里**没有改变任何图片处理行为**：`toWebp()` 的三个数（1600 / 质量阶梯 / 2MB）
    //    一个字没动。这些值本来就已经算出来、存在 `imgList` 里了 —— **只是从来没画到屏幕上。**
    // ⚠️ 他要知道的是"我这张图被动过什么"，⛔ 不是压缩算法 ⇒ 只说尺寸与画质两件事。
    if (it.kind === "new") {
      card.append(el("span", "itag", `待上传 ${(it.size / 1024).toFixed(0)}KB`));
      const meta = el("span", "imeta", `${it.w}×${it.h}`);
      // 🔴 被缩过必须说明从多大缩来 —— ⛔ 只报结果尺寸，他看不出原图被动过
      if (it.ow && it.oh && (it.ow !== it.w || it.oh !== it.h)) {
        meta.append(el("span", "ishrunk", `（已从 ${it.ow}×${it.oh} 缩小）`));
      }
      card.append(meta);
      // 🔴 画质 ≤55% = 为了压进 2MB **牺牲了画质** ⇒ 让他当场知道、当场决定换不换图，
      //    ⛔ 不是等哪天在官网上看出来再反推。
      const low = it.quality <= 0.55;
      const q = el("span", "iq" + (low ? " is-low" : ""), `画质 ${Math.round(it.quality * 100)}%`);
      q.title = low
        ? `为了压进 ${(MAX_UPLOAD / 1024 / 1024).toFixed(0)}MB，这张图被压到了 ${Math.round(it.quality * 100)}%。`
          + `不满意的话，请先自行压缩、或换一张更小的再传。`
        : `按 ${Math.round(it.quality * 100)}% 导出，未触发降质。`;
      card.append(q);
    } else {
      card.append(el("span", "itag", it.path.split("/").pop()));
    }

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

  // 🔴 图片增 / 删 / 拖动换位**全都**要经过这里 ⇒ 这一处就守住了图片那一路。
  //    ⚠️ Joe 撞的正是这条路：删完图，面板还写着「图片无改动」。
  //    ⛔ 别改成在每个 onclick 里各调一次 —— 拖动那条路会被忘掉（它不是按钮）。
  invalidatePreviewIfStale();
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
      const { blob, quality, w, h, ow, oh } = await toWebp(arr[k]);
      state.imgList.push({
        kind: "new", base64: await blobToBase64(blob),
        url: URL.createObjectURL(blob), size: blob.size, quality, w, h, ow, oh,
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

/**
 * 重复行（卖点）。⭐ 每一行**认领自己的字段名**（`highlights[N]`）并**自己报字数**。
 *
 * 🔴 为什么不是把那段 30 字的完整说明抄到每一行：那是把一块噪音拆成七块。
 *    **一个数字 + 一个颜色就够**，完整理由放 title（hover 再看）。
 * ⚠️ 计数用的是 SEO 页那套**三态**（留空 / 正常 / 超标），⛔ 不造第二套。
 */
function repeatRow(container, value, opts = {}) {
  const r = el("div", "repeat-row");
  const i = el("input"); i.value = value || "";
  const d = el("button", "del-row", "×"); d.type = "button";
  const cnt = opts.limit ? el("div", "shint rowcnt") : null;

  // ⚠️ 下标由**它在容器里的实际位置**算，不是创建顺序 —— 删掉中间一行之后
  //    后面几行的下标会整体前移，而校验器报的是新下标。
  const reindex = () => {
    [...container.querySelectorAll(".repeat-row > input")].forEach((inp, n) => {
      inp.dataset.anchor = `${opts.field || "highlights"}[${n}]`;
    });
  };
  const paint = () => {
    if (!cnt) return;
    const n = i.value.trim().length;
    cnt.classList.remove("cnt-empty", "cnt-ok", "cnt-over");
    if (n === 0) { cnt.classList.add("cnt-empty"); cnt.textContent = "留空"; cnt.title = ""; }
    else if (n > opts.limit) {
      cnt.classList.add("cnt-over");
      cnt.textContent = `${n} 字符`;
      // 完整理由挂 title —— 屏幕上只留数字和颜色
      cnt.title = `契约说的是"短句"（建议 ${opts.limit} 字符以内）。详情页的参数表用 specs，别塞进卖点。` +
        "⚠️ 卖点过长会把官网产品页那一栏撑窄。";
    } else { cnt.classList.add("cnt-ok"); cnt.textContent = `${n} 字符`; cnt.title = ""; }
  };
  d.onclick = () => { r.remove(); reindex(); };
  i.addEventListener("input", paint);
  r.append(i, d); if (cnt) r.append(cnt);
  container.append(r);
  reindex(); paint();
}
function kvRow(container, k, v) {
  const r = el("div", "kv-row");
  const ik = el("input", "k"); ik.value = k || ""; ik.placeholder = "键";
  const iv = el("input", "v"); iv.value = v || ""; iv.placeholder = "值（字符串）";
  // specs 的提示是 `specs.<key>` ⇒ 值那一格认领它，键一改就跟着改。
  const claim = () => { iv.dataset.anchor = `specs.${ik.value.trim()}`; };
  ik.addEventListener("input", claim); claim();
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
  $("#f_metadesc").value = p.metaDescription || "";
  paintMetaDesc();   // 计数与"保存"可用态跟着新值走 —— 换产品时不能留着上一个的红字/禁用

  $("#f_sensors").querySelectorAll("input").forEach((cb) => { cb.checked = (p.sensors || []).includes(cb.value); });

  const h = $("#f_highlights"); h.innerHTML = "";
  (p.highlights || []).forEach((x) => repeatRow(h, x, { field: "highlights", limit: hlLimit() }));
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
    // 空 ⇒ null ⇒ 服务端 mergeProduct 删键 ⇒ 仓里**没有**这个字段（SPEC §2："空值保存时不写该字段"）。
    // ⛔ 别送 ""：契约把空串当错误（与 moq 同一条规矩），官网模板也不该看到一个假值。
    metaDescription: nz($("#f_metadesc").value),
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

  // 🔴 乐观锁：把**打开这个产品那一刻**读到的文件 sha 原样带回去。
  //    ⚠️ 它随产品数据在**同一个响应**里返回（`state.loaded.sha`）⇒ ⛔ 不存在"保存时再取一次"的缝隙。
  //    新建时没有 sha（文件还不存在）—— 那条路由 `mustCreate` 守着 slug 唯一性，不需要它。
  const expectedSha = state.isNew ? undefined : state.loaded?.sha;

  return { patch, uploads, ...(expectedSha ? { expectedSha } : {}), ...extra };
}

/**
 * 🔴 `wouldChange` **只有一种读法**。
 *
 * ⚠️ 这个函数存在的唯一理由，是 P0-1 的病根曾经原样复活过一次：
 *    同一个字段，`nothingToDo` 缺失时恒 false（不降级），`canCommit` 缺失时降级到 identical，
 *    两个消费者隔着 76 行各写各的判断 ⇒ 字段一缺，两边说的话互相矛盾。
 * ⇒ **一个字段只有一处降级**。要改降级方式，改这里，两个消费者一起跟着变。
 *
 * 缺失时退回旧判据（`!identical`）：它只看数据文件、看不见图片操作 ——
 * ⛔ 所以调用方**必须**同时把 `missing` 吼出来（见 `renderPreview()` 开头）。
 */
function readWouldChange(r) {
  const missing = r.change?.wouldChange === undefined;
  return { missing, wouldChange: missing ? !r.change.identical : r.change.wouldChange };
}

/**
 * 「这块确认面板算的是哪一份内容」的指纹。
 *
 * ⚠️ ⛔ 不直接用 `JSON.stringify(buildEnvelope())`：新图的 `base64` 在里面，
 *    每次按键都要把几 MB 的串拼出来比一遍。
 * 🔴 新图用 `it.url`（每个 blob URL 唯一）当身份，⛔ 不用 `it.size` ——
 *    两张不同的图大小可能一样，那样换图会**比不出差别**，闸就瞎了。
 *    （我第一版差点写成 `it.name`，而 imgList 的新图项**根本没有 name 字段** ⇒
 *      恒为 undefined ⇒ 所有新图指纹相同。写之前去数据结构里核了一遍才发现。）
 */
function previewFingerprint() {
  try {
    return JSON.stringify({
      patch: readForm(),
      // 顺序也算：第一张就是封面，拖动换位是**真改动**
      imgs: (state.imgList || []).map((it) => (it.kind === "have" ? "h:" + it.path : "n:" + it.url)),
    });
  } catch { return null; }
}

/**
 * 🔴 内容变了就不许再把上一次的确认结果摆在屏幕上。
 *
 * ⚠️ 真事（Joe 2026-08-27）：他删掉一张图后问「**我刚刚删了一张图片，怎么又保存不了**」——
 *    屏幕上是删完的 5 格，而面板还写着「图片**无改动**」「什么都不会改」。
 *    **他看到的是一句已经不成立的断言，于是以为系统坏了。**
 *    这块面板出现在按下提交之前的最后一眼，**正是最该说真话的位置**。
 *
 * ⛔ 不做成"一动就清空"：那样什么都没改时面板也会消失，结论永远看不到（见反向自证判据）。
 *    ⇒ 判据是**指纹变了没有**，不是"有没有事件发生"。
 * ⛔ 不做成"自动重算"：那会变成每次按键发一个 dry-run 请求。
 */
function invalidatePreviewIfStale() {
  const box = $("#preview");
  if (!box || box.hidden || !state.previewOf) return;   // 没有面板，就无所谓过时
  const now = previewFingerprint();
  if (now === null || now === state.previewOf) return;  // 🔴 反向自证：没变 ⇒ 面板留着
  state.previewOf = null;
  box.innerHTML = "";
  box.append(mkNotice("warn",
    "**内容已改变**，上面那份确认结果已经过期 —— 请重新点「保存」，再确认一次。"));
}

// ═══════════════ 预览（dry-run）═══════════════
/**
 * 主按钮的文案（A12 追加③）。
 *
 * 🔴 闸没变：仍是"点它 → 校验 + 展示将要写入的内容 → 再点确认才真写"。
 *    变的是**措辞**：原来叫「校验并预览」——那是在描述**机制**，而人找的是「保存」。
 *    而且新建时根本没有 diff 可言（新文件），"预览 diff"这个概念对新建态本就不成立。
 * ⚠️ 新建与编辑**各说各的**，⛔ 不用同一句话硬套两种情形。
 */
// 🔴 两态都叫「保存」（Joe 2026-08-27：「不要出现"保存草稿"这种按钮」）。
//    **草稿/上架是 `status` 字段的事，按钮不该替它说话** —— 按钮说"保存草稿"，
//    而表单里 status 明明可以是"在线"，两处就开始互相矛盾。
const saveBtnLabel = () => "保存";

async function doPreview(e) {
  e.preventDefault();
  const btn = $("#previewBtn");
  const slug = state.isNew ? ($("#f_slug").value.trim() || "unnamed") : state.slug;
  btn.disabled = true; btn.textContent = "检查中…";
  // 🔴 **发请求之前**记下指纹，⛔ 不是渲染之后 ——
  //    请求飞在路上时人还能接着改；那种情况下面板一渲染出来就已经是过时的，
  //    此刻记下的指纹才对得上"这块面板算的是哪一份内容"。
  state.previewOf = previewFingerprint();
  try {
    const { body } = await api(`/api/products/${encodeURIComponent(slug)}/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildEnvelope()),
    });
    renderPreview(body);
    renderIssues(body.validation);
    // 请求飞在路上的这段时间里人可能已经改过了 ⇒ 渲染完立刻自查一次
    invalidatePreviewIfStale();
  } catch (err) {
    renderIssues({ ok: false, errors: [{ field: "(请求)", code: "failed", message: err.message }], warnings: [] });
    $("#preview").hidden = true;
  } finally {
    btn.disabled = false; btn.textContent = saveBtnLabel();
  }
}

function renderPreview(r) {
  const box = $("#preview"); box.hidden = false; box.innerHTML = "";
  const wrap = el("div", "preview");

  // 🔴 服务端没给出 `wouldChange` ⇒ **必须吼出来**，⛔ 不许静默退回旧判据。
  //
  // ⚠️ 这条提示防的是**这个 bug 当初诞生的方式**：
  //    A6（`5c045c0`）把写入换成原子多文件提交，响应里少了两个字段，**没有任何地方吼一声**，
  //    于是按钮门坏了 16 天没人发现。下面那条 fallback（`canCommit`）本身是同一个形状的入口 ——
  //    将来哪次迁移再动响应结构，判据会**悄悄退回**到只看数据文件的旧逻辑。
  //    ⇒ 退回可以，静默不行。退回时屏幕上必须有话说。
  //
  // ⛔ 不做成"缺失就不给按钮"：那会把一个还能用的兜底变成新的卡死。**要的是吼，不是拒。**
  const { missing: wouldChangeMissing, wouldChange } = readWouldChange(r);
  if (wouldChangeMissing) {
    // ⚠️ 写成一段：`.notice` 没有 `white-space: pre-wrap`，换行会被折叠成空格。
    //    ⛔ 不为这一条去给 `.notice` 加 pre-wrap —— 那会让别处多行模板串里的缩进也被渲染出来。
    wrap.append(mkNotice("warn",
      "⚠️ **服务端没有给出这次的改动判定**，界面已退回旧判据 —— 而旧判据**只看数据文件、看不见图片改动**。" +
      "如果你这次**只换了图片、没改字段**，下面可能不出现保存按钮，或者面板会说「什么都不会改」，" +
      "**那句话在这种情形下是假的**。这通常说明接口结构变过了，请把这条提示告诉开发窗，别当成偶发。"));
  }

  // ⚠️ 这里原来是「将要改动 <完整仓内路径> +38 −0 1234B」。
  //    Joe 2026-08-27：「也不要出现下面的代码」。⇒ 路径全文、diff 计数、字节数全部撤掉。
  //    ⛔ **确认这一步本身保留** —— 他指的是"代码"，不是"确认"（按最小范围理解那句话）。

  // 🔴 三种结论要说不同的话。混成一句"预览完成"，最危险的那种（什么也没变）会被当成成功。
  // ⚠️ 这里原来只判 `r.change.identical`（JSON 逐字节相同）⇒ **只换一张图、不动字段**时
  //    它为 true，于是这句话说"什么都不会改"，而下面的提交按钮也不渲染。
  //    可**同一块面板上自己写着「图片 N 项改动」** —— 它知道有改动，却不让提交，
  //    而那句话在这个情形下**是假的**：会改一张图。
  //    ⇒ 判据换成服务端算的 `wouldChange`（JSON 变了 **或** 有图片操作），
  //      与真实写入路径判的是同一件事。
  const imgOnly = r.change.identical && (r.imageOps?.length || 0) > 0;
  // 🔴 与下面的 `canCommit` **读的是同一个值**（`readWouldChange()`），⛔ 不再各写各的降级。
  //    原来这行是 `r.change?.wouldChange === false` —— 字段缺失时它恒为 false，**不降级**；
  //    而 76 行之外的 `canCommit` 缺失时**降级到 identical**。
  //    ⇒ 同一个字段两个消费者两种读法，于是字段一缺，面板会对一个逐字节没变的产品说
  //      「以下是**将要写入的改动**」。这正是 P0-1 的病根原样复活：**两边判的不是同一件事。**
  const nothingToDo = !wouldChange;
  if (nothingToDo) {
    wrap.append(mkNotice("warn", "内容与现有文件**逐字节相同**，也没有图片变动 —— 这次即使真的保存，也什么都不会改。"));
  } else if (imgOnly) {
    // 第三种情形：数据文件不变，但有图片要写。⛔ 绝不能说"什么都不会改"。
    wrap.append(mkNotice("ok", `**数据文件不变**，但有 **${r.imageOps.length} 项图片改动** —— ` +
      "确认无误后点下面的按钮，图片会写进仓里。"));
  } else if (!r.validation.ok) {
    wrap.append(mkNotice("bad", `契约校验未通过（${r.validation.errors.length} 个错误），这份内容不允许写入。上方已逐条列出。`));
  } else {
    wrap.append(mkNotice("ok", state.write?.enabled
      ? (state.isNew
          ? "契约校验通过。以下是**将要创建的文件** —— 确认无误后点下面的按钮。"
          : "契约校验通过。以下是**将要写入的改动** —— 确认无误后点下面的按钮。")
      : "契约校验通过。以下是将要写入的改动 —— 但当前无法写入。"));
  }

  if (r.change.cleared?.length) {
    wrap.append(mkNotice("warn", `会被**清空**的字段：${r.change.cleared.join("、")}`));
  }

  // ══ 人话摘要（Joe 2026-08-27：「不要出现下面的代码」）══
  //
  // 这里原来是：38 行 `+` 开头的**原始 JSON**（转义字符串、路径全文）
  // + 一份逐条列文件路径的图片清单 + 一个「完整内容（可复制走）」的折叠区。
  // ⇒ 全部撤掉。
  //
  // ⛔ **但确认这一步没有撤** —— Joe 说的是"代码"，不是"确认"（按最小范围理解他的话）。
  // 🔴 而且确认区里有**表单上根本看不到的信息**，其中一条只在这里出现：
  //    · **这次会动几个图片文件** —— 图片操作在表单里完全不可见。
  //      它是唯一能让人发现"我以为只改了标题，其实还搬了 9 个文件"的地方。
  //    · 文件会落到哪个区（草稿图不进官网构建）
  //    · 这次保存会触发一次官网重建
  {
    const sum = el("div", "savesum");
    const name = ($("#f_name")?.value || "").trim() || r.target.path.split("/").pop();
    sum.append(el("div", "savesum-t", (r.target.exists ? "将更新产品「" : "将新建产品「") + name + "」"));
    const ul = el("ul");
    const li = (t) => ul.append(appendMd(el("li"), t));

    li(`数据文件 **1 个**`);

    // 🔴 图片这一块是**两件事**，读者分得清，所以面板也要分开说：
    //    ① 文件增删（`imageOps` 看得见）  ② 封面/顺序（只在 JSON 里，`imageOps` 看不见）
    // ⛔ 「无改动」只有在**两件都没有**时才许说 —— 见 describeImageMoves() 的病根注释。
    const moves = describeImageMoves();
    if (r.imageOps?.length) {
      // ⚠️ 这个数必须留着，而且要与真实 imageOps 长度**相等** —— 不是"约"、不是取整。
      const n = r.imageOps.length;
      const draft = r.imageOps.filter((o) => /\/_draft\//.test(o.path)).length;
      const dels = r.imageOps.filter((o) => o.op === "delete").length;
      let t = `图片 **${n} 项改动**`;
      const bits = [];
      // ⚠️ 用破折号不用括号：里层那句本身带括号，套起来会出现「（…（…））」这种双层。
      if (draft) bits.push(`其中 ${draft} 张进草稿区，**草稿图不会进官网构建**`);
      if (dels) bits.push(`${dels} 张会被删除`);
      if (bits.length) t += ` —— ${bits.join("；")}`;
      li(t);
    }
    if (moves?.cover?.gone) {
      li("封面 **被删除** —— 这个产品将一张图都没有");
    } else if (moves?.cover) {
      li(`封面 **从「${moves.cover.from}」换成「${moves.cover.to}」**`);
    }
    // ⚠️ 换封面本身就是一次换序 ⇒ 封面已经点名时**不再重复说"顺序有调整"**（两句都真，但后一句是废话）。
    //    ⛔ 所以顺序这一条只在"封面没变"时出现 —— 那正是 Joe 只拖了后面几张的情形。
    if (moves?.reordered && !moves?.cover) li("图片**顺序有调整**（封面没变）");
    if (!r.imageOps?.length && !moves?.cover && !moves?.reordered) li("图片 **无改动**");

    li("这次保存会产生一次 commit 并触发 airsonde.com 重建，**约 1 分钟后站上可见**");
    sum.append(ul);
    wrap.append(sum);
  }

  // ── 提交按钮：**只在真能写、且这份内容确实该写的时候才出现** ──
  // ⚠️ 不做成"永远显示但 disabled"：一个灰着的提交按钮会让人以为"再试试就能点"，
  //    而真实情况是这份内容根本不允许提交。不该出现的东西就不要出现。
  // 🔴 判据是 `wouldChange`（JSON 变了 **或** 有图片操作），不是 `!identical`。
  //    用 identical 的话，只换图不改字段 ⇒ 按钮不渲染 ⇒ 图永远传不上去。
  //    ⚠️ 兼容旧响应：wouldChange 缺失时退回旧判据。
  //    🔴 这行注释原来写着「⛔ 但不静默」—— **而代码里没有任何告警、日志或界面提示，它就是静默的。**
  //       注释断言的和代码做的是两回事，而注释还骗了下一个读它的人（包括我自己）。
  //       ⇒ 真正的吼现在装在 `renderPreview()` 开头（`wouldChangeMissing`），
  //         这行注释只是指过去，⛔ 别再把"打算怎么做"写成"已经这么做了"。
  // ⚠️ 它在 `change` 里（它是"这次改动"的属性），⛔ 不在顶层 ——
  //    我第一版读成了 `r.wouldChange`，于是恒为 undefined、恒退回旧判据。
  //    **写完就量**才抓到：文案分支没按预期走。
  // 🔴 降级逻辑现在只有 `readWouldChange()` 一处，上面的 `nothingToDo` 读的是同一个值 ——
  //    所以 `nothingToDo === !canCommit` 恒成立，⛔ 不可能出现"面板说什么都不会改、按钮却可点"。
  const canCommit = wouldChange;
  if (state.write?.enabled && r.validation.ok && canCommit) {
    const bar = el("div", "commit-bar");
    // ⚠️ 这一步**没有被去掉**，只是名字从"提交"改成"确认保存并上线" ——
    //    它写的是生产数据且会触发官网重建，写前看一眼是真价值。
    const btn = el("button", "primary", "确认保存并上线");
    btn.type = "button";
    btn.onclick = () => doCommit(r, btn);
    bar.append(btn);
    bar.append(el("span", "actions-note",
      `${r.target.exists ? "更新" : "新建"} ${r.target.path.split("/").pop()} —— 会产生一次 commit 并触发 airsonde.com 重建。`));
    wrap.append(bar);
  } else {
    wrap.append(mkNotice("warn", r.note + `（写能力：${r.writeCapability}）`));
  }

  box.append(wrap);
  wrap.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ═══════════════ 真实提交 ═══════════════
/**
 * 🔴 "写已经发生了，但后面的渲染/刷新炸了" —— 这一句是给这种情形用的。
 *
 * ⛔ 这种时候**绝不能说"失败"**：说失败 ⇒ 人再点一次 ⇒ **第二次真的写**。
 *    2026-08-27 就这么让 Joe 在 13 秒内往官网仓写了两个 commit。
 * ⚠️ 有多少报多少：commit sha 拿得到就报，拿不到就说拿不到，⛔ 不硬拼一个空壳。
 */
function wroteButRenderFailed(commitSha, err) {
  const sha = commitSha ? String(commitSha).slice(0, 7) : "(没拿到 commit sha)";
  return `**已保存**（commit \`${sha}\`），但界面在显示结果时出错了：${err && err.message ? err.message : err}` +
    " —— **改动已经写进仓里了，⛔ 不要再点一次**。刷新一下页面即可。";
}

async function doCommit(prev, btn) {
  const slug = state.isNew ? ($("#f_slug").value.trim() || "unnamed") : state.slug;
  btn.disabled = true;
  btn.textContent = "提交中…";

  // 🔴🔴 **"写有没有发生"与"渲染有没有成功"必须彻底分开。**
  //
  // 2026-08-27 真出过：服务端**写成功了**（官网仓里有 commit），而客户端在渲染成功提示时
  // 抛了 `Cannot read properties of undefined (reading 'slice')` ⇒ 掉进 catch ⇒
  // 界面报「**提交请求失败**」⇒ Joe 以为没成功 ⇒ **又点了一次 ⇒ 又真写了一次**。
  // 13 秒内两个 commit。数据这次侥幸没坏，**但那是运气不是设计**。
  //
  // ⇒ 一旦拿到服务端 2xx 且 `wrote:true`，**这次写就已经发生了**。
  //   之后无论渲染出什么错，⛔ **绝不允许再显示"提交请求失败"**。
  let wroteOk = false;      // ← 越过这一行之后，"失败"这个词就不许再出现
  let payload = null;

  try {
    const r = await fetch(`/api/products/${encodeURIComponent(slug)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildEnvelope({ mustCreate: state.isNew })),
    });
    const b = await r.json().catch(() => null);
    payload = b;
    const box = $("#preview");

    if (b?.wrote === true) {
      wroteOk = true;   // ⚠️ 在渲染任何东西**之前**就置位

      // ── 渲染成功提示 ──
      // ⚠️ 每一个字段都兜底：这次就是 `blobSha` 没兜底炸的。
      //    🔴 而且那不是偶发 —— 产品保存走的是 commitFiles()，它**从来不返回**
      //       `blobSha` / `bytes`（那两个字段是另一个函数 writeProductFile 的）。
      //       客户端这两行是 A4 写的，那时服务端确实返回它们；A6 换成原子多文件提交后
      //       没人回来改这里 ⇒ **"迁移时没枚举谁假设了旧形态"**。
      const ok = el("div", "notice notice-ok");
      ok.append(el("b", null, "已提交。"));
      const sha = b.commitSha ? String(b.commitSha).slice(0, 7) : "(没拿到 commit sha)";
      ok.append(document.createTextNode(" commit "));
      if (b.commitUrl) {
        const a = el("a", null, sha);
        a.href = b.commitUrl; a.target = "_blank"; a.rel = "noopener";
        ok.append(a);
      } else ok.append(el("code", null, sha));
      // 有多少报多少：字节校验那一段只在服务端真的给了才显示，⛔ 不硬拼一个空壳
      const bytes = typeof b.verifiedBytes === "number" ? b.verifiedBytes
        : (typeof b.bytes === "number" ? b.bytes : null);
      if (bytes != null) ok.append(document.createTextNode(`  ·  ${bytes}B`));
      const nFiles = Array.isArray(b.files) ? b.files.length : null;
      if (nFiles != null) ok.append(document.createTextNode(`  ·  这一个 commit 落了 ${nFiles} 个文件`));
      box.prepend(ok);
      box.prepend(mkNotice("warn", "官网重建需要一两分钟。**现在去刷 airsonde.com 看到的仍是旧内容，这不是没保存成功。**"));
      btn.remove();

      // 🔴 待上传清单必须清空：不清的话，下一次保存会把同一批图**再传一遍**，
      //    而且如果这时切到别的产品，这批图会落到那个产品名下。
      resetPending();
      state.cacheBust = b.commitSha;
      await loadList();
      await select(slug);
      return;
    }

    // ── 以下都是**没有写成**的分支 ──
    if (r.status === 409) {
      box.prepend(mkNotice("bad", `**并发冲突**：${b?.detail || ""}`));
      btn.disabled = false; btn.textContent = "重新提交";
    } else if (b?.wrote === "unknown") {
      // 🔴 这一条绝不能说成"保存失败" —— commit 可能已经产生了，说失败会让人再存一次。
      box.prepend(mkNotice("bad", `**状态未知，需要人工核对**：${b?.detail || ""}`));
    } else {
      box.prepend(mkNotice("bad", `**未提交**（没有产生 commit）：${b?.detail || b?.reason || b?.error || r.status}`));
      btn.disabled = false; btn.textContent = "重新提交";
    }
  } catch (e) {
    // 🔴🔴 分岔就在这里。
    if (wroteOk) {
      // 写**已经发生**了，炸的是后面的渲染/刷新。⛔ 绝不说"提交请求失败" ——
      //    那句话会让人再点一次，而再点一次就是**第二个 commit**。
      const sha = payload?.commitSha ? String(payload.commitSha).slice(0, 7) : "(没拿到 commit sha)";
      $("#preview").prepend(mkNotice("warn",
        `**已保存**（commit \`${sha}\`），但界面在显示结果时出错了：${e.message}` +
        " —— **改动已经写进仓里了，⛔ 不要再点一次保存**。刷新一下页面即可。"));
      // 按钮不还原：还原等于邀请他再写一次
      btn.remove();
    } else {
      $("#preview").prepend(mkNotice("bad", "提交请求失败：" + e.message));
      btn.disabled = false; btn.textContent = "重新提交";
    }
  }
}

function mkNotice(kind, msg) {
  return appendMd(el("div", `notice notice-${kind}`), msg);
}

// ═══════════════ 视图切换 / 事件 ═══════════════
function switchView(v) {
  // ⚠️ 守一道：被禁用的 tab 不许切过去。只把按钮设成 disabled 是不够的 ——
  //    别处（如恢复上次状态）仍可能直接调 switchView("view")。
  const t = document.querySelector(`.tab[data-view="${v}"]`);
  if (t && t.disabled) return;
  state.activeView = v;
  document.querySelectorAll(".tab").forEach((t) => {
    const on = t.dataset.view === v;
    t.classList.toggle("is-on", on);
    // 它们是**互斥的开关按钮** ⇒ aria-pressed 才是准确的语义。
    t.setAttribute("aria-pressed", String(on));
  });
  $("#viewPane").hidden = v !== "view";
  $("#editPane").hidden = v !== "edit";
  // 「保存」住在顶部那一行里（表单外，靠 form="editPane" 归属）⇒ 显隐要跟着 tab 走。
  // ⚠️ 预览态摆一个保存按钮，点了会提交一张看不见的表单 —— 那正是"点了不知道发生了什么"。
  $("#previewBtn").hidden = v !== "edit";
  // 提示贴在哪儿取决于当前 tab ⇒ 切 tab 要用同一份结果重画一次。
  // ⚠️ 传 state.lastValidation 而不是重新校验：重新校验会**掉进另一个真源**，
  //    而人看到的应该始终是"上一次校验的结论"。
  if (state.lastValidation !== undefined) renderIssues(state.lastValidation);
}

document.querySelectorAll(".tab").forEach((t) => { t.onclick = () => switchView(t.dataset.view); });
// 搜索框常驻顶栏 ⇒ 在别的视图里也看得见。
// ⚠️ 不切视图的话，人在设置页打字会**什么都不发生** —— 而那看起来像搜索坏了。
$("#q").oninput = () => {
  if (state.nav !== "products") showNav("products");
  renderList();
};
$("#catFilter").onchange = renderList;
// ── 型号列排序（A15）：点一下升序，再点反序 ──
// ⚠️ 没有"第三态回到原顺序"：Joe 要的是「排序 / 反序」两件事，多一态就多一次看不懂的点击。
$("#sortModelBtn").onclick = () => {
  state.modelSort = state.modelSort === 1 ? -1 : 1;
  // 箭头与 aria-sort 只在这里改 —— modelSort 也只在这里变，两者不可能漂移。
  $("#sortModelArrow").textContent = state.modelSort === 1 ? " ▲" : " ▼";
  $("#thModel").setAttribute("aria-sort", state.modelSort === 1 ? "ascending" : "descending");
  renderList();
};
$("#newBtn").onclick = startNew;
// ── Meta description 计数 + 超限禁存（A16）──
// ⚠️ 上限从 /api/contract 的 limits.metaDescription 拿，⛔ 界面不抄第二份 160（与 hlLimit 同一条规矩）。
//    契约没到时 limit=0 ⇒ 只计数不判超，不会把人锁在一个未知的上限外面。
// ⚠️ 三态复用 SEO 页那套 .cnt-empty/.cnt-ok/.cnt-over，⛔ 不造第二套。
// 🔴 禁用的是"保存"（= 进预览）这一步：超限的内容连预览都不该跑 —— 服务端契约会硬拒，
//    但等它拒再告诉人，等于让人先填完再被打回来。
const mdLimit = () => state.contract?.limits?.metaDescription || 0;
function paintMetaDesc() {
  const ta = $("#f_metadesc"), cnt = $("#f_metadesc_cnt");
  if (!ta || !cnt) return;
  const n = ta.value.trim().length, lim = mdLimit();
  cnt.classList.remove("cnt-empty", "cnt-ok", "cnt-over");
  let over = false;
  if (n === 0) { cnt.classList.add("cnt-empty"); cnt.textContent = "留空 —— 官网沿用自动拼接的描述"; }
  else if (lim && n > lim) { over = true; cnt.classList.add("cnt-over"); cnt.textContent = `${n} / ${lim} 字符 —— 超出上限，保存已禁用，请删到 ${lim} 以内`; }
  else { cnt.classList.add("cnt-ok"); cnt.textContent = lim ? `${n} / ${lim} 字符` : `${n} 字符`; }
  // ⚠️ 只在这里改 previewBtn.disabled，全仓再无第二处 ⇒ 不会出现"谁禁的、谁该解"的漂移
  $("#previewBtn").disabled = over;
  $("#previewBtn").title = over ? "Meta description 超过上限，删到上限以内才能保存" : "";
}
$("#f_metadesc").addEventListener("input", paintMetaDesc);
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
// ⚠️ 「还原」按钮已撤（Joe 2026-08-26）。绑定必须一起删：
//    对着不存在的元素 `.onclick=` 会当场抛 TypeError，而它在模块顶层 ⇒
//    **整份 app.js 停在这一行**，症状是"整个后台白屏"，看起来完全不像是删了个按钮。
document.querySelectorAll(".add[data-add]").forEach((b) => {
  b.onclick = () => {
    if (b.dataset.add === "specs") kvRow($("#f_specs"), "", "");
    else repeatRow($("#f_highlights"), "", { field: "highlights", limit: hlLimit() });
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

  // 🔴 "孤儿"的判据只有一处：服务端盖在每个文件上的 `f.orphan`（media.ts 的 isOrphan）。
  //    ⛔ 这里**不再**写 `!referencedBy.length` —— 那是第二个真源，而且已经出过事：
  //       顶部计数排除 originals（说「未被引用 0」），卡片黄标不排除（38 张原图全被标成
  //       「未被引用」）⇒ 同一个词、同一屏、两个定义。而人会照卡片去删原图。
  const rows = m.files.filter((f) => {
    if (state.mediaTab === "orphan") return f.orphan;
    if (["published","draft","originals"].includes(state.mediaTab)) return f.area === state.mediaTab;
    return true;
  });

  const grid = $("#mediaGrid"); grid.innerHTML = "";
  rows.forEach((f) => {
    const card = el("div", "gcard mcard");
    if (f.orphan) card.classList.add("is-orphan");
    const t = el("div", "thumb"); setThumb(t, rawUrl(f.rel), f.rel);
    card.append(t);
    card.append(el("span", "gtag", f.rel.replace(/^products\//, "").replace(/^_draft\//, "")));
    const use = el("span", "gtag");
    if (f.referencedBy.length) {
      use.textContent = "用于 " + f.referencedBy.join("、");
      // 点一下直接跳到引用它的产品 —— 想删它就得从那里改
      card.style.cursor = "pointer";
      card.onclick = () => { showNav("products"); select(f.referencedBy[0]); };
    } else if (f.orphan) {
      use.textContent = "未被引用";
      use.style.color = "var(--warn)";
    } else {
      // 🔴 原图存档也是"零引用"，但它**不是**孤儿 —— 它是整条图片管线的源材料
      //    （`images:build` 从这里读）。给它自己的标，⛔ 绝不复用「未被引用」那个词：
      //    那个词已经有主了，而它在这里的含义是"可以删"。
      use.textContent = "原图存档 · 不参与打包";
      use.style.color = "var(--muted)";
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
  // ── A：留空时把**继承来的那句**显示出来 ──
  // 🔴 这一页存在的理由就是回答"这一页在搜索结果里会显示什么"。
  //    而 `home · 描述` 是空的 `0 / 160` ⇒ 界面上**没有任何地方**告诉人首页实际显示哪句 ——
  //    人得自己记住"留空=用站点默认"，再自己往上翻去找那句。
  // ⚠️ 它必须**明显是只读的**（灰底、无边框、不是 input）：做成可编辑的框就是第二个写入口，
  //    而这一页刚因为"两个长得一样的框"出过一次事故。
  let paintInherit = () => {};
  if (opts.inheritFrom) {
    // ⚠️ 它要在**别人**（站点默认描述）被改时也重画 —— 只绑自己的 input 的话，
    //    Joe 改完默认描述，下面几张卡显示的还是上一次渲染时的那句。
    //    ⇒ 登记到 state.sitePainters，由 updateSiteDirty（每次输入都跑）统一触发。
    const box = el("div", "inherit");
    box.append(el("span", "inherit-tag", "继承自站点默认"));
    const txt = el("span", "inherit-txt");
    box.append(txt);
    paintInherit = () => {
      const own = input.value.trim();
      box.hidden = !!own;                      // 自己填了就不显示继承
      if (!own) txt.textContent = opts.inheritFrom() || "（站点默认描述也是空的 —— 这一页会没有 description）";
    };
    input.addEventListener("input", paintInherit);
    (state.sitePainters ||= []).push(paintInherit);
    wrap.append(box);
  }

  if (opts.counter) {
    // ── D：计数器**三态**，不是两态 ──
    // ⚠️ `0 / 160`（留空）与 `155 / 160`（快到上限）原来长得一模一样 ——
    //    一个"这一页在继承别人的文案"和一个"再写五个字就超了"，用同一种灰色说。
    const cnt = el("div", "shint");
    const paint = () => {
      const n = input.value.trim().length;
      cnt.classList.remove("cnt-empty", "cnt-ok", "cnt-over");
      if (n === 0) {
        cnt.classList.add("cnt-empty");
        cnt.textContent = opts.inheritFrom ? "留空 —— 继承站点默认描述" : "留空";
      } else if (n > opts.counter) {
        cnt.classList.add("cnt-over");
        cnt.textContent = `${n} / ${opts.counter} 字符 —— 超出部分会在搜索结果里被截断`;
      } else {
        cnt.classList.add("cnt-ok");
        cnt.textContent = `${n} / ${opts.counter} 字符`;
      }
    };
    input.addEventListener("input", paint); paint();
    wrap.append(cnt);
  }
  paintInherit();
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
  // ⚠️ 表单重画 ⇒ 上一批继承框的画笔全部作废。不清的话它们指向已被移除的节点，
  //    每渲染一次就多攒一份，而且看不出任何症状（只是白跑）。
  state.sitePainters = [];
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

    // ══ 首页精选产品（Joe 2026-08-27）══
    //
    // 真源是 site-content.json 的 `home.featuredSlugs`，**数组顺序 = 首页展示顺序**。
    // ⚠️ 只能选**已上架**的：选一个未上架的等于指向一个官网上不存在的页面，
    //    首页那张卡会渲染不出来 —— 而官网构建只打印警告、**不失败**，人不会知道。
    renderFeatured(form);

    const o = siteCard("其它段落");
    siteField(o, "home.sections.capabilitiesIntro", "能力段小字");
    siteField(o, "home.contactBlock.title", "首页联系区块 · 标题");
    siteField(o, "home.contactBlock.body", "首页联系区块 · 正文", null, { multiline: true, rows: 2 });
    form.append(o);
  } else {
    // ══════════ 站级 SEO（Joe 2026-08-26 重做排版）══════════
    //
    // 🔴 这一页的排版**造成过一次真实事故**，不是审美问题：
    //    Joe 想改 /products/ 的描述，粘进了「组织描述」那一格，覆盖了公司简介并上了生产。
    //    根因是三个框长得一模一样、只靠一行灰字区分，而它们进的地方完全不同
    //    （页面 meta / JSON-LD Organization / 单页 meta）。
    const lim = b.limits || { title: 60, description: 160 };

    // ── B：组织描述**独立成块**，不再和「默认标题/默认描述」同卡 ──
    // 它和那两个不是同一种东西：那两个是页面 meta 的兜底，它是公司简介，不属于任何一页。
    const org = siteCard("公司简介", "进 JSON-LD 的 Organization —— 不是任何一页的 meta");
    org.classList.add("card-org");
    org.append(appendMd(el("p", "hint"),
      "🔴 **AI 与搜索引擎读「AirSonde 这家公司是什么」，读的就是这一条。** " +
      "所以它要有主语、要有公司名 —— 一句产品文案放进来，机器读到的是「一堆产品」而不是「一家做贴牌代工的厂」。" +
      "⚠️ 它**不受 160 字符限制**（那是页面 meta 的规矩，与这里无关）。"));
    siteField(org, "seo.organisationDescription", "公司简介", null, { multiline: true });
    form.append(org);

    // ── 站点默认：现在只剩真正属于"页面 meta 兜底"的两个 ──
    const d = siteCard("站点默认", "某一页没单独填时，用这两条兜底");
    siteField(d, "seo.defaultTitle", "默认标题", null, { counter: lim.title });
    siteField(d, "seo.defaultDescription", "默认描述", null, { multiline: true, counter: lim.description });
    form.append(d);

    // ── C：每页一张卡，路径当卡标题 ──
    const defDesc = () => (state.siteDraft?.seo?.defaultDescription || "").trim();
    Object.entries(b.pages || {}).forEach(([key, url]) => {
      const box = siteCard(url, key);
      box.classList.add("card-page");

      // ── E：那条 title 警告挪到**与 title 相邻处** ──
      // ⚠️ 它只关于 title，压在整块顶部时，下面 title 与 description 是混排的。
      //    ⛔ 这句话本身是真的（构建时数唯一 title 数），不许顺手删。
      siteField(box, `seo.pages.${key}.title`, "标题", null, { counter: lim.title });
      box.append(appendMd(el("p", "hint hint-tight"),
        "⚠️ **两页 title 相同会让官网构建直接失败**（构建时数唯一 title 数）—— 后台会先拦住，改动上不了线。"));

      siteField(box, `seo.pages.${key}.description`, "描述", null,
        { multiline: true, counter: lim.description, inheritFrom: defDesc });
      form.append(box);
    });
  }
  updateSiteDirty();
}

/**
 * 首页精选产品：选 / 排序 / 移除。
 *
 * ⛔ 排序沿用**图片列表那套拖拽**（同样的 dragstart/dragover/drop + `state.dragFrom`），
 *    不造第三种交互。
 * 🔴 坏条目（产品不存在 / 已下架）**列出来并标红**，⛔ 绝不静默过滤 ——
 *    静默过滤之后，Joe 的列表里有坏的他永远不知道，而首页会安静地少一张卡。
 */
function renderFeatured(form) {
  const f = state.site?.featured;
  const list = state.siteDraft?.home?.featuredSlugs;
  if (!Array.isArray(list)) return;

  const card = siteCard("首页精选产品", `${list.length} 个 · 顺序就是首页的展示顺序`);
  card.classList.add("card-featured");

  if (f && f.checked === false) {
    card.append(mkNotice("warn", `⚠️ 产品清单读不出来，**这一段没核过**：${f.why}。` +
      "下面只按 slug 显示，看不出哪些已经下架或不存在了。"));
  }

  // ⚠️ 不是 4 的倍数就说一句 —— ⛔ 不阻断（实测 6 条渲染 6 张、9 条渲染 9 张，网格都不塌）
  if (list.length % 4 !== 0) {
    card.append(mkNotice("warn",
      `现在是 **${list.length} 个**，不是 4 的倍数 —— 首页那个网格是 4 列，**最后一行会缺 ${4 - (list.length % 4)} 个位置**。` +
      "不影响保存，也不会让构建失败，只是看起来会缺一角。"));
  }

  // 🔴 查找表要**同时**盖住两种条目，⛔ 不能只用服务端算的那一份。
  //
  // ⚠️ 真事（Joe 2026-08-28）：他把 AK36 加进精选，那张卡渲染成
  //    「无图 /（无型号）/ wbgt-heat-index-monitor」，而**同一个下拉里型号和标题都在**。
  //    成因：`featured.items` 是服务端按**已保存的** featuredSlugs 算出来的 ——
  //    刚从下拉加进草稿的那个 slug **根本不在这张表里** ⇒ `st` 为 undefined ⇒
  //    图取不到、型号回落成「（无型号）」、标题回落成 slug。
  //    ⇒ **数据一直是对的**（保存 envelope 里那条 slug 在、官网也正常），坏的只是这一处渲染。
  //    ⛔ "刷新一下就好了"不算修好 —— 刷新之所以好，正是因为服务端这时才把它算进 items。
  //
  // 🔴 为什么图片卡没有这个病：`state.imgList` 里的新条目是**自带渲染数据的**
  //    （`kind:"new"` 带着 url/size）。而精选草稿里存的**只有一个 slug**，
  //    自己描述不了自己 ⇒ 只能靠查表 ⇒ 表不全就露馅。**同族只此一处**（全文件仅两个 `new Map`，另一个是产品详情缓存）。
  //
  // 顺序：先铺「选得到的」当**兜底**（它带着 name/model/image），
  //       再让服务端的 `items` **覆盖**上去 —— 它才知道哪些是坏条目（已下架/不存在）。
  const byStatus = new Map();
  for (const p of (f?.["选得到的"] || [])) {
    byStatus.set(p.slug, { slug: p.slug, exists: true, status: "published",
                           name: p.name, image: p.image, model: p.model, ok: true });
  }
  for (const x of (f?.items || [])) byStatus.set(x.slug, x);
  // ⭐ 卡片网格，**4 列**（Joe 2026-08-27）。
  //    🔴 4 不是随便挑的：官网首页就是 4 列 ⇒ **后台看到的排列 == 首页看到的排列**，
  //       排序时不用在脑子里做一次转换。这才是这一块改成可视化的价值。
  //    ⛔ 不显示 slug（Joe 前面刚让列表撤掉它，这里同理）。
  const ul = el("div", "featgrid");
  list.forEach((slug, i) => {
    const st = byStatus.get(slug);
    // 🔴 `st` 压根查不到，也是**坏条目**，⛔ 不能当成"正常卡但字段恰好都空"。
    //    原来写的是 `st && !st.ok` ⇒ `st` 为 undefined 时它是 undefined（假值）⇒
    //    那张卡既不标红、也没有型号和标题，看起来像"一张普通卡片坏了" ——
    //    **把"查不到"和"查到了但已下架"混成了同一种样子**，而这两者的修法完全不同。
    const bad = !st || !st.ok;
    const cardEl = el("div", "featcard" + (bad ? " is-bad" : ""));
    cardEl.draggable = true;

    // 🔴 坏条目**没有图也没有型号** ⇒ 必须有一个明确的"坏卡"样子，
    //    ⛔ 绝不因为取不到图就静默跳过它 —— 那样他永远不知道列表里有坏的。
    // 型号**醒目**（Joe 点名要的），取自真源 model 字段 —— ⛔ 不是从标题里截的
    const v = featVisual(st, slug, { bad });
    cardEl.append(v.thumb);
    cardEl.append(el("span", "featno", String(i + 1)));
    cardEl.append(v.body);

    if (bad) {
      // 🔴 分得清是哪一种：「不存在」与「已下架」的修法完全不同
      // ⚠️ `st?.` 不是防御性写法凑数：`bad` 现在在 `st` 为 undefined 时也为 true，
      //    写成 `st.exists` 会当场抛错（原来它靠 `bad` 恒假才没炸）。
      const tag = el("span", "featbad", st?.exists ? `已下架` : "产品不存在");
      tag.title = st?.exists
        ? "它现在没有官网页面 —— 首页那张卡会渲染不出来（官网构建只打印警告、不失败，所以站上只是安静地少一张）。"
        : "真源里找不到这个产品 —— 多半是被删了或改过 slug。";
      cardEl.append(tag);
      cardEl.append(el("div", "featslug", slug));   // ⚠️ 坏卡才显示 slug：这时它是**唯一**能指认是谁的东西
    }

    const rm = el("button", "featdel", "×"); rm.type = "button";
    rm.title = "从首页精选里移除（不删产品）";
    rm.onclick = () => {
      state.siteDraft.home.featuredSlugs = list.filter((_, k) => k !== i);
      renderSite(true);
    };
    cardEl.append(rm);

    // 拖拽换序 —— 与图片列表同一套
    cardEl.addEventListener("dragstart", (e) => {
      state.featDrag = i; cardEl.classList.add("is-dragging");
      e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(i));
    });
    cardEl.addEventListener("dragend", () => { cardEl.classList.remove("is-dragging"); state.featDrag = null; });
    cardEl.addEventListener("dragover", (e) => { if (state.featDrag == null) return;
      e.preventDefault(); cardEl.classList.add("is-over"); });
    cardEl.addEventListener("dragleave", () => cardEl.classList.remove("is-over"));
    cardEl.addEventListener("drop", (e) => {
      if (state.featDrag == null) return;
      e.preventDefault(); e.stopPropagation(); cardEl.classList.remove("is-over");
      moveFeatured(state.featDrag, i);
    });
    ul.append(cardEl);
  });
  card.append(ul);

  // 添加：**只列已上架、且还没在列表里的**
  const pool = (f?.["选得到的"] || []).filter((p) => !list.includes(p.slug));
  // ── 「加一个产品」：与上面那排卡**同一套视觉**（Joe 2026-08-28）──
  //
  // ⚠️ 原来是原生 `<select>`，只显示得了纯文本，而最长那条产品名是：
  //    `AK34 · AK34-18 in 1 Air Quality Monitor Indoor,15D & 24H History, 7" TFT CO2 …`
  //    —— 一行拉得比屏幕还宽。⇒ 改成缩略图 + 型号 + 标题。
  //
  // 🔴 复用两样东西，⛔ 都不另起炉灶：
  //    ① 渲染走 `featVisual()` —— 与精选卡**同一处代码**
  //    ② 查找走上面那张 `byStatus` —— **同一张表**（它已经同时盖住"已保存的"和"可选的"两种来源）
  //
  // 🔴 每一项是 `<button>`，不是 div：原生按钮**天然可聚焦、Enter/空格可激活** ——
  //    换掉原生 select 最容易丢的就是键盘可达，用按钮就不用自己发明一套 tabindex/keydown。
  const add = el("div", "featadd");
  add.append(el("div", "featadd-head", `＋ 加一个产品（可选 ${pool.length} 个）`));
  if (!pool.length) {
    add.append(appendMd(el("span", "hint"), "**已上架的产品都已经在精选里了。**"));
  } else {
    const grid = el("div", "featpickgrid");
    pool.forEach((p) => {
      const st = byStatus.get(p.slug);          // 🔴 同一张表
      const b = el("button", "featpick"); b.type = "button";
      const v = featVisual(st, p.slug);         // 🔴 同一处渲染
      b.append(v.thumb); b.append(v.body);
      b.title = `加入首页精选：${st?.name || p.slug}`;
      b.onclick = () => {
        state.siteDraft.home.featuredSlugs = [...list, p.slug];
        renderSite(true);
      };
      grid.append(b);
    });
    add.append(grid);
  }
  add.append(appendMd(el("span", "hint"),
    "⚠️ 只列**已上架**的产品：未上架的在官网上没有那一页，选了首页那张卡会渲染不出来。"));
  card.append(add);
  form.append(card);
}

/**
 * 缩略图 + 型号 + 标题 —— **精选卡与「加一个产品」选择器共用这一处**。
 *
 * 🔴 ⛔ 别在选择器里再抄一遍这三行：抄一份，就一定会有一天两边长得不一样
 *    （A14 整单就是在收这种"同一个东西两种写法"）。
 * ⚠️ `bad` 只影响型号那一格的占位符：坏条目显示「—」，正常但缺型号显示「（无型号）」——
 *    这两种缺失不是一回事，⛔ 不许混成同一个样子。
 */
function featVisual(st, slug, opts = {}) {
  const thumb = el("div", "thumb featthumb");
  setThumb(thumb, st?.image ? rawUrl(st.image) : null, st?.name || slug);
  const body = el("div", "featbody");
  body.append(el("div", "featmodel", st?.model || (opts.bad ? "—" : "（无型号）")));
  body.append(el("div", "feattitle", st?.name || slug));
  return { thumb, body };
}

/** 换序。⚠️ 单独一个函数，是为了拖拽之外也调得到（自检、将来的键盘操作）。 */
function moveFeatured(from, to) {
  const list = state.siteDraft?.home?.featuredSlugs;
  if (!Array.isArray(list) || from === to || from == null || to == null) return;
  const next = list.slice();
  const [m] = next.splice(from, 1);
  next.splice(to, 0, m);
  state.siteDraft.home.featuredSlugs = next;
  state.featDrag = null;
  renderSite(true);
}

function updateSiteDirty() {
  // 继承框跟着"被继承的那一句"走（见 siteField 的 inheritFrom）
  (state.sitePainters || []).forEach((f) => { try { f(); } catch {} });
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
  // 🔴 与 doCommit 同一条规矩：写发生之后，"失败"这个词不许再出现。
  let wroteOk = false, commitSha = null;
  try {
    const r = await fetch("/api/site-content", {
      method: "PUT", headers: { "content-type": "application/json" },
      // ⚠️ 只提交自己这一节 + 基线 sha（乐观锁）
      body: JSON.stringify({ patch: { [sec]: state.siteDraft[sec] }, expectedSha: state.site.sha, section: sec }),
    });
    const b = await r.json().catch(() => null);
    if (b?.wrote === true) {
      wroteOk = true; commitSha = b.commitSha;
      alert(`已提交。commit ${(String(b.commitSha ?? "").slice(0, 7) || "(没拿到 sha)")}\n改了：${(b.changedFields || []).join(", ")}\n\n${b.note || ""}`);
      await loadSite(state.siteSection);
    } else if (b?.validation && !b.validation.ok) {
      // 🔴 校验不过 = **零 commit**，要说清楚，别让人以为"存了一半"
      alert("未写入任何东西（没有产生 commit）。以下没通过校验：\n\n" +
        b.validation.errors.map((e) => `· ${e.field}：${e.message}`).join("\n"));
    } else {
      alert(`未写入：${b?.detail || b?.reason || b?.error || r.status}`);
    }
  } catch (e) {
    if (wroteOk) { alert(wroteButRenderFailed(commitSha, e).replace(/\*\*/g, "")); await loadSite(state.siteSection).catch(() => {}); }
    else alert("提交失败：" + e.message);
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
  // 🔴 徽章语义**三档**，不是两档（Joe 2026-08-26 重排时定的口径）。
  //    原来只有 yes/no 两个函数，于是「本后台看不见」被塞进了 no() ⇒ 橙色。
  //    可那**不是坏事，是一条中性事实**：worker 本来就看不见 Access 的策略列表，
  //    这是架构决定的，不需要任何人去处理它。橙色会被读成"这里有问题"。
  //    ⇒ 绿 = 已就绪 · 灰 = 中性事实 · 橙 = 需要注意。**同语义必须同色。**
  const yes = (t) => el("span", "badge badge-published", t);   // 绿：已就绪
  const fact = (t) => el("span", "badge badge-unknown", t);    // 灰：中性事实，不需要处理
  const no = (t) => el("span", "badge badge-draft", t);        // 橙：需要注意
  const grid = el("div", "settings-grid");

  // ══ A：顶部状态摘要 —— 一眼看完，再往下才是细节 ══
  //
  // 🔴 这一页存在的理由是回答三个真会发生的问题：
  //    「为什么保存不了」「为什么他进不来」「生产上跑的是哪一版」。
  //    原来这三问的答案分散在五张**同权重**的卡里，得逐字读完才拼得出来。
  //    ⇒ 结论压成一行，细节留在下面。摘要**不是重复**，它是那三问的直接答案。
  // ⚠️ 每一项都取自同一份 w（/api/_whoami），**不另开数据源** ——
  //    摘要与下面的卡说的必须是同一件事，否则这一页会自相矛盾，而那比没有摘要更糟。
  {
    const sum = el("div", "sumbar");
    const item = (badge, label) => {
      const d = el("div", "sumitem");
      d.append(badge);
      d.append(el("span", "sumlabel", label));
      return d;
    };
    sum.append(item(w.data.writeEnabled ? yes("可以保存") : no("不能保存"), "写入能力"));
    // 🔴 这里原来数 `w.access.allowlist` —— 那个字段**已经不存在了**（2026-08-27 删名单）。
    //    留着的话它恒为 0 ⇒ 摘要上会常驻一条橙色的「名单为空 = 拒绝所有」，
    //    而那是**一条永远亮着的假警报**：名单没空，是这个概念没了。
    //    ⇒ 摘要改说"谁在管名单"，而不是"名单里有几个人"。
    sum.append(item(fact("Cloudflare Access"), "谁能进（唯一名单）"));
    sum.append(item(fact(w.git.shortSha || "无 sha"), w.request.isLocalDev ? "本地 dev" : "生产版本"));
    if (w.git.dirty) sum.append(item(no("部署时工作区是脏的"), "可复现性"));
    const ct = state.contract;
    sum.append(item(fact(ct?.version || "—"), "契约"));
    if (ct) sum.append(item(fact(`${ct.categories?.length ?? "—"} 机型 · ${ct.sensors?.length ?? "—"} 传感器`), "分类轴"));
    box.append(sum);
  }

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
      // 中性事实：本机就是只能写靶子仓，这是设计如此，不是待办
      row(c, "本机额外一道闸", fact("本机只能写靶子仓"),
        "🔴 本机**永远**写不到官网数据仓（zq8345/AirSonde-Web 硬编码在出站闸的黑名单里，不是开关）。" +
        "所以本地看到「可以保存」不代表能改官网 —— 真按下去会被这道闸拦住并说明理由。");
    }
    grid.append(c);
  }

  // ── ② 谁能进来：**两道门**，而这里只看得见一道 ──
  {
    const a = w.access || {};
    const c = card("谁能进来", "唯一名单在 Cloudflare Access");
    row(c, "当前操作人", el("b", null, w.operator || "(无身份)"),
      "取自**验过签的 Access 令牌**，不是那个明文头 —— 头可以伪造，签名不能。" +
      "它会被写进 commit message 和审计日志，所以来源取错 = 审计记录指认错人，而那种错事后查不出来。");
    // 🔴 这里以前有一张「后台名单」。**整个删掉了**（2026-08-27）。
    //    ⛔ 不是"隐藏"：留一张空名单的话，界面会渲染出"0 人"，
    //       而那正是我们要消灭的第二份名单的样子 —— 人还会去找它、去问怎么加。
    row(c, "唯一名单", fact(a.singleSource || "Cloudflare Access 策略"), a.accessPolicyNote);
    row(c, "怎么加人", "去 Cloudflare Access 策略里加",
      "**改完立刻生效，不需要动这个后台、也不需要重新部署。** " +
      "以前这里还有一份 ALLOWED_EMAILS 要手工同步，2026-08-27 就因为它少一个邮箱，" +
      "同事过了 Access 却被本后台回 403 —— 那份名单已经删掉了。");
    row(c, "worker 怎么确认身份", fact("验 Access JWT 签名"),
      `公钥取自 **${a.teamDomain || "（未配置）"}**，并校验 **aud** 等于本应用。` +
      "🔴 aud 那一条不是形式：同一个 team 下 4 个 Access 应用**共用签名公钥**，" +
      "不校验 aud 等于接受兄弟应用（如 CRM）的令牌 —— 而那些令牌的**签名是有效的**，" +
      "所以那个洞不会以「验签失败」的形式出现，它没有症状。");
    if (a.writeImplication) row(c, "⚠️ 加人 = 给写权限", no("能进 = 能写"), a.writeImplication);
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
    // 🔴 这两行以前写着"（冻结）· 增删改要改两个仓的源码"。契约 v1.4 之后**那是假话**，
    //    而且是**印在屏幕上的**假话 —— 人照着它去找总工，总工会说"你自己在后台改"。
    //    （这一批里同类残留一共三处：这里、app.js 顶部的 state.cats 注释、github.ts 的 catlabels 注释。）
    row(c, "机型", `${ct?.categories?.length ?? "—"} 个`,
      "真源是官网仓的 **src/data/taxonomy.json**，在「分类」页可以增删改。");
    row(c, "传感器", `${ct?.sensors?.length ?? "—"} 种`,
      "与机型同一个文件、同一页管理。");
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

// ═══════════════ 分类（机型 / 传感器 两个轴）═══════════════
//
// 契约 v1.4：两个轴的真源 = 官网仓 src/data/taxonomy.json，这一页能增删改。
//
// 🔴🔴 **删除是这一页唯一危险的动作，而且没有第二道闸。**
//    实测（W18 四层实验）：删掉一个仍被产品引用的取值，官网构建**照常通过** ——
//    Astro 只在内容配置文件本身变化时才重新校验，单改 taxonomy.json 不算。
//    ⇒ 服务端的引用计数是唯一防线。前端这里**不自己数一份**：
//      前端数的是 state.list（可能是几分钟前的），服务端数的是此刻仓里的字节。
//      两份数字迟早不一致，而不一致时**看起来正确的那一份**会赢。
//      ⇒ canDelete / refs 全部取自 /api/taxonomy 的响应，前端只负责显示。
async function loadCats() {
  $("#catsSummary").innerHTML = '<div class="notice notice-warn">读取中…</div>';
  try {
    const { body } = await api("/api/taxonomy");
    state.cats = body;
    renderCats();
  } catch (e) {
    $("#catsSummary").innerHTML = "";
    $("#catsSummary").append(mkNotice("bad", "读取失败：" + e.message));
  }
}

/** 一次轴写入。成功后**重读**，不在前端猜新状态（sha 也变了）。 */
async function taxonomyOp(payload, btn) {
  const label = btn && btn.textContent;
  let wroteOk = false, commitSha = null;
  const out = $("#catsResult");
  // 🔴 一进来就清：这一格只属于**这一次**提交。
  //    实测过不清的样子 —— 上一次被拒的红字留在屏幕上，这一次的结果叠在旁边，
  //    两条消息各说各的一次操作，而人只会读离得近的那条。
  out.innerHTML = "";
  out.append(mkNotice("warn", "提交中…（一次轴改动 = 官网仓的一个 commit）"));
  if (btn) { btn.disabled = true; btn.textContent = "提交中…"; }
  try {
    const { body } = await api("/api/taxonomy", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, expectedSha: state.cats?.sha }),
    });
    out.innerHTML = "";
    if (!body || !body.wrote) {
      // ⚠️ 拒绝要把**服务器的原话**放出来，尤其是 refs 那一串 ——
      //    "还有产品在用"没有用，"这 15 个产品在用"才是人能照着做事的东西。
      out.append(mkNotice("bad", `🔴 ${(body && (body.error || body.reason)) || "没有写入"}`));
      if (body && body.detail) out.append(mkNotice("warn", body.detail));
      if (body && body.refs && body.refs.length) {
        const ul = el("ul", "catnote");
        body.refs.forEach((slug) => {
          const li = el("li");
          const b = el("button", "linkish", slug); b.type = "button";
          b.onclick = () => { showNav("products"); select(slug); };
          li.append(b);
          ul.append(li);
        });
        out.append(ul);
      }
      // ⚠️ 是 "error" 不是 "bad"：mkIssue 的 kind 直接拼成 class，而样式表里只有
      //    issue-error / issue-warn / issue-ok。写错的话不报错，只是**那几行没有颜色**。
      if (body && body.errors) body.errors.forEach((x) => out.append(mkIssue("error", x.field, x.message)));
      return false;
    }
    wroteOk = true; commitSha = body.commitSha;
    // ⚠️ 先重读再写结果 —— loadCats() 会重画 #catsSummary，结果落在 #catsResult 才不会被它抹掉。
    await loadCats();
    out.append(mkNotice("ok", `✅ ${body.what} —— commit ${String(body.commitSha || "").slice(0, 7)}。${body.note || ""}`));
    // 下拉框/多选框的取值来自 /api/contract，轴变了它就过期了。
    loadContract().catch(() => {});
    return true;
  } catch (e) {
    out.innerHTML = "";
    if (wroteOk) { out.append(mkNotice("warn", wroteButRenderFailed(commitSha, e))); return true; }
    out.append(mkNotice("bad", "提交失败：" + e.message));
    return false;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = label; }
  }
}

function renderCats() {
  const c = state.cats; if (!c) return;
  const sum = $("#catsSummary"); sum.innerHTML = "";

  // 🔴 有产品读不出来 ⇒ 引用计数**不完整**，此时"0 个在用"不是"没人用"，是"我没看全"。
  //    这一行必须在最前面，因为它决定了下面每一个「删除」是不是可信的。
  if (c.unreadable) sum.append(mkNotice("bad", `🔴 ${c.unreadableNote}`));

  // ⭐ 对账：每个产品的 category 都必须落在轴里。落不进去的产品在下表上**根本不出现**。
  const known = new Set(c.categories.map((x) => x.value));
  const good = state.list.filter((p) => !p.error);
  const strays = good.filter((p) => !known.has(p.category));
  if (strays.length) {
    sum.append(mkNotice("bad",
      `🔴 有 **${strays.length}** 个产品的机型不在这一轴里，下表统计不到它们：` +
      strays.map((p) => `${p.slug}(${p.category || "空"})`).join("、")));
  } else {
    // ⚠️ 对账成立时也要**出一行**：什么都不显示的话，"查过了，没问题"和"这个检查根本没跑"
    //    在界面上长得一模一样。
    // 与每一行的「官网筛选栏」同源：都数服务端盖的 `onSite`，不在这里另算一遍。
    const onSite = c.categories.filter((cat) => cat.onSite).length;
    // 🔴 有产品读不出来时**不许说"对账成立"**。
    //    2026-08-26 真出过一次（我自己把匿名配额打满，4 个产品读不出来）：
    //    逐机型引用之和 19，产品数 23 —— 数字自己就不自洽，而那一行照样写着"对账成立"。
    //    ⇒ 这一行必须说清它只覆盖了读得出来的那些，否则它是在替一份残缺的统计背书。
    //    （闸本身当时是对的：unreadable>0 ⇒ 每一条 canDelete 都是 false，一个都删不了。）
    const partial = c.unreadable > 0;
    const total = c.productCount ?? good.length;
    sum.append(mkNotice(partial ? "warn" : "ok",
      partial
        // ⚠️ 这句话里**不出现"对账成立"四个字**，哪怕是在否定它。
        //    我自己的判据刚被这一点骗过：`includes("对账成立")` 在这句上返回 true。
        //    否定句里嵌着肯定词，对扫字符串的人和工具都是陷阱 —— 换个说法就没有这个洞。
        ? `⚠️ 这份统计**不完整**：只对上了读得出来的 **${good.length}/${total}** 个产品，` +
          `另外 ${c.unreadable} 个读不出来，**它们的机型没算进下表**。`
        : `${good.length} 个产品全部落在 ${c.categories.length} 个机型里（对账成立）· ` +
          `官网筛选栏上会出现 **${onSite}** 个机型 · 真源 ${c.path}`));
  }

  renderAxis("categories", $("#catsRows"), c.categories, good);
  renderAxis("sensors", $("#sensorsRows"), c.sensors, good);
  syncManageBtns();

  const note = $("#catsNote"); note.innerHTML = "";
  const ul = el("ul", "catnote");
  [
    "**取值（value）创建之后不能改** —— 它已经写进每个产品的 JSON，改它等于改数据。要换叫法，改**显示名**。",
    "**删除只对没人在用的取值开放。** 官网构建**不会**替我们拦这一步（实测），所以拦在这里。要删一个在用的：先把那些产品改成别的，再回来删。",
    "**官网筛选栏**只列有已上架产品的机型。一个 0 个已上架的机型，在站上是看不见的。",
    "改产品的**归属**是另一件事：列表里勾选后用「批量改机型」，或在产品编辑页改。",
  ].forEach((t) => ul.append(appendMd(el("li"), t)));
  note.append(ul);
}

/** 两个轴共用一份渲染 —— 写成两份的话，改了一边忘了另一边不会有任何症状。 */
function renderAxis(axis, tb, items, good) {
  const isCat = axis === "categories";
  const canWrite = !!state.write?.enabled;
  // 🔴 **按轴**取管理态，不是一个全局开关：管机型时不该把传感器那栏也解锁。
  const manage = canWrite && !!state.axisManage[axis];
  tb.innerHTML = "";
  items.forEach((it) => {
    const tr = el("tr");

    const tdName = el("td");
    tdName.append(el("div", "li-name", it.label || it.value));
    // ⚠️ 显示名与取值**逐字节相同**时只显示一次。传感器那栏 14 行现在几乎全是
    //    `CO2 / CO2` 这样把同一个串印两遍 —— 重复的字符串不携带信息，
    //    只是把真正有区别的那几行（如 `Wall-mounted / wall-mounted`）淹掉。
    // ⚠️ 判据是"逐字节相同"，不是"忽略大小写相同"：`Desktop` 与 `desktop` 不是一回事，
    //    进产品 JSON 和官网 URL 的是小写那个，看得见它才不会照着显示名去填。
    if (it.label && it.label !== it.value) tdName.append(el("div", "li-sub", it.value));
    tr.append(tdName);

    // 在用数取服务端的 refCount（此刻仓里的真相），不是前端 state.list 的再数一遍。
    const tdN = el("td", "col-st");
    if (it.refCount && isCat) {
      // 机型有筛选栏，点得过去。
      const b = el("button", "linkish", String(it.refCount)); b.type = "button";
      b.title = it.refs.join("、");
      b.onclick = () => { showNav("products"); $("#catFilter").value = it.value; state.tab = "all"; renderList(); };
      tdN.append(b);
    } else if (it.refCount) {
      // ⚠️ 传感器**没有**列表筛选。做成按钮的话点了什么也不会发生 ——
      //    一个骗人的按钮比一个纯数字糟。列表在 title 里，够用。
      const s = el("span", null, String(it.refCount)); s.title = it.refs.join("、");
      tdN.append(s);
    } else tdN.append(el("span", "li-sub", "0"));
    tr.append(tdN);

    if (isCat) {
      // 🔴 判据取自官网自己的规则（lib/products.ts 的 categoriesOf 只收有已上架产品的机型），
      //    而且**由服务端在数引用的同一次扫描里算出来**（`it.onSite`）。
      //    ⛔ 不在这里拿 state.list 再数一遍：那样这一行上的两个数字会来自两次不同的读取，
      //       "在用 0"与"筛选栏显示"就可能同时出现，而看的人无从知道为什么。
      const tdOn = el("td", "col-cat");
      if (it.onSite) tdOn.append(el("span", "badge badge-published", "显示"));
      else {
        tdOn.append(el("span", "badge badge-unknown", "不显示"));
        tdOn.append(el("div", "li-sub", "没有已上架产品"));
      }
      tr.append(tdOn);
    }

    const tdAct = el("td", "col-act");
    // 🔴 只读态：**一个操作入口都不出**（不是禁用，是不存在）。
    //    Joe 定的。理由比"更整洁"硬：默认态原本摆着 28 个红色删除按钮，其中一半点了没反应。
    //    把破坏性入口从默认态拿掉，"看起来能点其实不能点"这个问题从源头就没有了。
    if (canWrite && manage) {
      const bEdit = el("button", "linkish", "改名"); bEdit.type = "button";
      bEdit.onclick = () => startRename(tr, tdName, axis, it);
      tdAct.append(bEdit);

      const bDel = el("button", "linkish danger", "删除"); bDel.type = "button";
      if (!it.canDelete) {
        // ⚠️ 禁用**必须带原因**：一个灰掉的按钮什么也没告诉人，人只会以为后台坏了。
        bDel.disabled = true;
        // 🔴 title 挂在 **td 上，不挂在按钮上**：`disabled` 的按钮在 Chrome 里
        //    不接收指针事件，挂在它自己身上的 title 很可能永远不出现 ——
        //    那就成了"我以为写了说明，屏幕上其实什么都没有"。
        //    挂在 td 上，命中测试落到 td，说明跟着鼠标走。
        tdAct.title = it.refCount
          ? `还有 ${it.refCount} 个产品在用：${it.refs.join("、")}`
          : "有产品读不出来，此刻数不准谁在用 —— 任何删除都先拒绝";
      } else {
        bDel.onclick = () => {
          if (!confirm(`删除${axis === "categories" ? "机型" : "传感器"}「${it.label || it.value}」（${it.value}）？\n\n服务端会再数一次引用；有人在用就会被拒。`)) return;
          taxonomyOp({ axis, op: "delete", value: it.value }, bDel);
        };
      }
      tdAct.append(bDel);
    }
    // ⚠️ 只读态这一格是**空的**，不写"只读"两个字：那一列在只读态本来就没有标题，
    //    每行印一遍"只读"只是把 14 行都填上同一个不携带信息的词。
    //    写入闸没开时的说明归「管理」按钮（它会被禁用并带上原因），不归每一行。
    tr.append(tdAct);
    tb.append(tr);
  });
}

/** 行内改名。⛔ 只动 label —— value 那一格连输入框都不给。 */
function startRename(tr, tdName, axis, it) {
  tdName.innerHTML = "";
  const box = el("div", "axisedit");
  const inp = el("input"); inp.type = "text"; inp.value = it.label || it.value;
  const ok = el("button", "linkish", "保存"); ok.type = "button";
  const no = el("button", "linkish", "取消"); no.type = "button";
  box.append(inp, ok, no);
  tdName.append(box);
  tdName.append(el("div", "li-sub", `${it.value}（取值不可改）`));
  inp.focus(); inp.select();

  const cancel = () => renderCats();
  no.onclick = cancel;
  inp.onkeydown = (e) => { if (e.key === "Escape") cancel(); if (e.key === "Enter") ok.click(); };
  ok.onclick = async () => {
    const label = inp.value.trim();
    if (!label) { inp.focus(); return; }
    if (label === (it.label || "")) return cancel();
    await taxonomyOp({ axis, op: "edit", value: it.value, label }, ok);
  };
}

/** 管理按钮与新增表单的显隐 —— **一个函数说了算**，两处各写一遍迟早对不上。 */
const ADD_FORM = { categories: "#addCategories", sensors: "#addSensors" };
function syncManageBtns() {
  const canWrite = !!state.write?.enabled;
  ["categories", "sensors"].forEach((axis) => {
    const on = canWrite && !!state.axisManage[axis];
    const b = document.querySelector(`.managebtn[data-axis="${axis}"]`);
    if (b) {
      b.textContent = on ? "✓ 管理中" : "🔧 管理";
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));   // 管理态是个开关，语义上就是 pressed
      // 写入闸没开时禁用并说明原因 —— 让人点了没反应，正是这一批在修的病。
      b.disabled = !canWrite;
      if (!canWrite) b.title = "当前不能保存（写入闸或 token 未就绪），所以也不给管理入口";
    }
    // 新增表单跟着同一个开关走（三个动作一条规则，不留特例）。
    const f = $(ADD_FORM[axis]);
    if (f) { f.hidden = !on; if (!on) f.reset(); }
  });
}

["categories", "sensors"].forEach((axis) => {
  const b = document.querySelector(`.managebtn[data-axis="${axis}"]`);
  if (!b) return;
  b.onclick = () => {
    state.axisManage[axis] = !state.axisManage[axis];
    // ⚠️ 退出管理态时要重画：正开着的行内改名输入框必须跟着收掉，
    //    否则会留下一个能打字、按保存却已经不该存在的框。
    if (state.cats) renderCats(); else syncManageBtns();
  };
});

/** 两个轴的新增表单。⚠️ 绑一次，不在 renderCats 里重绑（那会叠出 N 个提交）。 */
["categories", "sensors"].forEach((axis) => {
  const form = document.getElementById(axis === "categories" ? "addCategories" : "addSensors");
  if (!form) return;
  form.onsubmit = async (e) => {
    e.preventDefault();
    const value = form.value.value.trim();
    const label = form.label.value.trim();
    if (!value) { form.value.focus(); return; }
    const okDone = await taxonomyOp({ axis, op: "add", value, label: label || value }, form.querySelector("button"));
    if (!okDone) return;
    form.reset();
    // ⚠️ 这一句是**事实**，不是客套：官网的 productTypePhrase 是 src/lib/products.ts 里
    //    一张写死的表（后台的写入范围到不了那个文件）。新机型不在表里 ⇒ 产品页的
    //    结构化描述会少那半句。不说的话，没有任何症状能让人发现。
    //    （`other` 是**故意**不给短语的 —— 所以这是提示，不是错误。）
    if (axis === "categories") {
      $("#catsResult").append(mkNotice("warn",
        `⚠️ 新机型「${value}」在官网还**没有 SEO 描述短语** —— 属于这个机型的产品页，` +
        "结构化描述里会少一句（现有的长这样：「desktop indoor air quality monitor」）。" +
        "那张表在官网源码 `src/lib/products.ts` 里，后台改不了：**告诉总工补上**。"));
    }
  };
});

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
  document.querySelectorAll(".nav-item[data-nav]").forEach((b) => {
    const on = b.dataset.nav === which;
    b.classList.toggle("is-on", on);
    // ⚠️ 选中态原来**只有 class** —— 读屏软件读到的是一排一模一样的按钮，
    //    "我现在在哪一页"这个信息只存在于颜色里。
    //    ⛔ 没用 role="tab"：那会带来方向键导航的契约，而我们没实现 ——
    //      挂一个履行不了的 ARIA 角色比不挂更糟。aria-current 没有这层义务。
    if (on) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  });
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

// ⚠️ 这里原来是 updateDirty()：往 sticky 条上的「未改动 / N 处改动」写字。
//    那一格已随 .editbar 一起撤掉（Joe 2026-08-26）⇒ 整个函数删掉，不留空转的版本。
//    留着的话它是一个每次输入都跑一遍、却对屏幕零影响的函数 —— 下一个人会以为它有用。

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
});

// ── 图片：多选 + 拖文件进来 ──
// 🔴 **先拷成真数组，再清 input** —— 顺序反了就是一个静默失效的上传。
//    `input.files` 是**活的 FileList**：`input.value = ""` 会把已经拿到手的那个引用
//    一起清空（实测：清空前 length=1，清空后同一个引用 length=0）⇒
//    addImageFiles 收到空数组，什么都不做，**界面上毫无反应也毫无报错**。
//    ⚠️ 这个 bug 是 A12-5 重构入口时我自己引入的，已经上了生产（afd3b26 起）。
//    清 value 本身是必要的：不清的话连续选同一个文件不会再触发 change。
$("#f_imgfile").onchange = (e) => {
  const files = [...e.target.files];   // ← 快照
  e.target.value = "";                 // ← 之后才清
  addImageFiles(files);
};
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

// ── 过时的确认面板：内容一变，上一次的结论就不许再摆着 ──
// 🔴 **一处委托，⛔ 不在每个字段上各挂一个** —— 挂五处的话，第六个字段就是下一个漏网的。
//    `#editPane` 是整张表单，`input`/`change` 都冒泡 ⇒ 连动态加出来的
//    specs / highlights 行也一并覆盖到，不用在新增行时补绑。
// ⚠️ 覆盖完整性的依据：`buildEnvelope()` 只读两样东西 —— `readForm()` 与 `state.imgList`。
//    表单这一路由下面这个委托守住，图片那一路由 `renderImages()` 守住（每次增删拖动都会调它）。
//    **两处合起来正好是全集**，不是"我能想到的几个地方"。
$("#editPane").addEventListener("input", invalidatePreviewIfStale);
$("#editPane").addEventListener("change", invalidatePreviewIfStale);

// ── 删除：二次确认要求打出 slug 本身 ──
// ⚠️ 不用"你确定吗"那种确认框：它训练人闭着眼睛点确定。要求打出名字，是让手停一下。
$("#deleteBtn").onclick = async () => {
  const slug = state.slug;
  if (!slug) return;
  const feat = featuredWarning([slug], "删除");
  const typed = prompt(`删除会同时删掉这个产品的 JSON 和它的图片，并触发官网重建。${feat}\n\n确认请输入 slug：\n${slug}`);
  if (typed !== slug) { if (typed !== null) alert("输入不匹配，已取消。"); return; }
  const btn = $("#deleteBtn"); btn.disabled = true; btn.textContent = "删除中…";
  let wroteOk = false, commitSha = null;
  try {
    // 🔴 删除也带锁：删掉一个"别人刚改过"的产品是**不可逆**的，比保存更需要它。
    //    ⚠️ DELETE 没有请求体 ⇒ 走查询串。
    const delSha = state.loaded?.sha;
    const r = await fetch(`/api/products/${encodeURIComponent(slug)}`
      + (delSha ? `?expectedSha=${encodeURIComponent(delSha)}` : ""), { method: "DELETE" });
    const b = await r.json().catch(() => null);
    if (b?.wrote === true) {
      wroteOk = true; commitSha = b.commitSha;
      $("#detailView").hidden = true; $("#listView").hidden = false;
      state.slug = null; cache.delete(slug); state.selected.delete(slug); resetPending();
      state.cacheBust = b.commitSha;
      await loadList();
      alert(`已删除。commit ${(String(b.commitSha ?? "").slice(0, 7) || "(没拿到 sha)")}\n${b.note || ""}`);
    } else {
      alert(`未删除：${b?.detail || b?.error || r.status}`);
    }
  } catch (e) {
    if (wroteOk) { alert(wroteButRenderFailed(commitSha, e).replace(/\*\*/g, "")); await loadList().catch(() => {}); }
    else alert("删除请求失败：" + e.message);
  } finally {
    btn.disabled = false; btn.textContent = "删除这个产品…";
  }
};

// ⚠️ 列宽随视口变 ⇒ 能放下几个传感器也跟着变。不重收的话，
//    窗口拉宽之后那个 `+3` 会一直挂着，而旁边明明空着一大片。
addEventListener("resize", () => { try { fitSensorRows(); } catch {} });

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





