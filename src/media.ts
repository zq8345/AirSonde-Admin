// 媒体库：图片清单 + 引用对账（孤儿扫描）。**纯函数，不碰网络。**
//
// 🔴 为什么不用正则去文本里搜引用（wanew 的 orphan-scan 就是那么做的，并且吃过亏）：
//    正则要枚举"文件名里可能出现哪些字符"。**字符类漏一个（比如逗号），
//    引用它的那张图就会被判成孤儿** —— 而孤儿的下场是被删。
//    ⚠️ 这个错的方向是**不可逆**的：判错一张在用的图 = 官网当场缺图。
//
// ⇒ 这里改成：把每个产品 JSON **解析出来**，直接取 `images.main` / `images.gallery` 的值。
//    引用集合来自**结构化字段**，不是文本匹配 —— 不存在"漏一个字符"这回事。
//    代价是只能发现 JSON 里声明的引用；而按契约 C1，产品图**只可能**从这两个字段被引用。
//    ⚠️ 若将来有别处引用图片（比如首页模块），**必须回来把那个来源加进这里**，
//       否则它引用的图会被算成孤儿。这一条写在这里，不写在别处。

export const PRODUCT_IMG_PREFIX = "src/assets/products/";

export interface MediaFile {
  path: string;        // 仓内真实路径
  size: number;
  sha: string;
  /** 相对 src/assets/ 的值，与产品 JSON 里写的形态一致 */
  rel: string;
  area: "published" | "draft" | "originals" | "other";
  referencedBy: string[];   // 引用它的产品 slug（可能多个）
  /**
   * 🔴 **"孤儿"的判据只有这一个字段**，跟着数据一起走。
   *
   * 界面上曾经在渲染层又写了一遍 `!referencedBy.length` ——
   * 于是同一个词在同一屏上有了两个定义：顶部计数说「未被引用 0」，
   * 而 38 张 `originals/` 原图每一张都挂着黄色的「未被引用」。
   * 摘要是对的，卡片在打它的脸。而人会照卡片去删 —— 删掉的是整条图片管线的源材料。
   *
   * ⇒ 判据搬进这里，随每个文件发出去。渲染层**只读它，不重算**。
   *   ⛔ 谁要再在别处写 `!referencedBy.length`，就又开了第二个真源。
   */
  orphan: boolean;
}

/**
 * 一张图是不是孤儿。**全仓唯一定义。**
 * `originals/` 是有意存档的供应商原图，从设计上就不会被产品 JSON 引用 ⇒ 永远不是孤儿。
 */
export const isOrphan = (f: Pick<MediaFile, "area" | "referencedBy">): boolean =>
  f.referencedBy.length === 0 && (f.area === "published" || f.area === "draft");

export interface MediaReport {
  files: MediaFile[];
  total: number;
  /** 参与孤儿判定的（published + draft），不含 originals 存档 */
  liveTotal: number;
  /** products/originals/ 下的供应商原图：有意存档，**不算孤儿** */
  archived: number;
  referenced: number;
  orphans: number;
  /** 🔴 对账：referenced+orphans===liveTotal **且** liveTotal+archived===total。任一不成立 ⇒ 扫描本身有问题。 */
  reconciled: boolean;
  /** 产品 JSON 里声明了、但仓里**找不到文件**的引用 —— 与孤儿相反的另一种病。 */
  missing: { slug: string; rel: string }[];
}

function areaOf(rel: string): MediaFile["area"] {
  if (rel.startsWith("products/_draft/")) return "draft";
  if (rel.startsWith("products/originals/")) return "originals";
  if (rel.startsWith("products/")) return "published";
  return "other";
}

/**
 * 交叉比对：仓里的图片文件 × 产品 JSON 声明的引用。
 *
 * @param blobPaths 仓内所有 blob 的路径（来自 git tree）
 * @param products  已解析的产品：{ slug, images:{main,gallery} }
 */
export function crossReference(
  blobPaths: { path: string; size: number; sha: string }[],
  products: { slug: string; images?: { main?: string; gallery?: string[] } | null }[],
): MediaReport {
  // ① 仓里实际存在的产品图（只看 src/assets/products/ 下的图片扩展名）
  const files: MediaFile[] = blobPaths
    .filter((b) => b.path.startsWith(PRODUCT_IMG_PREFIX) && /\.(webp|png|jpe?g|avif)$/i.test(b.path))
    .map((b) => {
      const rel = b.path.slice("src/assets/".length);
      // orphan 先占位；引用收集完之后统一按 isOrphan 盖章（见下面）。
      return { path: b.path, size: b.size, sha: b.sha, rel, area: areaOf(rel), referencedBy: [] as string[], orphan: false };
    });
  const byRel = new Map(files.map((f) => [f.rel, f]));

  // ② 产品声明的引用 —— 取自**解析后的字段**，不是文本匹配
  const missing: { slug: string; rel: string }[] = [];
  for (const p of products) {
    const refs = [p.images?.main, ...(p.images?.gallery || [])].filter((x): x is string => !!x);
    for (const rel of refs) {
      const f = byRel.get(rel);
      if (f) {
        // ⚠️ 同一张图被同一个产品引用两次（main 与 gallery 重复）只记一次，
        //    否则"被几个产品引用"这个数字会说谎。
        if (!f.referencedBy.includes(p.slug)) f.referencedBy.push(p.slug);
      } else {
        // 声明了但文件不在 —— 这是**另一种病**，不是孤儿。分开报，修法也不同。
        missing.push({ slug: p.slug, rel });
      }
    }
  }

  // 🔴 `products/originals/` 是**有意存档**的供应商原图，从设计上就不会被产品 JSON 引用。
  //    把它们算进"孤儿"，报出来的是"38 张未被引用" —— 而人看到这个数字的第一反应是清理，
  //    那正好会删掉唯一的原始素材。**一个会让人做出错误动作的正确数字，就是错的报告。**
  //    ⇒ 单列成 archived，不进孤儿。孤儿只统计 published/draft 两个区。
  // ⭐ 引用收集完了才盖章 —— 盖早了就是拿一份还没填完的 referencedBy 下结论。
  for (const f of files) f.orphan = isOrphan(f);

  const live = files.filter((f) => f.area === "published" || f.area === "draft");
  const archived = files.filter((f) => f.area === "originals").length;
  const referenced = live.filter((f) => f.referencedBy.length > 0).length;
  // 🔴 计数也走同一个字段，不再用 `live.length - referenced` 减出来 ——
  //    减法得到的数**永远**与 reconciled 自洽（那是恒等式），所以它证明不了口径一致。
  //    数 `f.orphan` 才让下面那条对账真的有可能红。
  const orphans = files.filter((f) => f.orphan).length;
  return {
    files,
    total: files.length,
    liveTotal: live.length,
    archived,
    referenced,
    orphans,
    // 恒真？不是：files 的分类来自 referencedBy 是否为空，而这两个数各自独立数出来。
    // 它挡的是"我改了统计口径却忘了改另一边"那类错。
    reconciled: referenced + orphans === live.length && live.length + archived === files.length,
    missing,
  };
}

