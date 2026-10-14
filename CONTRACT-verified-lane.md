# 冻结契约：已验证泳道 + 人工验证 + git/gerrit 推送

本文件是本次改造的唯一接口契约。三个并行工作包（A 核心与 Host、B 客户端 UI、C git 子系统）
按此文件各自实现，**任何一方都不得单方面改动本文件中的签名/字面量**；确需变更先在回报里提出。

## 0. 目标行为（已与用户确认，勿自行发挥）

1. 列顺序固定为：`待规划` → `待办` → `进行中` → `已完成` → `已验证` → `已失败`。
   - 新增 `verified`（已验证）列，位于 `done` 与 `failed` 之间。
   - `待规划`(backlog) **保留**（不删除状态），但**默认折叠成细条**贴在**最左**；
     `已失败`(failed) **默认折叠成细条**贴在**最右**；点击细条**就地展开/收起为正常列**（不做浮层）。
2. 只有**人**在看板上点「验证通过」按钮，才能把卡从 `已完成` 推进到 `已验证`：
   - 拖拽不能把卡放入 `已验证`；agent 工具也不提供验证动作。
   - 人工验证**只改状态**，不记录验证人/时间/备注。
   - 从 `已验证` 可以手工拖走（例如拖回 `已完成`，用于撤回误验证）。
3. 点「验证通过」时弹窗，含**两个独立勾选框**：`自动 commit`、`自动 push 到 gerrit`。
   - 两个开关**默认关闭**，并记住上次选择（localStorage）。
   - 执行顺序：先 commit（若勾选）→ 再 push（若勾选）→ **两步都成功后才把状态置为 `已验证`**。
   - 任一步失败：状态**保持 `已完成`**，错误信息回显在弹窗里。
4. commit 口径：在卡片绑定工作区执行 `git add -A` + `git commit -m <信息>`，
   **提交该工作区全部未提交改动**（不做文件级筛选）。
   提交信息：`<卡片标题> (#<卡片ID>)`。
5. push 口径：`git push <remote> HEAD:refs/for/<当前分支>`，分支名取**工作区当前分支**
   （`git rev-parse --abbrev-ref HEAD`）。远端默认 `origin`，可通过配置项 `gitRemote` 改。
   **绝不 force push。**

## 1. A 包 — 核心状态机与 Host 语义

### 1.1 `src/core/tasks.ts`

```ts
export type TaskStatus = 'backlog' | 'todo' | 'running' | 'done' | 'verified' | 'failed'

/** 六个列，显示顺序即此顺序。 */
export const COLUMNS: readonly { status: TaskStatus; label: string }[] = [
  { status: 'backlog', label: '待规划' },
  { status: 'todo', label: '待办' },
  { status: 'running', label: '进行中' },
  { status: 'done', label: '已完成' },
  { status: 'verified', label: '已验证' },
  { status: 'failed', label: '已失败' },
]

/** 默认折叠成细条的两列：最左、最右各一。仅表现层使用。 */
export const COLLAPSED_COLUMNS: readonly TaskStatus[] = ['backlog', 'failed']

/** 已归档/已失败/已完结之外的列…… 在既有常量上增补 'verified'： */
// ARCHIVABLE_STATUSES: ['backlog', 'todo', 'done', 'verified', 'failed']
// ALL_STATUSES:        ['backlog', 'todo', 'running', 'done', 'verified', 'failed']
// MANUAL_STATUSES 保持不变：['backlog', 'todo', 'running', 'done', 'failed']
//   —— 'verified' 不是手工目标列；但 canMoveManually 的 from 不受限，
//      所以「从 verified 拖回 done」天然合法，无需额外放行。
// RUNNER_SETTLE_STATUSES 不变：['done', 'failed']
```

新增纯谓词（本文件内实现）：

```ts
/** 一张卡此刻是否可以被人工验证通过：只有落在 'done' 且不归档、无未结算执行的卡。 */
export function canVerifyTask(task: TaskRecord): boolean
```

### 1.2 `src/core/use-cases/task-verify.ts`（新文件）

纯账本转移，不做持久化、不发通知（与 `task-update.ts` 同构）：

```ts
export interface VerifyTaskResult {
  applied: boolean
  error?: string
  tasks: readonly TaskRecord[]
}

/** 把 id 对应的卡从 'done' 置为 'verified'（withStatus 语义，盖新 updatedAt）。 */
export function applyVerifyTask(
  tasks: readonly TaskRecord[],
  id: string,
  now: number,
): VerifyTaskResult
```

拒绝条件（返回 `applied: false` 并给 `error`）：找不到卡 / 卡已归档 / 有未结算执行 /
`canVerifyTask(task)` 为 false（例如卡不在 `'done'`）。

### 1.3 `src/protocol.ts`

动作联合新增一支，并让既有 parser 接受它（布尔严格 `=== true` 归一）：

```ts
| { kind: 'verify'; taskId: string; commit: boolean; push: boolean }
```

### 1.4 `src/core/controller.ts`（浏览器侧控制器）

```ts
verifyTask(id: string, options: { commit: boolean; push: boolean }): void
```

实现方式与既有 `moveTask` 同构：`void this.commitRemote({ kind: 'verify', taskId: id, commit: options.commit === true, push: options.push === true }, id)`。

### 1.5 `src/host-service.ts`（**异步编排层**，git 只能在这里跑）

硬约束：`host-ledger.ts` 的 `private apply(action, initiator)` 是**同步**方法，
**不得**在其中执行 git。git 编排必须放在 `HostService`：

- `apply(...)` 的重载需要把 `verify` 归入 **Promise 分支**：
  - `Extract<TaskBoardAction, { kind: 'extension-action' | 'verify' }>` → `Promise<TaskBoardSnapshot>`
  - 其余（`Exclude<...>`）→ 同步 `TaskBoardSnapshot`
- 新增 `private async handleVerifyAction(action, initiator?): Promise<TaskBoardSnapshot>`：
  1. 用 `this.ledger.getTask(taskId)` 取卡；卡不存在/已归档/有未结算执行 → 抛错（文案与账本一致）。
  2. `canVerifyTask(task)` 为假 → 抛错 `only a settled done card can be verified`。
  3. 解析工作区绝对路径：
     `this.workspaceRegistry?.list().find(w => String(w.id) === task.workspaceId)?.path`。
     卡片没有 `workspaceId` 时，**沿用 runner 的回退口径**（见 `HostExecutionRunner`
     的 `mostRecentWorkspaceId` / `withInheritedWorkspace`，host-service.ts:389）。
     解析不到工作区 → 抛错（不要静默跳过 git 步骤）。
  4. 需要 git 时（`commit || push`）调用 C 包模块：
     `const result = await runGitSync({ workspacePath, message: \`${task.title} (#${task.id})\`, commit: action.commit, push: action.push, remote: gitRemote(), timeoutMs: GIT_SYNC_TIMEOUT_MS })`
     失败（`!result.ok`）→ 抛错，错误文本带上 `result.error`（可附 `result.output` 尾部）。
     成功或本来就不需要 git → 继续第 5 步。
  5. 走既有 commit 路径执行账本动作 `{ kind: 'verify', taskId, commit: false, push: false }`
     （即账本只负责状态转移，不再碰 git），返回快照。
- `GIT_SYNC_TIMEOUT_MS` 建议 120000，常量放本文件。
- 路由层 `src/host-routes.ts:211` 已经是 `await service.apply(...)`，**无需改动**。

### 1.6 `src/host-ledger.ts`

在动作 switch 里新增 `case 'verify'`：守卫（找不到 / 已归档 / 有未结算执行）后调用
`applyVerifyTask`；`applied === false` 时抛 `error`。**不在此处调用 git。**

### 1.7 `src/host/agent-tools.ts`

- `task_board_list` 的 `status` 枚举与 `task_board_manage` 的相关枚举：把 `'verified'`
  加入**读取类**过滤枚举（`task_board_list` 的 `status`）。
- **不要**新增任何验证类动作：`task_board_manage` 的 action 枚举**保持不含**
  `move-verified`/`verify`；`move-backlog` 等既有动作全部保留（backlog 未删除）。
- `task_board_get`/`manage` 文案里描述列的地方，若列举列名，需与六列一致。

### 1.8 `src/index.ts` 配置

- `Config` schema 新增 `gitRemote`（字符串，默认 `'origin'`），命名与既有
  `goalVerificationModel` 等字段同风格；`ConfigInput` 同步。
- 导出 `export const DEFAULT_GIT_REMOTE = 'origin'`。
- `applyImpl` 里按 `readConfigField(config?.gitRemote, DEFAULT_GIT_REMOTE)` 读取，
  并把 `gitRemote` 透传给 `HostService`（构造参数新增一个可选 `gitRemote?: () => string`，
  与其他 `setConfiguration` 风格保持一致即可）。

### 1.9 `test/verify-flow.entry.ts`（新测试入口）

必须覆盖：`done → verified` 合法；`todo → verified` 被拒；`canMoveManually(todo,'verified')`
为假；`canMoveManually('verified','done')` 为真；`ARCHIVABLE_STATUSES`/`ALL_STATUSES` 含
`'verified'`；`COLUMNS` 顺序恰为上述六列；无未结算执行的判断。

## 2. B 包 — 客户端 UI

只动 `src/client/**`。**不要**改 `src/core/**`、`src/protocol.ts`、`src/host-*`、`src/index.ts`。

1. `TaskBoard.tsx`：
   - `GROUPED_COLUMNS` 增补 `'verified'`（与 `done`/`failed` 一样按时间分组、默认紧凑）。
   - 折叠列：`backlog` 渲染在最左（`COLUMNS` 首位）、`failed` 在最右。
     `COLLAPSED_COLUMNS`（从 `core/tasks.ts` 导入）中的列，默认渲染为细条：
     竖排标题 + 卡片计数徽标；点击**就地展开**为正常列（宽列 + 正常卡片），再点收起。
     展开状态用 `localStorage` 持久化，写法与既有 `readCompactColumns`/`compactColumns` 同构。
   - 折叠状态下该列**不作为拖拽放置目标**；展开后按既有 `isManualDropTarget` 逻辑处理。
   - `verified` 不是手工拖拽目标（`MANUAL_STATUSES` 已不含它，沿用 `canMoveTask` 即可）。
2. `TaskCard.tsx` + `TaskDetail.tsx`：处于 `已完成` 的卡渲染「验证通过」按钮，
   点击打开验证弹窗。非 `done` 卡的按钮隐藏。
3. `VerifyTaskModal.tsx`（新）：两个勾选框「自动 commit」「自动 push 到 gerrit
   (refs/for/<当前分支>)」，默认关，选择记入 `localStorage`（键名自定，写在文件顶部常量）。
   确认 → `controller.verifyTask(taskId, { commit, push })`；失败时把 host 返回的错误
   显示在弹窗内，弹窗**不关闭**；成功则关闭。等待期间按钮进入 pending 态、禁止重复提交。
4. `status-key.ts`：`verified: 'board.status.verified'`。
5. `card-view.ts`：`STATUSES` 增补 `'verified'`（`card-view.ts:249` 的常量）。
6. `locales.ts`：新增 zh/en 文案，至少覆盖
   `board.status.verified`（已验证 / Verified）、`status.move.verified`（移到已验证 / Move to Verified）、
   验证按钮、弹窗标题、两个勾选框、执行中/失败文案、折叠列的展开/收起 aria 文案。
   **保留** `board.status.backlog` 与 `status.move.backlog`。
7. `board.module.css`：细条折叠列样式（竖排文字用 `writing-mode: vertical-rl`）、
   验证按钮与弹窗样式。沿用既有 CSS Module 命名与 `data-dsh-part` 约定。
8. `settings-form.ts`：新增「gerrit 远端名」文本框，对应配置项 `gitRemote`（默认 `origin`），
   与既有设置项同构。
9. `host-api.ts` / `service.ts` / `client/index.ts`：把 `verify` 动作接到既有传输与
   controller 上（`verifyTask` 由 A 包在 `core/controller.ts` 提供，直接调用，不要另写一份）。

## 3. C 包 — git/gerrit 子系统

只动 `src/host/git-gerrit.ts`（新建）与 `test/git-gerrit.entry.ts`（新建）。
**不要**改其他任何文件（A 包负责把它接进 host-service）。

```ts
export interface GitSyncRequest {
  /** 卡片绑定工作区的绝对路径（Workspace.path）。 */
  workspacePath: string
  /** 提交信息。 */
  message: string
  /** 执行 git add -A + git commit。 */
  commit: boolean
  /** 推送 HEAD 到 refs/for/<当前分支>。 */
  push: boolean
  /** 远端名，默认 'origin'。 */
  remote: string
  /** 整个序列的硬超时。 */
  timeoutMs: number
}

export interface GitSyncResult {
  ok: boolean
  committed: boolean
  commitSha?: string
  /** 工作区干净、没有可提交内容（此时 committed 为 false 且 ok 仍为 true）。 */
  nothingToCommit?: boolean
  pushed: boolean
  branch?: string
  refspec?: string
  error?: string
  /** 失败步骤的 stdout+stderr 合并尾部（截断，建议 4KB）。 */
  output?: string
}

export function runGitSync(request: GitSyncRequest): Promise<GitSyncResult>
```

实现要求：
- 用 `node:child_process` 的 `spawn`／`execFile`，**数组式 argv，绝不拼 shell 字符串**，
  `cwd` 一律用 `workspacePath`（不要依赖 `-C` 与相对路径）。
- 步骤：① `git rev-parse --abbrev-ref HEAD` 取分支；得到 `HEAD`（detached）→ 报错，
  不猜分支名。② 若 `commit`：`git add -A` → `git commit -m <message>`；
  没有可提交内容（退出码非 0 且输出含 `nothing to commit` / `no changes added`）
  → `nothingToCommit: true`，**不算失败**。③ 若 `push`：
  `git push <remote> HEAD:refs/for/<branch>`，把 refspec 记进 `refspec`。
- **禁止** `--force`、`--force-with-lease`、`-f`。
- 任一步非零退出：`ok: false`，`error` 写成可读的一行（含步骤名与退出码），
  `output` 附合并输出尾部（截断）。
- 超时按 `timeoutMs` 处理，超时视为 `ok: false`。
- 只读判断、不修改工作区其他内容；不改 git config、不做 `checkout`/`stash`/`clean`。

`test/git-gerrit.entry.ts` 要求：
- 在 `os.tmpdir()` 下建一个临时 git 仓库（`git init`、`git config user.email/user.name`），
  断言：干净仓库 + `commit: true` → `nothingToCommit: true` 且 `ok: true`；
  有改动 + `commit: true` → `committed: true` 且拿到 `commitSha`；
  `push: false` 时不触碰远端；detached HEAD → `ok: false`。
- 断言 refspec 形状为 `refs/for/<branch>`：用一个**本地 bare 仓库当远端**
  （`git init --bare`，`remote add origin <bare>`）验证 `push: true` 时 refspec 字符串正确。
  **事实更正（C 包实测，原契约此处写错）**：git 并不拒收 `refs/for/*`，它会把这个名字照字面
  存进远端。因此断言改为更强的方向：`refs/for/<branch>` 指向本次新提交，而 `refs/heads/<branch>`
  仍停在旧提交 —— 以此证明没有退化成普通分支推送。测试**不得**发起任何网络访问。
- 测试必须在无 git 凭据、无网络的机器上可重复通过。

## 3.1 C 包复审追加要求（调度者裁决，优先级高于 §3 的实现自由度）

C 包第一轮通过了自检，但复审发现两处必须改：

1. **`committed` 不得由 git 的散文输出推断。**
   第一轮用「commit 退出码非零 + 输出里出现 `[name] ...` 形状的行 → 仍算 committed」的
   启发式。这是**假阳性**：一个失败但打印了方括号行的 hook（例如 `[my-hook] checking...`
   然后 `exit 1`）会被读成「提交成功」，随后我们会在没有新提交的情况下 push，并把卡片推进
   「已验证」。
   改为**正向事实**：commit 之前记录 `git rev-parse HEAD`（首次提交前该仓库无 HEAD 时
   记为缺失），commit 之后再取一次；`committed = 后值存在且与前值不同`。
   - HEAD 前进 → `committed: true`（无论输出多啰嗦）。
   - commit 退出码非零**且** HEAD 未前进 → `ok: false` + 可读 `error` + `output` 尾部。
   - 仓库此前无 HEAD、现在有 HEAD → 视为前进。
   - **删除**按输出形状判定成功的那段逻辑。
2. **`commitSha` 必须是完整 40 位 SHA**（用第 1 条已经要取的 `rev-parse HEAD` 结果），
   不要再从 `[branch abc1234] subject` 摘要里解析缩写 id。
3. **所有 git 子进程的 env 里设 `GIT_TERMINAL_PROMPT=0`**（在模块内部设，不依赖调用方）。
   Host 进程无 TTY，缺凭据时 git 会一直等输入，白白消耗 120s 预算、最后报成超时而不是
   认证失败。保留调用方传入的其他 env 与环境继承。

追加测试（必须）：
- 一个**失败的 pre-commit hook**（打印 `[my-hook] ...` 后 `exit 1`）→ `ok: false`、
  `committed: false`；并断言仓库 HEAD 未前进。
- 一个**啰嗦但成功的 hook**（打印方括号行后 `exit 0`）→ `committed: true`，且
  `commitSha` 是 40 位。
- 断言子进程 env 里 `GIT_TERMINAL_PROMPT === '0'`。

## 4. 三个包的共同纪律

- 包名/路径不要改名；`src` 只读于构建脚本，改完必须能过 `pnpm build` 的契约自检。
- 构建：`cd /Users/lee/Documents/deepseek-harness/default-workspace/dsh-task-board && pnpm build`
- 测试：`node test/run.mjs test/<entry>.ts`
- 类型/风格：与相邻文件一致（TS、无分号、单引号、显式返回类型、注释解释「为什么」）。
- 不要引入任何新的运行时依赖（`git-gerrit.ts` 只用 `node:*`）。
