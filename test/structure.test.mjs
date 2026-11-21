/**
 * dsh-rig · 结构守卫
 *
 * 这些断言不测行为，测**形状**。它们的价值在于：当有人在赶工时把一段 IO 写进纯逻辑层、
 * 或者在两个文件里各存一份常量，CI 会当场红，而不是三个月后有人对着一个「改了没生效」发呆。
 *
 * 五条守卫（对应我们那条模块化规范的四个硬约束 + 收尾三问）：
 *   1. 纯逻辑层零 `node:` 内建；
 *   2. 依赖方向单向（下层不许反过来 import 组合根）；
 *   3. 组合根与单文件体积上限；
 *   4. 同一字面量只许一处（host 与 client 的那份要对拍相等）；
 *   5. 写盘只许在 IO 层（装配层与工具层不许碰 fs）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const LIB = join(ROOT, 'lib')

/** 纯逻辑层白名单：这些文件**不许**出现 `node:` 导入。 */
const PURE_FILES = ['lab/constants.js', 'lab/naming.js', 'lab/registry.js', 'lab/spawn-plan.js', 'lab/redact.js', 'lab/log-buffer.js', 'lab/runtime.js', 'lab/ownership.js', 'lab/drive-guard.js']

const read = (rel) => readFileSync(join(LIB, rel), 'utf8')

function listJs(dir, prefix = '') {
  const out = []
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name)
    if (statSync(abs).isDirectory()) {
      out.push(...listJs(abs, prefix ? `${prefix}/${name}` : name))
    } else if (name.endsWith('.js')) {
      out.push(prefix ? `${prefix}/${name}` : name)
    }
  }
  return out
}

const ALL = listJs(LIB).sort()

test('守卫 1：纯逻辑层零 node: 内建', () => {
  for (const file of PURE_FILES) {
    const text = read(file)
    const hits = [...text.matchAll(/from\s+'node:[^']+'/gu)].map((m) => m[0])
    assert.deepEqual(hits, [], `${file} 是纯逻辑层，不该 import 内建模块：${hits.join(', ')}`)
  }
})

test('守卫 1b：纯逻辑层不 import 任何 IO 层文件', () => {
  const ioFiles = ['lab/supervisor.js', 'lab/seed.js', 'lab/probe.js', 'lab/versions.js', 'lab/layout.js', 'lab/ui-session.js', 'lab/browser.js', 'lab/driver.js', 'lab/core-bin.js', 'lab/diagnostics.js']
  for (const file of PURE_FILES) {
    const text = read(file)
    for (const io of ioFiles) {
      const stem = io.split('/').pop()
      assert.equal(text.includes(`'./${stem}'`), false, `${file} 不该 import IO 层 ${stem}`)
    }
  }
})

test('守卫 2：依赖方向单向 —— 除组合根外没人 import index.js', () => {
  for (const file of ALL) {
    if (file === 'index.js') continue
    const text = read(file)
    assert.equal(/from\s+'\.{1,2}\/(?:\.\.\/)?index\.js'/u.test(text), false, `${file} 反向 import 了组合根`)
  }
})

test('守卫 3：组合根薄，单文件不许无限长', () => {
  const rootLines = read('index.js').split('\n').length
  assert.ok(rootLines <= 150, `index.js 是装配层，现在 ${rootLines} 行（上限 150）：把逻辑挪到 lib/lab/ 下`)
  for (const file of ALL) {
    const lines = read(file).split('\n').length
    // client.js 是**单个 ModuleLoader bundle 文件**：协议上没法拆成多文件
    // （factory 只能 require 宿主导出的模块，不能 require 本包自己的文件）。
    // 所以它单独一档上限，「组件化」靠同一文件内的分区保证：
    // 常量 / 样式 / 通信 / hook / 展示组件 / 容器 / 注册。
    const cap = file === 'client.js' ? 620 : 420
    assert.ok(lines <= cap, `${file} 现在 ${lines} 行（上限 ${cap}）：先拆模块，别抬上限`)
  }
})

test('守卫 4：同一字面量只许一处（host 侧）', () => {
  const profilePrefixHits = ALL.filter((f) => f !== 'lab/naming.js' && read(f).includes('`rig-${'))
  assert.deepEqual(profilePrefixHits, [], `profile 前缀只该在 naming.js 里拼，这些文件也拼了：${profilePrefixHits.join(', ')}`)

  // client.js 必须自带一份（跨 bundle 不能 import），那份由守卫 4b 对拍，不算重复定义。
  const apiHits = ALL.filter((f) => f !== 'client.js' && read(f).includes("'/dsh-rig/api'"))
  assert.deepEqual(apiHits, ['lab/constants.js'], `API 前缀只该在 constants.js 定义，实际出现在：${apiHits.join(', ')}`)
})

test('守卫 4b：host 与 client 的 API 前缀必须对拍相等', () => {
  const hostPrefix = read('lab/constants.js').match(/export const API_PREFIX = '([^']+)'/u)?.[1]
  const clientPrefix = read('client.js').match(/const API = '([^']+)'/u)?.[1]
  assert.ok(hostPrefix, 'constants.js 里找不到 API_PREFIX')
  assert.ok(clientPrefix, 'client.js 里找不到 API 常量')
  assert.equal(clientPrefix, hostPrefix, '两侧 API 前缀不一致：面板会全部 404，而宿主日志里看不出来')
})

test('守卫 5：写盘与杀进程只许在 IO 层', () => {
  const allowedWrite = new Set(['lab/supervisor.js', 'lab/seed.js', 'lab/versions.js', 'lab/process.js', 'lab/core-bin.js', 'lab/browser.js', 'lab/driver.js', 'lab/ui/cdp-impl.js', 'lab/ui/playwright-impl.js', 'lab/report.js', 'lab/orphans.js'])
  for (const file of ALL) {
    if (allowedWrite.has(file)) continue
    const text = read(file)
    assert.equal(/from\s+'node:fs/u.test(text), false, `${file} 不该碰 fs（落盘只许 supervisor / seed）`)
    assert.equal(/from\s+'node:child_process'/u.test(text), false, `${file} 不该自己起子进程`)
  }
  // 装配层与路由层保持「只接线」：连 node: 内建都不该有
  for (const file of ['http/routes.js', 'tools/lab-tool.js', 'lab/registry.js', 'lab/spawn-plan.js']) {
    assert.equal(/from\s+'node:/u.test(read(file)), false, `${file} 属于接线/纯逻辑层，不该有 node: 导入`)
  }
})

test('守卫 6：每个模块都要有自己的测试入口（新模块配自己的套件）', () => {
  const tests = readdirSync(join(ROOT, 'test')).filter((f) => f.endsWith('.test.mjs'))
  assert.ok(tests.length >= 3, `测试文件太少（${tests.join(', ')}）：新模块请配自己的套件`)
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  for (const file of tests) {
    assert.ok(pkg.scripts.test.includes(file), `package.json 的 test 脚本漏了 ${file}`)
  }
})
