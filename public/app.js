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
  // 列表筛选（crm-skin B 批 §3）：⛔ 原 tab 条（state.tab）与机型下拉（#catFilter）已撤 —— 元素、绑定、状态三处一起。
  // ⭐ Joe 2026-09-04：「后台默认显示在线产品」⇒ **初值就是 published**，⛔ 不是 null。
  // ⚠️ 这是**默认值**，不是"记住上次"：切到未上架、切走再回来，照样回到在线（见 showNav）。
  //    ⛔ 不许做成 localStorage 记忆 —— 那样"我上次看的"会冒充"默认"，而两者的行为不同。
  statusSeg: "published",     // 「状态」列头两段切换：null = 全部 · "published" · "draft"（点同一段再点 = 取消）
  // ⭐ 分类页暂存区（Joe 2026-09-04「编辑 / 保存」）。
  // 🔴 改名/新增/删除在这里**只进内存**，点「保存」才一次性提交 ⇒ **一次保存 = 一个 commit**。
  //    ⚠️ 这样「保存」两个字才是真话。原来点「管理中」什么也不保存，
  //       而那句假话比没有按钮更坏：他会以为不点它改动就不生效，其实早写进仓了。
  // ⛔ 不持久化（不进 localStorage）：刷新就该没有，⛔ 但离开前必须拦一次。
  axisPending: { categories: [], sensors: [] },
  catSel: "",                 // 「机型」列头漏斗：""=全部机型 · 某个 category value
  auditSrc: "",               // 审计页「来源」漏斗：""=全部 · admin · other
  auditOp: "",                // 审计页「操作人」漏斗：""=全部 · 某个 operator
  /**
   * 型号列排序（Joe 2026-08-28：「产品列表加一个按照型号排序」）。
   * 0 = 不排（保持仓里的文件顺序）· 1 = 升序 · -1 = 降序。点表头在 1/-1 间切换。
   * ⛔ 只有型号这一列 —— 别的列他没要，不加。
   */
  modelSort: 0,
  nav: "products",            // 左导航当前视图：products | media
  media: null,
  // 图片页的视图：null = 文件夹网格（默认）｜ 文件夹名 = 只看那一个 ｜ ORPHAN_VIEW = 全部未被引用。
  // ⛔ 旧的 `mediaTab` 三段筛选（在线 / 草稿 / 原图存档）已随文件夹化整个删掉，
  //    连同那个字段本身 —— ⛔ 不留"以后可能用得上"的死声明。
  //    · 草稿 / 原图存档：两个系统目录文件夹已完全取代（实测集合逐个相同）
  //    · 在线 164：⚠️ **这个入口确实没了**。它是旧结构的产物（旧视图得有办法把草稿/原图滤掉），
  //      文件夹结构本身已经做到那件事；页头「N 张 · 在用 K」也仍给着那个数。
  //      ⛔ 但这条要说出来，不能静默丢 —— 已报总工转告 Joe。
  mediaFolder: null, mediaQ: "",
  // 排序：name(默认) | count | live。⛔ 不持久化 —— 它是"我现在想这么看"，不是一项设置。
  mediaSort: "name",
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
    // ⛔ 左栏底部的账号块（邮箱 · 仓 · sha · 版本 id · 节点 · 登出）已整块撤（crm-skin A 批，Joe：「把账号移到设置里面」）。
    //    那个元素与它的样式已撤（⛔ 元素、绑定、样式三处一起）；数据一个字没少 —— state.who 由设置页整页渲染，
    //    登出按钮连同它那段"为什么本地要禁用"的理由一起搬进 renderSettings() 的「账号」卡。
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
    // 身份读取失败：横幅（下面）与设置页（state.who 为空时整页说明）负责把它说出来；左栏不再有那格。
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
    // ⛔ G 批 §4：页底那句「点保存后会先让你确认一遍…」已撤。
    //    它**永远为真**，而它描述的那件事（确认面板）在点下去的那一刻就自己出现了 ——
    //    ⚠️ 一条常驻在按钮旁边的解释和没有解释是一回事，它只会把真正会变的东西挤下去。
    //    🔴 确认面板本身一个字没动；写不了时那句（下面 else 分支）也一个字没动 —— 那句才是真信息。
    //    ⚠️ 必须显式清空：从"写不了"切到"能写"时，不清的话上一句会留在屏幕上。
    $("#actionsNote").textContent = "";
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
  loadSiteBuild();          // ⚠️ 不 await：官网状态晚到不该挡住列表
}

/**
 * 官网构建状态（审计①）。⛔ 替掉那句**恒为真**的「已提交，线上生效有延迟」。
 *
 * 🔴 三态都要说得出口：
 *   ok      ⇒ 什么都不显示（⛔ 不做"一切正常"的常驻绿条：那又是一句恒真的话）
 *   stale   ⇒ 红条，写清两个 sha 和已经多少分钟
 *   unknown ⇒ **也必须出声**：「无法确认官网状态」。
 *            ⚠️ 这一态最容易被省掉，而省掉它的后果正是这次事故的形状 ——
 *               告警从不亮，与"一切正常"长得一模一样。
 * ⚠️ 连请求本身失败（端点挂了 / 网络断了）也落 unknown，⛔ 不静默 catch。
 */
async function loadSiteBuild() {
  const bar = $("#siteBuildBar"); if (!bar) return;
  const short = (s) => String(s || "").slice(0, 7) || "—";
  let b;
  try {
    const r = await api("/api/site-build");
    b = r.body;
    if (!b || !b.state) throw new Error("响应里没有 state");
  } catch (e) {
    bar.innerHTML = "";
    bar.append(mkNotice("warn", `⚠️ **无法确认官网状态** —— 查询失败：${String(e.message || e).slice(0, 120)}`));
    return;
  }
  bar.innerHTML = "";
  if (b.state === "ok") return;                    // ⛔ 正常时不占位置
  if (b.state === "unknown") {
    bar.append(mkNotice("warn",
      `⚠️ **无法确认官网状态** —— ${b.detail || "读不到官网的构建戳"}。`
      + `⚠️ 这**不等于**官网正常，也不等于它坏了：现在这一项查不出来。`));
    return;
  }
  // stale
  bar.append(mkNotice("bad",
    `🔴 **官网已停止更新** —— 线上跑的是 \`${short(b.liveSha)}\`，`
    + `你的最新改动是 \`${short(b.headSha)}\`，已 **${b.minutes} 分钟**没生效。`
    + `⚠️ 现在保存的内容**不会出现在 airsonde.com 上**，直到构建恢复。`));
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
  const cat = state.catSel;
  const rows = state.list.filter((it) => {
    if (state.statusSeg && it.status !== state.statusSeg) return false;
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
// ⛔ `TAB_ORDER` 已撤（crm-skin B 批）：全部/在线/未上架 那排 tab 没了，
//    状态筛选住「状态」列头的两段切换（在线 | 未上架，默认无选中 = 全部），顺序写在 renderList 里。
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

// ═══ 筛选控件（crm-skin §1：全站只有这两种）═══
// 两段切换：二值维度。点一段只看一段，再点同一段取消 = 全部；**默认无选中 = 全部**。
function segControl(items, current, onPick) {
  const seg = el("span", "seg");
  items.forEach(([key, label, n]) => {
    const s = el("button", "seg-s" + (current === key ? " on" : "")); s.type = "button";
    s.setAttribute("aria-pressed", String(current === key));
    s.append(document.createTextNode(label));
    if (n !== undefined) s.append(el("i", null, `(${n})`));
    s.onclick = () => onPick(current === key ? null : key);
    seg.append(s);
  });
  return seg;
}
// 漏斗菜单：多值维度，挂在列头。点列头开菜单，选一项即筛并关；点外面关。
function funnelHeader(th, label, items, current, onPick) {
  th.innerHTML = "";
  const btn = el("button", "th-filt" + (current ? " on" : "")); btn.type = "button";
  btn.append(document.createTextNode(label));
  const caret = el("span", "fcaret");
  caret.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><polygon points="21 4 3 4 10 12.5 10 19 14 21 14 12.5"/></svg>';
  btn.append(caret);
  th.append(btn);
  btn.onclick = (e) => {
    e.stopPropagation();
    const old = th.querySelector(".hdrmenu");
    document.querySelectorAll(".hdrmenu").forEach((m) => m.remove());
    if (old) return;                       // 再点同一个列头 = 关
    const menu = el("div", "hdrmenu");
    items.forEach(([key, text, n]) => {
      const mi = el("button", "mi" + (current === key ? " sel" : "")); mi.type = "button";
      mi.append(el("span", null, text));
      if (n !== undefined) mi.append(el("span", "cnt", String(n)));
      mi.onclick = (ev) => { ev.stopPropagation(); menu.remove(); onPick(key); };
      menu.append(mi);
    });
    th.append(menu);
    const close = () => { menu.remove(); document.removeEventListener("click", close); };
    setTimeout(() => document.addEventListener("click", close), 0);
  };
}
/** 审计/记录用的时间格式：`2026-9-3 03:55`（mockup） */
function fmtStamp(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return String(iso || "—");
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function renderList() {
  // ── 页头副标由真值算（§3）：「26 个 · 全部在线」/「26 个 · 未上架 2」 ──
  const total = state.list.length;
  const nPub = state.list.filter((i) => i.status === "published").length;
  const nDraft = state.list.filter((i) => i.status === "draft").length;
  // ══ v3 §3.6（Joe 2026-09-04）══
  // 🔴 「N 个 · 未上架 M」**整句删掉**：两段切换搬到标题旁之后，
  //    「在线 25 | 未上架 9」自己就把总数说清楚了（25 + 9 = 34）——
  //    ⚠️ 同一个事实原来占了**两个显示位**，而且两个位置还会各自算一遍。
  //    ⛔ 不是藏起来：这一格现在不再写任何东西。
  $("#listSub").innerHTML = "";
  if (total) {
    $("#listSub").append(segControl(
      [["published", "在线", nPub], ["draft", "未上架", nDraft]], state.statusSeg,
      (v) => { state.statusSeg = v; state.selected.clear(); renderList(); }));
  }

  // ── 「状态」列头：v3 起是**纯文字**（Joe 定）──
  //    ⚠️ 原来那一格放的是**筛选器**，而下面每一行那格放的是「在线」这个**状态值** ——
  //       列头该说"这一列是什么"，⛔ 不是"用什么筛"。筛选器已搬到标题旁。
  const thS = $("#thStatus");
  if (thS.textContent !== "状态") { thS.innerHTML = ""; thS.textContent = "状态"; }

  // ── 「机型」列头 = 漏斗菜单：全部机型 / Desktop (17) / …（数字为当前列表口径）──
  //    选项从真实数据里长，显示名取契约（谁可筛 ← 数据；叫什么 ← taxonomy.json）。
  const cats = [...new Set(state.list.map((i) => i.category).filter(Boolean))].sort();
  if (state.catSel && !cats.includes(state.catSel)) state.catSel = "";
  const catItems = [["", "全部机型", total], ...cats.map((c) => [c, catLabel(c), state.list.filter((i) => i.category === c).length])];
  funnelHeader($("#thCat"), "机型", catItems, state.catSel, (v) => { state.catSel = v; state.selected.clear(); renderList(); });

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

    // col-name：让 CSS 挂得住"名字这一列"（第 11 条要它与图片列一起顶对齐）。
    //    ⛔ 不用 :nth-child 定位 —— 前面插一列就会静默指错格子。
    const tdName = el("td", "col-name");
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

    const tdSt = el("td", "col-st ac");
    // 状态 pill：在线 = 绿 tint · 未上架 = 灰（语义色只用于信息，附录 C.7）；文本走 statusLabel，与两段切换**同一张表**
    tdSt.append(el("span", `pill ${it.status === "published" ? "pill-ok" : "pill-gray"}`, statusLabel(it.status)));
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

  $("#navCount").textContent = `(${state.list.length})`;   // 左栏计数内联「(26)」（crm-skin §2）
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
  // ⚠️ 后果说明与批量条**同一个条件、同一处代码**（Joe 2026-09-04 搬进工具栏后它成了兄弟节点）。
  //    ⛔ 不在别处再写一遍那个条件 —— 两处各判一次，迟早出现"按钮在、说明不在"。
  const showBulk = !(n === 0 || !state.write?.enabled);
  $("#batchBar").hidden = !showBulk;
  const note = $("#batchNote"); if (note) note.hidden = !showBulk;
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
/**
 * 首页产品位的真源 —— **全文件只有这两个函数知道它在哪**。
 *
 * 🔴 2026-09-05 从 `home.featuredSlugs` 迁到 `homeV4.products.featured`：首页 v4 已合 main，
 *    **旧字段官网不读了**。⚠️ 旧字段本轮不删（派单明写），但后台一个字也不再写它 ——
 *    继续写它 = 界面上改了、首页纹丝不动，而这种错没有任何症状。
 * ⚠️ 形状也变了：旧的是裸 slug 数组，新的是 `{slug, tagline, chips[]}`。
 *    ⛔ 别在别处再写一次这个路径 —— 迁移之所以要枚举"谁假设了旧形态"，就是因为上一次
 *    这个路径散在五处，改一处不改另一处不会有任何报错。
 */
const featList = (c) => {
  const a = c?.homeV4?.products?.featured;
  return Array.isArray(a) ? a : null;
};
const setFeatList = (d, next) => { ((d.homeV4 ??= {}).products ??= {}).featured = next; };

function featuredAmong(slugs) {
  const list = featList(state.site?.content);
  if (!list) return { known: false, hit: [] };
  const have = new Set(list.map((x) => (typeof x === "string" ? x : x?.slug)));
  return { known: true, hit: slugs.filter((s) => have.has(s)) };
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
 *    根因是 `startNew()` 从不清预览面板（已随 D 批撤）。
 * ⚠️ 但那**不止一处** —— 我按总工的提醒系统排查了一遍，实测还有两个：
 *      · `#preview` 残留 1036 字符（虽然 hidden，但内容还在：谁一 un-hide 就露出上一个产品的 diff）
 *      · `state.lastValidation` 残留（切 tab 会拿它重画 —— 画的是上一个产品的提示）
 * ⇒ 所以不逐个补洞：**"离开一个产品该清什么"只写在这一个函数里**，
 *   select() 和 startNew() 都调它。以后新增一个面板，只需要在这里加一行 ——
 *   而漏加的话两条路径**一起**漏，不会出现"编辑页清了、新建页没清"这种半修状态。
 */
function clearProductPanes() {
  // ⚠️ 预览面板本体已随预览态一起撤（D 批）——"上一个产品的字段漏进新建页"那个洞的另外两处仍在这里清。
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
  setBarModel(null);            // 读取中：⛔ 不先摆一个可能不对的名字
  // 🔴 数据到达前把表单藏起来（D 批）：双态撤了之后编辑面板常显，不藏的话加载中会露出
  //    **上一个产品的残留值**（dev 下长达数秒）——人在那期间打的字会被 fillForm 覆盖。
  $("#editPane").hidden = true; $("#previewBtn").hidden = true;
  state.filePath = "读取中…";
  renderList();

  const { status, body } = await api(`/api/products/${encodeURIComponent(slug)}`);
  state.loaded = body;

  if (status === 422) {
    state.filePath = body.path || "";
    renderIssues({ ok: false, errors: [{ field: "(文件)", code: "invalid_json", message: body.hint + " " + body.parseError }], warnings: [] });
    $("#editPane").hidden = true; $("#previewBtn").hidden = true;
    return;
  }

  const p = body.product || {};
  cache.set(slug, p);
  // D 批：编辑即详情 —— 标题就是产品名（纯文字，17/700 省略）。
  // ⛔ v3：「看官网页 ↗」整组已删（元素 + 这里的三行绑定），Joe 点名。
  setBarModel(p.model);         // ⭐ 顶栏显示**型号**（Joe：「我们都是用型号来区分产品的」）
  state.filePath = body.path;

  const v = body.validation || { ok: true, errors: [], warnings: [] };
  if (body.slugPathIssue) v.errors = [...v.errors, body.slugPathIssue];
  renderIssues(v);
  state.draft = JSON.parse(JSON.stringify(p));
  fillForm(state.draft);
  // 编辑一个已存在的产品：**不简化**，全部展开。slug 也不再跟随标题（它已经是 URL 了）。
  state.slugTouched = true;
  setFormMode(false);
  $("#editPane").hidden = false; $("#previewBtn").hidden = false;
  void opts;                       // 旧签名 opts.view 已无意义（只有一个态），参数留着不破坏调用方
  // v3：刚载入 = 干净态、还没试过保存。⚠️ 必须在 fillForm **之后** ——
  //    fillForm 是程序赋值，不触发 input 事件，但 renderImages/renderFixedSpecs 会重绘，
  //    保险起见统一在这里归零，⛔ 不依赖"赋值不冒泡"这个假设。
  state.saveAttempted = false;
  markClean();
  paintMissing();
  renderList();
}

/* ⛔ v3（Joe 2026-09-04：「记录…干掉」）：`loadRecord()` **整个函数已删**，
   不是留着不调 —— 一个零调用的函数，下一个人会以为它还有用。
   ⚠️ 连带后果记在 index.html 那段注释里：编辑页不再有「谁在什么时候改了什么」的入口。
   总工建议审计日志页支持按产品筛选，但 Joe 尚未点头 ⇒ 本单不做，⛔ 也不偷偷留着记录卡。 */

/**
 * 上架状态两段切换 —— v3 起住在 .detail-bar 里（原来在侧栏状态卡）。
 * 🔴 它只是 `#f_status`（隐藏 select）的 UI：点击 = 设 select 值 + dispatch change。
 *    ⛔ 不是第二个状态真源 —— loadContract 填选项 / fillForm 设值 / readForm 读值全部走那个 select。
 * ⚠️ 新建态**锁死在「未上架」且不可点**（SPEC §3.1）：新产品一律 draft，
 *    给一个点得动却不该动的控件，比不给更坏。
 * ⛔ v3 已删：`paintSitePath()` 与它画的那行「官网 /products/<slug>」——
 *    那与「网址」字段是**同一个事实**，同一个事实不占两个显示位。
 */
function paintStatusSeg() {
  const host = $("#statusSeg"); if (!host) return;
  host.innerHTML = "";
  const cur = $("#f_status").value || "draft";
  host.classList.toggle("is-locked", !!state.isNew);
  host.append(segControl([["published", "在线"], ["draft", "未上架"]], cur, (v) => {
    if (state.isNew) return;                 // 新建态锁死，⛔ 不给"点得动却不生效"
    // 状态是二值必填 —— 再点同一段（v=null）不是"全部"，保持原值不变
    if (!v || v === cur) return;
    const sel = $("#f_status"); sel.value = v;
    sel.dispatchEvent(new Event("change", { bubbles: true }));   // 图片搬目录那条提示靠它
    paintStatusSeg();
  }));
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
  // v3：状态段位搬进 .detail-bar 且**两态都在**，新建态锁死在「未上架」不可点。
  // ⚠️ 原来是新建态整块 hidden；改成"在但锁死"是照 mockup 帧 2 ——
  //    人需要**看见**"新产品会是未上架的"，而不是猜。⛔ 锁死判据只写在 paintStatusSeg 一处。
  const sh = $("#slugHint"); if (sh) sh.hidden = !isNew;   // "自动生成、上线后锁定"那句只在新建态说
  paintStatusSeg();
  // ⛔ v3：原来这里有一行 `details.more` 的展开 —— 「更多」卡整张撤了
  //    （Meta 搬进基本信息、supplierRef 输入框删）⇒ 结构上已无折叠块，
  //    留着那行就是对着不存在的元素查询。**删元素要连绑定一起删。**
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
  // ⛔ v3：#dSiteLink / #recordCard 两行绑定随元素一起删（看官网页、记录卡都撤了）。
  $("#listView").hidden = true; $("#detailView").hidden = false; $("#preview").hidden = true;
  setBarModel(null);            // 新建：型号还没填 ⇒ 显示「新建产品」
  state.filePath = "（保存后会是 " + (state.listMeta?.dir || "…") + "/<slug>.json）";
  renderIssues(null);
  state.draft = { sensors: [], images: {}, status: "draft" };
  fillForm(state.draft);
  setFormMode(true);
  $("#editPane").hidden = false; $("#previewBtn").hidden = false;   // D 批：编辑即详情，没有 tab 可切
  // v3：新建页一进来是干净的、还没试过保存 ⇒ ⛔ 不满屏红；但按钮旁要说清为什么点不下去。
  state.saveAttempted = false;
  markClean();
  paintMissing();
  renderList();
}

// ⛔ setPreviewTabEnabled() 已撤（D 批）：预览 tab 没了，"新建态无预览"这个概念随之消失。

// ═══════════════ 校验结果 ═══════════════
/** 哪个字段的提示贴到哪个输入框下面。不在表里的留在顶部。 */
// ⛔ 原来这里有 `hlLimit()`（卖点"短句"上限，读 /api/contract 的 limits.highlight）。
//    A17 起卖点长度不限，服务端也不再下发那一项 —— 常量、warning、计数三处一起撤，不留空转函数。

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
  // ⚠️ lastValidation 仍要存：换产品时 clearProductPanes 清它，防上一个产品的提示串到下一个身上。
  if (v !== undefined) state.lastValidation = v;
  const box = $("#issues"); box.innerHTML = ""; box.className = "issues";
  clearFieldIssues();
  if (!v) return;

  const info = new Set(state.contract?.infoCodes || []);
  const warns = (v.warnings || []).filter((i) => !info.has(i.code));

  // ⛔ G 批 §5：`v.ok && !warns.length` 时那条绿条已整组撤。
  //    ⚠️ 这个面板**只在有问题时说话**：没问题 = 不占位，而不是占一行说"没问题"。
  //    绝大多数时候它都是绿的 ⇒ 那条绿条等于给编辑区顶了一条恒亮的装饰，
  //    而它一旦变红反而更难被注意到（那个位置本来就一直有东西）。
  //    🔴 判定逻辑一个字没动：errors / warnings 该报的照报，字段级锚点照贴。

  v.errors.forEach((i) => box.append(mkIssue("error", i.field, i.message)));

  warns.forEach((i) => {
    const anchor = anchorFor(i.field);
    // D 批起编辑即详情，表单常在 ⇒ 有锚就贴到字段旁；找不到锚的仍回顶部（回不去的提示不能凭空消失）。
    if (anchor) {
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
// ⛔ renderView()（预览渲染，含 .pv-* 整套）已撤（crm-skin D 批 §4）：编辑即详情，「预览」由「看官网页 ↗」承担。
//    原内部信息区里的 moq/文件路径不再展示（moq 是死字段 A10-C；文件路径进「记录」卡的 (?) 层级足够）。

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

/**
 * 缩略图铺满还是完整显示 —— **由图自身的宽高比决定**（总工 2026-09-05 裁定）。
 *
 * Joe 要"图片把容器撑满"，前提是"我的图都是 1:1"。⚠️ **实测那个前提不成立**：
 * 库里 247 张有 **37 张不是 1:1**，最极端 424×1115（比 0.38）——
 * 对这些图，`cover` 会裁掉一大半，**他就认不出那是哪个产品了**。
 * ⇒ `aspect ≈ 1 ⇒ cover（撑满，无裁切）`；`否则 ⇒ contain（完整显示）`。
 * 🔴 **一条按属性判的规则**，⛔ 不是给某几张图写名单 —— 明天上传一张 4:3 的它也照样对。
 * ⛔ 图片文件一个字节不动，变的只是后台缩略图怎么摆。
 *
 * ⚠️ 判"图多大"只能用 `naturalWidth/Height`，⛔ 不能用渲染盒（`object-fit` 下元素盒恒等于格子）。
 * ⚠️ 而且**不能只挂 load**：缓存命中时 load 可能已经错过 ⇒ 先当场量一次，量不到再等 load。
 *    （`img.complete` 在这个仓里被证过不可靠，判据一律落 `naturalWidth > 0`。）
 */
function fitByAspect(thumbNode) {
  const img = thumbNode.querySelector("img");
  if (!img) return;
  const apply = () => {
    if (!img.naturalWidth || !img.naturalHeight) return false;
    const r = img.naturalWidth / img.naturalHeight;
    img.dataset.fit = Math.abs(r - 1) < 0.01 ? "cover" : "contain";
    return true;
  };
  if (!apply()) img.addEventListener("load", apply, { once: true });
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
    fitByAspect(t);
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
    }
    // ⛔ 已存在图片下面那行**文件名已删**（Joe 2026-09-05：「这里不用显示图片的名字」）。
    //    ⚠️ 删的只有**产品图片区**这一处：图片页（媒体库）的文件名是他另一条需求要的，
    //       那边一个字没动。
    //    ⚠️ 待上传那一支（上面的 if）**保留** —— 它说的不是文件名，是"这张图被动过什么"
    //       （大小 / 尺寸 / 画质 / 缩过没有），那是他按下保存前要知道的事。
    //    🔴 文件名本身没有消失：它在卡片的 `title` 上（hover 可查，见上面 setThumb 一段）。

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

  paintImgCount();
  // ⚠️ 图片增/删/拖动换位都是**程序改 DOM**，委托监听接不到 ⇒ 脏态在这里补一次。
  //    ⛔ 别改成在每个 onclick 里各调 —— 拖动那条路不是按钮，一定会被忘掉（下面那段注释说的就是它）。
  if (state.draft) markDirty();
  // ⛔ v3：这里原来还往 #mainImgNote 写「还没有图片。第一张会成为封面（主图）。」——
  //    ① 那句话现在卡标题的「共 0 张」+「＋」格已经说了；
  //    ② 🔴 更要紧的是：**一个元素两个写入方**，renderImages 每次重绘都会把
  //       「改状态会搬图」那条警告覆盖掉。⇒ 这个元素现在**只归状态变更那一条用**。

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

// ⛔ `repeatRow()`（卖点逐条输入框 + 每行字数三态）已整个撤掉（A17，Joe 2026-09-03）：
//    卖点现在是一个大输入框（见 parseHighlights / paintHighlightsCount），
//    ⛔ 不留一个零调用的函数 —— 下一个人会以为它还有用。
/**
 * 参数表的**固定 7 行**（Joe 2026-09-04：「把这几个信息放在参数表里面固定，
 * 后台显示中文，官网显示英文；同时保留加一行功能」）。
 *
 * 🔴 这张表是**唯一真源**：键名只写在这里一处，HTML 里不抄第二份。
 * 🔴 存的是**英文键**（官网 `Object.entries(specs)` 直接渲染，且同时进 JSON-LD
 *    的 PropertyValue）；中文只是 Admin 的显示标签，⛔ 一个中文字都不进 JSON。
 * ⚠️ 大小写跟官网现存键走**句首大写**（`Form factor` / `Net weight`）——
 *    ⛔ 不引入第二种风格，同一张表里混两种会很明显。
 * ✅ 7 个键名 Joe 2026-09-04 已确认（「按照你的建议来」），⛔ 不许再改一个字符。
 */
const SPEC_FIXED = [
  ["Dimensions", "产品尺寸"],
  ["Net weight", "产品净重"],
  ["Carton size", "纸箱尺寸"],
  ["Carton qty", "每箱数量"],
  ["Carton gross weight", "纸箱毛重"],
  ["Lead time", "交货时间"],
  ["Certification", "认证"],
];
const SPEC_FIXED_KEYS = new Set(SPEC_FIXED.map(([k]) => k));

/**
 * 画固定 7 行。恒定显示、恒定顺序、恒定在自定义行之前；值可空。
 * ⚠️ 值那一格带 `data-anchor="specs.<英文键>"` —— 与自定义行同一套锚点机制，
 *    校验器报 `specs.Dimensions` 时提示才贴得到这一行旁边。
 */
function renderFixedSpecs(specs) {
  const box = $("#f_specs_fixed"); box.innerHTML = "";
  SPEC_FIXED.forEach(([key, label]) => {
    const r = el("div", "kv-row");
    // ⚠️ 标签是 <label> 纯文本不是 input：键名是契约的一部分，不该由这里改。
    // 🔴 中文标签 + **英文键**（SPEC §3.3 点名保留）：英文键不是字段名，
    //    它是真正印在官网参数表上、并进 JSON-LD PropertyValue 的那个词。
    const lab = el("label", "k kv-lab");
    lab.append(document.createTextNode(label), el("em", null, key));
    const iv = el("input", "v"); iv.value = (specs && specs[key]) || "";
    iv.placeholder = "留空 = 不写进官网";
    iv.dataset.anchor = `specs.${key}`;
    iv.dataset.fixedKey = key;
    lab.htmlFor = iv.id = `f_spec_${key.replace(/[^A-Za-z0-9]+/g, "_")}`;
    r.append(lab, iv);
    box.append(r);
  });
}

/** 「自定义参数」那条分隔线：⚠️ 没有自定义行时不出现（⛔ 不做常驻空标题）。 */
function paintSpecsDivider() {
  const d = $("#specsDivider"); if (!d) return;
  d.hidden = !$("#f_specs").querySelector(".kv-row");
}

function kvRow(container, k, v) {
  const r = el("div", "kv-row");
  const ik = el("input", "k"); ik.value = k || ""; ik.placeholder = "键";
  const iv = el("input", "v"); iv.value = v || ""; iv.placeholder = "值（字符串）";
  // specs 的提示是 `specs.<key>` ⇒ 值那一格认领它，键一改就跟着改。
  const claim = () => { iv.dataset.anchor = `specs.${ik.value.trim()}`; };
  ik.addEventListener("input", claim); claim();
  const d = el("button", "del-row", "×"); d.type = "button";
  // ⚠️ 删行是**程序改 DOM**，不触发 input/change ⇒ 委托监听接不到 ⇒ 这里显式补两件事。
  d.onclick = () => { r.remove(); paintSpecsDivider(); markDirty(); };
  r.append(ik, iv, d); container.append(r);
}

/**
 * 顶栏那一格显示什么（Joe 2026-09-05：「顶栏可以干掉标题；返回列表后面显示型号就可以了」）。
 *
 * ⚠️ 顶栏**不再显示产品长标题** —— 那串英文名占满一行、还得省略号，
 *    而他认产品靠的是型号。标题输入框在「基本信息」里，⛔ 一个字没动。
 * 🔴 新建页型号还没填时显示「新建产品」，**一填就跟上**（下面 oninput 实时驱动，
 *    ⛔ 不是保存后才变 —— 那种"要保存才知道自己在编谁"正是这次要去掉的东西）。
 */
function setBarModel(model) {
  const el0 = $("#dTitle");
  if (!el0) return;
  const m = String(model || "").trim();
  el0.textContent = m || "新建产品";
  el0.classList.toggle("is-placeholder", !m);
}

function fillForm(p) {
  $("#f_slug").value = p.slug || "";
  $("#f_slug").readOnly = !state.isNew;   // 改名＝改文件名，本阶段不支持
  $("#f_name").value = p.name || "";
  $("#f_model").value = p.model || "";
  $("#f_category").value = p.category || "";
  $("#f_status").value = p.status || "draft";
  paintStatusSeg();   // 两段切换是它的 UI —— 换产品/新建都要重画到当前值
  // ⚠️ 上一个产品的「改状态会搬图」警告必须清掉：它是**针对那一次改动**的，
  //    留着就会串到下一个产品身上，而那时它是假的。
  const _mn = $("#mainImgNote"); if (_mn) { _mn.textContent = ""; _mn.hidden = true; }
  // ⚠️ moq 的输入框已撤（A10-C：它是死字段，官网渲染层 0 处引用）。
  //    **契约字段没动**，现存值也不会被碰 —— 见 readForm 里那段。
  $("#f_imgmain").value = p.images?.main || "";
  // ⛔ v3：`$("#f_supplier").value = …` 已删（输入框撤了）。
  //    ⚠️ **数据没删**：readForm 完全不提这个键 ⇒ 服务端保持原值。见 readForm 里那段。
  $("#f_metadesc").value = p.metaDescription || "";
  paintMetaDesc();   // 计数与"保存"可用态跟着新值走 —— 换产品时不能留着上一个的红字/禁用

  $("#f_sensors").querySelectorAll("input").forEach((cb) => { cb.checked = (p.sensors || []).includes(cb.value); });
  paintSensorCount();

  // 卖点：数组 → 一行一条（A17）。⚠️ 用 "\n" 不用 "\r\n"：textarea 的 value 内部一律是 LF。
  $("#f_highlights").value = (p.highlights || []).join("\n");
  paintHighlightsCount();
  // G 批 §6：值是**程序**填的 ⇒ 不会触发 input 事件，替身文本必须在这里同步一次，
  // 否则框的高度还停在上一个产品的卖点上。
  syncGrow($("#f_highlights"));
  // 参数表：固定 7 行 + 自定义行。
  // 🔴 一个键**只出现在一个地方**：固定键落固定行，其余原序进自定义区。
  //    ⛔ 不许两边各画一份 —— 那样保存时同一个键有两个来源，谁赢取决于遍历顺序。
  // ⚠️ 自定义行保持**仓里的原顺序**（键序 = 官网显示序），⛔ 不排序、不去重、不改写。
  renderFixedSpecs(p.specs);
  const s = $("#f_specs"); s.innerHTML = "";
  Object.entries(p.specs || {})
    .filter(([k]) => !SPEC_FIXED_KEYS.has(k))
    .forEach(([k, v]) => kvRow(s, k, v));
  paintSpecsDivider();
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
  // gallery 现在由缩略图管理，不再是一排文本框；把草稿里的原值原样带回去，
  // 具体搬到哪个目录由服务端的 planImages 决定 —— 前端不拼路径。
  const galleryFromDraft = state.draft?.images?.gallery || null;
  const specs = (() => {
    const o = {};
    // ── 固定 7 行**在前**：键序就是官网显示序，也是 JSON-LD 的 PropertyValue 序 ──
    // 🔴 **值为空 ⇒ 这个键不写进 JSON**（⛔ 不许 `"Dimensions": ""`）：
    //    官网 `Object.entries(specs)` 会照渲染出一个空行，JSON-LD 会多一条空 PropertyValue。
    //    ⚠️ 这条规则与下面自定义行的**相反**，是故意的 ——
    //       固定行恒定显示，"空"是它的常态（26 个产品里大半个 specs 都是空的），
    //       而自定义行是人**手动加出来**的，加了却不填值是个错误，该让校验器吼。
    $("#f_specs_fixed").querySelectorAll(".kv-row .v").forEach((iv) => {
      const v = iv.value.trim();
      if (v) o[iv.dataset.fixedKey] = v;
    });
    // ── 自定义行在后，保持用户排列 ──
    $("#f_specs").querySelectorAll(".kv-row").forEach((r) => {
      const k = r.querySelector(".k").value.trim();
      const v = r.querySelector(".v").value.trim();
      if (!k) return;
      // ⚠️ 键与某个**已填了值**的固定行撞了：JSON 对象容不下两个同名键，
      //    以固定行为准（它是那个键的正规位置）。固定行为空时这里照常写入。
      if (k in o) return;
      o[k] = v;   // ⚠️ 值为空也保留：让校验器去报错，别在界面上悄悄丢掉一行
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
    highlights: parseHighlights($("#f_highlights").value),   // 一行一条 → string[]；全空 ⇒ null（显式清空）
    // 空 ⇒ null ⇒ 服务端 mergeProduct 删键 ⇒ 仓里**没有**这个字段（SPEC §2："空值保存时不写该字段"）。
    // ⛔ 别送 ""：契约把空串当错误（与 moq 同一条规矩），官网模板也不该看到一个假值。
    metaDescription: nz($("#f_metadesc").value),
    specs,
    // 🔴 **`supplierRef` 这个键同样完全不出现**（v3，Joe 2026-09-04：「supplierRef 内部字段干掉」）。
    //    ⚠️ 他说的是**输入框**，⛔ 没说数据 —— 实测 36 个产品里 20 个此刻存着值，
    //       AK35 那条是阿里巴巴链接，别处没有备份。
    //    ⛔ 最容易犯的错就是照着上面那些字段写成 `supplierRef: nz($("#f_supplier").value)`：
    //       输入框没了 ⇒ 读到 undefined ⇒ 送 null ⇒ **他每保存一个产品就静默抹掉一条链接**。
    //    ⇒ 与 moq 同一种处理：键不出现 = 「我没收到」= mergeProduct 保持原样。
    //    判据在验收里：有值的产品不改任何值保存 ⇒ diff 的 del 行数 = 0 且 supplierRef 那行是 ctx。
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

  // ══ 悬空图片引用（审计③）══
  // ⚠️ 官网对缺图是**静默跳过**：构建不报错、页面不坏、图就是没了 ⇒ 没人会发现。
  //    ⇒ 这件事必须由界面主动说，⛔ 不能等人自己去比对文件。
  // 🔴 `legacy`（本来就坏、这次没让它更坏）只报不拦 —— 那是 Joe 的内容资产，等他定。
  //    `introduced` 这里也报一句，但真正的拦截在服务端；界面只是提前说，⛔ 不替它下结论。
  const dg = r.dangling;
  if (dg && dg.skipped) {
    wrap.append(mkNotice("warn",
      "⚠️ **这次没能检查图片引用是否都指得到文件** —— " + dg.skipped +
      "。保存不受影响，但**这一项这次没有结论**，⛔ 别把它当成「检查通过」。"));
  } else if (dg && (dg.introduced?.length || dg.legacy?.length)) {
    const bad = [...(dg.introduced || []), ...(dg.legacy || [])];
    const kind = dg.introduced?.length ? "bad" : "warn";
    // ⚠️ 走 appendMd，⛔ 不要 el(…, text)：`.notice` 里的 `**粗体**` 是靠 appendMd 变成 <b> 的，
    //    直接塞 textContent 会把星号**原样印在屏幕上**（实测就印出来了一次）。
    // ⚠️ 指名道姓用**型号**，⛔ 不用 slug —— Joe 认的是 AK13A，不是 portable-breathalyser。
    const who = state.draft?.model || state.loaded?.product?.model || state.slug;
    const n = el("div", `notice notice-${kind}`);
    appendMd(n.appendChild(el("div")), dg.introduced?.length
      ? `🔴 这次保存会让 **${dg.introduced.length}** 条图片引用指向不存在的文件，服务端会拒绝写入：`
      : `⚠️ **${who}** 有 ${bad.length} 条图片引用指不到文件（**本来就这样，不是这次改的**）：`);
    const ul = el("ul", "dangling-list");
    bad.forEach((p) => ul.append(el("li", null, p)));
    n.append(ul);
    appendMd(n.appendChild(el("div")), dg.introduced?.length
      ? "请重新上传这些图，或把它们从图片列表里去掉。"
      : "官网会静默跳过它们 —— 页面上那个位置就是空的。**这次保存不会被拦**（它没让情况变坏），"
        + "但这条得由你来定：补图，还是把这条引用删掉。");
    wrap.append(n);
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
      // ⚠️ 这句话原来是「官网重建需要一两分钟，现在刷还是旧内容，这不是没保存成功」——
      //    **它恒为真**：构建正常时对，构建死了三小时它还是它（2026-09-04 就这么过去了三小时）。
      //    ⇒ 保留"要等一会儿"这个事实，但**把结论指向那个可证伪的判据**，
      //      ⛔ 不再让它单独承担"官网到底有没有更新"这件事。
      box.prepend(mkNotice("warn",
        "官网重建需要一两分钟，现在去刷 airsonde.com 看到的仍是旧内容。"
        + "⚠️ **过几分钟回产品列表看一眼** —— 如果官网停止更新了，那里会亮红条。"));
      loadSiteBuild();      // 保存完顺手重查一次：下次回列表时那条状态是新的
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
// ⛔ switchView() 与 .tab 绑定已撤（D 批）：预览/编辑双态没了，编辑面板常显（select/startNew 直接开）。
// 搜索框常驻顶栏 ⇒ 在别的视图里也看得见。
// ⚠️ 不切视图的话，人在设置页打字会**什么都不发生** —— 而那看起来像搜索坏了。
$("#q").oninput = () => {
  if (state.nav !== "products") showNav("products");
  renderList();
};
// ⛔ `$("#catFilter").onchange` 已撤（B 批）：机型筛选住列头漏斗，绑定在 funnelHeader 里。
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
  // 🔴 v3 起有**两条**禁用理由（Meta 超限 / 必填项没填）。
  //    ⚠️ 原来的注释说"只在这里改 disabled，全仓再无第二处" —— 现在不能再那样写了，
  //       但那条规矩的**意图**要守住：⛔ 不许两处各自 `disabled = …`，
  //       否则会出现"我把 Meta 删短了，按钮却还是灰的（另一处禁的）"。
  //    ⇒ 改成：这里只**记录自己那条理由**，`paintMissing()` 是**唯一**真正落 disabled 的地方。
  $("#previewBtn").dataset.metaOver = over ? "1" : "0";
  $("#previewBtn").title = over ? "Meta description 超过上限，删到上限以内才能保存" : "";
  paintMissing();
}
$("#f_metadesc").addEventListener("input", paintMetaDesc);

// ── 卖点大输入框（A17）：一行一条 ⇄ highlights: string[] ──
// 🔴 拆行时清三样：① 不可见字符（零宽 U+200B–D/U+2060、BOM、U+FFFC 对象替换符、U+FFF9–B、
//    私用区 U+E000–F8FF、软连字符、LRM/RLM）—— 从网页/AI 复制时最常带进来，存进仓就是产品页上的「□」；
//    ② 行首项目符号/序号（• · - * – — ▪ ◦ ● ○ ■ □ ➢ ➤ ► ✓ ✔ ①…⑳、"1." "1)" "(1)" "1、"）——
//       ⚠️ 数字序号只在**后面跟着空白**时才算序号："1.5-inch display" 的 "1." 不是序号，不能吃掉；
//    ③ 每行 trim，空行丢弃。全空 ⇒ null（显式清空，与其它选填字段同一语义）。
const HL_INVISIBLE = /[​-‍⁠﻿￼￹-￻-­‎‏]/g;
const HL_LEAD_MARK = /^(?:[\s•·\-\*–—▪◦●○■□➢➤►✓✔①-⑳]+|\(?\d{1,3}(?:[.)]\s+|、\s*))+/;
function parseHighlights(text) {
  const out = String(text || "").split(/\r?\n/)
    .map((l) => l.replace(HL_INVISIBLE, "").replace(HL_LEAD_MARK, "").trim())
    .filter(Boolean);
  return out.length ? out : null;
}
/* ══════════ v3 计数（Joe 2026-09-04）══════════
 * 🔴 每个数都**从真源算**：mockup 里的 `19` / `25` / `9` 是画图时填的快照，
 *    ⛔ 写死任何一个，都会在 Joe 改 taxonomy 或加产品的当天变成谎话。
 */
function paintHighlightsCount() {
  const cnt = $("#hlCount"); if (!cnt) return;
  const n = (parseHighlights($("#f_highlights").value) || []).length;
  cnt.textContent = `共 ${n} 条`;   // ⛔ 不再有"短句"警告
}
function paintImgCount() {
  const c = $("#imgCount"); if (!c) return;
  c.textContent = `共 ${(state.imgList || []).length} 张`;
}
/** 已选 N / M。⚠️ M = taxonomy 里传感器的真实条数，⛔ 不是写死的 19。 */
function paintSensorCount() {
  const c = $("#sensorCount"); if (!c) return;
  const box = $("#f_sensors");
  const total = box.querySelectorAll("input").length;
  const on = box.querySelectorAll("input:checked").length;
  c.innerHTML = "";
  c.append(document.createTextNode("已选 "));
  const b = el("b", on ? "" : "is-zero", String(on));
  c.append(b, document.createTextNode(` / ${total}`));
}

/* ══════════ v3 §3.4 校验：违反时才出声 ══════════
 * 「保存前还缺」那张卡删掉之后，禁用的保存按钮就哑了 ⇒ 这里是它唯一的替代。
 * ⛔ 不写"请填写必填项"，要写出**具体缺的项**；同时那几处**就地标红**。
 * ⚠️ 只报"空着"这一类，⛔ 不在这里复制契约校验器的规则 —— 那是服务端的活，
 *    这里只回答一个问题：**为什么这个按钮点不下去。**
 */
function paintMissing() {
  const pane = $("#editPane");
  if (!pane || pane.hidden) return;
  const miss = [];
  const mark = (id, bad) => {
    const f = $(id); if (!f) return;
    f.classList.toggle("is-bad", bad);
    const m = f.querySelector(".badmsg"); if (m) m.hidden = !bad;
  };
  const noName = !$("#f_name").value.trim();
  const noModel = !$("#f_model").value.trim();
  const noCat = !$("#f_category").value;
  const noSensor = !$("#f_sensors").querySelectorAll("input:checked").length;
  if (noName) miss.push("产品标题");
  if (noModel) miss.push("型号");
  if (noCat) miss.push("机型");
  if (noSensor) miss.push("传感器");
  // ⚠️ 两个时机，是故意分开的（mockup 帧 2 的说明：「**点过一次保存**，暴露出缺的两项」）：
  //    · 按钮旁那行红字 —— **只要按钮是灰的就该说**，那正是它存在的理由；
  //    · 字段**就地标红** —— 等人真的试过一次保存再标。
  //    ⛔ 一进新建页就满屏红，会让红色在真正该看的时候不被当回事。
  const showInline = !!state.saveAttempted;
  mark("#fld_model", showInline && noModel);
  mark("#fld_category", showInline && noCat);
  mark("#fld_sensors", showInline && noSensor);

  const why = $("#whyMiss");
  // 🔴 Meta 超限是**另一条**禁用理由，它由 paintMetaDesc 管（全仓只有那一处改 disabled）。
  //    ⇒ 这里只在"没有超限"时接管按钮，⛔ 两处各自 disabled 会变成"谁禁的、谁该解"。
  const metaOver = $("#previewBtn").dataset.metaOver === "1";
  if (why) { why.hidden = !miss.length; why.textContent = miss.length ? `还缺：${miss.join("、")}` : ""; }
  $("#previewBtn").disabled = metaOver || miss.length > 0;
}

/* ══════════ v3 §3.5 未保存提醒 ══════════
 * ⚠️ 这是全单**唯一一条不是 Joe 提出的功能**（总工提，Joe 未反对）—— 交付时单列。
 * 改过字段后离开会静默丢失，此前没有任何防护。
 * ⛔ 不用原生 confirm（Admin 的零弹窗规矩）：拦下来 + 页面内提示，人自己再点一次。
 */
function markDirty() {
  if (state.dirty) return;
  state.dirty = true;
  const b = $("#dirtyBar"); if (b) b.hidden = false;
}
function markClean() {
  state.dirty = false;
  state.leaveArmed = false;
  const b = $("#dirtyBar"); if (b) b.hidden = true;
}
/**
 * 离开前拦一次。返回 true = 放行。
 * ⚠️ 第一次点拦下并把提示改成"再点一次就丢弃"；第二次点放行 ——
 *    ⛔ 不做成永远拦不过去，也⛔ 不用系统弹窗。
 */
function confirmLeave() {
  if (!state.dirty) return true;
  if (state.leaveArmed) return true;
  state.leaveArmed = true;
  const b = $("#dirtyBar");
  if (b) { b.hidden = false; b.textContent = "⚠️ 有未保存的修改 —— 再点一次「返回列表」就会丢弃它们。"; }
  return false;
}
/**
 * 分类页离开拦截（第 4 条边界 1）。与 confirmLeave 同一套：第一次拦下并说清**会丢什么**，
 * 第二次放行。⛔ 不做成永远拦不过去，也⛔ 不用系统弹窗。
 */
let catsLeaveArmed = false;
function confirmLeaveCats() {
  const n = pendingTotal();
  if (!n) { catsLeaveArmed = false; return true; }
  if (catsLeaveArmed) {
    // 🔴 第二次点 = 放行，而屏幕上刚说过「再点一次就会丢弃它们」
    //    ⇒ **必须真的丢弃**。实测发现过：走掉了但暂存还在内存里，
    //      切回分类页它们又冒出来 —— 那句提示当场变成假话，
    //      而更坏的是他以为已经放弃了，下次点「保存」会把它们一起提交。
    catsLeaveArmed = false;
    state.axisPending = { categories: [], sensors: [] };
    state.axisManage = { categories: false, sensors: false };
    const bar0 = $("#dirtyBar"); if (bar0) bar0.hidden = true;
    if (state.cats) renderCats();
    return true;
  }
  catsLeaveArmed = true;
  const lines = [...pendingLines("categories"), ...pendingLines("sensors")];
  const bar = $("#dirtyBar");
  if (bar) {
    bar.hidden = false;
    // ⚠️ 说清**是哪几处**，⛔ 不只说个数字 —— 数字回答不了"我会失去什么"。
    bar.textContent = `⚠️ 分类页有 ${n} 处未保存：${lines.join("；")} —— 再点一次就会丢弃它们。`;
  }
  return false;
}

/**
 * G 批 §6：`[data-autogrow]` 的 textarea 随内容长高，**不内滚**。
 *
 * ⚠️ 地板由 HTML 的 `rows` 出（rows=4），⛔ 这里不写第二个数字 ——
 *    写死一个 min-height 的话，改 rows 时它不跟，而没人会想到回来改这里。
 * 🔴 `scrollHeight` 在元素**不可见**时是 0（`<details>` 收起 = display:none）。
 *    直接照抄会把框压成 0 高，而症状是"卖点框不见了" ⇒ 读到 0 就把 height 清掉，
 *    交回 `rows` 那个地板，等它可见时再量。
 * ⚠️ 必须先 `height:auto` 再读 scrollHeight：不清的话上一次撑开的高度会把它锁住，只涨不缩。
 */
/**
 * `[data-autogrow]` 的 textarea 随内容长高、**不内滚**（G 批 §6）。
 *
 * 🔴 这里**一个像素都不量** —— 高度由布局自己算出来（`.grow-wrap` 的 CSS 见 style.css）：
 *    包裹层是一个单格 grid，textarea 与 `::after` 叠在同一格里，`::after` 装着同一段文字
 *    （`content: attr(data-replicated-value)`）。格子高 = 两者的较高者 ⇒ 框永远刚好装下文字。
 *
 * ⚠️ 为什么不用"量 scrollHeight 再赋 height"那条路（我先写的就是那条，已撤）：
 *    那条路要求**在正确的时刻、正确的宽度下**去量，于是它有三个必然的坑 ——
 *      ① `<details>` 收起时 scrollHeight = 0（量到 0 会把框压没）；
 *      ② `box-sizing: border-box` 下 `height` 含边框而 `scrollHeight` 不含，永远差一个边框；
 *      ③ **宽度一变折行数就变**，必须靠 ResizeObserver/resize 事件回来重量，
 *         漏了就把多出来的行**切掉且不可达**（`overflow-y: hidden`，连滚动条都没有）。
 *    ③ 实测过：1278 → 700 少了 22px 内容，没有任何症状。
 *    ⇒ 换成布局自己算之后，这三条**全部不存在**：没有时刻、没有测量、没有观察者。
 *
 * ⚠️ 这个函数是**同步文本**，不是测量 ⇒ 早调晚调都对，框看不看得见也都对。
 */
function syncGrow(ta) {
  const wrap = ta && ta.closest(".grow-wrap");
  if (wrap) wrap.dataset.replicatedValue = ta.value;
}
document.querySelectorAll("textarea[data-autogrow]").forEach((ta) => {
  syncGrow(ta);
  ta.addEventListener("input", () => syncGrow(ta));
});
$("#f_highlights").addEventListener("input", paintHighlightsCount);

/* ══ v3 接线：一个入口管住"字段变了" ══
 * 🔴 用**捕获阶段的委托**挂在表单上，⛔ 不给每个控件各绑一次：
 *    新增字段（今天就加了三个）不会被忘掉，而"忘绑一个"的症状是
 *    "改了那一项，脏提醒不出来" —— 没有任何报错。
 * ⚠️ chip 是 label 包 checkbox ⇒ change 事件同样冒泡到这里，传感器计数一并跟着走。
 */
$("#editPane").addEventListener("input", () => { markDirty(); paintMissing(); }, true);
$("#editPane").addEventListener("change", () => {
  markDirty(); paintSensorCount(); paintMissing();
}, true);

$("#backBtn").onclick = () => {
  if (!confirmLeave()) return;          // v3 §3.5：拦一次（⛔ 不是原生 confirm）
  markClean();
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
document.querySelectorAll("[data-bulk]").forEach((b) => {
  b.onclick = () => bulk([...state.selected], b.dataset.bulk);
});
// ⚠️ 选完立刻回到占位项：不回的话，下拉停在刚用过的值上，看起来像"当前筛选是它"。
$("#bulkCat").onchange = (e) => {
  const v = e.target.value; e.target.value = "";
  if (v) bulk([...state.selected], v, "category");
};
// ⚠️ 「试过一次保存」这个事实要在 doPreview 之前落下 —— 就地标红靠它。
//    ⛔ 不放进 doPreview 里面：那个函数里有多条 early return，会漏。
$("#editPane").onsubmit = (e) => { state.saveAttempted = true; paintMissing(); return doPreview(e); };
// ⚠️ 「还原」按钮已撤（Joe 2026-08-26）。绑定必须一起删：
//    对着不存在的元素 `.onclick=` 会当场抛 TypeError，而它在模块顶层 ⇒
//    **整份 app.js 停在这一行**，症状是"整个后台白屏"，看起来完全不像是删了个按钮。
// ⚠️ 卖点的「+ 加一条」也已撤（A17：卖点改成一个大输入框）—— 元素和这里的分支一起删，
//    ⛔ 不留 `else repeatRow(...)` 那种对着不存在容器的死绑定。现在只剩 specs 一个 data-add。
document.querySelectorAll(".add[data-add]").forEach((b) => {
  b.onclick = () => {
    if (b.dataset.add !== "specs") return;
    kvRow($("#f_specs"), "", "");
    paintSpecsDivider(); markDirty();   // 同上：程序加行，委托监听接不到
  };
});
// ═══════════════ A8 媒体库 ═══════════════
//
// ⛔ **只报告，绝不提供"一键清理孤儿"。** 判错一张在用的图 = 官网当场缺图，而删除不可逆。
//    要删就去那个产品的编辑页逐张确认 —— 多点两下，换的是"删错了没法撤"这件事不会发生。
async function loadMedia() {
  // ⚠️ #mediaGrid 已随 E 批换成 #mediaGroups —— 这里跟着换，⛔ 摸已删元素会让整个函数第一行就抛
  $("#mediaGroups").innerHTML = "";
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

/**
 * 图片页。**两个视图**（Joe 2026-09-04 两次指出：「图片只有分类，没有看到文件夹」「文件夹呢？」）：
 *   `state.mediaFolder === null` ⇒ **文件夹网格**（默认）
 *   `state.mediaFolder === "ak13a"` ⇒ 只看那一个文件夹里的图
 *
 * 🔴 上一版做的是「41 个小标题 + 230 张图一次全渲染」。那**不是文件夹**，是分组 ——
 *    他要找一个产品的图仍然得滚过一屏又一屏，和没有文件夹时是同一个问题。
 *    ⚠️ 我们当时满足了字面（"按文件夹组织"），没满足他要解决的那件事（"别让我一路滚"）。
 *    ⇒ **文件夹的定义：看到文件夹 → 点一个 → 只看那一个。** 判据落在
 *      「他找一个产品的图要滚多远」，⛔ 不落在「有没有按文件夹分组」。
 *
 * ⚠️ 「孤儿」判据仍然只有服务端盖的 `f.orphan`（media.ts 的 isOrphan）——
 *    ⛔ 这里不写第二遍 `!referencedBy.length`（那个双真源出过事：38 张原图被标成可删）。
 */
function renderMedia() {
  const m = state.media; if (!m) return;
  $("#navMediaCount").textContent = `(${m.total})`;

  // 对账红 / missing 红是**真警告**，⛔ 两个视图都要显示，不随视图切换消失
  const sum = $("#mediaSummary"); sum.innerHTML = "";
  if (!m.reconciled) sum.append(mkNotice("bad", "🔴 **对账不成立**（被引用 + 孤儿 ≠ 总数）—— 本次扫描结果不可用。"));
  if (!m.orphansTrustworthy) sum.append(mkNotice("bad", m.note));
  if (m.missing?.length) {
    // ⚠️ 与孤儿**相反**的病：不是"图没人要"，是"要的图不在"（官网会缺图）。
    sum.append(mkNotice("bad", "以下引用指向不存在的文件（官网会缺图）：" +
      m.missing.map((x) => `${x.slug} → ${x.rel}`).join("；")));
  }

  if (state.mediaFolder === ORPHAN_VIEW) renderOrphanList(m);
  else if (state.mediaFolder === null || state.mediaFolder === undefined) renderFolderGrid(m);
  else renderFolderContents(m, state.mediaFolder);
}

/**
 * 「全部未被引用」这个视图的哨兵值。
 * ⚠️ 用 `@` 开头是有理由的：服务端的文件夹名闸是 `^[a-z0-9]+(-[a-z0-9]+)*$`，
 *    `@` 永远不可能是一个真实文件夹名 ⇒ ⛔ 不可能与某个文件夹撞名。
 */
const ORPHAN_VIEW = "@orphans";

/** 文件夹 = rel 去掉 `products/` 后的目录部分；根目录记作 ""。 */
const folderOfRel = (rel) => {
  const rest = rel.replace(/^products\//, "");
  const i = rest.indexOf("/");
  return i < 0 ? "" : rest.slice(0, i);
};

/** 系统目录：⛔ 这两条「不上站」**仍然为真**（官网 glob 的两条负向排除挡着它们），别删。 */
const SYS_FOLDERS = {
  _draft: { name: "草稿区", tag: "不上站", sub: "未上架产品的图" },
  originals: { name: "原图存档", tag: "不上站", sub: "jpg / png 源材料" },
};

/**
 * 默认视图：文件夹网格。
 *
 * 🔴 数据源是 **产品列表 × 文件夹列表的并集**，⛔ 不是"仓里已存在的目录"：
 *    只列已存在的目录，**还没有图的产品就永远不会出现** —— 而那恰恰是 Joe
 *    现在完全看不见、也最该看见的东西（"哪些产品还缺图"）。
 */
function renderFolderGrid(m) {
  const byFolder = new Map();
  m.files.forEach((f) => {
    const k = folderOfRel(f.rel);
    if (!byFolder.has(k)) byFolder.set(k, []);
    byFolder.get(k).push(f);
  });

  // 产品 → 它的型号文件夹（与服务端/imagepaths 同一口径：小写 + 非字母数字压成连字符）
  const modelFolder = (mod) => String(mod || "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-");
  const prodByFolder = new Map();
  (state.list || []).forEach((p) => {
    const k = modelFolder(p.model);
    if (k && !prodByFolder.has(k)) prodByFolder.set(k, p);
  });

  // 🔴 「型号文件夹是空的」≠「这个产品没有图」。
  //    未上架产品的图住在 `_draft/`（批 2 定的规则：发布时才落进型号目录）。
  //    ⚠️ 实测 2026-09-04：41 个产品 = 25 个型号文件夹里有图 + **16 个图在草稿区**
  //       + **0 个真的一张都没有**。
  //    ⇒ 给这 16 个写「还没有图」**是假话** —— 与刚修掉的「不进构建」是同一类错：
  //      **页面把"我没在这里看见"说成了"它不存在"。**
  //    ⇒ 这里按 slug 找出它在别处的图，卡片说「N 张 · 在草稿区」，⛔ 不说"还没有图"。
  const draftOf = new Map();
  m.files.forEach((f) => {
    if (f.area !== "draft") return;
    f.referencedBy.forEach((slug) => {
      if (!draftOf.has(slug)) draftOf.set(slug, []);
      draftOf.get(slug).push(f);
    });
  });

  // ⭐ 并集：产品的型号文件夹 ∪ 仓里真实存在的产品目录（后者能兜住"型号改过、旧目录还在"）
  const productFolders = new Set([...prodByFolder.keys()]);
  [...byFolder.keys()].forEach((k) => { if (k && !SYS_FOLDERS[k]) productFolders.add(k); });

  const q = (state.mediaQ || "").trim().toLowerCase();
  const hit = (k, files) => !q || k.includes(q) || (files || []).some((f) => f.rel.toLowerCase().includes(q));

  // 「在草稿区」的图算它有图 ⇒ noImgs 只数**真的一张都没有**的（实测当前为 0）
  const filesFor = (k) => {
    const own = byFolder.get(k) || [];
    if (own.length) return { files: own, inDraft: false };
    const p = prodByFolder.get(k);
    const d = (p && draftOf.get(p.slug)) || [];
    return { files: d, inDraft: d.length > 0 };
  };
  const noImgs = [...productFolders].filter((k) => !filesFor(k).files.length).length;

  // ── 页头 ──
  $("#mediaSub").textContent =
    `${productFolders.size + Object.keys(SYS_FOLDERS).length} 个文件夹 · ${m.total} 张 · 在用 ${m.referenced}`;
  const head = $("#mediaHead"); head.innerHTML = "";
  // 🔴 「未被引用」入口：**仅 N > 0 时出现**（0 的时候⛔ 不占位置）。
  //    它是唯一会引导破坏性操作（清理）的信号 —— 文件夹网格上只能看出**哪个文件夹**有孤儿，
  //    ⛔ 没有"一次列全"的入口的话，5 张孤儿散在 5 个文件夹里就得点进 5 次才看得全。
  //    ⚠️ 一个只在出问题时才有用的入口，恰恰不能等出问题了再补。
  // 🔴🔴 **结论不可信时不给清单**（审计④，照搬 taxonomy 那道硬闸的形状：
  //    `canDelete: refs.length===0 && unreadable===0` —— 读不出来的产品引用了什么看不见，
  //    此时"没人在用"这个结论**不成立**）。
  //    ⚠️ 这里的后果比 taxonomy 更重：孤儿清单唯一的用途就是引导清理，
  //       而被误判的"孤儿"里可能正躺着官网在用的图，删了不可逆。
  // ⛔ 但**不许静默藏起来**：入口消失 = 屏幕上什么都没发生，
  //    而"有孤儿却没有入口"与"没有孤儿"在界面上同形 —— 那是另一种骗人。
  //    ⇒ 位置照占、话照说、**就是不给点**。
  if (m.orphans > 0 && m.orphansTrustworthy === false) {
    const ob = el("button", "mtag is-refused", "未被引用 —— 本次算不出");
    ob.type = "button"; ob.disabled = true;
    ob.title = "有产品 JSON 读不出来，它们引用了什么看不见 ⇒ 算出来的\"孤儿\"里可能混着官网在用的图。"
      + "先修好上面点名的那几个文件，这个清单才有意义。";
    head.append(ob);
  } else if (m.orphans > 0) {
    const ob = el("button", "mtag", `未被引用 ${m.orphans}`); ob.type = "button";
    ob.title = `把散落在各个文件夹里的 ${m.orphans} 张一次列全`;
    ob.onclick = () => { state.mediaFolder = ORPHAN_VIEW; renderMedia(); };
    head.append(ob);
  }
  const search = el("input", "msearch");
  search.type = "search"; search.placeholder = "搜型号 / 文件名"; search.value = state.mediaQ || "";
  search.oninput = () => { state.mediaQ = search.value; renderMedia(); search.focus(); };
  head.append(search);
  // 排序（Joe：「加个排序」）。⛔ 只有三项 —— 派单里的第四项「最近更新」**做不了**：
  //    `/api/media` 读的是 git tree，而 **tree 里没有时间**（它只有 path/size/sha/mode）。
  //    ⚠️ 拿 `sha` 或数组顺序去排会是「**算得出、但不度量那件事**」——
  //       排出来的顺序看着像"最近更新"，其实与时间无关，而且没有任何症状。
  //    ⇒ ⛔ 宁可少一项，也不放一个会骗人的选项。已报总工（要它得先让服务端取 commit 时间）。
  const sort = el("select", "msort");
  [["name", "型号 A→Z"], ["count", "张数 多→少"], ["live", "在用优先"]]
    .forEach(([v, t]) => sort.append(new Option(t, v)));
  sort.value = state.mediaSort || "name";
  sort.onchange = () => { state.mediaSort = sort.value; renderMedia(); };
  head.append(sort);
  const nf = el("button", "btn-secondary", "＋ 新建文件夹"); nf.type = "button";
  nf.onclick = () => mediaPanel("folder");
  const up = el("button", "primary", "上传图片"); up.type = "button";
  up.onclick = () => mediaPanel("upload");
  if (!state.write?.enabled) {
    nf.disabled = true; up.disabled = true;
    nf.title = up.title = "当前不能保存（写入闸或 token 未就绪）";
  }
  head.append(nf, up);

  const box = $("#mediaGroups"); box.innerHTML = "";

  // ── 产品文件夹：排序 ──
  // ⛔ 系统目录（草稿区 / 原图存档）**不参与排序，永远排最后** —— 它们下面单独一组。
  // ⛔ 排序不持久化：刷新回默认。⚠️ 它是"我现在想这么看"，不是一项设置；
  //    记住它会让下一次打开这一页的样子取决于上次点了什么，而人早忘了。
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const names = [...productFolders].sort((a, b) => {
    const fa = filesFor(a), fb = filesFor(b);
    if (state.mediaSort === "count") {
      const d = fb.files.length - fa.files.length;
      if (d) return d;
    } else if (state.mediaSort === "live") {
      // 「在用优先」：型号文件夹里真有图的在前，图还在草稿区的在后。
      // ⚠️ Joe 嫌乱多半就是这个 —— 现在按字母排，ak11c(草稿) 和 ak13a(在用) 是混着的。
      const w = (x) => (x.files.length === 0 ? 2 : x.inDraft ? 1 : 0);
      const d = w(fa) - w(fb);
      if (d) return d;
    }
    return collator.compare(a, b);   // 兜底一律型号 A→Z ⇒ 排序稳定、⛔ 不出现"同一档内顺序乱跳"
  });
  const grid = el("div", "fgrid");
  let shown = 0;
  names.forEach((k) => {
    const { files, inDraft } = filesFor(k);
    if (!hit(k, files)) return;
    shown++;
    grid.append(folderCard(k, files, prodByFolder.get(k), inDraft));
  });
  box.append(grid);
  if (!shown) box.append(el("p", "hint0", q ? `没有匹配「${q}」的文件夹。` : "还没有任何产品文件夹。"));

  // ⭐ "还有 N 个没有图" —— 这一条是本单顺带解决的那件事：以前埋在 230 张图里发现不了
  if (!q && noImgs) {
    const p = el("p", "fnote");
    p.append(document.createTextNode("其中 "));
    p.append(el("b", "is-amber", String(noImgs)));
    p.append(document.createTextNode(" 个产品还没有图。"));
    box.append(p);
  }

  // ── 系统目录 ──
  box.append(el("div", "fsect", "系统目录"));
  const sg = el("div", "fgrid");
  Object.keys(SYS_FOLDERS).forEach((k) => {
    const files = byFolder.get(k) || [];
    if (!hit(k, files)) return;
    sg.append(folderCard(k, files, null));
  });
  box.append(sg);

  $("#mediaEmpty").hidden = true;
}

/** 一张文件夹卡：2×2 四格预览 + 名字 + 「N 张 · 全部在用 / M 张未被引用」。 */
function folderCard(k, files, product, inDraft) {
  const sys = SYS_FOLDERS[k];
  const card = el("div", "fcard" + (sys ? " is-sys" : "") + (!files.length ? " is-empty" : ""));
  card.tabIndex = 0;
  const open = () => { state.mediaFolder = k; renderMedia(); window.scrollTo?.(0, 0); };
  card.onclick = open;
  card.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } };

  // ══ 封面（Joe 2026-09-04：「这个文件夹的封面看起来很丑，要不直接用产品主图作为封面」）══
  //
  // 🔴 封面 = **该产品的 `images.main`**，⛔ 不是"文件夹里的第一张"：
  //    主图是产品数据里**明确指定**的那一张，真源在产品 JSON（列表接口把它带在 `image` 上）。
  //    "文件夹里的第一张"只是文件排序的副产物，⛔ 那不是任何人指定过的东西。
  // ⚠️ 草稿产品的主图在 `products/_draft/` ⇒ **别只在型号目录里找**，
  //    只在型号目录里找的话，那 16 个草稿产品会全变成空白卡。
  //    （`p.image` 本身就带着完整相对路径，两种情况都覆盖到了。）
  // ⛔ 原来的四格拼贴 + `+N` 角标已撤：43 张卡 × 4 张缩略图 = **一屏 170 多张小图**，
  //    噪音盖过信息；而张数副标题里已经写着，⛔ 不说两遍。
  const th = el("div", "fth");
  // 三档回落，⛔ 每一档都要出得来东西，别让某一档变成空白卡
  const cover = (product && product.image) || (files[0] && files[0].rel) || null;
  if (cover) {
    const img = el("img", "fcover");
    img.loading = "lazy"; img.alt = "";
    img.src = rawUrl(cover);
    // 第三档：图 404 时回落到灰底占位，⛔ 不留一个碎图图标
    img.onerror = () => { img.remove(); th.classList.add("is-blank"); };
    th.append(img);
  } else if (!files.length) {
    th.append(el("i", "fplus", "＋"));      // 真的一张图都没有
  } else {
    th.classList.add("is-blank");
  }
  card.append(th);

  const meta = el("div", "fmeta2");
  const name = el("div", "fname");
  name.append(document.createTextNode(sys ? sys.name : k));
  if (sys) name.append(el("span", "ftag", sys.tag));
  meta.append(name);

  const orph = files.filter((f) => f.orphan).length;
  let sub;
  if (!files.length) sub = "还没有图";
  else if (sys) sub = `${files.length} 张 · ${sys.sub}`;
  // 🔴 未上架产品的图住在草稿区 —— 说出**它们在哪**，⛔ 不说"还没有图"（那是假话）
  else if (inDraft) sub = `${files.length} 张 · 在草稿区`;
  else if (orph) sub = `${files.length} 张 · ${orph} 张未被引用`;
  else sub = `${files.length} 张 · 全部在用`;
  const s = el("div", "fsub" + (orph ? " is-warn" : ""), sub);
  meta.append(s);
  card.append(meta);

  card.title = product
    ? `${product.model} — ${product.name}\n${files.length} 张`
    : `${k}\n${files.length} 张`;
  return card;
}

/**
 * 「全部未被引用」：把散落在各个文件夹里的孤儿一次列全。
 * ⚠️ 判据仍只有服务端盖的 `f.orphan`，⛔ 这里不写第二遍 `!referencedBy.length`。
 */
function renderOrphanList(m) {
  // 🔴 闸在**两处**都要有，⛔ 不能只守入口：
  //    `state.mediaFolder` 是会留存的（切到别处再回来、上一次扫描时还可信），
  //    只守入口的话，一次刷新就能带着旧视图进到这里 —— 而这里正是那份不可信清单。
  if (m.orphansTrustworthy === false) return renderOrphanRefused(m);
  const files = m.files.filter((f) => f.orphan);
  $("#mediaSub").textContent = "";
  $("#mediaHead").innerHTML = "";
  const box = $("#mediaGroups"); box.innerHTML = "";

  const crumb = el("div", "fcrumb");
  const back = el("button", "linkish", "← 全部文件夹"); back.type = "button";
  back.onclick = () => { state.mediaFolder = null; renderMedia(); };
  crumb.append(back, el("span", "hint0", "/"), el("b", null, "未被引用"));
  crumb.append(el("span", "hint0", `${files.length} 张 · 散落在 ${new Set(files.map((f) => folderOfRel(f.rel))).size} 个文件夹里`));
  box.append(crumb);

  // ⚠️ 这一句不是装饰：人到这一页来多半是想清理，而"未被引用"**不等于**"可以删"。
  // ⚠️ 这一句原本写着「删除仍然会二次确认」——**那是假的**：
  //    这个后台按设计**没有删图能力**（本文件上方：「⛔ 只报告，绝不提供一键清理孤儿」，
  //    服务端也没有任何删图端点）。真删是在仓里删的，**没有任何二次确认兜着他**。
  //    ⇒ 一句承诺了不存在的护栏的话，比没有护栏更危险。
  box.append(mkNotice("warn", "**未被引用 ≠ 可以删。** 这里只是列出「没有任何产品 JSON 指向它」的图。"
    + "⚠️ 这个后台**不删图**，删是在仓里手动删的 —— **没有二次确认兜着你**，删错了也不可逆。"));

  const grid = el("div", "mgal");
  files.forEach((f) => grid.append(mediaCard(f)));
  box.append(grid);
  $("#mediaEmpty").hidden = files.length > 0;
  if (!files.length) $("#mediaEmpty").textContent = "没有未被引用的图片 —— 干净。";
}

/**
 * 孤儿清单的**拒绝页**（审计④）。
 *
 * 🔴 判据不是"有没有孤儿"，是"**这个结论算不算得出来**"。
 *    有产品 JSON 读不出来 ⇒ 它们声明的引用看不见 ⇒ 那些图会被算成孤儿。
 *    此时给出清单，等于把**在用的图**摆进一个标题叫"未被引用"的页面。
 * ⛔ 不给"我知道风险，还是看一眼"的旁路：这一页的唯一用途就是引导清理，
 *    一个带着风险提示的清单，人照样会照着它删。
 */
function renderOrphanRefused(m) {
  $("#mediaSub").textContent = "";
  $("#mediaHead").innerHTML = "";
  const box = $("#mediaGroups"); box.innerHTML = "";
  const crumb = el("div", "fcrumb");
  const back = el("button", "linkish", "← 全部文件夹"); back.type = "button";
  back.onclick = () => { state.mediaFolder = null; renderMedia(); };
  crumb.append(back, el("span", "hint0", "/"), el("b", null, "未被引用"));
  box.append(crumb);
  const n = el("div", "notice notice-bad");
  appendMd(n.appendChild(el("div")),
    "🔴 **这份清单这次算不出来，所以不给。**");
  appendMd(n.appendChild(el("div")),
    `有 ${(m.unreadable || []).length} 个产品的数据文件读不出来 ——`
    + "它们**引用了哪些图看不见**，那些图会被算成「未被引用」。"
    + "照这份清单清理，删掉的可能正是官网在用的图，**而且不可逆**。");
  if ((m.unreadable || []).length) {
    const ul = el("ul", "dangling-list");
    m.unreadable.forEach((slug) => ul.append(el("li", null, slug)));
    n.append(ul);
  }
  appendMd(n.appendChild(el("div")), "⇒ 先把上面这几个文件修好，这一页会自己恢复。");
  box.append(n);
  $("#mediaEmpty").hidden = true;
}

/** 点进一个文件夹：只看这一个。 */
function renderFolderContents(m, k) {
  const sys = SYS_FOLDERS[k];
  let files = m.files.filter((f) => folderOfRel(f.rel) === k);
  // 🔴 型号目录是空的，不代表这个产品没有图 —— 未上架产品的图在 `_draft/`。
  //    ⇒ 点进来要看得见它们，⛔ 不能给一个"这个文件夹还没有图片"的空页面（那是假话）。
  let fromDraft = false;
  if (!sys && !files.length) {
    const p = (state.list || []).find((x) => String(x.model || "").toLowerCase()
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") === k);
    if (p) {
      const d = m.files.filter((f) => f.area === "draft" && f.referencedBy.includes(p.slug));
      if (d.length) { files = d; fromDraft = true; }
    }
  }
  const orph = files.filter((f) => f.orphan).length;

  $("#mediaSub").textContent = "";
  const head = $("#mediaHead"); head.innerHTML = "";

  const box = $("#mediaGroups"); box.innerHTML = "";

  // ── 面包屑：⛔ 必须能回去，否则"点进来"就是单程票 ──
  const crumb = el("div", "fcrumb");
  const back = el("button", "linkish", "← 全部文件夹"); back.type = "button";
  back.onclick = () => { state.mediaFolder = null; renderMedia(); };
  crumb.append(back, el("span", "hint0", "/"), el("b", "mono", sys ? sys.name : k));
  crumb.append(el("span", "hint0", !files.length ? "还没有图"
    : fromDraft ? `${files.length} 张 · 在草稿区（未上架，发布时会搬进这个文件夹）`
      : orph ? `${files.length} 张 · ${orph} 张未被引用`
        : `${files.length} 张 · 全部在用`));
  box.append(crumb);

  // ── 标题行：型号 + 产品标题 + 「编辑这个产品 →」 ──
  const hd = el("div", "fhead");
  hd.append(el("h2", "fh2 mono", sys ? sys.name : k));
  const prod = sys ? null : (state.list || []).find((p) => String(p.model || "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") === k);
  if (prod) {
    const sub = el("span", "fhsub");
    sub.append(document.createTextNode(prod.name + "　·　"));
    const go = el("button", "linkish", "编辑这个产品 →"); go.type = "button";
    go.onclick = () => { showNav("products"); select(prod.slug); };
    sub.append(go);
    hd.append(sub);
  } else if (sys) {
    hd.append(el("span", "fhsub", sys.sub));
  }
  const spacer = el("span", "fsp"); hd.append(spacer);
  // ⚠️ 上传复用现有面板，文件夹**预选为当前**（⛔ 保留目录不能传，见服务端闸）
  if (!sys) {
    const up = el("button", "primary", "上传到这个文件夹"); up.type = "button";
    up.onclick = () => mediaPanel("upload", k);
    if (!state.write?.enabled) { up.disabled = true; up.title = "当前不能保存（写入闸或 token 未就绪）"; }
    hd.append(up);
  }
  box.append(hd);

  // ── 图片网格：卡片只有文件名一行（已上线，保持）──
  const grid = el("div", "mgal");
  files.forEach((f) => grid.append(mediaCard(f)));
  box.append(grid);

  $("#mediaEmpty").hidden = files.length > 0;
  if (!files.length) $("#mediaEmpty").textContent = "这个文件夹还没有图片。";
}

/**
 * 一张图片卡。只有文件名一行（Joe：「图片下面不要显示那么多文字」）。
 * 🔴 但**孤儿那行红字不收进 hover** —— 它是唯一会引导破坏性操作（清理）的信号，
 *    藏进 hover 等于让人在看不见它的情况下做决定。
 */
function mediaCard(f) {
  const card = el("div", "micard");
  if (f.orphan) card.classList.add("is-orphan");
  const t = el("div", "thumb mthumb"); setThumb(t, rawUrl(f.rel), f.rel);
  card.append(t);
  card.append(el("div", "iname", f.rel.split("/").pop()));
  const kb = `${(f.size / 1024).toFixed(0)}KB`;
  if (f.referencedBy.length) {
    card.title = `${f.rel}\n用于 ${f.referencedBy.join("、")}\n${kb}\n（点击打开引用它的产品）`;
    card.style.cursor = "pointer";
    // ⚠️ 点击跳到那个产品这条**能力**保留 —— 删的是那行字，不是这条路。
    card.onclick = () => { showNav("products"); select(f.referencedBy[0]); };
  } else if (f.orphan) {
    card.title = `${f.rel}\n${kb}`;
    card.append(el("div", "iuse is-warn", "未被引用"));
  } else {
    // 原图存档零引用但**不是**孤儿 —— 它是图片管线的源材料，⛔ 不复用「未被引用」那个词
    card.title = `${f.rel}\n存档 · 不参与打包\n${kb}`;
  }
  return card;
}


/**
 * 新建文件夹 / 上传图片的内联面板（E 批）。同一时间只开一个；再点同一个按钮 = 关。
 * 🔴 上传**必须选文件夹**（服务端硬闸同款理由）：官网 glob 是根目录 eager `*.webp`，
 *    传根 = 未引用的素材也全部进构建产物。保留目录（_draft/originals）不在可选里。
 */
function mediaPanel(kind, preselectFolder) {
  const p = $("#mediaPanel");
  if (p.dataset.kind === kind && !p.hidden) { p.hidden = true; p.dataset.kind = ""; return; }
  p.dataset.kind = kind; p.hidden = false; p.innerHTML = "";
  const res = $("#mediaResult");

  const folders = [...new Set((state.media?.files || [])
    .map((f) => { const rest = f.rel.replace(/^products\//, ""); const i = rest.indexOf("/"); return i < 0 ? "" : rest.slice(0, i); })
    .filter((k) => k && k !== "_draft" && k !== "originals"))].sort();

  if (kind === "folder") {
    const row = el("div", "mrow");
    const inp = el("input"); inp.placeholder = "文件夹名（小写字母数字连字符，如 banners）"; inp.spellcheck = false;
    const ok = el("button", "primary btn-mini", "建"); ok.type = "button";
    ok.onclick = async () => {
      const name = inp.value.trim().toLowerCase();
      res.innerHTML = "";
      ok.disabled = true;
      try {
        const { status, body } = await api("/api/media/folder", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
        if (!body?.wrote) { res.append(mkNotice("bad", `🔴 ${body?.error || status}${body?.detail ? " —— " + body.detail : ""}`)); return; }
        res.append(mkNotice("ok", `✅ ${body.what} —— commit ${String(body.commitSha || "").slice(0, 7)}`));
        p.hidden = true;
        await loadMedia();
      } catch (e) { res.append(mkNotice("bad", "新建失败：" + e.message)); }
      finally { ok.disabled = false; }
    };
    row.append(inp, ok);
    p.append(row);
    inp.focus();
    return;
  }

  // ── 上传 ──
  const row = el("div", "mrow");
  const sel = el("select");
  sel.append(new Option("选择文件夹…", ""));
  folders.forEach((k) => sel.append(new Option(k + "/", k)));
  // 「上传到这个文件夹」进来时预选当前文件夹。
  // ⚠️ 预选而不是锁死：⛔ 服务端那道闸仍然是唯一真源（保留目录不许传、必须选文件夹），
  //    这里只是省他一次选择，⛔ 不替代校验。
  if (preselectFolder && folders.includes(preselectFolder)) sel.value = preselectFolder;
  const pick = el("label", "btn-secondary btn-mini");
  const fi = el("input"); fi.type = "file"; fi.accept = "image/*"; fi.multiple = true; fi.hidden = true;
  pick.append(fi, document.createTextNode("选图片…"));
  const note = el("span", "hint0", folders.length ? "自动转 WebP · 单张 ≤2MB · 不挂产品，传完会出现在「未被引用」" : "还没有文件夹 —— 先「新建文件夹」（不能传到根目录：根目录的图会被官网构建全部打包）");
  row.append(sel, pick, note);
  p.append(row);
  fi.onchange = async () => {
    const folder = sel.value;
    res.innerHTML = "";
    if (!folder) { res.append(mkNotice("bad", "先选一个文件夹 —— ⛔ 不能传到根目录（根目录的图会被官网构建全部打包，哪怕没人用）。")); fi.value = ""; return; }
    const files = [...fi.files]; fi.value = "";
    if (!files.length) return;
    res.append(mkNotice("warn", `转码并上传 ${files.length} 张到 ${folder}/ …（一次上传 = 官网仓一个 commit）`));
    try {
      const payload = [];
      for (const f of files) {
        const w = await toWebp(f);       // 复用产品图那条链：转 WebP + ≤2MB，超标就抛
        const stem = f.name.toLowerCase().replace(/\.[a-z0-9]+$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-") || "image";
        payload.push({ name: stem, base64: await blobToBase64(w.blob) });
      }
      const { status, body } = await api("/api/media/upload", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ folder, files: payload }) });
      res.innerHTML = "";
      if (!body?.wrote) { res.append(mkNotice("bad", `🔴 ${body?.error || status}${body?.detail ? " —— " + body.detail : ""}`)); return; }
      res.append(mkNotice("ok", `✅ ${body.what} —— commit ${String(body.commitSha || "").slice(0, 7)}。${body.note || ""}`));
      p.hidden = true;
      await loadMedia();
    } catch (e) { res.innerHTML = ""; res.append(mkNotice("bad", "上传失败：" + e.message)); }
  };
}

// ═══════════════ 站点内容：首页 / 联系方式 / SEO ═══════════════
//
// 三个视图编辑**同一个 JSON**，每次只提交自己那一节（section）。
// 🔴 只提交自己那一节 ⇒ 服务端的合并必须把"没收到的字段"当成"不动"。
//    当成"清空"的话，保存联系方式就会把首页文案抹掉，而两边都显示保存成功。
// ⚠️ 字段清单不是我照着源码列的，是**照产出页实测过**的：每一条都在构建产物里
//    渲染得出来。渲染不出来的（那两个 heading、整个 CAPABILITIES）**故意没放进来**。
// 🔴 `keys` 是**复数**（2026-09-05 由 `key` 改）：一个视图可以管不止一个顶层节。
//    ⚠️ 起因是一个会静默吃掉整次迁移的缺口：首页产品位从 `home.featuredSlugs` 迁到
//    `homeV4.products.featured` 之后，改动落在 `homeV4` 里，而"算改动"和"发 patch"
//    两处都只看 `home` 这一个键 ⇒ **保存按钮根本不会亮，改了也发不出去**。
//    症状是"我改了它没反应"，而界面上没有任何东西是坏的。
//    ⛔ 修法不是在保存那里加一句 `if (sec === "home") 顺便带上 homeV4` ——
//    那是把"这一节由哪些键组成"这件事散到第二个地方去；下一次再加一个块又会漏。
const SITE_SECTIONS = {
  // sub = 页头副标（C 批 §6：那条绿横幅压成这一句）；"保存 ≠ 上线"的完整版挂副标 title
  home: { title: "首页", keys: ["home", "homeV4"], sub: "官网首页文案 · 保存后约 1 分钟上线" },
  contact: { title: "联系方式", keys: ["contact"], sub: "站上的邮箱 / 电话 / 地图链接都由它们派生" },
  seo: { title: "SEO", keys: ["seo"], sub: "站级默认 + 逐页 title / description" },
};

/**
 * 站点三页的两态开关（C 批，Joe 定）：只读 = 字段纯文字（.ro 皮 + 控件 disabled），页头只有描边「编辑」；
 * 编辑 = 输入框 + 「取消」「保存」。🔴 同一份 markup —— 这里只换 class 和 disabled，⛔ 不重画字段。
 * ⚠️ disabled 而不只是 pointer-events:none：后者挡不住 Tab 键聚焦后打字。
 *    全局 :disabled 的灰化对只读态不适用（它不是"残废"是"展示"）—— .ro 里有覆盖（style.css）。
 */
function setSiteEditing(on) {
  state.siteEditing = !!on;
  const form = $("#siteForm");
  form.classList.toggle("ro", !on);
  // 🔴 规则（⛔ 不是给二维码开的特例）：**这个开关只管「保存」按钮会提交的那些字段**。
  //    自己管自己提交的控件挂 `data-selfsave`，编辑态碰不到它 —— 否则会出现
  //    "只读态下二维码也点不动"，而那张图根本不在「保存」的提交范围里，
  //    人会以为得先点「编辑」才能换图，点完又发现「保存」跟它没关系。
  form.querySelectorAll("input, textarea, select, button").forEach((el2) => {
    if (el2.closest("[data-selfsave]")) return;
    el2.disabled = !on;
  });
  $("#siteEdit").hidden = on;
  $("#siteCancel").hidden = !on;
  $("#siteSave").hidden = !on;
}

async function loadSite(which) {
  state.siteSection = which;
  state.siteEditing = false;               // 每次进视图回到只读态（Joe 定的默认）
  $("#siteEdit").disabled = true;          // 数据没到之前编辑不可点；到了 renderSite 再放开
  $("#siteTitle").textContent = SITE_SECTIONS[which].title;
  const ss = $("#siteSub");
  ss.textContent = SITE_SECTIONS[which].sub;
  ss.title = "保存 = 官网仓一次 commit ⇒ Cloudflare Pages 重建 ⇒ 约 1 分钟后站上可见。保存成功不等于站上已经变了，中间隔着一次构建。";
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
      $("#siteEdit").disabled = true; $("#siteEdit").title = "读取失败 —— 修好数据源之前不能编辑";   // 加载失败禁用编辑（Joe 定）
      return;
    }
    state.site = body;
    renderSite();
  } catch (e) {
    $("#siteNotes").innerHTML = "";
    $("#siteNotes").append(mkNotice("bad", "读取失败：" + e.message));
  }
}

/**
 * 表单控件：label（+ 灰 meta + (?) + 右侧计数）+ input/textarea。值写回 state.siteDraft。
 * crm-skin C 批（§6）：**常驻说明全撤** ——「为什么」进 label 旁 (?) 的 title（零 JS），
 * 「填什么」进 placeholder（opts.ph），「填错」交给保存时校验红字（现有闸）。
 * ⚠️ appendMd 的 **粗体** 语法在 title 里没有意义 ⇒ 塞进 (?) 前把星号剥掉。
 */
function siteField(parent, path, label, hint, opts = {}) {
  const wrap = el("div", "field");
  const id = "sf_" + path.replace(/\W/g, "_");
  const lab = el("label", "flab", label); lab.htmlFor = id;
  if (opts.meta) lab.append(el("span", "fmeta", opts.meta));
  if (hint) { const q = el("span", "q2", "?"); q.title = String(hint).replace(/\*\*/g, ""); lab.append(q); }
  wrap.append(lab);
  const cur = path.split(".").reduce((o, k) => (o == null ? o : o[k]), state.siteDraft) ?? "";
  const input = el(opts.multiline ? "textarea" : "input");
  input.id = id; input.value = cur;
  if (opts.ph) input.placeholder = opts.ph;
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
    // ── 计数放 **label 右侧**（§6），三态不变 ──
    // ⚠️ `0 / 160`（留空）与 `155 / 160`（快到上限）不能长一样：一个是"在继承别人的文案"，
    //    一个是"再写五个字就超了"。空 = 灰斜体；正常 = 绿；超限 = 变红（title 里说会被截断）。
    const cnt = el("span", "fcnt");
    const paint = () => {
      const n = input.value.trim().length;
      cnt.classList.remove("cnt-empty", "cnt-ok", "cnt-over");
      cnt.textContent = `${n} / ${opts.counter}`;
      if (n === 0) { cnt.classList.add("cnt-empty"); cnt.title = opts.inheritFrom ? "留空 —— 继承站点默认描述" : "留空"; }
      else if (n > opts.counter) { cnt.classList.add("cnt-over"); cnt.title = "超出部分会在搜索结果里被截断"; }
      else { cnt.classList.add("cnt-ok"); cnt.title = ""; }
    };
    input.addEventListener("input", paint); paint();
    lab.append(cnt);
  }
  paintInherit();
  // ⛔ 常驻 `<p class="hint">` 已撤（C 批）：hint 现在进 label 旁 (?) 的 title，见函数头。
  parent.append(wrap);
}

/**
 * 站点**固定资产位** —— 本单只有一个：官网联系页那张微信二维码。
 *
 * 🔴 它**不走这一页的「保存」**：点「更换」当场就是官网仓的一个 commit。
 *    ⇒ 界面必须把这句原样说出来。⛔ 不能让它长得像表单里的普通字段 ——
 *      长得像的话，人会以为"选完图还要点保存"（其实点「更换」就已经提交了），
 *      反过来也可能以为"我没点保存，所以刚才那张没上去"。两种误解都会让他再操作一次。
 * ⚠️ 挂 `data-selfsave` ⇒ 不归 setSiteEditing 的只读/编辑态管（规则写在那里）。
 *
 * ⚠️ **当前图与新图并排**，⛔ 不是选完就把当前那张换掉 —— 换掉的话，"我到底要把哪张
 *    替换成哪张"这件事在按下不可逆按钮的那一刻恰好看不见了。
 */
function siteAssetSlot(parent, key, label, hint) {
  const wrap = el("div", "field qrslot");
  wrap.dataset.selfsave = "1";
  const lab = el("label", "flab", label);
  const q = el("span", "q2", "?"); q.title = String(hint).replace(/\*\*/g, ""); lab.append(q);
  wrap.append(lab);

  const row = el("div", "qrrow");
  const mkCell = (cap) => {
    const cell = el("div", "qrcell");
    const box = el("div", "qrthumb");
    cell.append(box, el("span", "qrcap", cap));
    row.append(cell);
    return { cell, box };
  };
  const curCell = mkCell("现在这张");
  const newCell = mkCell("要换成"); newCell.cell.hidden = true;

  const side = el("div", "qrside");
  const pick = el("label", "btn-secondary btn-mini");
  const fi = el("input"); fi.type = "file"; fi.accept = "image/*"; fi.hidden = true;
  pick.append(fi, document.createTextNode("选一张新的…"));
  // ⚠️ 「更换」是描边不是绿实心：附录 C.7 的闭集写着**主动作一屏至多一个**，
  //    而这一屏的绿实心已经被页头的「保存」占了（index.html `.primary#siteSave`）。
  //    两个绿按钮会让人分不清哪一个才算"做完了这件事"。
  // ⚠️ 「取消」用 .linkish —— 站内撤销动作既定的分量（见 style.css 791 行「全部放弃」）。
  const go = el("button", "btn-secondary btn-mini", "更换"); go.type = "button"; go.hidden = true;
  const undo = el("button", "linkish", "取消"); undo.type = "button"; undo.hidden = true;
  const acts = el("div", "qracts");
  acts.append(pick, go, undo);
  side.append(acts);
  const st = el("p", "hint0", "读取中…");
  side.append(st);
  row.append(side);
  wrap.append(row);
  const res = el("div", "qrres");
  wrap.append(res);
  parent.append(wrap);

  let meta = null;     // 服务端说的"仓里现在是什么"
  let picked = null;   // {base64, w, h, bytes}

  const setThumbImg = (box, src, alt) => {
    box.innerHTML = "";
    if (!src) { box.append(el("span", "thumb-empty", alt)); return; }
    const img = el("img"); img.alt = alt; img.src = src; box.append(img);
  };

  const paint = () => {
    if (!meta) setThumbImg(curCell.box, null, "读不到");
    else if (!meta.exists) setThumbImg(curCell.box, null, "还没有图");
    else setThumbImg(curCell.box, rawUrl(meta.rel), "官网现在用的" + label);

    newCell.cell.hidden = !picked;
    go.hidden = !picked; undo.hidden = !picked;
    // ⚠️ 写入闸没开时不给"更换"，并且**说出理由** —— 点了没反应正是这一批在修的病。
    go.disabled = !picked || !state.write?.enabled;
    if (!state.write?.enabled) go.title = "当前不能写入（写入闸或 token 未就绪）";
    else go.title = `把官网仓里的 ${meta ? meta.path : ""} 换成这张 —— 点下去就是一次提交`;
  };

  const say = (t) => { st.textContent = t; };

  (async () => {
    try {
      const { status, body } = await api("/api/site-asset/" + key);
      if (status >= 400) { meta = null; say(body?.error || `读取失败（${status}）`); paint(); return; }
      meta = body;
      say(meta.exists
        ? `官网仓 ${meta.path} · ${(meta.size / 1024).toFixed(0)} KB · ${meta.usedBy}`
        : (meta.hint || "仓里还没有这个文件。"));
      paint();
    } catch (e) { meta = null; say("读取失败：" + e.message); paint(); }
  })();

  fi.onchange = async () => {
    const f = fi.files && fi.files[0]; fi.value = "";
    res.innerHTML = "";
    if (!f) return;
    say("转 WebP 中…");
    try {
      // 🔴 与产品图**同一个函数**：浏览器里转 WebP，服务端只认 WebP 且按文件头判。
      //    ⛔ 不另写一份转换 —— 两份转换迟早在某个参数上分叉，而分叉没有症状。
      const { blob, w, h, ow, oh } = await toWebp(f);
      picked = { base64: await blobToBase64(blob), w, h, bytes: blob.size };
      setThumbImg(newCell.box, URL.createObjectURL(blob), "要换上去的" + label);
      // 🔴 「点更换就是提交」这句必须**在这一刻看得见**：只读态下 (?) 那个提示是被藏起来的
      //    （style.css `#siteForm.ro .q2 { display:none }`），而这一刻恰恰是他要按下不可逆按钮之前。
      say(`新图 ${w}×${h}${(ow !== w || oh !== h) ? `（原图 ${ow}×${oh}，已缩）` : ""} · ${(blob.size / 1024).toFixed(0)} KB`
        + " · 点「更换」当场提交到官网仓，不用点上面的「保存」");
    } catch (e) {
      picked = null;
      res.append(mkNotice("bad", "这张图用不了：" + e.message));
      say("");
    }
    paint();
  };

  undo.onclick = () => { picked = null; res.innerHTML = ""; say(meta?.exists ? `官网仓 ${meta.path}` : ""); paint(); };

  go.onclick = async () => {
    if (!picked) return;
    go.disabled = true; const t0 = go.textContent; go.textContent = "提交中…";
    res.innerHTML = "";
    try {
      const { status, body } = await api("/api/site-asset/" + key, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ base64: picked.base64 }),
      });
      if (body && body.wrote === true) {
        // 🔴 换 cacheBust 才能看见新图：raw.githubusercontent.com 有 ≈300s CDN 缓存，
        //    路径又没变 ⇒ 不换的话缩略图还是旧的，而人会以为没传上去，**再传一次**。
        state.cacheBust = body.commitSha;
        picked = null; res.innerHTML = "";
        meta = { ...meta, exists: true, sha: body.sha, size: body.bytes };
        res.append(mkNotice("ok", body.note || "已提交。"));
        say(`官网仓 ${meta.path} · ${(meta.size / 1024).toFixed(0)} KB`);
      } else {
        // wrote:false 也是**正常回答**（比如"跟现在这张一模一样"），⛔ 不当成失败报红
        res.append(mkNotice(status >= 400 ? "bad" : "warn", body?.reason || body?.detail || body?.error || `没有写入（${status}）`));
      }
    } catch (e) {
      res.append(mkNotice("bad", "更换失败：" + e.message));
    }
    go.textContent = t0; paint();
  };
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
  // ⚠️ "不能保存"是真警告，保留；⛔ 那条常驻绿横幅（真源 · 保存 ≠ 上线）已撤（C 批 §6）——
  //    结论压进页头副标一句（loadSite 里设），"保存 ≠ 上线"那半句挂在副标的 title 上。
  if (!state.write?.enabled) notes.append(mkNotice("warn", "当前**不能保存**（写入闸或 token 未就绪）——改动不会提交。"));

  const form = $("#siteForm"); form.innerHTML = "";
  // ⚠️ 表单重画 ⇒ 上一批继承框的画笔全部作废。不清的话它们指向已被移除的节点，
  //    每渲染一次就多攒一份，而且看不出任何症状（只是白跑）。
  state.sitePainters = [];
  const sec = state.siteSection;

  if (sec === "contact") {
    const c = siteCard("联系数据", "站上的链接由它们派生");
    siteField(c, "contact.email", "邮箱", "页面上的 mailto: 链接由它拼出来。写错 = 死链接，而页面看不出异常。");
    const r1 = el("div", "row2"); c.append(r1);
    siteField(r1, "contact.phone", "电话", "WhatsApp 与拨号链接都由这一个号码派生（wa.me / tel:）。号码只存这一处，不可能出现「号码改了链接没改」。以 + 和国家码开头。");
    siteField(r1, "contact.wechatId", "微信号", "联系页那个「复制微信号」按钮复制的就是它。");
    // 二维码紧跟微信号（Joe 2026-09-05 定的位置）。⚠️ 它是**图片**，不走这一页的「保存」——
    //    理由与做法都在 siteAssetSlot 里，界面上也会明说。
    siteAssetSlot(c, "wechat-qr", "微信二维码",
      "官网联系页把鼠标停在 WeChat 那一行时弹出的那张图。**它不走这一页的「保存」**：选好图点「更换」当场就是官网仓的一次提交，约 1 分钟后站上生效。");
    siteField(c, "contact.address", "地址", "Google 地图链接由地址算出来，不单独存 —— 改了地址，地图自动跟着走。");
    const r2 = el("div", "row2"); c.append(r2);
    siteField(r2, "contact.hours", "营业时间");
    siteField(r2, "contact.response", "响应时间");
    form.append(c);
  } else if (sec === "home") {
    // 🔴 `card-inline`（Joe 2026-09-05）：这两张卡里**值紧跟在标签后面、同一行**
    //    （原来每个字段占两行，整块太高）。查看态与编辑态**同一份 markup** ——
    //    与两态皮同一条规矩：只换 class，⛔ 不重画字段。
    // ⚠️ 只挂在这两张卡上：SPEC 明写「首页精选产品及其他板块不动」，
    //    ⛔ 绝不改全局 `.field` —— 那会连联系方式 / SEO / 产品页一起换掉。
    const h = siteCard("Hero", "首页第一屏");
    h.classList.add("card-inline");
    siteField(h, "home.hero.eyebrow", "小标", null, { meta: "eyebrow" });
    siteField(h, "home.hero.headline", "大标题", "首页的 H1，搜索引擎最看重的一行。", { meta: "H1" });
    siteField(h, "home.hero.body", "副文案", null, { multiline: true, rows: 2 });
    // Joe 2026-09-05（看过上线效果后）：次按钮**移到主按钮正下方**，不再左右两栏。
    // ⛔ 做法不是把 `.row2` 用 CSS 压成一列 —— 那会留下一个名叫「两栏」却渲染成一栏的类，
    //    下一个人照类名去理解布局就会被骗。⇒ 直接不要那个容器。
    siteField(h, "home.hero.primaryCtaLabel", "主按钮文字", "只能改文字。按钮指向哪里（/contact）留在代码里 —— 链接改错是 404，文案改错只是难看。");
    siteField(h, "home.hero.secondaryCtaLabel", "次按钮文字");
    form.append(h);

    // 卖点卡（§6 mockup）：每张 = row2（标题 | 正文），右上「删掉这张」红字；卡底「+ 加一张」描边小按钮
    const v = siteCard("卖点卡", `首页那几张小卡 · ${(state.siteDraft.home.valueProps || []).length} 张`);
    v.classList.add("card-inline");   // 同上（Joe 红框里的第二块）
    (state.siteDraft.home.valueProps || []).forEach((_, i) => {
      const row = el("div", "vprop");
      const del = el("button", "vprop-del", "删掉这张"); del.type = "button";
      del.onclick = () => {
        // ⚠️ 数组是整块提交的，所以这里真删一条，保存后站上就少一张卡
        state.siteDraft.home.valueProps.splice(i, 1);
        if (!state.siteDraft.home.valueProps.length) { alert("至少要留一张 —— 全删掉首页那一段会整块空掉。"); state.siteDraft.home.valueProps = state.siteBase.home.valueProps.slice(0, 1); }
        renderSite(true);
      };
      row.append(del);
      // Joe 2026-09-05：正文**移到标题正下方**，标题/正文不再左右分栏（同上，⛔ 不压 `.row2`）。
      siteField(row, `home.valueProps.${i}.title`, `第 ${i + 1} 张 · 标题`);
      siteField(row, `home.valueProps.${i}.body`, `第 ${i + 1} 张 · 正文`, null, { multiline: true, rows: 2 });
      v.append(row);
    });
    const add = el("button", "btn-secondary btn-mini", "+ 加一张"); add.type = "button";
    add.onclick = () => { state.siteDraft.home.valueProps.push({ title: "", body: "" }); renderSite(true); };
    v.append(add);
    form.append(v);

    // ══ 首页精选产品（Joe 2026-08-27）══
    //
    // 真源是 site-content.json 的 `homeV4.products.featured`，**数组顺序 = 首页展示顺序**。
    // 🔴 2026-09-05 从 `home.featuredSlugs` 迁过来：首页 v4 已合 main，**旧字段官网不读了**。
    //    旧字段仍留在文件里（本轮不清理），但后台一个字也不写它。
    // ⚠️ 只能选**已上架**的：选一个未上架的等于指向一个官网上不存在的页面，
    //    首页那张卡会渲染不出来 —— 而官网构建只打印警告、**不失败**，人不会知道
    //    （真源 index.astro:38 就是 `console.warn(... card skipped)`）。
    // ⚠️ 还有一个硬上限：首页只取前 6 张有效卡（index.astro:44）—— 见 renderFeatured 里那道提示。
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
    // 公司简介：左侧 3px 品牌绿粗线（它进 JSON-LD，与其它卡不同类，§6）；那段"为什么"收进 (?)
    const org = siteCard("公司简介", "进 JSON-LD 的 Organization · AI 与搜索引擎读「AirSonde 是什么」读的就是这一条 · 不受 160 字限制");
    org.classList.add("card-org");
    siteField(org, "seo.organisationDescription", "公司简介",
      "要有主语、要有公司名 —— 一句产品文案放进来，机器读到的是「一堆产品」而不是「一家做贴牌代工的厂」。", { multiline: true });
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

      // title 那条警告收进 (?)（C 批 §6）。⛔ 句子本身不许删 —— 它是真的（构建时数唯一 title 数）。
      siteField(box, `seo.pages.${key}.title`, "标题",
        "两页 title 相同会让官网构建直接失败（构建时数唯一 title 数）—— 后台会先拦住，改动上不了线。",
        { counter: lim.title });
      siteField(box, `seo.pages.${key}.description`, "描述", null,
        { multiline: true, counter: lim.description, inheritFrom: defDesc, ph: "留空 = 继承站点默认描述" });
      form.append(box);
    });
  }
  updateSiteDirty();
  // 两态皮在**每次重画后**统一恢复（增删卖点的 renderSite(true) 会造出新控件，默认是 enabled 的）——
  // 只在切态时设的话，重画一次就掉回混合态。数据到了，编辑才可点。
  $("#siteEdit").disabled = false; $("#siteEdit").title = "";
  setSiteEditing(state.siteEditing);
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
  const list = featList(state.siteDraft);
  if (!list) return;

  const card = siteCard("首页精选产品", `${list.length} 个 · 顺序就是首页的展示顺序 · 首页最多显示 6 张`);
  card.classList.add("card-featured");

  if (f && f.checked === false) {
    card.append(mkNotice("warn", `⚠️ 产品清单读不出来，**这一段没核过**：${f.why}。` +
      "下面只按 slug 显示，看不出哪些已经下架或不存在了。"));
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

  // ── 首页 v4 的**硬上限**：3 列 × 2 行 = 6 张（Joe 的首页 v4，2026-09-05 合 main）──
  //
  // 🔴 真源不是我数出来的，是官网源码写死的（`src/pages/index.astro:44`）：
  //      const rows = [featured.slice(0, 3), featured.slice(3, 6)].filter(r => r.length > 0);
  //    ⇒ **第 7 张起被官网直接丢掉**，不报错、不失败、页面照常渲染。
  // ⚠️ 而且 slice 是在**过滤掉未上架的之后**才做的 ⇒ 数的是**有效卡**，不是列表长度。
  //    ⛔ 拿 list.length 去判会在"列表里有坏条目"时给出错误的结论。
  // ⚠️ 这里替换掉了原来那条「不是 4 的倍数」——首页 v4 是 3 列不是 4 列，
  //    那句话现在是**假的**。⛔ 一个说假话的提示比没有提示更糟：人会照它去凑数量。
  const okList = list.filter((x) => {
    const s = typeof x === "string" ? x : x?.slug;
    const st = byStatus.get(s);
    return st && st.ok;
  });
  if (okList.length > 6) {
    const dropped = okList.slice(6).map((x) => (typeof x === "string" ? x : x?.slug));
    card.append(mkNotice("bad",
      `**首页最多只显示 6 张。** 现在有 ${okList.length} 张能上首页的，` +
      `**排在第 7 位之后的 ${dropped.length} 张会被官网直接丢掉** —— 不报错、页面照常渲染，` +
      "所以从站上看不出它们没上去。⇒ 要么删掉几张，要么把想上的拖到前 6 位。"));
  } else if (okList.length && okList.length !== 3 && okList.length !== 6) {
    card.append(mkNotice("warn",
      `现在有 **${okList.length} 张**能上首页的。首页是 **3 列**，` +
      `**最后一行会缺 ${(3 - (okList.length % 3)) % 3} 个位置**。不影响保存，也不会让构建失败，只是看起来会缺一角。`));
  }
  // ⭐ 卡片网格，**4 列**（Joe 2026-08-27）。
  //    🔴 4 不是随便挑的：官网首页就是 4 列 ⇒ **后台看到的排列 == 首页看到的排列**，
  //       排序时不用在脑子里做一次转换。这才是这一块改成可视化的价值。
  //    ⛔ 不显示 slug（Joe 前面刚让列表撤掉它，这里同理）。
  const ul = el("div", "featgrid");
  list.forEach((it, i) => {
    // ⚠️ 兼容读到裸字符串（迁移期间若哪份数据还是旧形状，⛔ 不能当场炸掉整页）——
    //    但**写回去的一律是新形状**，⛔ 不把旧形状再写回仓里。
    const slug = typeof it === "string" ? it : String(it?.slug ?? "");
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
    // ── 图区：照官网 `.pcard .ph`（白底 1:1，图 cover）──
    const ph = featPh(st, slug);
    // 🔴 后台专属件（序号 / 删除）浮在**图区**上，⛔ 不放进文字区 ——
    //    文字区是官网那三行（型号 / 一句话 / chips）的地盘，放进去就不"和官网一致"了。
    //    ⚠️ 而且上一单刚栽过：绝对定位的删钮压住了输入框，点一下不是放光标是删卡。
    //       ⇒ 这次它们落在图区（那里没有可点的内容），并且下面会实测重叠为 0。
    ph.append(el("span", "featno", String(i + 1)));
    const rm = el("button", "featdel", "×"); rm.type = "button";
    rm.title = "从首页精选里移除（不删产品）";
    rm.onclick = () => {
      setFeatList(state.siteDraft, list.filter((_, k) => k !== i));
      renderSite(true);
    };
    ph.append(rm);
    cardEl.append(ph);

    // ── 文字区：照官网 `.pcard .tx`（mint 底）→ 型号 / 一句话 / chips ──
    // ⚠️ **不显示产品长名**（Joe 点名）：官网那张卡上没有它。
    //    坏条目除外 —— 那时候名字/slug 是**唯一**能指认"这是谁"的东西。
    const tx = el("div", "feattx");
    tx.append(el("span", "featmodel", st?.model || (bad ? "—" : "（无型号）")));

    // ── 一句话 + chips：官网真读的两个字段，必须能在这里改 ──
    // ⚠️ 输入直接写回草稿对象、**不重画**：重画会让每敲一个字就丢一次焦点。
    if (typeof it === "string") list[i] = { slug, tagline: "", chips: [] };   // 顺手升形状，⛔ 旧形状不再写回仓
    const item = list[i];

    // 一句话用 `<input>`：只读皮（`#siteForm.ro input`）会把它洗成透明无边框的纯文字，
    // ⇒ **同一份 markup** 在查看态长得就是官网那行 h3，编辑态才是输入框。⛔ 不写两份。
    const tag = el("input", "feattagin");
    tag.value = String(item.tagline || "");
    tag.placeholder = "一句话说明（首页卡上那行）";
    tag.title = "首页那张卡上型号下面的一行字。留空的话卡上就少一行。";
    tag.oninput = () => { item.tagline = tag.value; updateSiteDirty(); };
    tx.append(tag);

    // chips 有**两种呈现**：查看态是官网那样的白底绿字药丸，编辑态是一个用「、」分隔的输入框。
    // 🔴 它们不是两个真源：药丸每次渲染都从 `item.chips` 现算，而且
    //    **两者由 CSS 互斥（`#siteForm.ro` 显示药丸、非只读显示输入框），永不同时可见**。
    //    ⚠️ 编辑期间药丸会变陈 —— 但它那时是隐藏的，而回到查看态必经 renderSite()／loadSite()
    //       （取消、保存、切视图三条路都会重画）⇒ 露面之前一定已经重算过。
    const pills = el("div", "featchips");
    (Array.isArray(item.chips) ? item.chips : []).forEach((c) => pills.append(el("span", null, c)));
    tx.append(pills);

    const chips = el("input", "featchipsin");
    chips.value = (Array.isArray(item.chips) ? item.chips : []).join("、");
    chips.placeholder = "标签，用「、」隔开（CO₂、PM2.5）";
    // ⚠️ 这里对人说的是"用、隔开"，而**存进去的是数组** ——
    //    ⛔ 别让人以为存的是一串文字：他要是在某个标签里写了顿号，那一个会被切成两个。
    //    这是个真实存在的限制，写在 title 里，⛔ 不假装它不存在。
    chips.title = "存进去的是一组标签（数组），这里只是用「、」来分隔。⚠️ 标签自身不能含「、」——含了会被切成两个。";
    chips.oninput = () => {
      item.chips = chips.value.split(/[、,]/).map((s) => s.trim()).filter(Boolean);
      updateSiteDirty();
    };
    tx.append(chips);

    if (bad) {
      // 🔴 分得清是哪一种：「不存在」与「已下架」的修法完全不同
      // ⚠️ `st?.` 不是防御性写法凑数：`bad` 在 `st` 为 undefined 时也为 true，
      //    写成 `st.exists` 会当场抛错。
      const btag = el("span", "featbad", st?.exists ? `已下架` : "产品不存在");
      btag.title = st?.exists
        ? "它现在没有官网页面 —— 首页那张卡会渲染不出来（官网构建只打印警告、不失败，所以站上只是安静地少一张）。"
        : "真源里找不到这个产品 —— 多半是被删了或改过 slug。";
      tx.append(btag);
      tx.append(el("div", "featslug", slug));   // ⚠️ 坏卡才显示 slug：这时它是**唯一**能指认是谁的东西
    }
    cardEl.append(tx);

    // 拖拽换序 —— 与图片列表同一套
    cardEl.addEventListener("dragstart", (e) => {
      // 🔴 卡片是 draggable 的，而它现在**装着输入框**：在框里按住拖选文字，浏览器会
      //    把它当成"开始拖这张卡" ⇒ 选不中字，还会莫名换序。⛔ 不能只靠"别那么操作"。
      if (e.target.closest("input, textarea")) { e.preventDefault(); return; }
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
  // ⚠️ 条目现在是对象 ⇒ 判"在不在列表里"要比 slug，⛔ 不能再 `list.includes(p.slug)`
  //    （那个在新形状下**永远为假** ⇒ 已经在精选里的产品会重新出现在"可加"里，
  //      加进去就是同一个产品在首页出现两次，而校验器要到保存那一刻才拦得住）。
  const inList = new Set(list.map((x) => (typeof x === "string" ? x : x?.slug)));
  const pool = (f?.["选得到的"] || []).filter((p) => !inList.has(p.slug));
  // ── 「加一个产品」：一行 6 个的挑选清单（Joe 2026-09-05 改）──
  //
  // ⚠️ 原来是原生 `<select>`，只显示得了纯文本，而最长那条产品名是：
  //    `AK34 · AK34-18 in 1 Air Quality Monitor Indoor,15D & 24H History, 7" TFT CO2 …`
  //    —— 一行拉得比屏幕还宽。⇒ 改成图 + 型号 + 名字。
  //
  // 🔴 复用两样东西，⛔ 都不另起炉灶：
  //    ① 图区走 `featPh()` —— 与精选卡**同一处代码**
  //       （⚠️ 原来这里写的是"渲染走 featVisual()"，那个函数 2026-09-05 已拆掉：
  //         文字区两边有意不同了，理由写在 featPh 头部。⛔ 不留指着已删函数的注释。）
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
      b.append(featPh(st, p.slug));             // 🔴 图区与精选卡同一处渲染
      // 选择器的文字区：型号 + 产品名（见 featPh 头部说明，⛔ 与精选卡有意不同）
      const bx = el("div", "featpicktx");
      bx.append(el("div", "featmodel", st?.model || "（无型号）"));
      bx.append(el("div", "featpickname", st?.name || p.slug));
      b.append(bx);
      b.title = `加入首页精选：${st?.name || p.slug}`;
      b.onclick = () => {
        // 新形状：加进来的是一个对象。tagline/chips 先留空，卡片上就能直接填。
        setFeatList(state.siteDraft, [...list, { slug: p.slug, tagline: "", chips: [] }]);
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
 * 卡片的**图区** —— 精选卡与「加一个产品」选择器共用这一处（照官网 `.pcard .ph`：白底 1:1，cover）。
 *
 * 🔴 共用的只剩图区，**文字区两边有意不同**（2026-09-05 Joe 定）：
 *    · 精选卡 = 官网卡的内容：型号 / 一句话 / chips，**没有产品长名**（官网卡上就没有）。
 *    · 选择器 = 选东西用的：型号 + **产品名**（截断）——
 *      在这里名字不是装饰，是"这两个型号相近的到底哪个是我要的"唯一的分辨依据。
 * ⇒ 强行让两边共用一个文字区，就得让其中一边显示它不该显示的东西。⛔ 不做那种"统一"。
 */
function featPh(st, slug) {
  const ph = el("div", "featph");
  setThumb(ph, st?.image ? rawUrl(st.image) : null, st?.name || slug);
  return ph;
}

// ═══════════════ 证书（About 页四张认证卡）═══════════════
//
// 🔴 与二维码那个槽**同一套机制**（选文件 → 校验 → 一个 commit），但两处不同，⛔ 别照抄：
//    ① 证书**不转 WebP**：PDF 转成图就不是那份文件了，而扫描件 PDF 才是客户要的东西。
//       ⇒ 原样上传，服务端按文件头认 PDF/PNG/JPG/WebP。
//    ② 证书**可以删**（二维码没有"删掉"这回事：删了官网构建会缺一个 import）。
// ⚠️ 上限 10MB 且**不压缩** ⇒ 传大文件会慢，界面必须在传的时候说话，⛔ 不给一个静止的按钮。
async function loadCerts() {
  $("#certSub").textContent = "读取中…";
  $("#certNotes").innerHTML = ""; $("#certList").innerHTML = "";
  try {
    const { status, body } = await api("/api/certificates");
    if (status >= 400 || !body?.slots) {
      $("#certNotes").append(mkNotice("bad", `读不到证书：${body?.detail || body?.error || status}`));
      $("#certSub").textContent = "";
      return;
    }
    state.certs = body;
    renderCerts();
  } catch (e) {
    $("#certNotes").innerHTML = "";
    $("#certNotes").append(mkNotice("bad", "读取失败：" + e.message));
  }
}

function renderCerts() {
  const b = state.certs; if (!b) return;
  const have = b.slots.filter((s) => s.url && !s.fileMissing).length;
  $("#certSub").textContent = `${have} / ${b.slots.length} 个槽有文件 · 没传的那张卡在官网上不显示「View certificate」`;
  const notes = $("#certNotes"); notes.innerHTML = "";
  if (!state.write?.enabled) notes.append(mkNotice("warn", "当前**不能写入**（写入闸或 token 未就绪）—— 传和删都不会生效。"));
  if (b.treeOk === false) {
    notes.append(mkNotice("warn", "仓内文件清单这次没读全 ⇒ **下面的「文件不见了」判断这次不可信**（只按登记的路径显示）。"));
  }

  const list = $("#certList"); list.innerHTML = "";
  b.slots.forEach((s) => list.append(certCard(s, b)));
}

function certCard(s, meta) {
  const card = el("section", "card certcard");
  const h = el("h3", null, s.label);
  h.append(el("span", "h3sub", " " + s.what));
  card.append(h);

  const row = el("div", "certrow");
  const state0 = el("div", "certstate");
  // 🔴 三种状态各有各的样子，⛔ 不许混：没传 / 有文件 / **登记了但文件不在**（那是故障）
  if (s.fileMissing) {
    state0.append(appendMd(el("div", "certbad"),
      `**登记的文件不在仓里**（${s.url}）—— 官网上那个「View certificate」点开会是 404。重新传一份，或者删掉这个槽。`));
  } else if (s.url) {
    const a = el("a", "lnk mono-link", s.url);
    a.href = `https://airsonde.com${s.url}`; a.target = "_blank"; a.rel = "noopener";
    a.title = "在官网上打开这份证书（要等这次改动构建完才生效）";
    state0.append(a);
    state0.append(el("div", "hint0", s.size ? `${(s.size / 1024).toFixed(0)} KB` : ""));
  } else {
    state0.append(el("div", "hint0", "还没传 —— 官网那张卡不显示「View certificate」链接。"));
  }
  row.append(state0);

  const acts = el("div", "certacts");
  const pick = el("label", "btn-secondary btn-mini");
  const fi = el("input"); fi.type = "file";
  fi.accept = ".pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/*"; fi.hidden = true;
  pick.append(fi, document.createTextNode(s.url ? "换一份…" : "选文件…"));
  acts.append(pick);
  const del = el("button", "linkish danger", "删除"); del.type = "button";
  del.hidden = !s.url;
  acts.append(del);
  row.append(acts);
  card.append(row);
  const res = el("div", "certres"); card.append(res);

  const busy = (on, what) => {
    pick.classList.toggle("is-busy", on);
    fi.disabled = on || !state.write?.enabled;
    del.disabled = on || !state.write?.enabled;
    if (on) res.textContent = what;
  };
  busy(false);

  fi.onchange = async () => {
    const f = fi.files && fi.files[0]; fi.value = "";
    res.innerHTML = "";
    if (!f) return;
    if (f.size > meta.maxBytes) {
      res.append(mkNotice("bad", `这个文件 ${(f.size / 1024 / 1024).toFixed(2)}MB，超过 ${meta.maxBytes / 1024 / 1024}MB 上限。**没有上传任何东西。**`));
      return;
    }
    // ⚠️ 逐字说清要做什么再问 —— ⛔ 不写"确认上传？"。这一下会产生真 commit 并触发官网重建。
    const verb = s.url ? `把 ${s.label} 证书换成「${f.name}」（旧的那份会在同一次提交里删掉）` : `把「${f.name}」作为 ${s.label} 证书传上去`;
    if (!confirm(`${verb}？\n\n会产生一次 commit 并触发官网重建，约 1 分钟后站上可见。`)) return;
    busy(true, "上传中…（大文件会慢一点，别关页面）");
    try {
      // 🔴 ⛔ 不转 WebP、⛔ 不压缩：证书就是那份文件本身。原样读成 base64。
      const base64 = await blobToBase64(f);
      const { status, body } = await api("/api/certificates/" + s.key, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ base64 }),
      });
      await afterCertWrite(res, status, body, "上传");
    } catch (e) { res.innerHTML = ""; res.append(mkNotice("bad", "上传失败：" + e.message)); }
    busy(false);
  };

  del.onclick = async () => {
    // ⚠️ 删除要说清**删的是哪一个文件**，⛔ 不是一句"确定删除？"
    if (!confirm(`删除 ${s.label} 证书？\n\n会从官网仓里删掉 ${s.url}，并且 About 页上 ${s.label} 那张卡不再显示「View certificate」链接。\n\n会产生一次 commit 并触发官网重建。`)) return;
    busy(true, "删除中…");
    try {
      const { status, body } = await api("/api/certificates/" + s.key, { method: "DELETE" });
      await afterCertWrite(res, status, body, "删除");
    } catch (e) { res.innerHTML = ""; res.append(mkNotice("bad", "删除失败：" + e.message)); }
    busy(false);
  };

  return card;
}

/** 写之后统一收尾：成功就重读（⛔ 不自己在前端猜新状态），失败要说清"什么都没写"。 */
async function afterCertWrite(res, status, body, what) {
  res.innerHTML = "";
  if (body?.wrote === true) {
    res.append(mkNotice("ok", body.note || "已提交。"));
    // 🔴 重读而不是本地改一改：仓里到底成了什么样，只有服务端知道。
    await loadCerts();
    return;
  }
  if (body?.validation && !body.validation.ok) {
    res.append(mkNotice("bad", `${what}未生效，**没有产生任何 commit**：\n` +
      body.validation.errors.map((e) => `· ${e.field}：${e.message}`).join("\n")));
    return;
  }
  res.append(mkNotice("bad", `${what}未生效（${status}）：${body?.detail || body?.error || "没拿到原因"}`));
}

/** 换序。⚠️ 单独一个函数，是为了拖拽之外也调得到（自检、将来的键盘操作）。 */
function moveFeatured(from, to) {
  const list = featList(state.siteDraft);
  if (!list || from === to || from == null || to == null) return;
  const next = list.slice();
  const [m] = next.splice(from, 1);
  next.splice(to, 0, m);
  setFeatList(state.siteDraft, next);
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
  const keys = SITE_SECTIONS[state.siteSection]?.keys;
  if (!state.siteDraft || !state.siteBase || !keys) return out;
  // ⚠️ 逐个键走 —— 「首页」现在管 home + homeV4 两个顶层节。
  //    漏掉一个的后果不是报错，是**保存按钮不亮**：他改了产品位，界面说"没有改动"。
  for (const k of keys) walk(state.siteBase[k], state.siteDraft[k], k);
  return out;
}

// C 批两态：编辑进入 / 取消回只读（取消 = 丢弃草稿重画，renderSite 默认从服务端那份重拷）
$("#siteEdit").onclick = () => setSiteEditing(true);
$("#siteCancel").onclick = () => { state.siteEditing = false; renderSite(); };
$("#siteSave").onclick = async () => {
  const sec = state.siteSection;
  const keys = SITE_SECTIONS[sec].keys;
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
      // 🔴 "自己这一节"现在可能是**多个顶层键**（首页 = home + homeV4）。
      //    ⛔ 别再写成 `{ [sec]: … }` —— 那个形状把"节名"和"键名"当成了同一个东西，
      //    而它们从 2026-09-05 起就不是了；漏掉的那个键会被**静默丢弃**（服务端合并时
      //    "没收到" = "不动"），于是保存成功、首页产品位纹丝不动。
      //
      // ⚠️ `homeV4` 是**两个窗共有的块**：后台只拥有 `products.featured`，hero/marquee/factory…
      //    都是官网仓那边维护的，而这里是**整块回传**。撑住它的是乐观锁（`expectedSha` 是
      //    整个文件的 blob sha）⇒ 别人在我读到之后改过这个文件，这次保存会 **409**，
      //    ⛔ 不会把他们的改动覆盖掉。
      //    ⛔ 不要为此把 patch 收窄成 `{homeV4:{products:{featured}}}`：锁是**文件级**的，
      //    收窄一个字也不会减少冲突，只会多出一套"这一节拥有哪些路径"的机器。
      body: JSON.stringify({
        patch: Object.fromEntries(keys.filter((k) => state.siteDraft[k] !== undefined).map((k) => [k, state.siteDraft[k]])),
        expectedSha: state.site.sha, section: sec,
      }),
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
  // crm-skin A 批（SPEC §9，Joe：「设置页看起来有点懵」）：三张卡只答三问 ——
  //   我是谁（账号）· 能不能存、存到哪、多久上线（保存与上线）· 出事报哪个版本（版本）。
  // ⛔ 删掉（不是藏）：四格摘要条、契约卡（机型/传感器数分类页已有）、写入闸/token 两行（收进「可以保存」的 (?)）、
  //    发布目标卡（并进「存到哪」）、平台版本 ID / 接入节点（收进版本行的 (?)）。
  // ⚠️ 每一项仍取自同一份 state.who（/api/_whoami），**不另开数据源**。
  const w = state.who;
  const box = $("#settingsBody"); box.innerHTML = "";
  if (!w) { box.append(mkNotice("bad", "拿不到 /api/_whoami —— 这一页的每一项都来自它，因此什么都不显示，而不是显示一堆空格子。")); return; }

  const card = (title, sub) => {
    const s = el("section", "card card-narrow");
    const h = el("h3", null, title);
    if (sub) h.append(el("span", "h3sub", " " + sub));
    s.append(h);
    return s;
  };
  // 一行：键 · 值 · （右端动作）。照 mockup 的 .krow/.k/.v/.lnk。
  const row = (parent, k, ...nodes) => {
    const r = el("div", "krow");
    r.append(el("span", "k", k));
    const v = el("span", "v");
    nodes.forEach((n) => { if (n != null) v.append(typeof n === "string" ? document.createTextNode(n) : n); });
    r.append(v);
    parent.append(r);
    return r;
  };
  // (?)：「为什么」收进 title 悬浮，零 JS（SPEC §4/§6 的说明规则）
  const q = (title) => { const s = el("span", "q2", "?"); s.title = title; return s; };
  const link = (text, href, opts = {}) => {
    const a = el("a", "lnk", text);
    if (href) { a.href = href; a.target = "_blank"; a.rel = "noopener"; }
    if (opts.right) a.classList.add("lnk-right");
    return a;
  };
  const pill = (kind, text) => el("span", `pill pill-${kind}`, text);

  // ── ① 账号：我是谁 · 怎么退出 · 怎么加同事 ──
  {
    const c = card("账号");
    // 登出（Joe 点名的能力，从左栏搬来）。
    // ⚠️ `/cdn-cgi/access/logout` 是 Cloudflare 边缘的端点，不经过这个 worker ⇒ 本地开发（旁路模式、没有 Access）
    //    点它只会 404 —— 所以本地**禁用并说明为什么**，而不是"显示但点了没反应"。
    const out = el("a", "lnk lnk-right", "退出登录");
    if (w.request.isLocalDev) {
      out.setAttribute("aria-disabled", "true"); out.classList.add("is-disabled");
      out.title = "本地开发是旁路模式，前面没有 Access 门，也就没有会话可以登出";
    } else {
      out.href = "/cdn-cgi/access/logout";
      out.title = `以 ${w.operator} 登入中 · 登出后回到 Cloudflare Access 登录页`;
    }
    row(c, "当前账号", el("b", null, w.operator || "(无身份)"), out);
    const a = w.access || {};
    row(c, "加同事", "在 Cloudflare Access 里加邮箱，立刻生效",
      q(a.writeImplication || "能进后台 = 能改官网产品数据；没有第二份名单要同步"),
      link("去加人 ↗", "https://one.dash.cloudflare.com/", { right: true }));
    box.append(c);
  }

  // ── ② 保存与上线：现在能不能存 · 存到哪 · 多久上线 ──
  {
    const c = card("保存与上线");
    const d = w.data;
    const missing = [];
    if (!d.writeGateOpen) missing.push("写入闸未开");
    if (!d.ghTokenConfigured) missing.push("GitHub token 未配置");
    const now = d.writeEnabled ? pill("ok", "可以保存") : pill("bad", `不能保存 · 缺 ${missing.join("、") || "未知原因"}`);
    row(c, "现在", now, q("两个条件缺一不可：写入闸（ALLOW_GITHUB_WRITE）开着 + GitHub token 在。任一缺失这里会变成红色并写明缺哪个。" +
      (w.request.isLocalDev ? " ⚠️ 本机另有一道闸：永远写不到官网数据仓（硬编码黑名单），所以本地的「可以保存」不代表能改官网。" : "")));
    // 分支/目录收进 (?)（Joe：那行太长）
    row(c, "存到哪", "官网仓 ", el("code", null, d.repo || "—"), " · 每次保存 = 一次 commit",
      q(`分支 ${d.branch || "?"} · 产品目录 ${d.productsDir || "?"}`));
    row(c, "多久上线", "约 1 分钟", q("保存成功 ≠ 站上已经变了，中间隔着一次官网构建（Cloudflare Pages）。"),
      link("看官网 ↗", "https://airsonde.com/", { right: true }));
    box.append(c);
  }

  // ── ③ 版本：出问题时把这一行发给开发 ──
  {
    const c = card("版本", "出问题时把这一行发给开发");
    const g = w.git, dep = w.deploy;
    const who = g.deploySource || (w.request.isLocalDev ? "本地 dev" : "未知");
    // 构建时间显示成人读的本地时间（mockup：`2026-9-3 13:15`）；解析不了就原样放，⛔ 不猜。
    // 🔴 纯数字串先 Number()：生产的 BUILD_TIME 是 **epoch 毫秒**（"1788446135099"），
    //    `new Date("1788446135099")` 是 Invalid ⇒ 上一版的"原样放"兜底把 epoch 裸露上了生产（Joe 抓的）。
    //    dev 的 BUILD_TIME 恰好是 ISO 串 ⇒ dev 验证没盖住生产的数据形态 —— 又一课。
    const fmtTime = (v) => { const d = new Date(/^[0-9]+$/.test(String(v)) ? Number(v) : v); return isNaN(d) ? String(v || "—") : `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
    const line = `${g.shortSha || "无 sha"} · ${g.buildTime ? fmtTime(g.buildTime) : "—"} · ${who}`;
    const v = el("span", "mono", line);
    const btn = el("button", "linkish lnk-right"); btn.type = "button"; btn.textContent = "复制";
    btn.onclick = async () => {
      try { await navigator.clipboard.writeText(line); btn.textContent = "已复制"; setTimeout(() => { btn.textContent = "复制"; }, 1500); }
      catch { btn.textContent = "复制失败，请手动选中"; }
    };
    // 平台版本 ID / 接入节点 / 脏工作区标记全部收进 (?)（SPEC §9）。
    // 🔴 脏工作区的**警告**仍在顶部横幅里（loadWho 已做，那条不动）—— 这里只在 (?) 里提一句，⛔ 不再第二次、第三次重复它。
    row(c, "后台版本", v,
      q(`平台版本 ID ${dep.versionId || "（无此绑定）"} · 接入节点 ${w.request.host || "?"} · ${w.request.colo || "-"}` +
        (g.dirty ? " · ⚠️ 部署时工作区是脏的（GIT_SHA 不足以还原这次部署的字节）" : "") +
        (g.sha ? "" : " · ⚠️ 没有 sha ⇒ 这次部署没经过 CI/npm run deploy，无法确认它对应哪个 commit")),
      btn);
    box.append(c);
  }
  // ⛔ 页底不再重复 w.warnings：横幅已经在说同一句话（原来这一页把同一条警告说了三遍）。
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
  // 🔴 没有基线 sha 就**不发这次请求**（审计②）：
  //    原来这里是 `expectedSha: state.cats?.sha`，取不到时 `JSON.stringify` 把这个键
  //    整个省掉 ⇒ 服务端收到"没带锁" ⇒ 静默覆盖别人的改动，而两边都显示保存成功。
  //    ⚠️ 只把 `?.` 去掉会变成抛 TypeError —— 那是**换了一种坏法**，不是修好。
  //    ⇒ 在这里显式拦住并说清怎么办。⛔ 这是第二道闸；服务端的 missingLock 是第一道。
  if (!state.cats?.sha) {
    out.append(mkNotice("bad", "**还没读到分类的基线版本，这次不提交。** "
      + "没有基线就写，会把别人在这期间的改动静默覆盖掉。请刷新一下这一页再试。"));
    return false;
  }
  out.append(mkNotice("warn", "提交中…（一次轴改动 = 官网仓的一个 commit）"));
  if (btn) { btn.disabled = true; btn.textContent = "提交中…"; }
  try {
    const { body } = await api("/api/taxonomy", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      // 🔴 原来是 `state.cats?.sha` —— `state.cats` 还没加载完时是 `undefined`，
      //    而 `JSON.stringify` 会把 undefined 的键**整个省掉** ⇒ 服务端收到"没带 sha"，
      //    在补 missingLock 之前那意味着**静默覆盖别人的改动，两边都显示保存成功**。
      // ⇒ 取不到就**不发这次请求**，⛔ 不发一个"没带锁"的写请求。
      //    ⚠️ 这是**第二道**闸；服务端那道（missingLock）才是第一道，⛔ 它不依赖这里修好。
      body: JSON.stringify({ ...payload, expectedSha: state.cats.sha }),
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
    // 🔴🔴 暂存**只在这里清**，而且是**显式的一行**。
    //    ⛔ 绝不放进 finally：finally 在失败路径上也会跑 ⇒ 一次 409 就把他刚改的东西全抹掉，
    //       而屏幕上只显示"提交失败" —— 他会以为重试一下就行，其实活已经没了。
    //    ⚠️ 位置也重要：必须在**确认 wrote === true 之后**，⛔ 不在请求发出时清。
    state.axisPending = { categories: [], sensors: [] };
    state.axisManage = { categories: false, sensors: false };   // 保存完退出编辑态
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

/* ══════════ 分类页暂存区（第 4 条）══════════ */

/** 这一轴有几处未保存。⚠️ 判据是**改了几样东西**，⛔ 不是"点了几下"—— 见 pushPending 的合并。 */
function pendingCount(axis) { return (state.axisPending[axis] || []).length; }
function pendingTotal() { return pendingCount("categories") + pendingCount("sensors"); }

/**
 * 往暂存区加一处改动，**并合并同一条上的重复操作**。
 *
 * 🔴 合并不是优化，是**让「有 N 处未保存」这句话为真**：
 *    同一个取值改名三次仍然只是"一处改动"，不合并的话屏幕会说"3 处"，
 *    而提交上去也确实是 3 条 op —— 数字与事实都错，且没有任何症状。
 * 🔴 "本批新增的又删掉" ⇒ **两条一起撤**，⛔ 不是追加一条 delete：
 *    追加的话保存时会是 add+delete 一对，服务端算出来内容没变、回一句"无需写入"，
 *    而他明明改过别的东西 —— 那条消息会让他以为整批都没保存。
 */
function pushPending(axis, op) {
  const list = state.axisPending[axis] || (state.axisPending[axis] = []);
  if (op.op === "edit") {
    const added = list.find((x) => x.op === "add" && x.value === op.value);
    if (added) { added.label = op.label; return; }            // 本批新增的：直接改那条 add
    const i = list.findIndex((x) => x.op === "edit" && x.value === op.value);
    if (i >= 0) list[i] = op; else list.push(op);
  } else if (op.op === "delete") {
    if (list.some((x) => x.op === "add" && x.value === op.value)) {
      state.axisPending[axis] = list.filter((x) => x.value !== op.value);   // 新增又删 ⇒ 撤干净
      return;
    }
    state.axisPending[axis] = list.filter((x) => !(x.op === "edit" && x.value === op.value));
    state.axisPending[axis].push(op);
  } else {
    list.push(op);
  }
}

/**
 * 暂存里**指不到任何一行**的改动。
 *
 * 🔴 这不是理论情形：`loadCats()` 刷新之后列表会变（别人删了一条 / 换了机器上的数据），
 *    而暂存是内存里的。那时这条 op 仍算在「N 处未保存」里、仍会被一起提交，
 *    **却在屏幕上一个字都看不见** —— 正是第 4 条要消灭的那件事本身。
 * ⚠️ 实测发现的路径：拿一个大小写不对的取值（`Radiation` vs 真值 `radiation`）
 *    进暂存 ⇒ 计数说 3 处，屏幕上只画得出 2 处。⛔ 不许静默。
 */
function pendingOrphans(axis, items) {
  const have = new Set(items.map((x) => x.value));
  return (state.axisPending[axis] || []).filter((o) => o.op !== "add" && !have.has(o.value));
}

/** 撤销某一条上的全部暂存改动（那一行的「撤销」）。 */
function dropPending(axis, value) {
  state.axisPending[axis] = (state.axisPending[axis] || []).filter((x) => x.value !== value);
}

/**
 * 把暂存改动折到服务端给的那一份上，**得到他即将保存的样子**。
 *
 * 🔴 这一函数是第 4 条的核心：不画出来的话，「保存」保存的是**他看不见的东西** ——
 *    那比原来那句假话更坏。⛔ 不许"暂存归暂存、表格照旧渲染"。
 * ⚠️ 与服务端 applyOps 折的是同一批 op、同一个顺序；⛔ 但这里**不做判定**
 *    （能不能删由服务端在写入那一刻数引用说了算），这里只负责**显示**。
 */
function axisView(axis, items) {
  const rows = items.map((it) => ({ ...it, _kind: null, _oldLabel: null }));
  (state.axisPending[axis] || []).forEach((o) => {
    if (o.op === "add") {
      rows.push({ value: o.value, label: o.label, refCount: 0, refs: [], canDelete: true, onSite: false,
        _kind: "added", _oldLabel: null });
      return;
    }
    const r = rows.find((x) => x.value === o.value);
    if (!r) return;
    if (o.op === "edit") {
      if (r._oldLabel === null) r._oldLabel = r.label;
      r.label = o.label;
      if (r._kind !== "added") r._kind = "renamed";
    } else if (o.op === "delete") {
      r._kind = "deleted";
    }
  });
  return rows;
}

function renderCats() {
  const c = state.cats; if (!c) return;
  const sum = $("#catsSummary"); sum.innerHTML = "";

  // 🔴 有产品读不出来 ⇒ 引用计数**不完整**，此时"0 个在用"不是"没人用"，是"我没看全"。
  //    这一行必须在最前面，因为它决定了下面每一个「删除」是不是可信的。
  if (c.unreadable) sum.append(mkNotice("bad", `🔴 ${c.unreadableNote}`));

  // 🔴 暂存里指不到行的改动**必须吼出来**：它算在「N 处未保存」里、会被一起提交，
  //    但在表格上画不出来 ⇒ 不说的话，「保存」保存的就是他看不见的东西。
  const orph = [...pendingOrphans("categories", c.categories), ...pendingOrphans("sensors", c.sensors)];
  if (orph.length) {
    const n = el("div", "notice notice-bad");
    appendMd(n.appendChild(el("div")),
      `🔴 有 **${orph.length}** 处未保存的改动**在下面的表里找不到对应的行** —— 多半是这份列表在你编辑期间被刷新过。`);
    const ul = el("ul", "dangling-list");
    orph.forEach((o) => ul.append(el("li", null,
      `${o.op === "delete" ? "删除" : "改名"} ${o.axis === "categories" ? "机型" : "传感器"} ${o.value}`)));
    n.append(ul);
    appendMd(n.appendChild(el("div")),
      "⛔ 它们仍会被一起提交，而服务端多半会拒。**建议先撤销它们** —— 各自那一行已经不在了，用「全部放弃」重来最稳。");
    sum.append(n);
  }

  // ⭐ 对账：每个产品的 category 都必须落在轴里。落不进去的产品在下表上**根本不出现**。
  const known = new Set(c.categories.map((x) => x.value));
  const good = state.list.filter((p) => !p.error);
  const strays = good.filter((p) => !known.has(p.category));
  // ── 页头副标由真值算（§5）：「机型 6 · 传感器 19 · 26 个产品全部落在 6 个机型里」；对账不成立时红字写差几个。
  //    ⛔ 原来那条绿色横幅撤了 —— 结论压进副标；只有**坏消息**（散值 / 读不出来）才以红字通知出现。
  const total = c.productCount ?? good.length;
  const partial = c.unreadable > 0;
  const sub = $("#catsSub");
  sub.classList.toggle("is-bad", !!(strays.length || partial));
  if (strays.length) {
    sub.textContent = `机型 ${c.categories.length} · 传感器 ${c.sensors.length} · 有 ${strays.length} 个产品的机型不在轴里`;
    sum.append(mkNotice("bad",
      `🔴 有 **${strays.length}** 个产品的机型不在这一轴里，下表统计不到它们：` +
      strays.map((p) => `${p.slug}(${p.category || "空"})`).join("、")));
  } else if (partial) {
    // 🔴 有产品读不出来时**不许说"全部落在"** —— 这句只覆盖读得出来的那些（2026-08-26 真出过：和 19、产品 23 仍写着对账成立）
    sub.textContent = `机型 ${c.categories.length} · 传感器 ${c.sensors.length} · 只对上了 ${good.length}/${total} 个产品，另 ${c.unreadable} 个读不出来`;
  } else {
    // ⭐ Joe 2026-09-04：一切正常时**这一格什么都不写**。
    // 🔴 只删这一个分支 —— 上面两个分支（散值 / 读不出来）是**红字警告**，
    //    他要删的是那句"全部落在"的好消息，⛔ 不是把这一格的警告能力一起删掉。
    //    删警告没有任何症状：屏幕会变干净，而问题还在。
    sub.textContent = "";
  }

  renderAxis("categories", $("#catsRows"), c.categories, good);
  // 传感器排两列（10 + 9），两卡等高（§5）—— 同一份 renderAxis 各画一半，⛔ 不写第二份渲染
  const half = Math.ceil(c.sensors.length / 2);
  renderAxis("sensors", $("#sensorsRowsA"), c.sensors.slice(0, half), good);
  renderAxis("sensors", $("#sensorsRowsB"), c.sensors.slice(half), good);
  syncManageBtns();
  // ⛔ 页底那四条常驻说明（取值不可改 / 删除只对没人用的开放 / 筛选栏只列已上架 / 归属另改）已撤（§6 说明规则）：
  //    「取值不可改」在改名行内本来就写着；「删除为什么灰」挂在 td 的 title 上；「不显示」那格自带"没有已上架产品"。
}

/** 两个轴共用一份渲染 —— 写成两份的话，改了一边忘了另一边不会有任何症状。 */
function renderAxis(axis, tb, items, good) {
  const isCat = axis === "categories";
  const canWrite = !!state.write?.enabled;
  // 🔴 **按轴**取管理态，不是一个全局开关：管机型时不该把传感器那栏也解锁。
  const manage = canWrite && !!state.axisManage[axis];
  tb.innerHTML = "";
  // 🔴 渲染的是**暂存折算之后**的样子，⛔ 不是服务端那一份 ——
  //    否则「保存」保存的是他看不见的东西（第 4 条的核心判据）。
  axisView(axis, items).forEach((it) => {
    const tr = el("tr");
    if (it._kind) tr.classList.add("pend-" + it._kind);

    const tdName = el("td");
    const nm = el("div", "pname", it.label || it.value);
    // ⚠️ 暂存态要**在这一行上说出来**，⛔ 不只在顶部写个总数 ——
    //    总数回答不了"我到底改了哪几条"，而那正是他按下保存前要确认的。
    if (it._kind === "renamed") { const t = el("span", "pendtag", "改名"); t.title = `原来叫「${it._oldLabel}」`; nm.append(t); }
    if (it._kind === "added") nm.append(el("span", "pendtag", "新增"));
    if (it._kind === "deleted") nm.append(el("span", "pendtag pendtag-del", "待删除"));
    // 只留一个名字（Joe 2026-09-03：「取值和显示名保持一致，用一个就行」）——
    // 行内**不再显示取值副行（含管理态）**；两者不同的存量（如 Wall-mounted/wall-mounted、App/APP）
    // 取值只在 title 里留一条可查（hover），⛔ 不占一行。
    if (it.label && it.label !== it.value) { nm.title = `取值 ${it.value}（写进产品 JSON 与官网 URL 的是它）`; }
    tdName.append(nm);
    tr.append(tdName);

    // 在用数取服务端的 refCount（此刻仓里的真相），不是前端 state.list 的再数一遍。
    const tdN = el("td", "col-st ac");
    if (it.refCount && isCat) {
      // 机型有筛选栏，点得过去。
      const b = el("button", "linkish n", String(it.refCount)); b.type = "button";
      b.title = it.refs.join("、");
      b.onclick = () => { showNav("products"); state.catSel = it.value; state.statusSeg = null; renderList(); };
      tdN.append(b);
    } else if (it.refCount) {
      // ⚠️ 传感器**没有**列表筛选。做成按钮的话点了什么也不会发生 ——
      //    一个骗人的按钮比一个纯数字糟。列表在 title 里，够用。
      const s = el("b", "n", String(it.refCount)); s.title = it.refs.join("、");
      tdN.append(s);
    } else tdN.append(el("span", "hint0", "0"));   // 0 在用照常显示灰 0（§5）
    tr.append(tdN);

    if (isCat) {
      // 🔴 判据取自官网自己的规则（lib/products.ts 的 categoriesOf 只收有已上架产品的机型），
      //    而且**由服务端在数引用的同一次扫描里算出来**（`it.onSite`）。
      //    ⛔ 不在这里拿 state.list 再数一遍：那样这一行上的两个数字会来自两次不同的读取，
      //       "在用 0"与"筛选栏显示"就可能同时出现，而看的人无从知道为什么。
      const tdOn = el("td", "col-cat");
      if (it.onSite) tdOn.append(el("span", "pill pill-ok", "显示"));
      else {
        // ⚠️ 原来这里跟着一句「没有已上架产品」，Joe 2026-09-04 要求删掉。
        //    理由说得通：「不显示」这一格本来就只有这一个成因，那句话是把同一件事说第二遍。
        //    ⇒ 但**成因不能丢**，挪进 title（hover 可查），⛔ 不是让它彻底消失。
        const p = el("span", "pill pill-gray", "不显示");
        p.title = "官网筛选栏只列有已上架产品的机型 —— 这一个还没有";
        tdOn.append(p);
      }
      tr.append(tdOn);
    }

    const tdAct = el("td", "col-act");
    // 🔴 只读态：**一个操作入口都不出**（不是禁用，是不存在）。
    //    Joe 定的。理由比"更整洁"硬：默认态原本摆着 28 个红色删除按钮，其中一半点了没反应。
    //    把破坏性入口从默认态拿掉，"看起来能点其实不能点"这个问题从源头就没有了。
    if (canWrite && manage) {
      // 🔴 三个动作**都只进暂存**，⛔ 一律不立即提交 —— 提交只发生在「保存」那一下。
      //    这就是「保存」两个字成为真话的全部代价，也是它的全部理由。
      if (it._kind) {
        // 已经改过的行：给一条退路。⚠️ 没有退路的暂存等于"手一抖就只能整批放弃"。
        const bUndo = el("button", "linkish", "撤销"); bUndo.type = "button";
        bUndo.title = "把这一行的未保存改动去掉";
        bUndo.onclick = () => { dropPending(axis, it.value); renderCats(); };
        tdAct.append(bUndo);
      }
      if (it._kind !== "deleted") {
        const bEdit = el("button", "linkish", "改名"); bEdit.type = "button";
        bEdit.onclick = () => startRename(tr, tdName, axis, it);
        tdAct.append(bEdit);

        const bDel = el("button", "linkish danger", "删除"); bDel.type = "button";
        // ⚠️ `canDelete` 是服务端**上一次扫描**的结论，这里只拿它做提示。
        //    🔴 真正的引用闸在写入那一刻由服务端再数一次 —— ⛔ 这里不复述那个判定。
        if (!it.canDelete && it._kind !== "added") {
          bDel.disabled = true;
          // 🔴 title 挂在 **td 上，不挂在按钮上**：`disabled` 的按钮在 Chrome 里
          //    不接收指针事件，挂在它自己身上的 title 很可能永远不出现 ——
          //    那就成了"我以为写了说明，屏幕上其实什么都没有"。
          tdAct.title = it.refCount
            ? `还有 ${it.refCount} 个产品在用：${it.refs.join("、")}`
            : "有产品读不出来，此刻数不准谁在用 —— 任何删除都先拒绝";
        } else {
          bDel.onclick = () => {
            // ⛔ 这里**不再 confirm**：它现在只是标记待删，保存前随时能撤销，
            //    而保存那一步本身就是他的确认动作。多一个弹窗只会让人闭眼点。
            pushPending(axis, { axis, op: "delete", value: it.value });
            renderCats();
          };
        }
        tdAct.append(bDel);
      }
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
  // 🔴 编辑态**独占整行**：名字格铺满，其余格让位。
  //    ⚠️ 传感器那两张子表一张只有 253px、名字格 99.5px —— 不让位的话
  //       输入框只剩 14px、按钮被压到 25px 宽而把文字竖排（Joe 截图那个样子）。
  //    ⛔ 不改回去用固定宽度：列宽随视口和内容变，写死的数字当场就错。
  // ⚠️ 用 `hidden` 而不是 `style.display`：这一族在本文件里统一走 `hidden`，
  //    而且 `.ptable td` 没有设 display ⇒ `[hidden]` 不会被作者样式顶掉（已实测）。
  //    ⛔ 不需要恢复：取消/保存都走 renderCats() 整表重画。
  const others = [...tr.children].filter((td) => td !== tdName);
  const span = tr.children.length;
  others.forEach((td) => { td.hidden = true; });
  tdName.colSpan = span;
  tdName.innerHTML = "";
  const box = el("div", "axisedit");
  const inp = el("input"); inp.type = "text"; inp.value = it.label || it.value;
  const ok = el("button", "linkish", "保存"); ok.type = "button";
  const no = el("button", "linkish", "取消"); no.type = "button";
  box.append(inp, ok, no);
  tdName.append(box);
  // ⚠️ 「取值不可改」那行副行已撤（只留一个名字）；事实没变 —— 改名只动 label，value 由 taxonomyOp 层保证不动。
  inp.focus(); inp.select();

  const cancel = () => renderCats();
  no.onclick = cancel;
  inp.onkeydown = (e) => { if (e.key === "Escape") cancel(); if (e.key === "Enter") ok.click(); };
  ok.onclick = () => {
    const label = inp.value.trim();
    if (!label) { inp.focus(); return; }
    if (label === (it.label || "")) return cancel();
    // ⛔ 不再直接提交：进暂存，等「保存」一次性提交（第 4 条）。
    pushPending(axis, { axis, op: "edit", value: it.value, label });
    renderCats();
  };
}

/** 管理按钮与新增表单的显隐 —— **一个函数说了算**，两处各写一遍迟早对不上。 */
const ADD_FORM = { categories: "#addCategories", sensors: "#addSensors" };
function syncManageBtns() {
  const canWrite = !!state.write?.enabled;
  ["categories", "sensors"].forEach((axis) => {
    const on = canWrite && !!state.axisManage[axis];
    const n = pendingCount(axis);
    const b = document.querySelector(`.managebtn[data-axis="${axis}"]`);
    if (b) {
      // 扳手线条图标（⛔ 不用 emoji，附录 C.6）；path 抄 mockup 的 I.tool
      b.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>';
      // 🔴 「编辑 / 保存」（Joe 2026-09-04 定）。⚠️ 它现在是**真话**：
      //    编辑态里的改名/新增/删除只进暂存，点「保存」才一次性提交（一次保存 = 一个 commit）。
      //    ⛔ 原来这两个字是假的 —— 点「管理中」什么也不保存，而改动早就写进仓了。
      b.append(document.createTextNode(on ? (n ? ` 保存 ${n} 处` : " 保存") : " 编辑"));
      b.classList.toggle("on", on);
      b.classList.toggle("primary", on && n > 0);   // 有东西要存时它才是主按钮
      b.setAttribute("aria-pressed", String(on));   // 编辑态是个开关，语义上就是 pressed
      // 写入闸没开时禁用并说明原因 —— 让人点了没反应，正是这一批在修的病。
      b.disabled = !canWrite;
      if (!canWrite) b.title = "当前不能保存（写入闸或 token 未就绪），所以也不给编辑入口";
      else b.title = on ? (n ? `把这 ${n} 处改动一次性提交（一个 commit）` : "没有未保存的改动，点它退出编辑") : "进入编辑态才能改名 / 删除 / 新增";
    }
    // 「全部放弃」：⚠️ 只在**有东西可放弃**时出现，⛔ 不常驻占位。
    const d = document.querySelector(`.discardbtn[data-axis="${axis}"]`);
    if (d) {
      d.hidden = !(on && n > 0);
      d.textContent = `全部放弃（${n}）`;
    }
    // 新增表单跟着同一个开关走（三个动作一条规则，不留特例）。
    const f = $(ADD_FORM[axis]);
    if (f) { f.hidden = !on; if (!on) f.reset(); }
  });
}

/** 这一轴的暂存改动，逐条说成人话 —— 确认框和「放弃」都要拿它说清**放弃/提交的是什么**。 */
function pendingLines(axis) {
  const L = axis === "categories" ? "机型" : "传感器";
  return (state.axisPending[axis] || []).map((o) =>
    o.op === "add" ? `新增${L}「${o.label}」`
    : o.op === "delete" ? `删除${L}「${o.value}」`
    : `把${L}「${o.value}」改名为「${o.label}」`);
}

["categories", "sensors"].forEach((axis) => {
  const b = document.querySelector(`.managebtn[data-axis="${axis}"]`);
  if (b) b.onclick = async () => {
    if (!state.axisManage[axis]) {                 // 「编辑」：进编辑态
      state.axisManage[axis] = true;
      if (state.cats) renderCats(); else syncManageBtns();
      return;
    }
    // 「保存」
    const lines = pendingLines(axis);
    if (!lines.length) {                            // 没东西要存 ⇒ 直接退出，⛔ 不发空请求
      state.axisManage[axis] = false;
      if (state.cats) renderCats(); else syncManageBtns();
      return;
    }
    // ⚠️ 确认框里**逐条列出**要提交什么。⛔ 不写"确认保存 N 处改动？"——
    //    数字回答不了"我到底改了什么"，而这一下会产生真 commit。
    if (!confirm(`确认保存这 ${lines.length} 处改动？\n\n${lines.join("\n")}\n\n一次保存 = 一个 commit，会触发官网重建。`)) return;
    await taxonomyOp({ ops: state.axisPending[axis] }, b);
  };

  // 「全部放弃」——⚠️ 必须**说清放弃了什么**，⛔ 不是一句"确定放弃？"
  const d = document.querySelector(`.discardbtn[data-axis="${axis}"]`);
  if (d) d.onclick = () => {
    const lines = pendingLines(axis);
    if (!lines.length) return;
    if (!confirm(`放弃这 ${lines.length} 处未保存的改动？\n\n${lines.join("\n")}\n\n放弃之后它们就没了（仓里本来也没写进去）。`)) return;
    state.axisPending[axis] = [];
    renderCats();
  };
});

/** 两个轴的新增表单。⚠️ 绑一次，不在 renderCats 里重绑（那会叠出 N 个提交）。 */
["categories", "sensors"].forEach((axis) => {
  const form = document.getElementById(axis === "categories" ? "addCategories" : "addSensors");
  if (!form) return;
  form.onsubmit = async (e) => {
    e.preventDefault();
    // 单输入（Joe 2026-09-03：「取值和显示名保持一致，用一个就行」）—— 取值由名字**按轴的既有惯例**派生：
    //   机型 = slugify（存量 6/6 满足 value===slugify(label)，实测核过）
    //   传感器 = 名字原样（存量 19 个里 14 个保留大小写/点号：PM2.5、Data-History ——
    //            slugify 会分叉出第二套惯例；唯一历史例外 App→APP，存量不动）
    // ⚠️ 官网筛选栏 / 产品 JSON 里的 value 机制不变，只是后台不再让人填第二个框。
    const label = form.label.value.trim();
    if (!label) { form.label.focus(); return; }
    const value = axis === "categories" ? slugify(label) : label;
    if (!value) { form.label.focus(); return; }
    // ⛔ 不再直接提交：进暂存，等「保存」一次性提交（第 4 条）。
    if ((state.cats?.[axis] || []).some((x) => x.value === value)
        || (state.axisPending[axis] || []).some((x) => x.op === "add" && x.value === value)) {
      // ⚠️ 本地先挡一次重复：服务端仍会再判一次（它才是真源），
      //    但让人**在按保存之前**就知道，⛔ 不是攒到提交那一刻才告诉他。
      $("#catsResult").innerHTML = "";
      $("#catsResult").append(mkNotice("bad", `${axis === "categories" ? "机型" : "传感器"}里已经有「${value}」了。`));
      return;
    }
    pushPending(axis, { axis, op: "add", value, label });
    renderCats();
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
  $("#auditSummary").innerHTML = "";   // 顶部两条横幅撤（§8）；这一格只留给读取失败时用
  // 副标由真值算：「最近 60 条 · 本后台 60 · 别处推的 0」。⚠️ "包含别处推的改动"这件事仍然说了 —— 在副标里，不在横幅里。
  $("#auditSub").textContent = `最近 ${a.total} 条 · 本后台 ${a.fromAdmin} · 别处推的 ${a.fromOther}`;

  // 列头漏斗：来源（admin/other）· 操作人（从真实条目里长）；数字为当前口径
  const cnt = (f) => a.entries.filter(f).length;
  funnelHeader($("#thAuditSrc"), "来源",
    [["", "全部", a.entries.length], ["admin", "后台", cnt((e) => e.source === "admin")], ["other", "别处", cnt((e) => e.source !== "admin")]],
    state.auditSrc, (v) => { state.auditSrc = v; renderAudit(); });
  const ops = [...new Set(a.entries.map((e) => e.operator || "—"))].sort();
  funnelHeader($("#thAuditOp"), "操作人",
    [["", "全部", a.entries.length], ...ops.map((o) => [o, o, cnt((e) => (e.operator || "—") === o)])],
    state.auditOp, (v) => { state.auditOp = v; renderAudit(); });

  // 「这条产品的全部改动 →」（D 批）：按 slug 过滤 + 副标处写明 + 可清除。
  //    ⚠️ 用 includes 不用 ===：批量条目的 slugs 是多个。⛔ 解析不出 slugs 的条目（别处推的）匹配不到 —— 口径与记录卡一致，两边都按数据文件/后台格式算。
  if (state.auditSlug) {
    const x = el("button", "linkish", `筛选：${state.auditSlug} ×`); x.type = "button";
    x.title = "清除筛选，回到全部记录";
    x.onclick = () => { state.auditSlug = ""; renderAudit(); };
    $("#auditSummary").append(x);
  }
  const rows = a.entries.filter((e) =>
    (!state.auditSlug || (e.slugs || []).includes(state.auditSlug)) &&
    (!state.auditSrc || (state.auditSrc === "admin" ? e.source === "admin" : e.source !== "admin")) &&
    (!state.auditOp || (e.operator || "—") === state.auditOp));

  const tb = $("#auditRows"); tb.innerHTML = "";
  rows.forEach((e) => {
    const tr = el("tr");
    tr.append(el("td", "col-st mono", fmtStamp(e.date)));

    const src = el("td", "col-cat ac");
    src.append(el("span", `pill ${e.source === "admin" ? "pill-ok" : "pill-gray"}`, e.source === "admin" ? "后台" : "别处"));
    tr.append(src);

    const act = el("td");
    if (e.action) {
      const label = { create: "新建", update: "修改", delete: "删除", bulk: "批量" }[e.action] || e.action;
      act.append(el("div", "pname", `${label} ${e.slugs.join("、") || "—"}`));
      if (e.fields) act.append(el("div", "mono hint0", "字段：" + e.fields));
    } else {
      // 🔴 解析不出来就**原样显示 commit 标题**，不猜 —— 猜错的审计条目会被当成事实引用
      act.append(el("div", "pname", e.subject || "(无标题)"));
      act.append(el("div", "mono hint0", "未按后台格式记录，只能显示原始标题"));
    }
    tr.append(act);

    tr.append(el("td", "col-cat mono", e.operator || "—"));

    const sha = el("td", "col-st");
    const link = el("a", "lnk mono-link", e.shortSha);
    link.href = e.url; link.target = "_blank"; link.rel = "noopener";
    sha.append(link); tr.append(sha);
    tb.append(tr);
  });
  if (!rows.length) {
    const tr = el("tr"); const td = el("td", "hint"); td.colSpan = 5; td.textContent = "没有匹配的记录。"; tr.append(td); tb.append(tr);
  }
}

/** 左导航切视图。⚠️ 只切实做出来的这几个，SOON 项不可点（见 index.html 的 .soon）。 */
function showNav(which) {
  state.nav = which;
  $("#listView").hidden = which !== "products";
  $("#mediaView").hidden = which !== "media";
  $("#auditView").hidden = which !== "audit";
  $("#catsView").hidden = which !== "cats";
  $("#settingsView").hidden = which !== "settings";
  $("#certView").hidden = which !== "certs";
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
  // ⚠️ 从左栏进图片页 ⇒ 回到**文件夹网格**（⛔ 不要停在上次点进去的那个文件夹里：
  //    人是从别的页面回来的，他要的是"看全部"，而不是接着上次那一个）。
  //    ⛔ 不放进 loadMedia()：上传成功后也会调它，那时把人踢出当前文件夹是错的。
  // ⭐ 进产品页一律回到「在线」（Joe 2026-09-04）。与下面图片页回文件夹网格**同一条规矩**：
  //    人从别的页面回来时要的是默认视图，⛔ 不是接着上次那一档。
  // ⚠️ 放在这里而不是 renderList()：renderList 在筛选切换时也会跑，
  //    放进去等于**点「未上架」也会被弹回在线** —— 那不是默认值，那是锁死。
  // ⚠️ 「从机型的在用数点过来」那条路（renderAxis 里）在 showNav 之后**显式**把它设回 null，
  //    所以那条路不受影响：它要的是那个机型的全部产品，含未上架。
  // ⚠️ 切走分类页时把"再点一次"的武装解除 —— ⛔ 不让它跨页残留，
  //    否则下次从别处切走会被一个与当前页无关的拦截挡一下。
  if (which !== "cats") catsLeaveArmed = false;

  if (which === "products") state.statusSeg = "published";

  if (which === "media") {
    state.mediaFolder = null; state.mediaQ = "";
    if (state.media) renderMedia(); else loadMedia();
  }
  if (which === "audit" && !state.audit) loadAudit();
  // ⚠️ 分类页的计数每次都要重算（列表可能刚被批量改过），但接口只在第一次拉。
  if (which === "cats") { if (state.cats) renderCats(); else loadCats(); }
  if (which === "settings") renderSettings();   // 起步时已经拉过 _whoami，不重复请求
  // ⚠️ 站点内容每次进都**重新拉**：三个视图共用一个文件，别人（或我自己在另一个视图里）
  //    刚存过的话，拿旧的 sha 去保存会撞乐观锁；更糟的是在旧值上编辑。
  if (SITE_SECTIONS[which]) loadSite(which);
  // ⚠️ 证书页也**每次重拉**，理由与上面同一条：它写的是同一个 site-content.json，
  //    而"这个槽现在有没有文件"只有仓里知道 —— 拿上次的快照会显示一个已经不成立的状态。
  if (which === "certs") loadCerts();
}
// ⚠️ 拦截挂在**点击**上，⛔ 不挂在 showNav() 里面：
//    showNav 还被内部调用（如媒体页点图跳到那个产品），那些不该被拦。
//    ⇒ 判据落在"人主动切走"这个动作上，不落在函数名上。
document.querySelectorAll(".nav-item[data-nav]").forEach((b) => {
  b.onclick = () => {
    // 只有正停在编辑页且脏了才拦（v3 §3.5：返回列表 / 切左栏两条路）
    if (!$("#detailView").hidden && !confirmLeave()) return;
    // 🔴 分类页的**未保存暂存**同样要拦（第 4 条边界 1）：
    //    暂存只在内存里，切走就没了 —— ⛔ 不许静默丢弃，那是把一个假话换成另一个。
    //    ⚠️ 复用同一套两次点击的形状（confirmLeave + #dirtyBar），⛔ 不发明第二种拦法。
    if (state.nav === "cats" && b.dataset.nav !== "cats" && !confirmLeaveCats()) return;
    markClean();
    showNav(b.dataset.nav);
  };
});

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
//
// 🔴 **既有缺陷，v3 顺手修**：`#mainImgNote` 在 HTML 里带着 `hidden`，而全仓**没有一处**
//    把它 unhide 过 ⇒ 这条警告从写下的那天起**一次都没显示过**（往它写的另一句也一样）。
//    ⚠️ 这是「删元素没删绑定」的镜像：**绑定活着、元素在、只是永远看不见** ——
//       没有任何报错，`textContent` 每次都赋值成功，闸也查不出来。
//    ⇒ 之所以在本单修而不是只报：v3 把状态卡整张删了，我把这个元素搬进图片卡并写了
//       「它装的是一条真警告」——**不修的话那句注释本身就是假的**，交付就是错的。
$("#f_status").addEventListener("change", () => {
  const note = $("#mainImgNote"); if (!note) return;
  const dir = $("#f_status").value === "published" ? "products/" : "products/_draft/";
  note.textContent = `⚠️ 上架状态改为「${statusLabel($("#f_status").value)}」⇒ 保存时图片会搬到 ${dir}（在同一个 commit 里）。`;
  note.hidden = false;                       // ← 缺的就是这一行
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
/**
 * 删除确认框。返回 true 才继续删。
 *
 * 🔴 用原生 `<dialog>.showModal()`：Esc 关闭、`::backdrop`、焦点陷阱、背景 inert
 *    **全是浏览器给的**。⛔ 不手搓 modal —— 手搓的那套总会少一样，而少的那样没人发现。
 * ⚠️ 点遮罩关闭**要自己接**（`<dialog>` 不自带）：判据是"点击落在 dialog 元素本身"，
 *    因为内容都在 `<form>` 里，落到 dialog 自己身上的只可能是遮罩区域。
 * 🔴 确认键**不拿默认焦点**（autofocus 在取消上，见 HTML）—— 回车不该等于删除。
 */
function confirmDelete(slug) {
  const dlg = $("#delDlg");
  if (!dlg || typeof dlg.showModal !== "function") {
    // 🔴 拿不到对话框 ⇒ **明确拒绝并说清**，⛔ 不删。
    //
    // ⚠️ 这里原来退回一个原生 `prompt`（要求输入 slug）。两个理由换掉它：
    //   ① **它和主路径问的不是同一样东西** —— 主路径 2026-09-05 已改成输**型号**
    //      （Joe 用型号认产品），而这条还在要 slug 且大小写敏感。
    //      同一个函数两条分支问两样东西，真触发时他会以为"删不掉"。
    //   ② 原生弹窗撞 Joe 的零弹窗常驻规矩，而且**会被浏览器抑制** ——
    //      那正是这条流程当初重做的起因。一条几乎不触发的原生 prompt 路径，
    //      就是一颗迟早撞上那条规矩的雷。
    //
    // ⇒ 与其维护一条死路径的一致性，不如让它**响亮地拒绝**
    //   （"守卫会静默失效 ⇒ 换成不需要守卫的写法"）。
    // ⛔ 绝不改成"直接返回 false 但不说话"：那就是"点了删除什么都不发生"，
    //   正是 2026-09-05 刚修过的那个**挂死且无症状**的形状。
    const box = $("#preview");
    if (box) {
      box.hidden = false; box.innerHTML = "";
      box.append(mkNotice("bad",
        "**删除确认框加载失败，这次没有删除任何东西。** 请刷新一下页面（Ctrl+R）再试。"
        + "⚠️ 刷新之后如果还是这样，把这句话告诉开发窗 —— 那说明页面结构出问题了，⛔ 不是偶发。"));
    }
    console.error(JSON.stringify({ evt: "delete_dialog_missing", slug }));
    return Promise.resolve(false);
  }
  // 🔴 **简洁版**（Joe 2026-09-05：「搞那么多文字干嘛」）。
  //    上一版每句都是真话，但**把机器的账本也说给他了** —— 数据文件名、"同一个 commit"
  //    是我们的实现细节，不是他做这个决定需要的东西。**真话 ≠ 全部的话。**
  //    ⇒ 只留三件他要的：删的是哪个（型号）· 会少什么（图片张数）· 多久生效 + 不可撤销。
  const p = state.loaded?.product || {};
  const model = (p.model || "").trim();
  const imgs = [p.images?.main, ...(p.images?.gallery || [])].filter(Boolean);
  // ⚠️ 确认输入改成**型号**（Joe 用型号认产品；slug 又长又难打）。
  //    没有型号的产品（理论上不该存在，契约必填）回落到 slug —— ⛔ 不因此变成"点一下就删"。
  const key = model || slug;

  $("#delDlgTitle").textContent = `删除 ${key}？`;
  // ⚠️ 图片张数**现算**；0 张时不说图片，⛔ 不写"和它的 0 张图片"。
  appendMd($("#delDlgBody"), imgs.length
    ? `**${key}** 和它的 ${imgs.length} 张图片将从官网移除，约 1 分钟生效。此操作**不可撤销**。`
    : `**${key}** 将从官网移除，约 1 分钟生效。此操作**不可撤销**。`);

  // 首页精选：⚠️ **只在真不确定/真命中时出现**，压成一行。⛔ 平时不占位置。
  const featEl = $("#delDlgFeat");
  const feat = featuredWarning([slug], "删除").trim();
  featEl.hidden = !feat;
  featEl.textContent = "";
  if (feat) {
    const f = featuredAmong([slug]);
    featEl.textContent = !f.known
      ? "⚠️ 还没读过站点内容，无法确认它在不在首页精选里。"
      : `⚠️ 它正挂在首页精选上，删除后首页会少 ${f.hit.length} 张卡。`;
  }

  const inp = $("#delDlgType"); inp.value = "";
  inp.placeholder = `输入 ${key} 确认`;
  const yes = $("#delDlgYes"); yes.disabled = true;
  const no = $("#delDlgNo");
  // 🔴 只有逐字相同才解锁（型号**大小写不敏感** —— Joe 打字不该被大小写卡住）。
  const match = (v) => v.trim().toLowerCase() === key.toLowerCase();
  inp.oninput = () => { yes.disabled = !match(inp.value); };

  // 🔴🔴 **不等 `close` 事件** —— 实测（in-app 预览浏览器）：点「取消」之后
  //    `dlg.open` 变 false、`dlg.returnValue` 也更新了，**但 `close` 事件一次都没触发**
  //    （`addEventListener("close")` 与 `onclose` 都没响）。
  //    第一版就是等它 ⇒ Promise 永远不 settle ⇒ `await confirmDelete()` 挂死 ⇒
  //    **点了删除什么都不发生，而且屏幕上没有任何异常**（按钮文案都没变）。
  //
  // ⛔ 修法不是"再多绑一个事件试试"（cancel / onclose / close 三个一起绑）——**那是继续赌事件**。
  //    与本文件里 fitSensorRows 从 resize 事件改成观察列宽是同一条：
  //    **在"决定真正发生的那个地方"决定**，⛔ 不依赖引擎是否派发某个通知。
  //  ⇒ 三个出口各自 resolve：取消键 / 删除键 / 遮罩与 Esc。
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;                     // ⚠️ 三个出口可能重入（例如 Esc 之后表单又提交）
      done = true;
      dlg.onclick = null; dlg.onkeydown = null; inp.oninput = null;
      no.onclick = null; yes.onclick = null;
      try { if (dlg.open) dlg.close(); } catch { /* 已经关了就算了 */ }
      resolve(v);
    };
    // ⚠️ 两个键都是 `type=submit`（`<form method=dialog>` 负责关框）——
    //    这里**只负责给出答案**，⛔ 不 preventDefault：关框那件事交给浏览器做得更稳。
    no.onclick = () => finish(false);
    // 🔴 删除键上**再判一次** slug：按钮的 disabled 是可以被绕过的（改 DOM / 脚本），
    //    而这是不可逆操作 ⇒ 判据落在**值本身**，⛔ 不落在按钮的状态上。
    yes.onclick = () => finish(match(inp.value));
    // 点遮罩 = 取消（落在 dialog 元素本身上的点击只可能是遮罩，内容都在 <form> 里）
    dlg.onclick = (e) => { if (e.target === dlg) finish(false); };
    // Esc = 取消。⚠️ 自己接 keydown，⛔ 不依赖 `cancel`/`close` 事件（见上）。
    dlg.onkeydown = (e) => { if (e.key === "Escape") finish(false); };
    dlg.returnValue = "";
    dlg.showModal();
  });
}

// ⭐ 型号一边打字、顶栏一边跟上（Joe 2026-09-05）。
// ⚠️ 绑在 `input` 上，⛔ 不绑 `change` —— change 要失焦才发，
//    那会变成"打完还得点一下别处才更新"，看起来像没生效。
(() => {
  const m = $("#f_model");
  if (!m) return;
  // ⚠️ 这里**追加**监听，⛔ 不覆盖已有的 oninput（表单别处可能也挂了东西）。
  m.addEventListener("input", () => setBarModel(m.value));
})();

$("#deleteBtn").onclick = async () => {
  const slug = state.slug;
  if (!slug) return;
  // ⭐ 页内确认对话框（Joe 2026-09-05）。⛔ 不再用原生 prompt。
  //
  // 🔴 框里说的每一件事都必须**真的会发生** —— 这是上次那句
  //    「删除仍然会二次确认」（承诺了一个不存在的护栏）的反面：
  //    这次真有确认了，那就轮到"它说的后果必须属实"。
  //    下面每一句都对着服务端 DELETE 的真实行为写（src/index.ts）：
  //      · `planDelete` 删数据文件 + images.main + images.gallery，**同一个 commit**
  //      · CF Pages 自动重建 ⇒ 官网约 1 分钟后生效
  //      · 首页精选那一段由 featuredWarning 现算，⛔ 不写死
  //    ⚠️ 有一种情况框里**不预告**：数据文件不是合法 JSON 时服务端只删数据文件、不删图。
  //       那件事这里判不了（要读文件才知道），⇒ ⛔ 不承诺它，由服务端删完回报。
  const ok = await confirmDelete(slug);
  if (!ok) return;
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
      // ⛔ 不再用原生 alert（Joe 的零弹窗规矩；而且 prompt/alert 会被浏览器抑制 ——
      //    同一条删除流程里刚实测过 `prompt` 那颗雷，⛔ 不留半条旧病）。
      // 🔴 结果落在**列表页**的 #listResult：这一刻界面已经切回列表了，
      //    落在详情页的 #preview 上等于跟着详情页一起消失，他不知道到底删没删。
      const lr = $("#listResult");
      if (lr) {
        lr.innerHTML = "";
        const sha7 = String(b.commitSha ?? "").slice(0, 7) || "(没拿到 sha)";
        const ok = el("div", "notice notice-ok");
        // ⚠️ commit sha 用 <code> 元素，⛔ 不写反引号 —— `appendMd` 只认 `**粗体**`，
        //    反引号会**原样印在屏幕上**（实测印出来了）。同一族今天已经踩过两次。
        const line = el("div");
        appendMd(line, `✅ **已删除** ${slug} —— commit `);
        line.append(el("code", null, sha7));
        ok.append(line);
        // ⚠️ 服务端可能带一句"图片没删干净"之类的话 —— 有就照原样放出来，⛔ 不吞掉。
        if (b.note) appendMd(ok.appendChild(el("div")), String(b.note));
        if (b.warning) appendMd(ok.appendChild(el("div")), `⚠️ ${b.warning}`);
        lr.append(ok);
      }
    } else {
      // ⚠️ 失败时**人还停在详情页** ⇒ 结果落 #preview（与保存失败同一处，⛔ 不另开一个位置）。
      const box = $("#preview");
      box.hidden = false; box.innerHTML = "";
      box.append(mkNotice("bad", `**未删除**（没有产生 commit）：${b?.detail || b?.error || r.status}`));
    }
  } catch (e) {
    // 🔴🔴 分岔就在这里：删**已经发生**了，炸的是后面的渲染/刷新 ——
    //    ⛔ 绝不说"删除请求失败"，那句话会让他再删一次（而那一次会打到别的东西上）。
    if (wroteOk) {
      await loadList().catch(() => {});
      const lr = $("#listResult");
      if (lr) { lr.innerHTML = ""; lr.append(mkNotice("warn", wroteButRenderFailed(commitSha, e))); }
    } else {
      const box = $("#preview");
      box.hidden = false; box.innerHTML = "";
      box.append(mkNotice("bad", "删除请求失败：" + e.message));
    }
  } finally {
    btn.disabled = false; btn.textContent = "删除这个产品…";
  }
};

// ⚠️ 列宽随视口变 ⇒ 能放下几个传感器也跟着变。不重收的话，
//    窗口拉宽之后那个 `+3` 会一直挂着，而旁边明明空着一大片。
//
// 🔴 **判据从 resize 事件改成"列宽真的变了"**（2026-09-03，990 分屏档实测抓到）：
//    Joe 常态是分屏 ~990、最大化 1278 之间来回切。实测 1278 档名称列 479px 却只显示
//    2 个 chip 挂着 `+8` —— 手动 `dispatchEvent(new Event("resize"))` 后立刻变 7 个 + `+3`，
//    ⇒ **处理器是好的，是它没被调用**：改窗口宽度未必等于 window resize 事件按时到达
//    （受控视口/分屏/DevTools 缩放/内容自身导致的列宽变化，都可能不发或晚发这个事件）。
//    ⛔ 修法不是"再多绑一个事件试试"——那是继续赌事件。**改成观察被测对象本身**：
//      列宽变了就重收，与"是什么导致它变的"无关。
//    ⚠️ ResizeObserver 的回调里再改 hidden 会再次触发布局 ⇒ 用 rAF 合帧，且只在**宽度真变**时才做，
//      否则自己改自己会成环（fitSensorRows 会改 chip 的 hidden，进而可能改容器高度）。
addEventListener("resize", () => { try { fitSensorRows(); } catch {} });
if (typeof ResizeObserver === "function") {
  let lastW = 0, pending = 0;
  const ro = new ResizeObserver((ents) => {
    const w = Math.round(ents[0]?.contentRect?.width || 0);
    if (!w || w === lastW) return;      // 只认**宽度**变化：高度变化多半正是我们自己改出来的
    lastW = w;
    if (pending) cancelAnimationFrame(pending);
    pending = requestAnimationFrame(() => { pending = 0; try { fitSensorRows(document.getElementById("rows")); } catch {} });
  });
  const tb = document.getElementById("rows");
  if (tb) ro.observe(tb);
}

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

// 🔴 刷新 / 关标签也要拦（第 4 条边界 1）。暂存只在内存里，⛔ 不持久化 ——
//    刷新之后它就该没有，但**没有提醒地没有**是不行的。
// ⚠️ 现代浏览器只认 preventDefault + returnValue，文案由浏览器自己出，⛔ 我们写什么都不显示。
//    ⇒ 这一条只保证"他被问过一次"；"丢的是哪几处"由页内那条 #dirtyBar 负责说。
window.addEventListener("beforeunload", (e) => {
  if (state.nav === "cats" && pendingTotal()) { e.preventDefault(); e.returnValue = ""; }
});
