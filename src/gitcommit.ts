// 一次提交写多个文件（JSON + 图片）—— Git Data API。
//
// 🔴 为什么不能用 contents API：它一次只能写**一个**文件，一个文件一次 commit。
//    那意味着"产品 JSON 指向了一张还没提交的图"这种中间状态会真实存在于 main 上，
//    而 CF Pages 会拿那个中间状态去构建 —— 官网当场缺图。
//    ⇒ JSON 与它的图必须在**同一个 commit** 里。这不是洁癖，是构建正确性。
//
// 流程：读 ref → 读 base tree → 建 blob（二进制）→ 建 tree → **验证** → 建 commit → 移动 ref
//
// ⭐ 那道"验证"是本文件的要害：`POST /git/trees` 的响应里带着 **GitHub 自己算出的每个
//    entry 的 sha**。本地按同样的规则算一遍，逐条比对，**不等就在建 commit 之前中止**。
//    ⚠️ 闸的全部价值在于它拦在**不可逆那一步之前**；"警告一下然后照样提交"等于没有它。

import type { Env } from "./env";
import { ghFetch, gitBlobSha, gitBlobShaBytes, base64ToBytes, ConflictError, ByteMismatchError } from "./github";

/** 一次提交里的一个文件动作。 */
export type CommitFile =
  | { path: string; text: string }                  // 文本（产品 JSON）
  | { path: string; base64: string }                // 二进制（图片）
  | { path: string; fromPath: string }              // 从仓内已有 blob 复制（搬家用）
  | { path: string; remove: true };                 // 删除

export interface CommitResult {
  commitSha: string;
  commitUrl: string;
  treeSha: string;
  /** 逐条列出这次 commit 真正落了哪些文件 —— 出问题时不用去猜。 */
  files: { path: string; sha: string; how: string }[];
  removed: string[];
  /** 要删但基线里根本没有的路径。**报出来而不是静默跳过** —— 静默会掩盖"我以为删了"。 */
  skippedRemoves: string[];
  verifiedBytes: number;
}

const json = (r: unknown) => ({ "Content-Type": "application/json", ...(r as object) } as Record<string, string>);

async function api(env: Env, path: string, init?: RequestInit): Promise<any> {
  const res = await ghFetch(env, path, init);
  if (res.status === 409 || res.status === 422) {
    throw new ConflictError(`GitHub ${res.status}（多半是并发：分支在你读取之后被别人推过）。原话：${(await res.text()).slice(0, 240)}`);
  }
  if (!res.ok) throw new Error(`GitHub ${init?.method || "GET"} ${path} → ${res.status}：${(await res.text()).slice(0, 300)}`);
  return res.json();
}

/**
 * 原子提交一组文件。
 *
 * ⛔ **这里没有乐观锁，也不该有。**
 * 原来有一个 `expectedHeadSha`（分支 HEAD）参数，2026-08-28 删除，两个理由：
 *   ① **它是空转的**：服务端读 `env0.baseHeadSha` 往这里传，而**客户端从来不发** ⇒ 恒为 undefined
 *      ⇒ `if (opts.expectedHeadSha && …)` 整条被跳过。它从上线那天起就没生效过，**而且不报错**。
 *   ② **就算发了，粒度也是错的**：实测官网仓 3 小时 14 个 commit、相邻间隔中位数 3.1 分钟，
 *      其中只有 5 个碰产品 JSON ⇒ 用分支 HEAD 当锁，**编辑超过 3 分钟就必然冲突**，
 *      而真冲突只可能来自"同一个文件被改过"。
 * ⇒ 锁改在**调用方**按**文件 blob sha** 判（`index.ts` 的 `staleConflict()`，全仓唯一一处）。
 *
 * ⚠️ 保留的是**另一件事**：下面 `api()` 在 GitHub 返回 409/422 时抛 `ConflictError` ——
 *    那是"读 HEAD 到 push 之间的几秒"里被人抢先推了。它挡的窗口只有几秒，
 *    ⛔ **不要把它当成乐观锁**（"页面开了一小时"那种情形它挡不住）。
 *
 * @param message commit message
 * @param files   文件动作列表
 */
export async function commitFiles(
  env: Env,
  opts: { message: string; files: CommitFile[] },
): Promise<CommitResult> {
  const repo = env.GITHUB_REPO, branch = env.GITHUB_BRANCH;
  if (!repo || !branch) throw new Error("配置缺失：GITHUB_REPO / GITHUB_BRANCH。");
  if (!opts.files.length) throw new Error("没有任何文件要提交 —— 不产生空 commit。");

  // ── 1. 当前 HEAD ──
  const ref = await api(env, `/repos/${repo}/git/ref/heads/${branch}`);
  const headSha: string = ref.object.sha;

  // ── 2. base tree（一次拿全，copy 的源 sha 与 remove 的存在性都从这里查）──
  const headCommit = await api(env, `/repos/${repo}/git/commits/${headSha}`);
  const baseTreeSha: string = headCommit.tree.sha;
  const full = await api(env, `/repos/${repo}/git/trees/${baseTreeSha}?recursive=1`);
  if (full.truncated) {
    // ⚠️ 截断的树里"找不到某个路径"和"那个路径不存在"长得一模一样。
    //    在这种输入上做 copy/remove 决策会静默做错事 —— 宁可停。
    throw new Error("仓内文件数超出一次 tree 查询的上限（truncated）—— 拒绝在不完整的基线上做决策。");
  }
  const baseShaByPath = new Map<string, string>(
    (full.tree || []).filter((t: any) => t.type === "blob").map((t: any) => [t.path, t.sha]),
  );

  // ── 3. 逐个文件：算出期望 sha，必要时先建 blob ──
  const treeEntries: any[] = [];
  const expected = new Map<string, string>();   // path → 我方算出的期望 blob sha
  const files: { path: string; sha: string; how: string }[] = [];
  const removed: string[] = [];
  const skippedRemoves: string[] = [];
  let verifiedBytes = 0;

  for (const f of opts.files) {
    if ("remove" in f) {
      if (!baseShaByPath.has(f.path)) { skippedRemoves.push(f.path); continue; }
      treeEntries.push({ path: f.path, mode: "100644", type: "blob", sha: null });
      removed.push(f.path);
      continue;
    }

    if ("text" in f) {
      // ⚠️ 不用 tree 的内联 `content`：内联的话，这个 blob 的 sha 只能靠 tree 响应回读，
      //    而那条路已经被证明不可靠（见下方"读回创建出来的 tree"的注释）。
      //    显式建 blob ⇒ **建的那一刻就能验字节**，与图片走同一条路径、同一种证据。
      const wantText = await gitBlobSha(f.text);
      const blobT = await api(env, `/repos/${repo}/git/blobs`, {
        method: "POST", headers: json({}), body: JSON.stringify({ content: f.text, encoding: "utf-8" }),
      });
      if (blobT.sha !== wantText) {
        throw new ByteMismatchError(
          `🔴 ${f.path} 的字节与 GitHub 存下的不一致（期望 blob ${wantText}，实际 ${blobT.sha}）。已中止，未产生 commit。`,
        );
      }
      expected.set(f.path, wantText);
      treeEntries.push({ path: f.path, mode: "100644", type: "blob", sha: blobT.sha });
      verifiedBytes += new TextEncoder().encode(f.text).length;
      files.push({ path: f.path, sha: blobT.sha, how: "文本 blob" });
      continue;
    }

    if ("base64" in f) {
      // 🔴 二进制不能内联（tree 的 content 只吃文本）—— 必须先建 blob。
      const bytes = base64ToBytes(f.base64);
      const want = await gitBlobShaBytes(bytes);
      const blob = await api(env, `/repos/${repo}/git/blobs`, {
        method: "POST", headers: json({}), body: JSON.stringify({ content: f.base64, encoding: "base64" }),
      });
      // 建 blob 这一步就能验一次：GitHub 存的字节若与我们发的不同，sha 立刻不等。
      if (blob.sha !== want) {
        throw new ByteMismatchError(
          `🔴 上传 ${f.path} 的字节与 GitHub 存下的不一致（期望 blob ${want}，实际 ${blob.sha}）。已中止，未产生 commit。`,
        );
      }
      expected.set(f.path, want);
      treeEntries.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
      verifiedBytes += bytes.length;
      files.push({ path: f.path, sha: blob.sha, how: `二进制 blob（${bytes.length}B）` });
      continue;
    }

    // copy：搬家。期望 sha == 源文件的 sha（字节没变，只是换了路径）
    const src = baseShaByPath.get(f.fromPath);
    if (!src) throw new Error(`要搬动的文件在仓里不存在：${f.fromPath}`);
    expected.set(f.path, src);
    treeEntries.push({ path: f.path, mode: "100644", type: "blob", sha: src });
    files.push({ path: f.path, sha: src, how: `从 ${f.fromPath} 搬来` });
  }

  if (!treeEntries.length) throw new Error("没有任何实际改动 —— 不产生空 commit。");

  // ── 4. 建 tree ──
  const tree = await api(env, `/repos/${repo}/git/trees`, {
    method: "POST", headers: json({}), body: JSON.stringify({ base_tree: baseTreeSha, tree: treeEntries }),
  });

  // ── 5. ⭐ 验证：GitHub 算出的 sha 必须与我方期望逐条相等 ──
  //    这一步在建 commit **之前**。不等 ⇒ 直接抛，仓里什么都没发生（tree 是游离对象，不进历史）。
  //
  // 🔴 **不能直接用 `POST /git/trees` 的响应体来对账。**（2026-08-12 靶子实跑打出来的）
  //    它只列**顶层**条目（`fixtures`、`src` 这种 type=tree 的目录），
  //    嵌套路径如 `fixtures/products/x.json` **结构上永远不会出现在里面** ——
  //    于是这道闸对任何嵌套路径都是**恒红**：它不是偶尔误报，是从来没通过过。
  //    ⚠️ 方向是安全的（fail-closed，写不进去），但**照错了东西的闸没有判据价值**：
  //       恒红和恒绿一样，都不携带关于被测对象的信息。
  //    ⇒ 改成把创建出来的 tree **递归读回来**，那里面才有完整的 path→sha。
  const back = await api(env, `/repos/${repo}/git/trees/${tree.sha}?recursive=1`);
  if (back.truncated) throw new Error("创建出来的 tree 回读被截断 —— 无法逐条对账，拒绝提交。");
  const got = new Map<string, string>((back.tree || []).map((t: any) => [t.path, t.sha]));
  const bad: string[] = [];
  for (const [path, want] of expected) {
    const actual = got.get(path);
    // ⚠️ 缺失也算不匹配：`undefined !== want` 会静默放过，必须显式当失败
    if (actual !== want) bad.push(`${path}：期望 ${want}，实际 ${actual || "(响应里没有这个路径)"}`);
  }
  if (bad.length) {
    throw new ByteMismatchError(
      `🔴 tree 校验不通过，已在 commit 之前中止（仓内未发生任何改动）：\n` + bad.join("\n"),
    );
  }
  for (const w of files) if (!w.sha) w.sha = got.get(w.path) || "";

  // ── 6. 建 commit ──
  const commit = await api(env, `/repos/${repo}/git/commits`, {
    method: "POST", headers: json({}), body: JSON.stringify({ message: opts.message, tree: tree.sha, parents: [headSha] }),
  });

  // ── 7. 移动 ref。⚠️ 绝不 force：force 会把别人在这期间推的东西直接抹掉。 ──
  await api(env, `/repos/${repo}/git/refs/heads/${branch}`, {
    method: "PATCH", headers: json({}), body: JSON.stringify({ sha: commit.sha, force: false }),
  });

  return {
    commitSha: commit.sha,
    commitUrl: commit.html_url,
    treeSha: tree.sha,
    files, removed, skippedRemoves, verifiedBytes,
  };
}

