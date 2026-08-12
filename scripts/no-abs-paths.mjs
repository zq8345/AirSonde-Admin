// 守卫：仓里不许出现开发机的绝对路径。
//
// 🔴 这条守卫的来历（2026-08-12，代价是整整一批"已上线"全是假的）：
//    `scripts/imagepaths-selftest.mjs` 里写了 `C:/开发/airsonde/airsonde-admin/src/...`。
//    它在我的机器上跑得好好的，而 **CI 是 Linux** —— 那个路径根本不存在 ⇒ import 抛错
//    ⇒ `npm run typecheck`（构建命令）失败 ⇒ **构建失败 ⇒ 不部署**。
//
// ⚠️ 最毒的地方不是构建挂了，是**我连着两次宣布"生产已随 CI 自动上线"**：
//    那句话是从"push 成功"推断的，而不是量出来的。生产实际停在 11 个 commit 之前，
//    是 Joe 撞见控制台的失败徽标才发现的。
//    ⇒ 两条教训：① 本机绿 ≠ CI 绿；② push 成功 ≠ 部署成功，"已上线"必须实测再说。
//
// 判据：扫 src/ 与 scripts/ 里的 Windows 盘符路径。命中即失败。
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ⚠️ 用 fileURLToPath，**不要** `new URL(...).pathname`：
//    pathname 会把非 ASCII 百分号编码（`/开发/` → `/%E5%BC%80%E5%8F%91/`），
//    Windows 上还多一个前导斜杠。第一版就栽在这：目录名解错 ⇒ 找不到目录。
const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const DIRS = ["src", "scripts"];
const BAD = /[A-Za-z]:[\\/](?:开发|Users|Program|Windows)/;

const hits = [];
let scanned = 0;
for (const d of DIRS) {
  const dir = path.join(ROOT, d);
  // 🔴 **绝不静默跳过**。第一版写的是 `if (!existsSync) continue;`，
  //    于是目录名解错时它跳过了全部文件、然后打印"✅ 无绝对路径" ——
  //    一个什么都没扫的检查，报出来的绿和真绿长得一模一样。
  //    ⇒ 扫不到要扫的东西，就是这道闸自己坏了，必须红。
  if (!fs.existsSync(dir)) {
    console.log(`🔴 要扫的目录不存在：${dir}\n   这不是"没什么可扫"，是这道闸自己坏了（路径解析错）。`);
    process.exit(1);
  }
  for (const f of fs.readdirSync(dir)) {
    if (!/\.(mjs|ts|js)$/.test(f)) continue;
    const p = path.join(dir, f);
    scanned++;
    fs.readFileSync(p, "utf8").split("\n").forEach((line, i) => {
      const t = line.trim();
      // ⚠️ 只查**可执行位置**：注释里提一句"契约文档在 C:\开发\…"是正当的文档，
      //    把它也报红的话，这道闸会天天误报，而天天误报的闸最后没人看
      //    —— 那时它连提醒的价值都没有了。判据收窄到"代码里真用了这个路径"。
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
      if (BAD.test(line)) hits.push(`${d}/${f}:${i + 1}  ${t.slice(0, 110)}`);
    });
  }
}

if (hits.length) {
  console.log("🔴 仓里出现了开发机的绝对路径 —— 这些在 CI（Linux）上不存在，会让构建失败：");
  hits.forEach((h) => console.log("   " + h));
  console.log("\n   改法：用 `new URL(\"../src/\", import.meta.url)` 之类从模块自身位置推导。");
  process.exit(1);
}
// ⚠️ 报出**扫了多少个文件**：数字为 0 的"通过"不是通过。
if (scanned === 0) {
  console.log("🔴 一个文件都没扫到 —— 这道闸没在工作。");
  process.exit(1);
}
console.log(`✅ 无开发机绝对路径（扫了 ${DIRS.join("、")} 共 ${scanned} 个文件）`);
