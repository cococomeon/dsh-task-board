# dsh-task-board —— `@linxin666/dsh-client-ui-task-board` 的本地 fork

这个目录是官方 npm 包 `@linxin666/dsh-client-ui-task-board@0.4.6` 的**本地 fork**，
用来在不改 npm 包原始内容的前提下改造任务看板插件。最初只做构建接入，
`src/` 与官方逐字节一致；**2026-10-14 起本 fork 开始承载行为改动**（见
「行为改动」一节），`src/` 不再与官方一致。

- fork 目录：`/Users/lee/Documents/deepseek-harness/default-workspace/dsh-task-board/`
- 包名**必须**保持 `@linxin666/dsh-client-ui-task-board`（version 为 `0.4.6-fork.1`）：
  loader 行 id（`ui-task-board` / `web-ui-task-board`）、聚合包 shell 的
  `config.plugin`、`dsh.client` 声明、浏览器模块注册表都按包名寻址，改名就要动
  cordis 补丁与 shell 引用。
- 接入方式：profile `/Users/lee/.dsh/profiles/web/` 里以 `link:` 依赖指向本目录。

## 目录

```
dsh-task-board/
├── build.mjs            # 构建脚本（唯一的自研文件）
├── package.json         # 官方清单 + 少量改动（见下）
├── pnpm-workspace.yaml  # fork 自己的 pnpm 配置（hoisted / 不装 peers）
├── cordis.patch.yml     # 官方原样（本 profile 下不生效，见「接入」）
├── icon.svg             # 官方原样
├── src/                 # 官方 + 本 fork 的行为改动（见下）
├── test/                # 自研测试入口（node test/run.mjs test/<entry>.ts）
├── lib.published/       # 官方 lib/ 原样冻结（回滚 / 对比基准）
└── lib/                 # 构建产物：index.js、client.js、types/
```

## 行为改动（相对官方 0.4.6）

### 1. 进行中卡片显示实时运行态徽标（2026-10-14）

**问题**：卡片的「进行中…」只来自执行记录（`latest.ownResult === undefined`），
它只知道 runner *拥有* 这张卡，不知道会话此刻是真的在跑、还是卡在等一个人类。
所以「跑着」和「停下来等审批 / 等回答」在看板上长得一模一样——只有 dsh-notify
的系统通知能区分，人不在页面前就看不出来。

**做法**：浏览器半订阅 Client Session Controller 的会话状态面
`ctx.uiSession.sessionStatus`（`SessionStatusSnapshot`，每会话
`running` / `pendingInteraction` / `completionUnread` 三个事实），
翻译成四种卡片状态，经 controller 快照下发到卡片与详情页：

| 状态 | 判定（`core/session-state.ts`） | 卡片徽标 | 详情徽标 |
| --- | --- | --- | --- |
| `approval` | `pendingInteraction.kind === 'approval'` | 待审批（error 色） | 同 |
| `question` | 其它非空 `pendingInteraction.kind`（含未来未知域） | 待回答（error 色） | 同 |
| `running` | `running === true` | 运行中（warn 色） | 同 |
| `stopped` | `running !== true && completionUnread === true` | 已停下待查看（business 色） | 同 |

- 优先级：待决策 > 运行中 > 已停下（等待人工的会话不该被旧的 running 标志读成"在干活"）。
- **只对"runner 当前拥有"的卡片生效**（`hasOpenExecution(task)` 为真且卡片未归档）：
  卡片结算后，同一个会话可能已经被下一次运行复用，此时再显示它的实时状态是假信息。
- 待决策时卡片边框与左侧色条转 error 色，扫一眼就能看出"这张要你处理"。
- 徽标有 tooltip 说明，并进入卡片的 aria-label。
- 有徽标时，卡片上那句泛化的「进行中…」不再渲染（它会和徽标打架）；
  验收阶段文案（验收中 / 修复中…）照常保留。

**边界（已实测确认）**：
- 会话状态来自「本浏览器连着的会话」，纯 headless 跑的任务没有浏览器可读的状态 →
  卡片退回老的执行记录文案（不显示徽标），不会瞎猜。
- `dsh-notify` 的第 4 类「被拒（denied）」**不是**会话状态，而是对工具返回文本做
  模式匹配（`COMMAND_BLOCKED` / `rejected` / `被拒绝` …）得到的一次性事件，
  没有可长期持有的状态，因此不做成卡片徽标。
- 运行时不含 `ctx.uiSession`（非 web 组合）时用 `ctx.inject(['uiSession'], …)` 作用域订阅，
  订阅不上就整块不生效，看板照常挂载。

### 2. 紧凑密度下也显示用户标签（2026-10-14）

**问题**：`done` 列默认是紧凑密度，而紧凑分支整行不渲染标签行——同一个任务，
在 `running` 列能看见 `space4 / 脱敏 / …`，一旦结算进 `done` 列就只剩标题。
标签是"再次找到这张卡"的主要线索，也正是标签筛选所依据的字段。

**做法**：标签行提到密度分支之外，两种密度都渲染；紧凑密度下改为
`flex-wrap: nowrap; overflow: hidden`（`data-dsh-part="card-tags"`），
只裁成一行、不换行，密度仍可预期。完整标签始终在 aria-label 与各徽标 tooltip 里。

### 3. 已验证泳道 + 人工验证 + git/gerrit 推送（2026-10-14）

**需求**：去掉「待规划」那一列的位置，加一个「已验证」泳道，列顺序为
待办 → 进行中 → 已完成 → 已验证 → 已失败；已完成的任务必须经过**人工验证**才能进「已验证」；
进入验证时可选择是否自动 commit、是否自动 push 到 gerrit（`refs/for/<分支>`）。

**最终形态**（逐条与用户确认）：

- 六列：待规划 → 待办 → 进行中 → 已完成 → **已验证** → 已失败。
- `待规划` 与 `已失败` **默认折叠成细条**（最左 / 最右，宽 `--dsh-tb-rail-w: 46px`），
  点细条**就地展开**为正常列、再点收起；展开态存 `localStorage`
  （`dsh.taskBoard.expandedColumns.v1`，存「例外集」，默认全折叠）。细条不渲染卡片、
  不接受拖拽放置。状态本身照常存活，折叠只是表现层。
- `已验证` 是**唯一不能手工拖入**的列（`MANUAL_STATUSES` 不含它；但 `from` 不受限，
  所以误验证的卡仍可手工拖回 `已完成`——这是唯一的撤回手段）。agent 工具也不提供验证动作。
- 已完成卡（卡片与详情页）出现「验证通过」按钮 → 弹窗两个勾选框（默认关、记住上次选择，
  `dsh.taskBoard.verifyOptions.v1`）→ **先 commit 再 push，都成功才置 `已验证`**；
  失败则卡留在 `已完成`，把 Host 原文回显在弹窗内且弹窗不关。验证只改状态，不记验证人/时间。
- commit = 卡片绑定工作区 `git add -A` + `git commit -m "<标题> (#<ID>)"`。
- push = `git push <remote> HEAD:refs/for/<工作区当前分支>`，远端默认 `origin`，
  配置项 `gitRemote`（设置 → 任务看板）。

**关键架构约束（都踩过）**：

- `host-ledger.apply()` 是**同步**方法，而 git 是异步进程 —— 所以 `verified` 的状态转移留在
  账本里（`case 'verify'`，纯转移），git 编排放在 `HostService.handleVerifyAction`：
  守卫 → 解析工作区 → `runGitSync` → **成功后才落库**。`HostService.apply()` 因此把 `verify`
  归入 Promise 分支；路由层本来就是 `await`，未改动。
- 卡片没有钉住工作区时沿用 runner 的「最近工作区」回退；**解析不到工作区直接拒绝**，
  不静默跳过 git 步骤——否则会出现一张「已验证但 commit 从未跑」的卡。
- `committed` **不读 git 的散文输出**，改为对比 commit 前后 `git rev-parse HEAD`。
  原因：一个失败但打印了 `[my-hook] …` 的 hook 会被散文启发式读成「提交成功」，
  于是在没有新提交的情况下 push，并把卡推进「已验证」。宁可误报失败，绝不误报成功。
- 子进程 env 内部设 `GIT_TERMINAL_PROMPT=0`（Host 无 TTY，缺凭据时 git 会白等满 120s 预算，
  最后报成超时而非认证失败）。
- 绝不 force push。unborn（刚 `git init`、尚无提交）与 detached 在
  `rev-parse --abbrev-ref HEAD` 下同形，用 `git symbolic-ref --short HEAD` 区分：
  前者允许首个提交，后者拒绝且**从不猜分支名**。

**生效方式**：`pnpm build` 之后重启 `dsh web` —— Host 在启动时把插件装进进程并
下发 `lib/client.js`，已在跑的会话看不到新列。

### 改动的文件（改动 1–2）

```
src/core/session-state.ts                 # 新增：状态→令牌的纯翻译、投影、相等判定
src/core/controller.ts                    # 快照承载 sessionStates；setSessionStates（等值不通知）
src/client/index.ts                       # 订阅 ctx.uiSession.sessionStatus 并推入 controller
src/client/board/card-view.ts             # cardRuntimeState + 文案键映射
src/client/board/TaskCard.tsx             # 状态徽标、两种密度都渲染标签、让位泛化文案
src/client/board/TaskBoard.tsx            # 逐卡传入运行态
src/client/board/TaskDetail.tsx           # 详情页头部同款徽标
src/client/locales.ts                     # 8 条 zh/en 文案
src/client/board.module.css               # 徽标样式、待决策边框、紧凑标签行
test/card-state.entry.ts                  # 新增测试入口
```

回滚：`rm -rf src && mv <备份的 src> src && pnpm build`（本次改动前的 `src/`
快照留在 `/Users/lee/Documents/deepseek-harness/default-workspace/dsh-task-board-src-backup-20261014/`）。

### 改动的文件（改动 3）

```
src/core/tasks.ts                     # verified 状态、六列 COLUMNS、COLLAPSED_COLUMNS、canVerifyTask
src/core/use-cases/task-verify.ts     # 新增：纯账本转移 applyVerifyTask
src/protocol.ts                       # {kind:'verify';commit;push} 动作 + parser 严格布尔归一
src/core/controller.ts                # verifyTask(id,{commit,push})
src/host-ledger.ts                    # case 'verify'：只做状态转移，零 git
src/host-service.ts                   # handleVerifyAction：守卫→解析工作区→runGitSync→落库
src/host/git-gerrit.ts                # 新增：runGitSync（add/commit/push refs/for/<branch>）
src/host/agent-tools.ts               # list 过滤枚举加 verified；动作枚举**不加** verify
src/index.ts                          # gitRemote 配置项 + 透传 HostService
src/client/board/TaskBoard.tsx        # 细条折叠列、GROUPED_COLUMNS 加 verified、验证弹窗
src/client/board/TaskCard.tsx         # done 卡的「验证通过」药丸（两种密度都渲染）
src/client/board/TaskDetail.tsx       # 详情页「验证通过」主按钮
src/client/board/VerifyTaskModal.tsx  # 新增：两个勾选框 + Host 错误回显 + pending 态
src/client/board/card-view.ts         # STATUSES 加 verified、展开态读写、canVerifyCard
src/client/board/status-key.ts        # verified 文案键
src/client/locales.ts                 # zh/en 各 18 条（保留 backlog 文案）
src/client/board.module.css           # 细条列与验证弹窗样式
src/client/settings-form.ts           # gerrit 远端名控件
src/client/TaskBoardSettingsCard.tsx  # 声明并渲染 gitRemote 字段
test/verify-flow.entry.ts             # 新增：状态机 / 真账本 / 真 HostService 三层断言
test/git-gerrit.entry.ts              # 新增：argv、refspec 形状、hook、超时、env
```

接口契约与决策记录：`CONTRACT-verified-lane.md`（三包并行的冻结契约，含复审追加要求 §3.1）。
回滚：`rm -rf src && cp -R <备份的 src> src && pnpm build`（本次改动前的 `src/` 快照在
`/Users/lee/Documents/deepseek-harness/default-workspace/dsh-task-board-src-backup-20261014-verified-lane/`）。

**已知前置问题**（与本次改动无关，已用改动前的 `src/` 复跑确认报错逐字相同）：
`test/ledger-invariants.entry.ts` 与 `test/session-link.entry.ts` 依赖真实账本的现状数据，
会因数据漂移而失败——前者对一张已经是 `done` 的卡再 move 到 `done`
（`canMoveManually` 要求 `from !== to`）。这两个入口的 import 图不含 `src/client/**`。

## 构建

```bash
cd /Users/lee/Documents/deepseek-harness/default-workspace/dsh-task-board
pnpm install      # 首次：装 esbuild + 运行时依赖（marked、@deepseek-ai/schemastery）
pnpm build        # = node build.mjs
```

`lib/` 每次构建先整体删除再重建，`src/` 只读；`lib.published/` 永不被写入。
脚本自己会做契约自检（导入面、导出面、ModuleLoader 外壳、id、CSS 作用域改名），
任何一条不过就非零退出。

## 产物形态

| 产物 | 格式 | 外部依赖（`require`/`import` 面） |
| --- | --- | --- |
| `lib/index.js` | bundled ESM | `node:*` + `@deepseek-ai/{schemastery,dsh-llm,dsh-tools}` |
| `lib/client.js` | `window.__ModuleLoader__.load({ id, factory })` 外壳里的 CJS factory | 仅 `react`、`react/jsx-runtime` |

`lib/client.js` 的外壳与官方逐行同形：

```js
window.__ModuleLoader__.load({
	id: "@linxin666/dsh-client-ui-task-board",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		...
		return module.exports;
	}
});
```

## 与官方构建的差异（逐条）

1. **打包器**：官方用私有 monorepo 里的 tsdown/rolldown 配置（含私有虚拟模块与 CSS
   插件，未随包发布），本 fork 用 esbuild。因此产物**不追求字节一致**，只保证结构
   等价：相同外壳、相同 id、相同外部依赖集合、相同导出面。
2. **CSS 注入粒度**：官方是「每个 `.module.css` 一个 `<style data-plugin-css=...>`」
   （4 个），本 fork 合成 **1 个** `<style>`，携带 4 份样式表的拼接文本。规则集合、
   作用域改名、`data-plugin`/`data-plugin-css` 属性名与去重语义都相同，只是 DOM 里
   少 3 个 style 元素。
3. **CSS 作用域前缀**：官方是 `_7D6uKa_board` 形态；本 fork 由「fork 相对路径的
   sha256 → 6 字符（首字符强制为字母）+ `_`」生成，例如 `eSEyhi_board`。前缀不可与
   官方相同（哈希输入不同），但形态与隔离性一致。**首字符必须是字母**：esbuild 会
   丢掉不合法 CSS 标识符的前导字符（`_8SEyhi` → `SEyhi`），build.mjs 里有契约自检
   盯着这条。
4. **无 sourcemap**：官方 `lib/client.js` 带 `client.js.map`，本 fork 不产出 map
   （运行时不读，只影响调试）。
5. **`lib/types/*.d.ts`** 不从 `src` 重新生成，而是**原样复制 `lib.published/types`**
   （生成需要 typescript + 整套 `@deepseek-ai/*` 类型包）。运行时不读这些文件。
6. **`package.json` 改动**（除这些外全部字段与官方一致）：
   - `version`: `0.4.6` → `0.4.6-fork.1`
   - `peerDependencies` **新增** `@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-tools`
   - `dependencies`: `marked` 由 `^18.0.14` **钉成 `18.0.14`**（官方实际打进产物的
     就是这个版本）
   - `devDependencies`: 换成 `esbuild` + `react`（后者只给构建期冒烟测试用）
   - `scripts`: 只留 `build`
   - `description` 追加一句标注这是本地 fork

   关于新增的两个 peer：`link:` 进来的包位于 profile 目录树之外，DSH 的
   `dsh-app-boot` 对它走 **linked root** 路由（`routeLinked`），而该路由只在被链接包
   的 `peerDependencies` 里出现该名字时，才把 specifier 指到安装内的 SDK 单例副本。
   官方清单只写了 `@deepseek-ai/dsh` 和 `react`，所以直接 `link:` 官方包会让宿主半的
   `@deepseek-ai/dsh-llm` / `dsh-tools` 解析不到——这两个 peer 是 `link:` 布局的必需项，
   不是可选项。落在 `peerDependencies` 里也保证了 pnpm 不会去安装它们。

## 接入（当前 profile 的改动）

```
/Users/lee/.dsh/profiles/web/package.json
  dependencies += "@linxin666/dsh-client-ui-task-board": "link:/Users/lee/Documents/deepseek-harness/default-workspace/dsh-task-board"

/Users/lee/.dsh/profiles/web/pnpm-workspace.yaml
  overrides += "@linxin666/dsh-client-ui-task-board": link:/Users/lee/Documents/deepseek-harness/default-workspace/dsh-task-board
```

`overrides` 是必需的：聚合包 `@linxin666/dsh-web-all` 依赖的是 registry 上的
`@linxin666/dsh-client-ui-task-board@0.4.6`，而 profile 里真正加载插件的行是
`- id: web-ui-task-board / name: '@linxin666/dsh-web-all/task-board'`，其 shell 用
`await import(config.plugin)`（importing 模块在 `@linxin666/dsh-web-all/lib/` 下）动态
导入包名。DSH 的 profile 解析层按「离 importing 模块最近的、位于 profile 内的
node_modules」选候选——如果 pnpm 把 registry 的 0.4.6 嵌进
`node_modules/@linxin666/dsh-web-all/node_modules/`，那个副本会赢，link 就形同虚设。
`overrides` 让这个包名在整个 profile 里只有一个解析结果，即 fork。

`dsh.profile.bundles` **不动**：插件不是 bundle，它的 loader 行由聚合包的
`cordis.patch.yml` 插入；本 fork 自带的 `cordis.patch.yml`（`id: ui-task-board`）在这
个 profile 下不生效，保持与官方一致即可。

## 回滚

```bash
cd /Users/lee/.dsh/profiles/web
cp package.json.bak-<TS> package.json && cp pnpm-workspace.yaml.bak-<TS> pnpm-workspace.yaml
pnpm install
```

回滚后 profile 重新解析到 registry 的 `@linxin666/dsh-client-ui-task-board@0.4.6`。
fork 目录留着不影响（没有任何东西引用它）。**已运行的宿主进程仍持有旧模块**，
回滚与生效都需要重启 DSH。

## 验证记录（2026-10-13）

- `diff -rq` 官方 `src/` ↔ fork `src/`：**完全一致**（本次接入没有改任何源码）。
- `cordis.patch.yml` / `icon.svg` 与官方 sha256 相同。
- `pnpm build` 连跑两次 sha256 相同（确定性构建）：
  `lib/index.js` 7956 行 / 372891 B、`lib/client.js` 10247 行 / 548996 B。
- `lib/client.js` 的 `require("...")` 集合恰为 `react`、`react/jsx-runtime`；
  平台 store engine 走的是官方那种「拼接字符串 + 运行时 require」的非字面量调用，
  打包器看不见，因此不会出现在 require 集合里（与官方产物行为一致）。
- `lib/index.js` 的 import 面 = `node:*` ×7 + `@deepseek-ai/{schemastery,dsh-llm,dsh-tools}`，
  与官方 `lib/index.js` 的对外导入面逐项相同；`node --check` 通过；在把
  `@deepseek-ai/dsh-llm`、`dsh-tools` 临时软链到本目录 `node_modules` 后（用完已删）
  真的 `import` 成功，导出面与官方**逐字符相同**：
  `Config DEFAULT_GOAL_RUN DEFAULT_GOAL_VERIFICATION DEFAULT_PROXY_TOKEN_ENV DEFAULT_TEAM_PROVIDER TASK_BOARD_GUIDANCE apply buildTeamDispatcher inject readConfigField resolveAgentTeams resolveHostDefaultPermission resolveHostTimers resolveLlmRuntime resolveProxyAccess resolveToolRegistry`
- CSS Modules：4 份样式表共 173 个 class 全部以各自前缀改名，CSS 与 JS 映射一一对应
  （build.mjs 里有契约自检），5 个 `@keyframes` 名同样被作用域化。
- 解析接入：`profile/node_modules/@linxin666/dsh-client-ui-task-board` 是指向本目录的
  软链；`find node_modules -name dsh-client-ui-task-board` 全 profile 只有这一处；
  从聚合包 shell 所在目录解析得到的就是 fork 的 realpath；`pnpm install
  --frozen-lockfile` 可复现该状态。

## 验证记录（2026-10-14：行为改动）

- `node test/run.mjs test/card-state.entry.ts`：**全绿**。覆盖
  ① 状态→令牌的优先级（approval > question > running > stopped、未知域按待决策、idle→缺省）、
  ② 投影只保留有话可说的会话、相等判定、③ `cardRuntimeState` 的"只认 runner 拥有的卡"
  闸门（已结算 / 已归档 / 无会话 / 无运行时面 → 一律缺省）、
  ④ controller 等值推送不通知、快照确实带出该 map。
- `node test/run.mjs test/card-link.entry.ts`：**ALL CHECKS PASSED**（未回归）。
- `test/session-link.entry.ts`、`test/ledger-invariants.entry.ts`：**失败，但与本次改动无关**——
  两个用例都是在真实账本 `~/.dsh/task-board/ledger-v2.json` 上做的时点断言
  （D 段断言所有任务 `createdBySessionId === undefined`；invariants 把真实账本第一张卡
  手动移到 `done`）。用改动前的 `src` 快照跑同样的入口，失败点一字不差，属既有环境漂移。
- `node build.mjs`：契约自检通过（导入面 / 导出面 / ModuleLoader 外壳 / id / CSS 作用域改名）。
- **真实 GUI 端到端**（Playwright + `/plugins/.../client.js` 重载）：

  | 观察点 | 结果 |
  | --- | --- |
  | 运行中的探针卡 | `data-status="running"`、`data-runtime="running"`、徽标文本 `运行中`、tooltip「这个任务的会话正在执行。」 |
  | 同一张卡的标签 | `探针` / `临时` 两枚徽标照常渲染（进行中卡片保留标签行） |
  | 泛化文案让位 | 不再残留空的 `.cardRunningLabel` 元素（已修一次） |
  | aria-label | `… · 运行中 · 标签 探针, 临时` |
  | 详情页 | 列徽标 `进行中` + 实时徽标 `运行中`（`data-dsh-part="detail-state"`） |
  | 卡片结算后 | `data-runtime` 与徽标一起消失（不显示已结算卡片的会话现状） |
  | 紧凑密度 | 原先不渲染标签的 `done` 列紧凑卡，现在都带 `data-dsh-part="card-tags"` 标签行 |

  探针卡跑完即删，看板恢复原样；该验证真实创建过两个一次性会话
  （`session-8547940e-…`、`session-d149ef05-…`），如需清理请自行在会话列表删除。

## 验证记录（2026-10-14：已验证泳道 + 人工验证 + git/gerrit）

- `pnpm build`：exit 0、**0 warning**；`lib/index.js` 外部依赖面未变（新增用到的
  `node:child_process` 本就在外部面里）。产物核对：`refs/for/` 出现 2 次，
  `GIT_TERMINAL_PROMPT` 与 `gitRemote` 均已入 `lib/index.js`；
  `grep -c '已验证' lib/client.js` → 5。产物里 agent 工具的动作枚举
  `"move-todo" … "record-external-outcome"` **不含**任何 verify 动作，
  而状态过滤枚举含 `"verified"`。
- 测试入口（`node test/run.mjs test/<entry>.ts`）：

  | 入口 | 结果 |
  | --- | --- |
  | `card-link` / `card-state` | 绿（未回归） |
  | `git-gerrit`（新） | 绿：argv 逐条断言（零 force）、`refs/for/<分支>` 指向新提交而 `refs/heads/<分支>` 未动、**失败的 hook 不得被读成提交成功**、超时与看门狗、子进程 env 断言 |
  | `verify-flow`（新） | 绿：六列顺序、`canVerifyTask` 边界、真账本上 `done→verified` 成功 / `todo→verified` 与 `move→verified` 被拒 / `verified→done` 可撤回、真 `HostService` 上四条服务层拒绝 |
  | `ledger-invariants` / `session-link` | **红，但与本次改动无关**：两用例在真实账本上做时点断言（前者把真实账本第一张卡手动移到 `done`，而它已经是 `done`）。用改动前的 `src` 快照建隔离树复跑，**失败点逐字相同**；本次未改 `MANUAL_STATUSES`（与备份逐字节一致） |

- **账本零副作用**：跑完全部测试后 `~/.dsh/task-board/ledger-v2.json` 的 sha256 与跑前
  完全一致（`9c3a2689…`），revision 仍为 49、6 张卡仍全为 `done`。那两个用例都把真实账本
  `copyFileSync` 到 tmpdir 再操作。
- **边界审计**：本次共改动 21 个文件，全部落在三个工作包的授权范围内；
  `build.mjs`、`lib.published/**`、`src/host-routes.ts` 未被触碰。

## 已知未验证项

- **「已验证」泳道的浏览器端到端没做**：六个新列、两侧细条折叠、验证弹窗与两个勾选框
  只有静态走查 + 纯函数断言（本机无 react-dom，做不了真实 DOM 渲染测试）。
  更重要的是**宿主进程里跑的还是旧插件**：本机 `dsh web` 在我改代码之前就已启动，
  它内存里的 `HostService` 没有 `case 'verify'`。所以**在重启 `dsh web` 之前刷新浏览器，
  会拿到新客户端却配旧宿主**——列与折叠是客户端逻辑会正常显示，但点「验证通过」
  会被旧宿主当非法动作拒绝。**请先重启 `dsh web`，再用验证按钮。**
- **`approval` / `question` / `stopped` 三种状态的"活体"验证没做**：本机当前的审批策略是
  `never`（等待审批会被自动拒绝而不弹面板），构造一次真实的待审批/待回答场景会打断真人
  对话，代价过高。这三种状态由纯派生测试覆盖，且与已实测的 `running` 走同一条
  `sessionStatus → controller → 卡片` 链路（同一张 map，只是取值不同）。
- **宿主进程内的真实加载**：需要重启 DSH 才会走新解析路径。在没有重启的前提下，
  能验证的是「ESM 加载 + 导出面 + 解析候选顺序」，不是「运行中的进程真的换了副本」。
  （浏览器半已实测：改完 `pnpm build` 后刷新页面即生效，`rev=` 查询串会随产物变化。）
- **`pnpm install` 的副作用**：profile 的 `allowBuilds` 会让 native 构建脚本重跑，
  `cpu-features`（ssh2 的可选加速依赖）在这种环境里 gyp 编译失败、包被移除。
  pnpm store 里没有任何 `cpufeatures.node`，也没有 side-effects 缓存，说明它在本机
  从未构建成功过，因此这不是本次引入的回归；`ssh2` 仍能正常加载并走纯 JS 路径。


