# 任务看板 ↔ 会话 双向联动

本 fork 在官方 `@linxin666/dsh-client-ui-task-board` 之上增加了**双向关联**：

- **看板 → 会话**：卡片上显示「打开关联会话」入口；**双击卡片**跳到关联会话。
- **会话 → 看板**：会话标题栏、会话名称右侧的按钮，打开看板并定位到该会话关联的卡片；多张时弹列表选一张。

## 一、关联规则（唯一真源）

| 方向 | 规则 | 实现位置 |
| --- | --- | --- |
| 卡片 → 会话 | 「最后一条**带 sessionId** 的执行」→ 无则 `createdBySessionId` → 都无则该卡片没有关联会话 | `src/client/board/card-view.ts` 的 `cardSessionId(task)` |
| 会话 → 卡片 | 卡片的任一 `executions[i].sessionId === S` **或** `createdBySessionId === S`；排序：关联时刻降序 → `updatedAt` 降序 → `id` 升序 | `src/client/session-cards.ts` 的 `sessionLinkedCards()` / `resolveSessionLink()` |

`createdBySessionId` 是宿主侧新增字段，**只在 `create` 时写入一次**：

- 取值优先级：动作的 `initiator`（宿主侧，覆盖模型侧工具调用）→ 否则 `input.createdBySessionId`（浏览器侧填当前会话）；
- 空白/非字符串丢弃；不写空串；后续任何动作都不改写它；
- **刻意不使用 initiator 承载浏览器侧会话**：initiator 会连带激活 `withInheritedWorkspace`，把未 pin 工作区的根卡片钉到当前会话的工作区，属与本需求无关的语义变化。

## 二、交互语义

| 场景 | 行为 |
| --- | --- |
| 单击卡片 | 打开任务详情浮层（**改造前语义不变**） |
| 双击卡片（250ms 窗口内两次点击） | 跳到关联会话，并把该会话在其工作区分组里**展开 + 滚动到视口内**；**不**打开详情浮层 |
| 键盘激活卡片（Enter/Space） | **立即**打开详情，不受 250ms 窗口影响 |
| 双击但无关联会话 | 不动作，显示非阻塞提示（`role="status"`，约 2.5s 自动消失，零布局位移） |
| 会话按钮：1 张关联卡片 | 直接打开看板并定位该卡片 |
| 会话按钮：≥2 张 | 弹出列表面板（`role="menu"`），每项显示标题/所在列/关联方式；点选后跳转 |
| 会话按钮：0 张 | 按钮置灰（`aria-disabled`，仍可 Tab 聚焦读 tooltip），点击无动作 |
| 会话按钮：关联卡片已归档 | 视为无关联（看板看不到归档卡，列出来就是死点击） |
| 会话按钮的可发现性 | 按钮恒带 1px `border-l3` 描边（标题栏其它图标没有），否则纯图标「静止即隐形」；置灰色用 `label-tertiary`（浅色主题 `#81858c`，对白底约 3.7:1），**不要用 `label-dimmed`（`#e1e5ee`，约 1.2:1，等于看不见）**；活动态用 `label-secondary`（`#61666b`，约 5.9:1） |

`250ms` 窗口实现在 `src/client/board/card-activation.ts`（`CARD_DOUBLE_CLICK_MS`），单元可测。

### 侧边栏联动（跳到会话之后）

只把会话选中并不等于让用户**看见**它。实测侧边栏有**三种互相独立**的隐藏机制，必须全部击破：

1. **整列收起**：外壳在收起时给栅格容器加 `[data-sidebar-collapsed]`。
2. **分组折叠**：工作区分组 `aria-expanded="false"` 时不渲染任何会话行。
3. **组内行数上限**（最容易被忽略的一种）：每个分组只渲染一个有界窗口（初始约 5–6 行），其余藏在一个「展开其余 N 个会话」按钮后面，**每点一次只多 5 行**。`默认工作区` 实测有 128 个会话，而华夏那张卡关联的会话按时间排**第 95 位**——初始窗口里根本没有这一行，点多少次分组都点不出来，硬扛按钮则需要约 18 次点击。

> 这是"已验证列点华夏卡片、左边工作区没反应"的真正原因。v1 只处理了机制 1、2，所以对第 95 位的会话必然无效。

因此跳转统一经过 `src/client/session-reveal.ts` 的 `createSessionReveal`，改为**借用侧边栏自己的搜索展开通路**：

- 侧边栏自己的搜索命中后走的是 `openSearchResult()`：它把目标会话记进 `revealSessionId`，`SessionTree` 随即自动**展开全部祖先分组**、把该组的行数上限**提到 `Infinity`**、`scrollIntoView` 滚动，最后清空 reveal id。这正是我们需要的三步，且是宿主官方实现，不依赖内部 state 直连。
- 我们的 reveal 于是：展开侧边栏（机制 1）→ 打开搜索框（点 `button[aria-label="搜索会话"]`）→ 把**会话标题**写进 `input[placeholder="搜索会话名称"]`（用原生 setter + `input` 事件，否则 React 受控组件收不到）→ 点第一个搜索结果行。
- 关键约束：**搜索只匹配标题与工作区名，从不匹配会话 id**。查询会话 id 会得到空结果。标题由 catalog 派生（`sessions.list.getSnapshot().byId[id].title`），卡片里没有，所以 `createSessionReveal` 的 deps 增加 `title(sessionId)`。
- 搜索结果行**不是**会话树行：它由另一个组件渲染，用 `searchResultRow` 类、**没有 `data-row-key`**，因此搜索态下无法按 id 认行，只能靠查询词选中、取第一条。

回落：若目标行其实已在渲染窗口内（`[data-row-key="session:<id>"]` 存在），直接 `scrollIntoView`，不打扰搜索框与用户的折叠状态。

三趟 `setTimeout(fn, 0)` 分帧（等搜索框展开渲染 → 等结果渲染 → 激活），用 pending token 去重，连点两次只留最后一次；在上面两条通路（搜索 / 直接滚动）之间是幂等的。

DOM 契约（实测，写死在 `session-reveal.ts` 顶部）：搜索框 `input[placeholder="搜索会话名称"]`、搜索开关 `button[aria-label="搜索会话"]`、搜索结果行 `[role="treeitem"][class*="searchResultRow"]`；正常树态分组头 `data-row-key="workspace:<workspaceId>"` + `aria-expanded`、会话行 `data-row-key="session:<sessionId>"`、区域 `role="tree"/"treeitem"`。

验收（实测，浏览器内对着华夏那张卡点的「打开关联会话」）：
- 修复前：分组已全部 `aria-expanded="true"`，华夏会话仍无 DOM 行；点「展开其余 61 个会话」只从 40 行涨到 45 行。
- 修复后：点一次卡片入口，`[data-row-key="session:session-582eb17c-…"]` 出现，`visible=true`、`top=517`、`aria-selected="true"`，会话行总数由 6 变成 101，搜索框已清空并回到正常「会话」树。


## 三、改动清单（相对官方 0.4.6）

宿主半（5 个，`src/`）：

- `core/tasks.ts` — `TaskRecord.createdBySessionId?`、`NewTaskInput.createdBySessionId?`、`createTask()`、新增 `withCreatedBySession()`；
- `core/store.ts` — `parseLedger()` 归一化新字段（**故意不放进 `isTaskRecordShape`**：形状校验会丢整行，可选字段不该有这种权力）；
- `protocol.ts` — create 入参白名单 + `optionalSessionId()`（≤256）+ `importedTask()` 保留该字段；
- `host-ledger.ts` — `case 'create'` 是唯一写入点；
- `host/agent-tools.ts` — 工具输出透出该字段。

浏览器半：

- `client/board/card-view.ts`（`cardSessionId`）、`client/board/card-activation.ts`（新增，250ms 状态机）、`client/board/TaskCard.tsx`（双击接线、紧凑密度也渲染会话入口、快捷动作早退时取消窗口）、`client/board/TaskBoard.tsx`（提示条）、`client/board.module.css`、`client/locales.ts`（zh/en）；
- `client/session-cards.ts`（新增，反向查找/排序/决策）、`client/SessionBoardLink.tsx`（新增，标题栏按钮 + 弹层 + 席位注册）、`client/session-link.module.css`（新增）、`client/index.ts`（注册接线 + 会话 face 单例化）、`core/controller.ts`（**两处**：`createTaskConfirmed` 把当前会话填进 `input.createdBySessionId`；`SessionsControllerFace.open` / `openSession` 增加可选 `workspaceId`，供侧边栏只展开目标分组）；
- `client/session-reveal.ts`（新增，跳转后展开目标工作区分组 + 滚动到视口内）、`client/board/TaskCard.tsx`（把 `task.workspaceId` 带给双击与会话入口）、`client/board/TaskDetail.tsx`（执行记录行跳转带上 `current.workspaceId`）。

数据库/协议：**不升 `schemaVersion`**（保持 6）。证据：校验器不拒绝未知键；`parseLedger` 是展开+逐字段修复而非重建；旧 v6 文档与含新字段的文档双向兼容。

## 四、生效方式

| 改动类型 | 生效方式 |
| --- | --- |
| 浏览器半（`src/client/**`、`src/core/controller.ts`） | `pnpm build` → **刷新页面**即生效（无需重启宿主） |
| 宿主半（`src/core/tasks.ts`、`core/store.ts`、`protocol.ts`、`host-ledger.ts`、`host/agent-tools.ts`） | `pnpm build` 后**必须重启 `dsh web`**。实测：只改 profile 补丁触发的 loader 重组**不会**重新导入已加载的宿主模块 |
| profile 接线（`cordis.patch.yml`） | 约 3 秒内热生效 |

构建：`cd <本目录> && pnpm build`（esbuild，确定性；连跑两次 sha256 相同）。

## 五、profile 接线（为什么要动它）

浏览器半默认**不是**从本包加载的：聚合包 `@linxin666/dsh-web-all/lib/client.js` 把看板的整个客户端**编译内联**在自己产物里（CSS scope `_7D6uKa`）。因此 fork 的客户端改动原本到不了浏览器。

三处改动（均有 `.bak-<时间戳>` 备份在 `~/.dsh/profiles/web/`）：

1. `package.json`：`"@linxin666/dsh-client-ui-task-board": "link:<本目录>"`（直接依赖指向 fork）；
2. `pnpm-workspace.yaml`：`overrides` 同名钉死，避免 pnpm 把 registry 副本嵌进 `dsh-web-all/node_modules` 抢先解析；
3. `cordis.patch.yml`：`- id: web-ui-task-board` + `disabled: true`，并 `insert` `- id: ui-task-board` / `name: '@linxin666/dsh-client-ui-task-board'`。

判据（浏览器实测）：卡片元素 class 从 `_7D6uKa_*` 变为 fork 产物 scope（如 `eSEyhi_*`）；`__DSH_BOOT__.entries` 出现独立条目 `@linxin666/dsh-client-ui-task-board`。

## 六、回滚

```bash
F=/Users/lee/Documents/deepseek-harness/default-workspace/dsh-task-board
P=/Users/lee/.dsh/profiles/web

# 1) 协议层（先做）：恢复聚合包持有的看板行
cp -p $P/cordis.patch.yml.bak-20261013185211 $P/cordis.patch.yml   # 约 3 秒热生效

# 2) 解析层：恢复 profile 的依赖与 overrides，然后重装
cp -p $P/package.json.bak-20261013184236        $P/package.json
cp -p $P/pnpm-workspace.yaml.bak-20261013184236 $P/pnpm-workspace.yaml
cd $P && pnpm install

# 3) 生效需重启 dsh web。fork 目录留着不影响（无任何引用）。
```

单轮回滚（只撤某一轮功能）：本目录是 git 仓库（`401b446 chore: initial commit` 为基线），
`git diff` 可看全部改动，`git stash` / 按文件 `git checkout --` 可只撤某个文件，再 `pnpm build`。

## 七、插件升级时如何重放这些改动

1. 取新版官方源码（注意：npm 上 0.4.6 的 tarball 内容与最初安装的那份**并不一致**，别把 tarball 差异当成自己的改动）；
2. 用 `git` 做三方对照：`git log`/`git diff` 得到本 fork 的改动集（上面第三节的文件清单）；
3. 把改动逐项重放到新版对应文件（宿主半 5 个 + 浏览器半 11 个路径）；
4. `pnpm build` → 浏览器刷新验证双向联动；宿主半有变更时重启 `dsh web`；
5. `lib/types/**` 是从 `lib.published/types` 复制的官方声明，**不含** `createdBySessionId`（仅影响 TS 消费者，运行期无影响）。若要同步，需要 typescript 工具链重新生成。

## 八、验收证据（摘要）

- 构建：`pnpm build` 退出码 0，两次 sha256 相同；`lib/index.js` 不含任何客户端符号（本次浏览器半改动不影响宿主产物）。
- 单测（`node test/run.mjs <entry>`，驱动真实 `src`）：会话解析 7 例、双击状态机 9 例、宿主半落库/优先级/写一次/空白丢弃/旧账本兼容/往返不丢、反向查找与排序 12 例 —— 全部 PASS。
- 真实浏览器（Playwright，真实鼠标事件）：
  - 双击有会话卡片 → 看板关闭 + 会话树选中 `session:<该执行会话>`；双击无会话卡片 → 提示出现、不跳转、约 2.5s 消失；
  - 单击卡片 → 250ms 后打开详情；键盘 Enter → 立即打开；
  - 紧凑密度下会话入口存在（改造前缺失）；
  - 会话按钮：1 张 → 直接跳到该卡详情；7 张 → `role="menu"` 面板 7 项、点选后跳转并关面板；0 张 → 置灰可聚焦、点击无动作；
  - **正向端到端**：双击一张「从未执行、只靠 `createdBySessionId` 关联」的卡片 → 跳到它的创建会话。
  - **侧边栏联动端到端**：先把 16 个工作区分组**全部**折叠（`aria-expanded` 全为 `false`），再双击 `space5` 的卡片 → 跳转后**只有 `space5`** 变为 `true`，其余 15 组仍为 `false`；目标行 `session:session-97b6e942-…` 出现且 `getBoundingClientRect()` 落在视口内（top 517 / bottom 549，视口高 720）。
    - 首版实现曾用 `querySelector('[data-row-key^="workspace:"]')` 取**第一个**分组，实测第一个恰为已展开的「默认工作区」⇒ 未点击、`space5` 始终折叠、行不出现。改为按 `workspaceId` 精确定位后才通过；这一条是实测抓到的，不是推断。

## 九、已知限制

1. **250ms 窗口是每张卡片独立持有的**：点 A 卡后在 250ms 内双击 B 卡（触发跳转关看板）时，A 的窗口不会互相取消。实际上关看板会卸载卡片、`useEffect` 清理会取消窗口，所以观察不到脏状态；但这是**隐式**保护，不是设计保证。要彻底消除需把窗口所有权上提到看板层。
2. **无 transport 的本地 update 路径**（`src/core/use-cases/task-update.ts`）没有字段白名单，理论上多余键会被 spread 写入。实际不可达（`TaskUpdatePatch` 不含该字段，全仓库无此类调用），未做加固。
3. **会话的全部关联卡片都被归档时**，按钮按「无关联」置灰，tooltip 仍写「本会话还没有关联卡片」，措辞不够精确。
4. **本部署没有 typescript**：改动未经 `tsc --noEmit` 类型检查（esbuild 只剥离类型），靠运行期用例 + 与官方源码的行为不变量对照兜底。
5. 页面里仍留有聚合包注入的看板 CSS（`_7D6uKa_*`，约 339 条规则），无元素使用，属死规则。
6. `node_modules/@linxin666/.ignored_dsh-client-ui-task-board/` 是 pnpm 因 `link:` 挪开的已发布副本，无任何解析路径指向它，可忽略。
7. ~~`test/session-link.entry.ts` 里有一条断言「真实账本中不存在 `createdBySessionId`」……~~ **已修**：该测试与 `ledger-invariants.entry.ts` 已改为只读 `test/fixtures/ledger-v6-snapshot.json`（合成、pin 了 sha256），不再依赖真实用户数据；真实账本在跑套件前后 sha256 不变。

## 十、会话 ↔ 任务状态强绑定

**目的**：一个任务常常一轮问答做不完（建卡时预见不到），所以只要你在它的会话里继续问答，卡片就回到「进行中」；本轮结束再按结果结算。

| 项 | 规则 |
| --- | --- |
| 挂点 | `agent/pre-step`（waterfall 中间件，`step === 1`）——它在模型调用**之前**被 await，所以能真正把这一轮卡住；`turn/start` 只是广播事件、不可拦截，故不用 |
| 收尾 | `session/event` 里的 `turn/end`（**不是** cordis 生命周期事件） |
| 候选卡片 | 与该会话关联的卡（任一 `executions[].sessionId` 或 `createdBySessionId` 命中） |
| 排除 | 已归档；**有未结束执行**（归 runner 所有） |
| `verified` | **不排除**——在被验收的卡的会话里继续问答，它就回到进行中，同时「已验证」标签被释放（本轮结束进 `done`）。这是 2026-10-22 的用户决定 |
| runner 驱动的一轮 | **整轮跳过**：本会话名下存在未结束执行时不弹、不移、不结算（那张卡由执行结果自己结算；执行会话一般不是用户正在看的会话，问了只会白耗预算） |
| 0 张候选 | 什么都不做 |
| 1 张候选 | 直接置 `running`，不弹窗 |
| ≥2 张候选 | 阻塞模态（`role="alertdialog"`，列出标题/所在列/关联方式 + 倒计时 + 「本轮不关联」）；**选完才继续回答** |
| 粘性 | 选定后本会话后续轮次直接沿用，不再询问（只由**人工选择**写入，超时/回退不写） |
| 本轮结束 | `completed` → `done`；其余（`error`/`aborted`/`interrupted`/`blocked`/`max-tokens`/`forked`/未知）→ `failed` |
| 存储 | 粘性记忆在侧车 `~/.dsh/task-board/session-choice.json`（原子写，上限 500 条），**ledger 仍 `schemaVersion: 6`** |

**三道安全阀（缺一不可，否则会挂死对话）**
1. `payload.signal` 取消 → 立即放行；
2. 墙钟上限 `BINDING_WAIT_MS = 12s` → 到期按「最近关联的一张」回退；
3. **当时没有任何浏览器订阅者 → 一 tick 都不等**（无界面部署直接回退）。

绑定链路上的任何异常只 `warn`，`return await next()` 恒执行——**绝不让一轮对话失败**。

**实测过的关键事实**（2026-10-22，重启后）
- 单候选会话发一条消息：board `revision` +2（进 running 一次、出 running 一次），卡片 `updatedAt` 落到本轮结束时刻 ⇒ 绑定确实在跑。
- 因此「看不到正在执行」的成因是 `verified` 被排除（当时 23 张卡里 12 张是 verified），已于本次修正。

### 10.1 状态徽章（「运行中 / 待回答」）的准入

`cardRuntimeState()` 原来只对「有未结束执行」的卡片显示徽章——而绑定**只改泳道、不建执行**，于是被绑定的卡片永远不显示徽章。现改为：

```ts
if (archived || states === undefined) return undefined
if (task.status !== 'running' && !hasOpenExecution(task)) return undefined   // ← 新增 status 分支
return states.get(cardSessionId(task))
```

- 卡片在「进行中」就显示会话的**真实**实时状态：`running`→运行中、`question`→待回答、`approval`→需要确认、`stopped`→已停止；
- 已结算的卡片仍然不显示（避免「同一会话复用于后来的运行」时显示过期状态）；
- 徽章同时驱动视觉与 `aria-label`。

### 10.2 真机验证暴露并修复的两个缺陷

| # | 缺陷 | 现象 | 修法 |
| --- | --- | --- | --- |
| B1 | `session/event` 的事件是 `{type, seq, time, data}`，载荷**包在 `data` 里**；接线读的是 `event.turn / event.reason` ⇒ 恒 undefined ⇒ 结算 key 成 `${sid}#undefined`，永不匹配 | 卡片被拉进进行中后**永不结算** | 抽出纯函数 `readTurnEnd()` 只认 `data`；新增回归用例，含「把载荷写在事件外层必须解不出」的负向断言 |
| B2 | `HostTaskLedger.finalizeReadyRuns()` 的崩溃恢复扫描：状态 running + 无未结束执行 + 历史执行有结果 ⇒ 按历史结果折叠 | 绑定拉起后**同一事务内**被打回 `done`（毫秒级闪烁），用户看到「什么都没变」 | 判据收紧为「**自上次执行闭合后没被动过**」：`if (task.updatedAt > (latest?.endedAt ?? 0)) continue`。崩溃场景 `updatedAt === endedAt` 仍折叠；绑定/人工拖动 `updatedAt` 更新 ⇒ 跳过。顺带修掉「手动把已结算卡拖进进行中会被弹回」 |

另加**第二条结算链路**（`agent/status` 的 `idle`）：idle 时直接读该会话日志里最新的 `turn/end`，取出 `turn` 与真实 `reason`。两条链路互为兜底，谁先结算谁生效，后到者发现没有待结算记录即不做任何事（实测日志 `via:"turn/end"` 先结算，`via:"agent-idle"` 随后 `hasActed:false`）。

**端到端实测（2026-10-22 16:38，重启后，卡片「做一个漏洞扫描工具站…」）**

```
账本逐秒                                    宿主日志
T+0.0s  done     rev 253
T+8.5s  running  rev 254   ←────────────  08:38:46.217 move {done → running}
T+14.1s running  rev 254                  （sleep 12 期间稳定停在进行中，未被打回）
T+19.8s running  rev 254
T+25.4s running  rev 254
T+31.0s done     rev 255   ←────────────  08:39:08.508 afterTurn{hasActed:true} → move {running → done}
```

看板 DOM 同一时刻：轮次中 `data-status=running` 且状态徽章显示 **「运行中」**；轮次结束后 `done`、徽章消失。

### 10.3 已知限制（本节新增）

1. **轮次死于未记录 `turn/end`**（例如页面被强行关掉、进程被杀）：日志里没有可读的结束记录，`agent-idle` 兜底读到的是**上一轮**的结束（`hasActed:false`），因此那张卡会停在进行中，直到人工拖动或一次真实执行接手。
2. **`move → running` 与上一次 settle 落在同一毫秒**时 `updatedAt === endedAt`，仍会被判为崩溃残留而折回。实际不会出现（绑定在轮次开始、结算在轮次结束），真撞上表现为「中间态立刻被打回」，不会误判成别的坏结果。

### 10.4 子 agent 仍在跑时不得结算（2026-10-28 新增）

**问题**：父会话这一轮的 `turn/end` 只说明**父 agent 停止说话了**，不说明它派出去的 agent 也结束了。子 agent 有自己的 loop 和自己的轮次。实测在两条路径上都出现过「子 agent 还在跑，卡片已被判完成」。

**规则**：**任意层级**的后代 agent 仍处于 `running` 时，一律不结算，卡片留在「进行中」；最后一个后代转为 `idle` 之后才结算。

判定放在**一处**，两条结算路径共用（`src/core/subagent-tree.ts`）：

```ts
export function hasBusyDescendant(root: string, agents: Iterable<LiveAgentState>): boolean
```

- 父子关系取自会话头：`dsh-subagent` 建子会话时写 `parentSession: <父会话头 id>`、`origin: 'subagent'`，因此**多级（子 agent 再派子 agent）**也能判；
- `root` 自身不计入（问这个问题时它自己的轮次刚结束）；
- BFS + `visited`（以 root 播种）⇒ 脏数据里的环/自指不会死循环；
- 同一会话出现多条状态记录时「任一 busy 即 busy」⇒ 陈旧的 idle 记录不能成为提前结算的理由。

| 路径 | 修法 |
| --- | --- |
| A 会话绑定 | `settleFrom()` 发现后代 busy ⇒ 只把「待结算」记入 `deferred`；任一 agent 转 `idle` 时遍历 `deferred` 重试，放行后仍是唯一结算入口 `binder.afterTurn()` |
| B runner 执行 | `reconcileExecutions()` 在 `pending` 分支之后、强制验收与 `settleAndNotify` **之前**：后代 busy ⇒ `continue`（只跳过本轮巡检，执行保持 open，卡片留进行中）；下一轮巡检自然重试 |

活 agent 表来自 `agent/status`（**running 与 idle 两个方向都记录**，payload 的 `agent.session.header` 提供 `parentSession`）。

**真机实测（两条路径都验过）**

```
路径 B（runner 执行，探针卡 8e8b9548）
  01:40:04  执行开始
  01:40:10  父轮结束（父会话最后一次写入）
  01:42:23  子 agent turn/end (completed)
  01:42:26  执行结算 succeeded   ← 子 agent 结束后第一次巡检（周期 5s）
  ⇒ 比「父轮一结束就结算」晚了 142 秒

路径 A（会话绑定，卡 57e04fd8）
  01:37:51  轮次开始，卡片被拉进进行中
  01:37:55  子 agent 会话 turn/start
  01:38:40  子 agent turn/end (completed)
  01:38:40  卡片结算为已完成       ← 与子 agent 结束同一秒
```

**已知限制**：子 agent 若永不转为 `idle`（崩溃、被强杀），其父卡会一直停在进行中，直到人工拖动或一次真实执行接手——与 10.3 第 1 条同类，是「诚实状态」而非错误状态。

## 十一、结算列跟随最新执行结果

会话绑定原先按 turn/end 的 kind 直接定列（`completed → done`，其余一律 `failed`），于是「失败泳道的卡片重跑成功后又被一轮 `aborted` 打回失败」。现在改由 `core/session-binding.ts` 的 `settleColumnFor(task, kind, from)` 决定，`from` 是这一轮把卡片拉进「进行中」之前它所在的列（记录在 binder 的 `acted` 里）：

| 情况 | 结算列 |
| --- | --- |
| 最新一次执行有 verdict（`succeeded` / `failed`） | 按该 verdict，经 `tasks.ts` 的 `settledStatus()` 推导（`succeeded` + 已启用定时 → `todo`，这是既有约定） |
| 无 verdict + `completed` | `done` |
| 无 verdict + `error` | `failed` |
| 无 verdict + 其它 kind（`aborted` / `blocked` / `max-tokens` / `interrupted` / `forked` / 未知） | 回滚到 `from`（用户中断或超预算不是失败） |
| 无 verdict + kind 为 `undefined` | `failed`（没人解释的结束不能当作完成） |

最新执行若只有 `cancelled`，同样视为「没有 verdict」，走上面的回滚规则。

**已知限制**：`from` 为 `verified` 时纯函数确实返回 `verified`，但账本的手工移动守卫不接受 `verified` 作为目标列（`MANUAL_STATUSES` 不含它，人工验收只能从 `done` 经 verify 动作进入），因此这条回滚**落不了盘**，卡片会停在「进行中」并在宿主日志留一条 warn。要真正恢复该列需要改账本守卫，本模块不具备该权限。

**处置（已落地）**：不再指望账本放行，而是在 binder 里先判定「这次回滚是不是根本没变化」——`settleColumnFor` 返回的列与 `acted.from` 相同且该列不是合法移动目标时，直接不写账本（`src/host/session-binder.ts` 的 `afterTurn` 用 `canMoveManually` 判定）。语义是不改动任何东西：卡片在一轮被取消的对话里既没被判失败、也不会被凭空提升回 `verified`，重新验收仍须人工执行。这样既不产生 warn 噪音，也不需要放宽账本守卫。
