# 投稿到 awesome-dsh-plugin

这份文件是**给发布者看的清单**，不是插件运行时的一部分。它对应
[awesome-dsh-plugin 的 contributing.md](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)，
把"能不能被收录"拆成可以一条条勾掉的检查项。

> 该列表的收录标准（原文照抄）：
> *"An entry is added when the plugin **installs with `dsh plugin add`**, **does what its one-line
> description says**, **sits in the right category**, and is **maintained**. Every submission is
> checked against its own source before merging."*
> —— 也就是说：**能用 `dsh plugin add` 装上**、**一行描述与实际行为一致**、**分类正确**、**还在维护**。

## 0. 一句话现状

本包已满足这四条的全部技术条件（见下表），包内没有留任何待填项；
剩下的动作都在 GitHub 侧：建仓库 → push → 加 topic → 等满 1 天 → 提 PR。

| 收录要求 | 本包怎么满足 | 怎么自查 |
|---|---|---|
| 能用 `dsh plugin add` 安装 | 声明了 `dsh.bundle.patch: ./cordis.patch.yml`，`files` 里带着这个补丁 | `npm pack --dry-run` 确认产物含 `cordis.patch.yml` |
| 一行描述与行为一致 | `package.json` 的 `description` 就是一行；README 首段是它的展开 | 打开 README 第一屏，功能都能对上 |
| 分类正确 | **`fun`**（Just for Fun，官方 23 个 category 取值之一） | —— |
| 还在维护 | 6 个测试套件（`npm test`，**零依赖、无构建**）+ CHANGELOG + CI | `npm test` 本地全绿；`.github/workflows/test.yml` 会在 push 时跑 |

## 1. package.json 已补齐的仓库字段

- `repository` / `homepage` / `bugs` → `github.com/Eapp1e/dsh-poker`
- `author` → `Eapp1e`
- npm 包名仍是 `dsh-plugin-poker`（`cordis.patch.yml` 与打包契约测试都按它钉住了）；
  将来若发布 npm，`repository` 字段指回 `Eapp1e/dsh-poker` 就会与列表条目自动关联，
  不需要通知维护者，也不能在 yml 里手写 `npm:` 字段。

## 2. 发布步骤（GitHub 侧）

1. 在 GitHub 建一个**空**的公开仓库 `Eapp1e/dsh-poker`（不要初始化 README，
   避免和本地首提交冲突）。
2. 推送（本目录已 `git init`，remote `origin` 已指向该地址，分支 `main`）：

   ```bash
   git push -u origin main
   ```

3. 仓库页 → About 旁的齿轮 → **Topics** 添加：`dsh-plugin`（生态检索必备），
   建议再加 `dsh`、`deepseek-harness`、`poker`、`texas-holdem`。
4. 看一眼 Actions：首个 CI 应当全绿（`npm test` × Node 20/22 + `npm pack --dry-run`）。
   —— TODO：push 后回到 Actions 页确认一次。
5. **等仓库创建满 1 天**再提投稿 PR：列表 CI 会查仓库年龄（从建仓时刻起算），
   不足就等一等，重新提交没有任何影响。

## 3. 投稿 PR：只加一个文件

列表采用**一个插件一个 YAML 文件**，两个 README 都是脚本生成物——
**不要手编 README，也不要动任何别人的条目**。fork
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 后，
新建这一个文件（文件名格式 `<owner>__<repo>.yml`）：

```yaml
# data/plugins/Eapp1e__dsh-poker.yml
url: https://github.com/Eapp1e/dsh-poker
name: Eapp1e/dsh-poker
category: fun
description:
  en: "Texas Hold'em table for DeepSeek Harness: model-callable poker tools, six heuristic opponents, an optional coach, and a browser table whose buttons never post a chat message."
  zh: "德州扑克牌桌：模型可调用的扑克工具、六种内置策略对手、可选的教练层，以及一个浏览器牌桌面板。"
```

注意：

- `en` 描述里有 `: `（半角冒号+空格），**必须带引号**，否则 YAML 会把它当成嵌套键；
- `category: fun` 即 Just for Fun；分类拿不准也没关系，维护者会直接改、不会打回；
- 描述只说功能、与代码对得上：6 个工具、6 个策略对手、可选教练、浏览器牌桌，
  README 里都能一一指认——**夸大是这类投稿被打回的头号原因**；
- 一个 PR 只加这一条（上限 3 条/PR），PR 也不会与别人冲突，因为条目文件互不相撞。

## 4. 合并前维护者会核对什么（自查清单）

- [ ] `npm test` 在干净环境（CI）里全绿：本包 6 个套件、共 960+ 条断言（其中 `test/pack.mjs` 专门核对下面这些条目）。
- [ ] `npm pack --dry-run` 的产物里**有 `cordis.patch.yml`**，且 `package.json` 里有 `dsh.bundle`。
- [ ] `package.json` 的 `description` 是**一行**，且与 README 首段一致。
- [ ] README 里**没有**机器相关的绝对路径、没有个人会话 id、没有"待办/占位"字样。
- [ ] 客户端半只 `require('react')`（平台基线），没有 `dsh.client.external` 之类的额外依赖。
- [ ] `LICENSE` 存在且与 `package.json` 的 `license` 一致（MIT）。
- [ ] 仓库是**公开**的，默认分支上有 README、LICENSE、CHANGELOG 与源码。

## 5. 自己先跑一遍（复制粘贴即可）

```bash
git clone https://github.com/Eapp1e/dsh-poker && cd dsh-poker
npm test              # 零依赖：不需要 npm install
npm pack --dry-run    # 确认发出去的文件清单
```

装到自己的 profile 里验证一次（会改动 profile，按需执行）：

```bash
dsh plugin --profile web add link:<本仓库路径>
# 重启 dsh web，刷新页面，在侧栏页脚点「♠ 牌桌」
```
