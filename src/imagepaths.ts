// 产品图片的**位置规划** —— 纯函数，不碰网络。
//
// 🔴 为什么单独抽出来、而且必须是纯函数：
//    本批最容易漏的不是"能不能上传"，是 **status 切换时图片要跟着搬家**。
//    那个联动只在"改一个字段"的路径上触发，混在网络代码里就只能靠真跑一次去验，
//    而真跑一次要 commit 到官网仓 —— 一个需要产生真实 commit 才能验证的规则，
//    实际上等于没有被验证过。抽成纯函数，往返两个方向都能用假输入量。
//
// 约定（契约 C1 v1.1 §② + 仓内实测的现状）：
//   - `images.main` / `gallery` 的值是**相对 `src/assets/` 的路径**，例如 `products/ak35/foo.webp`
//   - published ⇒ 图在 `products/<型号小写>/`（2026-09-04 起；迁移前在 `products/` 根）
//   - draft     ⇒ 图在 `products/_draft/`
//     ⚠️ **它进不了产物的理由变了**：官网 glob 2026-09-04 起是递归的，
//        挡住 `_draft/` 的现在是那条**负向排除**（`!_draft/**`），⛔ 不再是"子目录天然在构建外"。
//   - 文件名 = slug 派生（实测：现存 39 个产品全部如此，25 published + 14 draft）

export const ASSETS_ROOT = "src/assets/";
export const PUB_DIR = "products";
export const DRAFT_DIR = "products/_draft";

/**
 * 型号 → 文件夹名。⚠️ 必须与服务端建文件夹那道闸**同一个口径**
 * （`index.ts` 的 `MEDIA_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/`）——
 * 两边口径不一致的话，会出现"这个名字建得出来、却写不进去"或者反过来。
 * ⛔ 不做花哨的转写：只小写 + 把非 [a-z0-9] 压成单个连字符 + 去首尾。
 * 🔴 算不出合法名字时返回 null，调用方**回落到根目录**（⛔ 不是编一个名字）。
 */
export function folderForModel(model: string | undefined | null): string | null {
  const s = String(model ?? "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-");
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(s) ? s : null;
}

/**
 * 该 status 下，图片应当在哪个目录。
 *
 * 批 2（Joe 2026-09-04：「每个文件夹用型号作为名称」）：
 *   - published + 有合法型号 ⇒ `products/<型号小写>`
 *   - draft                 ⇒ `products/_draft`（**一个字没改**）
 *   - published 但型号算不出合法名 ⇒ 回落 `products/` 根目录
 *
 * 🔴 回落到根**不是**兜底凑合，它是唯一安全的选择：官网的 glob 现在是递归的，
 *    但根目录和型号目录都在构建范围内 ⇒ 回落的图照样上得了站；
 *    而随便编一个目录名会让"这张图属于谁"从此对不上。
 * ⚠️ 型号缺失时 Joe 会在保存前就被必填校验拦下（型号是必填），所以这条路很窄 ——
 *    但窄不等于不存在，⛔ 不留一条会写出坏路径的分支。
 */
export function dirForStatus(status: string, model?: string | null): string {
  if (status !== "published") return DRAFT_DIR;
  const f = folderForModel(model);
  return f ? `${PUB_DIR}/${f}` : PUB_DIR;
}

/**
 * **存量**图片这一次该待在哪个目录。⚠️ 与 `dirForStatus` 是两件事，别合并。
 *
 * 🔴 批 2 的边界就在这里：Joe 要的是「**以后**新存的图落进型号文件夹」，
 *    ⛔ 不是「**保存一下就把已有的图搬过去**」—— 那是批 3，要一个产品一个 commit 地做。
 *
 * 🔴 实测（2026-09-04，39 个产品逐个跑服务端 preview）：
 *    如果存量路径也按 `dirForStatus` 归一化，**25 个 published 产品在"什么都不改"
 *    的保存下都会被重写 images 路径**（各 8~9 行 add + 8~9 行 del）——
 *    也就是 Joe 随手保存一个产品，就顺带触发了一次没人要的迁移，
 *    而那次迁移的图**还没被搬**，官网当场缺图。
 *
 * 规则：
 *   - draft ⇒ 必须在 `products/_draft/`（不在就搬）——**与批 2 之前完全一致**
 *   - published ⇒ **只要它不在 `_draft/` 里就原地不动**（根目录或型号目录都算数）
 *     ⚠️ 递归 glob 已上生产（批 1），两处都在构建范围内 ⇒ 原地不动不会让官网缺图。
 *   - published 且当前在 `_draft/` ⇒ 这是一次**真的**状态转换，图本来就要搬出来，
 *     顺势落进型号目录（`toDir`）。
 */
export function dirForExisting(status: string, currentPath: string, toDir: string): string {
  const inDraft = currentPath.startsWith(DRAFT_DIR + "/");
  if (status !== "published") return DRAFT_DIR;
  if (inDraft) return toDir;             // 真的要搬出来 ⇒ 顺势进型号目录
  return currentPath.slice(0, currentPath.lastIndexOf("/"));   // 原地不动
}

/** JSON 里的相对路径 → 仓内真实路径。 */
export const repoPath = (jsonPath: string): string => ASSETS_ROOT + jsonPath;

/**
 * 悬空引用的**写入闸**（审计③）。纯函数 ⇒ 它自己能被测，⛔ 不把判定埋进端点。
 *
 * 🔴 起因：`45af967` 一次提交里删掉了 `ak13a/portable-breathalyser-3.webp`，
 *    却把它留在 gallery 里 ⇒ 当前 origin/main 上有 1 处悬空引用（实测，47 个产品里 1 处）。
 *    官网模板**有意跳过缺图** ⇒ 构建不红、页面不坏，**图库静默少一张，界面零提示**。
 *
 * 🔴 判定的关键不是"引用是否都存在"，是「**这次保存有没有让它变坏**」：
 *    一个只看"是否都存在"的闸，会当场**锁死 AK13A** —— 它现在就带着一条坏路径，
 *    Joe 下次编辑它会被我们自己的闸挡住。那就从"防悬空"变成了"锁死一个产品"。
 *    ⇒ 只拦**这次新引入的**坏路径；**历史遗留**的照放，但**必须说出来**。
 *
 * @param nextImages 本次要写进 JSON 的最终 images（planImages 的产物）
 * @param prevImages 保存前 JSON 里的 images（新建时 null）
 * @param existing   仓里**现有**的资产路径集合（相对 src/assets/，如 `products/ak35/x.webp`）
 * @param creating   本次提交会**新建**的资产路径（upsert / copy 的目标）
 * @param deleting   本次提交会**删除**的资产路径
 */
export function checkDanglingRefs(
  nextImages: { main?: string; gallery?: (string | null)[] } | null,
  prevImages: { main?: string; gallery?: string[] } | null,
  existing: ReadonlySet<string>,
  creating: readonly string[],
  deleting: readonly string[],
): { introduced: string[]; legacy: string[] } {
  const after = new Set(existing);
  creating.forEach((p) => after.add(p));
  deleting.forEach((p) => after.delete(p));
  // ⚠️ 先删后加会算错顺序 ⇒ 这里**先加后删**是错的方向；planImages 里同一路径
  //    既 upsert 又 delete 不会发生（那是"替换自己"），但真发生时应当**以创建为准**。
  creating.forEach((p) => after.add(p));

  const prevRefs = new Set(
    [prevImages?.main, ...(prevImages?.gallery ?? [])].filter((x): x is string => !!x),
  );
  const nextRefs = [nextImages?.main, ...(nextImages?.gallery ?? [])].filter((x): x is string => !!x);

  const introduced: string[] = [];
  const legacy: string[] = [];
  for (const r of nextRefs) {
    if (after.has(r)) continue;                 // 提交后它在 ⇒ 没问题
    // 🔴 分档：保存前就引用着它、且它当时也不在 ⇒ **历史遗留**，⛔ 不拦（但要报）
    if (prevRefs.has(r) && !existing.has(r)) legacy.push(r);
    else introduced.push(r);                    // 这次新引入的（或这次把它删了却还引用着）
  }
  return { introduced, legacy };
}

/** 取文件名（含扩展名）。 */
const basename = (p: string): string => p.split("/").pop() || p;

/**
 * 把一个图片路径搬到目标目录，**文件名不变**。
 * ⚠️ 只换目录，不换名：换名会让"这张图是哪个产品的"这件事在历史里断掉。
 */
export function retarget(jsonPath: string, dir: string): string {
  return `${dir}/${basename(jsonPath)}`;
}

/**
 * 从一批已有路径里，找出 `<slug>-N.webp` 用掉的最大 N。没有就返回 1（主图算第 1 张）。
 * ⚠️ 只认**本 slug 的**编号：别的产品的图不参与，否则编号会毫无必要地一直涨。
 */
export function maxUsedIndex(slug: string, paths: (string | undefined)[]): number {
  const re = new RegExp(`(?:^|/)${slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d+)\\.webp$`, "i");
  let max = 1;   // 主图 `<slug>.webp` 占掉第 1 号
  for (const p of paths) {
    const m = p && re.exec(p);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

/**
 * 上传时用的文件名。⚠️ 一律小写 .webp。
 *
 * 🔴 **编号不再由数组下标派生**（A10-R1-c，实测证实过一个静默覆盖）：
 *    旧写法 `slot + 2` 把**位置编进了文件名**，而位置是会变的。实测出的事故时序：
 *      gallery=[foo-2,foo-3,foo-4] → 删中间的 foo-3 → 数组长度变 2
 *      → 再传一张，slot=2 → 旧写法给出 `foo-4.webp`
 *      → planImages 走"新增"分支 upsert → **覆盖掉仍被引用的 foo-4**，
 *         而结果 gallery 变成 [foo-2, foo-4, foo-4]（同一文件两个下标），预览还显示成"新增"。
 *    加上拖拽排序之后，下标与编号彻底脱钩，这个洞会更容易踩到。
 *
 * ⇒ 改由**已占用编号 max+1** 派生：新号永远没人用过。
 * ⚠️ **不复用刚删掉的号**：复用会让 git 历史里出现同名不同图，
 *    将来查"这张图什么时候变的"会查到两条互不相干的历史上去。
 * ⚠️ `<slug>-N.webp` 的约定保持不变 —— 现存 23 个产品全是这个形态，不许分叉。
 *    （gallery 从 -2 起，因为主图 `<slug>.webp` 占掉第 1 号。）
 */
export function uploadName(slug: string, slot: "main" | number): string {
  // ⚠️ 非 main 时，第二个参数现在是**真实编号 N**（由 planImages 的分配器给），
  //    不再是数组下标。名字的形态没变，变的是"N 从哪来"。
  return slot === "main" ? `${slug}.webp` : `${slug}-${slot}.webp`;
}

/**
 * 一次保存内的编号分配器：从**已占用编号 max+1** 开始，用一个发一个，绝不回头。
 * ⚠️ 必须把 current 与 next 两侧的路径都算进"已占用" ——
 *    只看其中一侧的话，另一侧还引用着的那个号会被当成空号发出去。
 */
function makeNameAllocator(slug: string, current: { main?: string; gallery?: string[] } | null,
                           next: { main?: string; gallery?: (string | null)[] } | null) {
  let n = maxUsedIndex(slug, [
    current?.main, ...(current?.gallery ?? []),
    next?.main, ...((next?.gallery ?? []).filter(Boolean) as string[]),
  ]);
  return () => uploadName(slug, ++n);
}

export interface Upload {
  /** "main" 或 gallery 下标（0 起） */
  slot: "main" | number;
  /** base64（不含 data: 前缀） */
  base64: string;
}

export interface FileOp {
  /** upsert=写入新字节；copy=把已有 blob 挪到新路径；delete=删除 */
  op: "upsert" | "copy" | "delete";
  path: string;          // 仓内真实路径
  base64?: string;       // op=upsert
  fromPath?: string;     // op=copy（源路径，用于取它的 blob sha）
  why: string;           // 这一步是为什么产生的 —— 出问题时不用猜
}

export interface ImagePlan {
  images: { main: string; gallery?: string[] };
  ops: FileOp[];
}

/**
 * 规划一次保存要对图片文件做的所有事。
 *
 * @param slug      产品 slug
 * @param status    保存后的 status（决定目录）
 * @param current   保存前 JSON 里的 images（新建时传 null）
 * @param next      本次表单提交的 images（可能与 current 相同）
 * @param uploads   本次上传的新字节
 * @param removeGallery 要删掉的 gallery 下标（0 起）
 *
 * 🔴 返回的 `images` 是**要写进 JSON 的最终值**，已按 status 归一化。
 *    调用方不要再自己拼路径 —— 两个地方各拼一次，迟早不一致。
 */
export function planImages(
  slug: string,
  status: string,
  // 🔴 `model` 插在 `status` **后面**，不是加在参数表末尾（批 2）：
  //    加在末尾且可选的话，漏传的调用点会**静默**回落到 `products/` 根目录 ——
  //    图能上站、看起来一切正常，只是没进型号文件夹，而这正是本单要做的那件事。
  //    插在这里 ⇒ 漏传是**编译错误**（TS）或自检断言失败，⛔ 不是一个悄悄错掉的默认值。
  model: string | null | undefined,
  current: { main?: string; gallery?: string[] } | null,
  next: { main?: string; gallery?: (string | null)[] } | null,
  uploads: Upload[] = [],
  removeGallery: number[] = [],
): ImagePlan {
  const dir = dirForStatus(status, model);
  const ops: FileOp[] = [];
  const uploadBySlot = new Map<string | number, Upload>(uploads.map((u) => [u.slot, u]));
  // 🔴 新图的编号一律从这里领（A10-R1-c）：已占用 max+1，用一个发一个，绝不回头。
  //    下标不再参与命名 —— 下标会因为删除和拖拽而变，而文件名不能跟着变。
  const allocName = makeNameAllocator(slug, current, next);

  // ── 主图 ──
  const curMain = current?.main;
  let mainJson: string;
  const upMain = uploadBySlot.get("main");
  if (upMain) {
    mainJson = `${dir}/${uploadName(slug, "main")}`;
    ops.push({ op: "upsert", path: repoPath(mainJson), base64: upMain.base64, why: "上传了新主图" });
    // 旧图路径不同 ⇒ 删掉，否则仓里会留一张没人引用的图，而且它可能还在 published 目录里
    if (curMain && repoPath(curMain) !== repoPath(mainJson)) {
      ops.push({ op: "delete", path: repoPath(curMain), why: "主图被替换，旧文件不再被引用" });
    }
  } else {
    const src = next?.main ?? curMain;
    if (!src) {
      // 没有主图 —— 不在这里报错，交给契约校验器（它已经把 images.main 定为必填）。
      // ⚠️ 两个地方各报一次同一个错，消息迟早不一致。
      return { images: { main: "" }, ops };
    }
    // ⚠️ 存量图走 dirForExisting，⛔ 不是 dir —— 批 2 只改"以后往哪写"，不碰"已经写在哪"。
    mainJson = retarget(src, dirForExisting(status, src, dir));
    if (repoPath(src) !== repoPath(mainJson)) {
      ops.push({ op: "copy", path: repoPath(mainJson), fromPath: repoPath(src), why: `status=${status} ⇒ 主图搬到 ${dirForExisting(status, src, dir)}/` });
      ops.push({ op: "delete", path: repoPath(src), why: "搬家后删掉原位置（git 里没有 move，只有加+删）" });
    }
  }

  // ── gallery ──
  const curGal = current?.gallery ?? [];
  const nextGal = (next?.gallery ?? curGal) as (string | null)[];
  const keep: string[] = [];
  nextGal.forEach((g, i) => {
    if (removeGallery.includes(i)) {
      if (g) ops.push({ op: "delete", path: repoPath(g), why: `gallery[${i}] 被删除` });
      return;
    }
    const up = uploadBySlot.get(i);
    if (up) {
      const p = `${dir}/${allocName()}`;
      ops.push({ op: "upsert", path: repoPath(p), base64: up.base64, why: `上传了 gallery[${i}]` });
      // ⚠️ `g` 可能是 null：新 UI 用 null 占位表示"这一位是本次新上传的"，
      //    这样**顺序**能原样表达出来（新图不必被迫排到末尾）。null 位没有旧文件可删。
      if (g && repoPath(g) !== repoPath(p)) ops.push({ op: "delete", path: repoPath(g), why: `gallery[${i}] 被替换` });
      keep.push(p);
      return;
    }
    // 没有上传却是 null ⇒ 调用方给错了。不静默跳过：静默跳过会让那一位凭空消失。
    if (!g) throw new Error(`gallery[${i}] 是占位 null 但本次没有对应的上传 —— 调用方给的 uploads 与顺序对不上。`);
    const gDir = dirForExisting(status, g, dir);   // 同上：存量不迁移
    const t = retarget(g, gDir);
    if (repoPath(g) !== repoPath(t)) {
      ops.push({ op: "copy", path: repoPath(t), fromPath: repoPath(g), why: `status=${status} ⇒ gallery[${i}] 搬到 ${gDir}/` });
      ops.push({ op: "delete", path: repoPath(g), why: "搬家后删掉原位置" });
    }
    keep.push(t);
  });

  // 追加：下标 >= nextGal.length 的上传 = 新增的 gallery 项
  uploads
    .filter((u) => u.slot !== "main" && (u.slot as number) >= nextGal.length)
    .sort((a, b) => (a.slot as number) - (b.slot as number))
    .forEach((u) => {
      const p = `${dir}/${allocName()}`;
      ops.push({ op: "upsert", path: repoPath(p), base64: u.base64, why: `新增 gallery[${u.slot}]` });
      keep.push(p);
    });

  // ── 清理不再被引用的旧文件 ──
  //
  // 🔴 新 UI 是**单一列表**：删掉一张 = 它不在列表里了，而不是"在 removeGallery 里点名"。
  //    不在这里兜底的话，被移出列表的图会变成仓里的孤儿 —— 没人引用、也没人删，
  //    而症状要等到媒体库那边报"未被引用"才看得见。
  // ⚠️ 判据用**归一化后的仓内路径**比，不比 JSON 相对路径：搬家会改目录，
  //    比错单位的话会把刚搬过去的文件当成孤儿删掉。（这个单位错我今天已经踩过一次。）
  const finalPaths = new Set<string>([repoPath(mainJson), ...keep.map(repoPath)]);
  const alreadyDeleted = new Set(ops.filter((o) => o.op === "delete").map((o) => o.path));
  for (const old of [curMain, ...curGal]) {
    if (!old) continue;
    const rp = repoPath(old);
    if (finalPaths.has(rp) || alreadyDeleted.has(rp)) continue;
    ops.push({ op: "delete", path: rp, why: "已从图片列表中移除，不再被任何字段引用" });
    alreadyDeleted.add(rp);
  }

  const images: { main: string; gallery?: string[] } = { main: mainJson };
  if (keep.length) images.gallery = keep;
  return { images, ops };
}

/**
 * 删除整个产品时，要一并删掉的文件。
 * ⚠️ 只删这个产品自己引用的图 —— 不做"扫描孤儿图"那种事：
 *    引用扫描一旦漏一种写法，就会把别人还在用的图删掉。
 */
export function planDelete(jsonRepoPath: string, images: { main?: string; gallery?: string[] } | null): FileOp[] {
  const ops: FileOp[] = [{ op: "delete", path: jsonRepoPath, why: "删除产品数据文件" }];
  if (images?.main) ops.push({ op: "delete", path: repoPath(images.main), why: "删除主图" });
  (images?.gallery || []).forEach((g, i) => ops.push({ op: "delete", path: repoPath(g), why: `删除 gallery[${i}]` }));
  return ops;
}
