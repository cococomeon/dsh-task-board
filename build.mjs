/**
 * 构建 @linxin666/dsh-client-ui-task-board 的本地 fork。
 *
 * 这个插件是「双面包」（dual-face），和 workspace 里 dsh-notify / dsh-branch-hover
 * 同一工程风格，只是它体量大得多（src 约 1.9 万行 TS/TSX，因此这里用打包器而不是
 * 逐文件拷贝）：
 *
 *  1. 宿主半 `src/index.ts` → `lib/index.js`：bundled ESM，`packages: 'external'`
 *     保留所有裸导入（node 内建 + @deepseek-ai/*），与官方 lib/index.js 的对外
 *     导入面一致。宿主侧 SDK 由 DSH 的 profile 解析层提供，不打进产物。
 *  2. 浏览器半 `src/client/index.ts` → `lib/client.js`：bundled CJS，再包进
 *     `window.__ModuleLoader__.load({ id, factory })` 外壳。只有 `react` 与
 *     `react/jsx-runtime` 走 factory 的 require（平台基线），其余全部内联。
 *  3. CSS Modules（4 个 *.module.css）：用 esbuild 的 `local-css` 做作用域改写，
 *     构建期把类名/关键帧名加上 `_<hash>` 前缀（与官方 `_7D6uKa_board` 同形），
 *     并把整份样式表作为字符串注入 factory 顶部的一个 <style> 标签。
 *
 * 产物只写 `lib/index.js` 与 `lib/client.js`（+ 可选复制类型声明）。`src/` 只读。
 *
 * @module dsh-task-board/build
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(ROOT, 'src')
const LIB = path.join(ROOT, 'lib')
const PUBLISHED = path.join(ROOT, 'lib.published')
const PKG = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'))

/** Plugin id. Must stay the package name: the loader row, `dsh.client` and the
 *  browser module registry all key on it. */
const ID = PKG.name
/** Specifiers the browser half resolves through the platform's own require. */
const CLIENT_EXTERNAL = ['react', 'react/jsx-runtime']

/**
 * 6 字符的作用域前缀，形如官方的 `7D6uKa`。
 *
 * 首字符强制成字母：esbuild 会把「不是合法 CSS 标识符」的前导字符逐字丢掉，而
 * base64url 的首字符可能是数字——`_8SEyhi` 会被改写成 `SEyhi`（且不止丢一个字符：
 * `_17SBtj` → `SBtj`），既破坏可预期性，也给不同文件留下撞名的余地。
 */
function shortHash(value) {
  const hash = createHash('sha256').update(value).digest('base64url').slice(0, 6)
  return String.fromCharCode(97 + (hash.charCodeAt(0) % 26)) + hash.slice(1)
}

/**
 * esbuild 的 `local-css` 用「文件基名 + '_' + 本地名」做作用域前缀，默认不含哈希
 * （`board_card`），放进共享页面里有和别的插件撞名的风险。这里给每个 CSS 模块
 * 一个虚拟文件名 `<hash>.module.css`，让前缀变成哈希 + `_` + 本地名。
 *
 * 虚拟路径只影响命名，不影响解析：真实内容仍从磁盘读，`resolveDir` 也指回原目录。
 * 哈希取自 fork 相对路径，因此跨机器稳定、且与文件内容改动无关。
 *
 * 发现到的「前缀 → fork 相对路径」记在 cssSheets 里，供构建后的 CSS 契约自检使用。
 */
const cssSheets = new Map()
function cssModules() {
  const NS = 'dsh-css'
  return {
    name: 'dsh-css-modules',
    setup(build) {
      build.onResolve({ filter: /\.module\.css$/ }, (args) => {
        if (args.namespace === NS) return undefined
        const file = path.resolve(args.resolveDir, args.path)
        const rel = path.relative(ROOT, file).split(path.sep).join('/')
        const prefix = shortHash(rel)
        cssSheets.set(prefix, rel)
        return { path: `${prefix}.module.css`, namespace: NS, pluginData: { file, rel } }
      })
      build.onLoad({ filter: /.*/, namespace: NS }, async (args) => ({
        contents: await readFile(args.pluginData.file, 'utf8'),
        loader: 'local-css',
        resolveDir: path.dirname(args.pluginData.file),
        pluginData: args.pluginData,
      }))
    },
  }
}

/**
 * 官方构建把 `@deepseek-ai/dsh-client-store` 换成了一个虚拟模块（产物里能看到
 * `//#region \0dsh-store-engine`）：它在运行时向平台 ModuleLoader 要这个模块，
 * 而且刻意用 `['@deepseek-ai/dsh-client', '-store'].join('')` 把 specifier 藏起来，
 * 让打包器看不见——这正是官方 client.js 的 require 集合里只有 react 的原因。
 *
 * 这里逐行复刻该 shim（含藏 specifier 的写法）：只有它保持「运行时向平台要」，
 * 产物才不会多出第三个外部依赖。
 */
const STORE_ENGINE = '\0dsh-store-engine'
const STORE_ENGINE_SOURCE = `const platform = ['@deepseek-ai/dsh-client', '-store'].join('')
const legacy = ['@deepseek-ai/dsh-client-runtime', '/client'].join('')
let engine
try {
	engine = require(platform)
} catch {
	engine = require(legacy)
}
export const createSnapshotStore = engine.createSnapshotStore
export const defineStore = engine.defineStore
export const shallowEqual = engine.shallowEqual
`

/** 把官方构建的私有虚拟模块补回产物：store engine shim。 */
function storeEngine() {
  const NS = 'dsh-virtual'
  return {
    name: 'dsh-store-engine',
    setup(build) {
      build.onResolve({ filter: /^@deepseek-ai\/dsh-client-store$/ }, () => ({
        path: STORE_ENGINE,
        namespace: NS,
      }))
      build.onLoad({ filter: /.*/, namespace: NS }, () => ({
        contents: STORE_ENGINE_SOURCE,
        loader: 'ts',
      }))
    },
  }
}

/** External specifiers of a build, read from its metafile. */
function externalsOf(result) {
  const found = new Set()
  for (const output of Object.values(result.metafile.outputs)) {
    for (const imported of output.imports) if (imported.external) found.add(imported.path)
  }
  return [...found].sort()
}

const fail = (message) => {
  throw new Error(`build: ${message}`)
}

await rm(LIB, { recursive: true, force: true })
await mkdir(LIB, { recursive: true })

// ── 宿主半：bundled ESM，所有裸导入保持 external ────────────────────────────
const host = await esbuild.build({
  entryPoints: [path.join(SRC, 'index.ts')],
  outfile: path.join(LIB, 'index.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  packages: 'external',
  charset: 'utf8',
  legalComments: 'none',
  metafile: true,
  logLevel: 'warning',
})
const hostExternal = externalsOf(host)

// ── 浏览器半：bundled CJS + ModuleLoader 外壳 ───────────────────────────────
const client = await esbuild.build({
  entryPoints: [path.join(SRC, 'client/index.ts')],
  // write:false —— 产物在内存里，壳由本脚本手工拼，CSS 也从这里取。
  outdir: path.join(ROOT, '.esbuild-out'),
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  jsxImportSource: 'react',
  external: CLIENT_EXTERNAL,
  charset: 'utf8',
  legalComments: 'none',
  plugins: [storeEngine(), cssModules()],
  metafile: true,
  logLevel: 'warning',
})
const clientExternal = externalsOf(client)

const jsAsset = client.outputFiles.find((file) => file.path.endsWith('.js'))
const cssAsset = client.outputFiles.find((file) => file.path.endsWith('.css'))
if (jsAsset === undefined) fail('浏览器半没有产出 JS')
if (cssAsset === undefined) fail('浏览器半没有产出 CSS')
if (client.outputFiles.length !== 2) {
  fail(`浏览器半产出了 ${client.outputFiles.length} 个文件，预期 2 个（JS + CSS）`)
}

// CSS Modules 契约自检：每个 .module.css 里的每个 class 都必须在产物 CSS 里以
// `<前缀>_<本地名>` 出现，且产物里不能再有别的同前缀名字。esbuild 会悄悄丢掉
// 「不合法 CSS 标识符」的前导字符（`_8SEyhi_board` → `SEyhi_board`），只保证
// CSS 与 JS 一致、却不保证前缀可预期，所以这条检查必须显式做。
{
  const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '')
  const classesOf = (text) =>
    new Set([...stripComments(text).matchAll(/\.(-?[A-Za-z_][A-Za-z0-9_-]*)/g)].map((m) => m[1]))
  const scopedInCss = classesOf(cssAsset.text)
  const expected = new Set()
  for (const [prefix, rel] of cssSheets) {
    const locals = classesOf(await readFile(path.join(ROOT, rel), 'utf8'))
    for (const local of locals) expected.add(`${prefix}_${local}`)
  }
  const missing = [...expected].filter((name) => !scopedInCss.has(name))
  if (missing.length > 0) {
    fail(`CSS Modules 改名不一致，产物里缺少这些作用域类名: ${missing.slice(0, 8).join(', ')}`)
  }
  const stray = [...scopedInCss].filter(
    (name) => /^[A-Za-z][A-Za-z0-9]{5}_/.test(name) && !expected.has(name),
  )
  if (stray.length > 0) {
    fail(`产物 CSS 里出现了非预期的作用域类名: ${stray.slice(0, 8).join(', ')}`)
  }
}

// CSS 注入块：官方是「每个 .module.css 一个 <style>」，这里合成一个，规则集合与
// 作用域完全相同。data-plugin / data-plugin-css 沿用官方属性名，重复注入可去重。
const cssTagId = `${ID}/client.css`
const cssPrelude = [
  `var __dshTbCss = ${JSON.stringify(cssAsset.text)};`,
  `if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(${JSON.stringify(cssTagId)}) + "]") === null) {`,
  `\tvar __dshTbCssTag = document.createElement("style");`,
  `\t__dshTbCssTag.dataset.plugin = ${JSON.stringify(ID)};`,
  `\t__dshTbCssTag.dataset.pluginCss = ${JSON.stringify(cssTagId)};`,
  `\t__dshTbCssTag.textContent = __dshTbCss;`,
  `\tdocument.head.appendChild(__dshTbCssTag);`,
  `}`,
].join('\n')

const clientBundle = [
  'window.__ModuleLoader__.load({',
  `\tid: ${JSON.stringify(ID)},`,
  '\tfactory: (require) => {',
  '\t\tvar module = { exports: {} };',
  '\t\tvar exports = module.exports;',
  '\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
  ...cssPrelude.split('\n').map((line) => `\t\t${line}`),
  ...jsAsset.text.split('\n').map((line) => (line === '' ? '' : `\t\t${line}`)),
  '\t\treturn module.exports;',
  '\t}',
  '});',
  '',
].join('\n')

await writeFile(path.join(LIB, 'client.js'), clientBundle)

// ── 类型声明：不从 src 重新生成，原样复制官方 lib 的 .d.ts ──────────────────
// 生成它们需要 typescript + 整套 @deepseek-ai/* 类型包（fork 不装），而运行时不读
// 这些文件。这里把它们当 vendored 资源复制，并在日志里显式说明，避免误以为是产物。
let typesNote = 'lib/types 未生成（没有 lib.published/types，且不从 src 重新生成）'
if (existsSync(path.join(PUBLISHED, 'types'))) {
  await cp(path.join(PUBLISHED, 'types'), path.join(LIB, 'types'), { recursive: true })
  typesNote = 'lib/types 原样复制自 lib.published/types（官方声明，未从 src 重新生成）'
}

// ── 契约自检 ────────────────────────────────────────────────────────────────
if (PKG.dsh?.client?.platform !== 'web') fail('package.json 缺少 dsh.client.platform === "web"')
if (PKG.exports?.['./client'] === undefined) fail('package.json 缺少 exports["./client"]')
if (PKG.dsh?.bundle?.patch === undefined) fail('package.json 缺少 dsh.bundle.patch')

const expectedExternal = ['react', 'react/jsx-runtime']
if (JSON.stringify(clientExternal) !== JSON.stringify(expectedExternal)) {
  fail(`浏览器半的外部依赖是 ${JSON.stringify(clientExternal)}，应为 ${JSON.stringify(expectedExternal)}`)
}
for (const specifier of hostExternal) {
  if (specifier.startsWith('node:')) continue
  if (specifier === '@deepseek-ai/schemastery') continue
  // 宿主侧 SDK 必须留在 external：DSH 的 profile 解析层按 specifier 把它们指到
  // 安装内的单例副本（见 package.json 的 peerDependencies 注释）。
  if (PKG.peerDependencies?.[specifier] === undefined) {
    fail(`宿主半 import 了 ${specifier}，但它既不是依赖也不是 peerDependency：link: 布局下解析不到`)
  }
}

// 浏览器半的语法与注册契约：用一个假的 window.__ModuleLoader__ 把 bundle 跑一遍。
// 这能抓出「factory 里混进 import 语句」「id 写错」「没有导出 apply」——这几种错在
// 浏览器里只表现为插件静默不激活。react 是真的（devDependency），所以模块顶层的
// createContext / jsx 调用等都会真实执行；平台侧的 store engine 用最小桩。
{
  let registered
  const fakeWindow = {
    __ModuleLoader__: { load: (spec) => { registered = spec } },
  }
  const nodeRequire = createRequire(import.meta.url)
  const react = nodeRequire('react')
  const jsxRuntime = nodeRequire('react/jsx-runtime')
  const requested = []
  const fakeRequire = (specifier) => {
    requested.push(specifier)
    if (specifier === 'react') return react
    if (specifier === 'react/jsx-runtime') return jsxRuntime
    // 平台基线里的 store engine：真实页面由 ModuleLoader 提供，这里只要求
    // factory 能把它取到手；任何调用都发生在 apply 之后，不会走到。
    if (specifier === '@deepseek-ai/dsh-client-store') return { createSnapshotStore: undefined, defineStore: undefined, shallowEqual: undefined }
    fail(`浏览器半请求了非基线模块 "${specifier}"`)
  }
  const fakeDocument = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '' }),
    head: { appendChild: () => {} },
  }
  const run = new Function('window', 'document', 'globalThis', 'require', clientBundle)
  run(fakeWindow, fakeDocument, { window: fakeWindow, document: fakeDocument }, fakeRequire)

  if (registered === undefined) fail('浏览器半没有调用 __ModuleLoader__.load')
  if (registered.id !== ID) fail(`浏览器半注册的 id 是 "${registered.id}"，应为 "${ID}"`)
  const half = registered.factory(fakeRequire)
  if (typeof half.apply !== 'function') fail('浏览器半没有导出 apply')
  if (!Array.isArray(half.inject)) fail('浏览器半没有导出 inject 数组')
  const exported = Object.keys(half).sort()
  if (JSON.stringify(exported) !== JSON.stringify(['apply', 'bindSettingsForm', 'inject', 'servedEntryId'])) {
    fail(`浏览器半的导出面是 ${JSON.stringify(exported)}，与官方不一致`)
  }
  // 运行时真正被 require 的 specifier 面（打包器看得见的那些）。
  const visible = [...new Set(requested)].filter((name) => name !== '@deepseek-ai/dsh-client-store').sort()
  if (JSON.stringify(visible) !== JSON.stringify(expectedExternal)) {
    fail(`浏览器半运行时请求了 ${JSON.stringify(visible)}，应为 ${JSON.stringify(expectedExternal)}`)
  }
}

// 宿主半：ESM 语法检查。它 import 的 SDK 由 DSH 在宿主进程里按 specifier 提供，
// 本目录解析不到，所以这里不做动态 import（见 README.fork.md 的验证章节）。
const check = spawnSync(process.execPath, ['--check', path.join(LIB, 'index.js')], { encoding: 'utf8' })
if (check.status !== 0) fail(`宿主半语法检查失败:\n${check.stderr}`)

const [hostStat, clientStat] = await Promise.all([
  stat(path.join(LIB, 'index.js')),
  stat(path.join(LIB, 'client.js')),
])
const kib = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`

process.stdout.write(
  [
    `${ID}/build: ok`,
    `  lib/index.js   ${kib(hostStat.size)}  external=${JSON.stringify(hostExternal)}`,
    `  lib/client.js  ${kib(clientStat.size)} (其中 ${kib(cssAsset.text.length)} 为注入的 CSS 字符串)  external=${JSON.stringify(clientExternal)}`,
    `  ${typesNote}`,
    '',
  ].join('\n'),
)
