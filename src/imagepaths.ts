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

/** 上传时用的文件名：slug 派生，gallery 依次编号。⚠️ 一律小写 .webp。 */
export function uploadName(slug: string, slot: "main" | number): string {
  return slot === "main" ? `${slug}.webp` : `${slug}-${slot + 1}.webp`;
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
  next: { main?: string; gallery?: string[] } | null,
  uploads: Upload[] = [],
  removeGallery: number[] = [],
): ImagePlan {
  const dir = dirForStatus(status);
  const ops: FileOp[] = [];
  const uploadBySlot = new Map<string | number, Upload>(uploads.map((u) => [u.slot, u]));

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
  const nextGal = next?.gallery ?? curGal;
  const keep: string[] = [];
  nextGal.forEach((g, i) => {
    if (removeGallery.includes(i)) {
      ops.push({ op: "delete", path: repoPath(g), why: `gallery[${i}] 被删除` });
      return;
    }
    const up = uploadBySlot.get(i);
    if (up) {
      const p = `${dir}/${uploadName(slug, i)}`;
      ops.push({ op: "upsert", path: repoPath(p), base64: up.base64, why: `上传了 gallery[${i}]` });
      if (repoPath(g) !== repoPath(p)) ops.push({ op: "delete", path: repoPath(g), why: `gallery[${i}] 被替换` });
      keep.push(p);
      return;
    }
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
      const p = `${dir}/${uploadName(slug, u.slot as number)}`;
      ops.push({ op: "upsert", path: repoPath(p), base64: u.base64, why: `新增 gallery[${u.slot}]` });
      keep.push(p);
    });

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
