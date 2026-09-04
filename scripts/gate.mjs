#!/usr/bin/env node
/**
 * 闸的判词包装。⛔ 不是第二套检查 —— 它只跑 `npm run typecheck`，步骤清单仍然只有
 * package.json 那一份真源。
 *
 * 🔴 它存在的唯一理由是**取证方式**，2026-09-04 真栽过一次：
 *
 *     npm run typecheck 2>&1 | tail -3 && echo "exit=$?"
 *     → 打印 exit=0，而 tsc 实际有一条真错。
 *
 *   因为 `$?` 是**管道里最后一个命令**（`tail`）的退出码，不是 tsc 的。README 里
 *   早就记着这个坑，我今天照样踩了 —— ⇒ **光记下来不够，判据得进闸。**
 *
 * ⇒ 修法不是"提醒大家取真退出码"（那还是靠人记），是让**判词永远是输出的最后一行**：
 *     GATE: GREEN            全绿
 *     GATE: RED — exit N     有红
 *   于是判据变成「输出最后一行必须是 `GATE: GREEN`」——
 *   ⚠️ 这条**穿得过管道**：`| tail` 会把判词一起带出来，而 `$?` 不会。
 *   ⛔ 没有 GATE 行 = 没跑完 = 当成红，别当成"大概过了"。
 */
import { spawnSync } from "node:child_process";

// ⚠️ `shell: true` 是必须的：Windows 上 npm 是 `npm.cmd`，而 Node 自 18.20/20.12 起
//    **拒绝不带 shell 直接 spawn `.cmd`**（CVE-2024-27980 的修复）。
//    🔴 第一版漏了它，症状是：一条 typecheck 输出都没有，却打印 `GATE: RED`。
//       那次红是**假红** —— 它报的不是"检查没过"，是"检查根本没跑起来"。
//       ⇒ 所以下面两种红要分开说，⛔ 别让"跑不起来"冒充"没通过"：
//         一个要修代码，另一个要修这台机器，而混在一起时人会去改错的那一边。
const r = spawnSync("npm", ["run", "typecheck"], { stdio: "inherit", shell: true });

if (r.error || r.status === null) {
  // 启动失败 / 被信号杀掉。⛔ 绝不能落到绿：没跑完就是没跑完。
  console.log(`GATE: RED — 检查没能跑起来（${r.error ? r.error.message : `signal ${r.signal}`}）`);
  process.exit(1);
}

console.log(r.status === 0 ? "GATE: GREEN" : `GATE: RED — typecheck exit ${r.status}`);
process.exit(r.status);
