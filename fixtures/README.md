# fixtures/ —— 测试材料，**不是产品数据**

🔴 **这里的东西不是 AirSonde 的产品数据，一个字都不是。**
真正的产品数据在 `zq8345/AirSonde-Web` 的 `src/content/products/`，由 Web 窗维护，
本仓永远只读它（契约 C1：没有数据库，那些 JSON 就是唯一真源）。

## 这些文件用来干什么

验证读取 / 校验 / dry-run 预览这条链路时，需要一份**真实存在于 GitHub 上、
能被真实 API 读到**的 C1 形态文件。开发期间 `AirSonde-Web` 的产品目录还没建出来，
而那个目录归 Web 窗，我不能去创建它。

⇒ 所以把测试材料放在**本仓**，本地开发时把 `GITHUB_REPO` / `PRODUCTS_DIR` 指到这里：

```
# .dev.vars（已 gitignore，绝不会带进生产）
GITHUB_REPO=zq8345/AirSonde-Admin
PRODUCTS_DIR=fixtures/products
GITHUB_BRANCH=e2e-fixtures        # 🔴 必填，见下
TAXONOMY_PATH=fixtures/taxonomy.json
```

### 🔴 `GITHUB_BRANCH=e2e-fixtures` 是必填的，不是可选优化

靶子仓**就是本 worker 自己的仓**。往它的 `main` 推一个提交 = Workers Builds 一次
**生产部署**。而写入侧的 e2e 一轮要推十几个提交 ⇒ **跑一次测试 ≈ 十几次生产部署**，
而且悄无声息。仓库历史里那串 `admin: create/update/delete imgorder-e2e (dev-bypass)`
每一条都是这么来的。

⚠️ 这条不靠"记得配"：出站口（`src/github.ts`）**硬拒**本机对生产分支的写入，
每个 e2e 脚本的第 ⓪ 步也会先拦一道（早报、报得懂 —— 否则症状是跑到一半一片 403，
看起来像 token 坏了）。忘了配的结果是**测试跑不起来**，不是"悄悄推了生产"。

### 为什么还要 `TAXONOMY_PATH`

契约 v1.4（A13）之后，两个分类轴的真源是 `taxonomy.json`，而且
`validateProduct` **必须显式拿到轴**、不做任何回落 ⇒ **写入路径硬依赖这个文件存在**。
靶子仓原来没有它，于是从 `c164678` 起每个写入侧 e2e 都在
「官网仓里没有 src/data/taxonomy.json」上 502 —— 而没人发现，因为跑一次要付出
十几次生产部署，于是没人跑。**两个洞互相遮掩。**

⇒ `fixtures/taxonomy.json` 的每个 label 都带 `[FIXTURE]` 后缀，**这是判别式不是玩笑**：
两份文件长得一样的话，任何"读到了轴"的断言都分不清读的是哪一份。

这样走的是**真实的 GitHub contents API、真实的 base64 解码、真实的校验器**，
只有"读哪个目录"不同。⚠️ 刻意不做"本地假数据注入"那种旁路 —— 那种旁路测的是
一条生产上根本不存在的代码路径，测过了也不能说明什么。

## 文件

| 文件 | 用途 |
|---|---|
| `products/fixture-desktop-16in1.json` | 合法样本（契约文档示例改的 slug）—— 正对照 |
| `products/fixture-supplier-leak.json` | `specs` 里粘了 alibaba 链接 —— 反向自证：读出来必须报 `supplier_leak` |

⚠️ `fixture-supplier-leak.json` 是**故意坏的**。它存在的意义就是证明闸会红。
别"顺手修好它"——修好了，那条判据就再也没有对照物了。
（同理：它里面那条 alibaba 链接是编的假 URL，不指向任何真实供应商页面。）
