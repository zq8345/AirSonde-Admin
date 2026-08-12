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
 * @param message commit message
 * @param files   文件动作列表
 * @param expectedHeadSha 可选的乐观锁：调用方读取数据时分支的 HEAD。
 *        传了它 ⇒ 分支若已前进就中止。⚠️ 不传不是"不锁"，是"以本次读到的 HEAD 为准"。
 */
export async function commitFiles(
  env: Env,
  opts: { message: string; files: CommitFile[]; expectedHeadSha?: string },
): Promise<CommitResult> {
  const repo = env.GITHUB_REPO, branch = env.GITHUB_BRANCH;
  if (!repo || !branch) throw new Error("配置缺失：GITHUB_REPO / GITHUB_BRANCH。");
  if (!opts.files.length) throw new Error("没有任何文件要提交 —— 不产生空 commit。");

  // ── 1. 当前 HEAD ──
  const ref = await api(env, `/repos/${repo}/git/ref/heads/${branch}`);
  const headSha: string = ref.object.sha;
  if (opts.expectedHeadSha && opts.expectedHeadSha !== headSha) {
    throw new ConflictError(
      `分支在你打开页面之后被推过（你基于 ${opts.expectedHeadSha.slice(0, 7)}，现在是 ${headSha.slice(0, 7)}）。` +
      `请重新读一次再保存 —— 直接提交会把别人的改动盖掉。`,
    );
  }

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
      // 文本可以内联进 tree（GitHub 按 UTF-8 解释）。期望 sha 本地算。
      expected.set(f.path, await gitBlobSha(f.text));
      treeEntries.push({ path: f.path, mode: "100644", type: "blob", content: f.text });
      verifiedBytes += new TextEncoder().encode(f.text).length;
      files.push({ path: f.path, sha: "", how: "文本内联" });
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
  const got = new Map<string, string>((tree.tree || []).map((t: any) => [t.path, t.sha]));
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

