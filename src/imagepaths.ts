// 产品图片的**位置规划** —— 纯函数，不碰网络。
//
// 🔴 为什么单独抽出来、而且必须是纯函数：
//    本批最容易漏的不是"能不能上传"，是 **status 切换时图片要跟着搬家**。
//    那个联动只在"改一个字段"的路径上触发，混在网络代码里就只能靠真跑一次去验，
//    而真跑一次要 commit 到官网仓 —— 一个需要产生真实 commit 才能验证的规则，
//    实际上等于没有被验证过。抽成纯函数，往返两个方向都能用假输入量。
//
// 约定（契约 C1 v1.1 §② + 仓内实测的现状）：
//   - `images.main` / `gallery` 的值是**相对 `src/assets/` 的路径**，例如 `products/foo.webp`
//   - published ⇒ 图在 `products/`
//   - draft     ⇒ 图在 `products/_draft/`（该子目录不被 Astro glob 匹配 ⇒ **draft 图物理上进不了产物**）
//   - 文件名 = slug 派生（实测：现存 23 个产品全部如此，12 published + 11 draft）

export const ASSETS_ROOT = "src/assets/";
export const PUB_DIR = "products";
export const DRAFT_DIR = "products/_draft";

/** 该 status 下，图片应当在哪个目录。 */
export function dirForStatus(status: string): string {
  return status === "published" ? PUB_DIR : DRAFT_DIR;
}

/** JSON 里的相对路径 → 仓内真实路径。 */
export const repoPath = (jsonPath: string): string => ASSETS_ROOT + jsonPath;

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
  current: { main?: string; gallery?: string[] } | null,
  next: { main?: string; gallery?: (string | null)[] } | null,
  uploads: Upload[] = [],
  removeGallery: number[] = [],
): ImagePlan {
  const dir = dirForStatus(status);
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
    mainJson = retarget(src, dir);
    if (repoPath(src) !== repoPath(mainJson)) {
      ops.push({ op: "copy", path: repoPath(mainJson), fromPath: repoPath(src), why: `status=${status} ⇒ 主图搬到 ${dir}/` });
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
    const t = retarget(g, dir);
    if (repoPath(g) !== repoPath(t)) {
      ops.push({ op: "copy", path: repoPath(t), fromPath: repoPath(g), why: `status=${status} ⇒ gallery[${i}] 搬到 ${dir}/` });
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
