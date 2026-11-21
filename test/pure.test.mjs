/**
 * dsh-rig · 纯逻辑单测
 *
 * 只测「不碰 IO 的那一层」：路径判定、env 白名单、argv 组装、URL 解析、状态机、日志脱敏。
 * 这一层的价值是**把不该发生的事钉死** —— 「凭据不进实验室」「实验室 home 不等于宿主 home」
 * 这两条一旦破，事故不是报错而是静默越界。
 *
 * 跑法：`npm test`（等价 `node --test test/`）
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { assertIsolated, isValidLabId, nextLabId, profileFromInstallPath, profileNameFor } from '../lib/lab/naming.js'
import { labPaths, resolveLabRoot } from '../lib/lab/layout.js'
import { buildSeedPlan, buildStartPlan, parseLabUrl, sanitizeEnv } from '../lib/lab/spawn-plan.js'
import { addLab, emptyState, findLab, parseState, removeLab, serializeState } from '../lib/lab/registry.js'
import { canTransition, DEFAULTS, isLive, STATUS } from '../lib/lab/constants.js'
import { redactLine } from '../lib/lab/redact.js'
import { appendLine, createLogBuffer, sliceSince, tail } from '../lib/lab/log-buffer.js'

test('隔离判定：三种越界都要挡住', () => {
  assert.equal(assertIsolated('E:/a/b', 'E:/a/b').ok, false, '相等必须拒绝')
  assert.equal(assertIsolated('E:/a/b/lab', 'E:/a/b').ok, false, '实验室落在宿主里面必须拒绝')
  assert.equal(assertIsolated('E:/a', 'E:/a/lab').ok, false, '宿主落在实验室里面必须拒绝')
  assert.equal(assertIsolated('E:/labs/x/home', 'E:/prod/home').ok, true, '互不相干要放行')
  // 大小写与分隔符：Windows 上 E:\A 与 E:/a 是同一处
  assert.equal(assertIsolated('E:\\A\\lab', 'e:/a/lab').ok, false, '大小写不同也要认成同一处')
})

test('隔离判定：空路径一律不放行', () => {
  assert.equal(assertIsolated('', 'E:/x').ok, false)
  assert.equal(assertIsolated('E:/x', '').ok, false)
})

test('env 白名单：凭据类变量绝不进实验室', () => {
  const env = sanitizeEnv(
    {
      Path: 'C:/windows',
      TEMP: 'C:/t',
      NPM_TOKEN: 'npm_x',
      OPENAI_API_KEY: 'sk-x',
      GH_TOKEN: 'ghp',
      AWS_SECRET_ACCESS_KEY: 's',
      DB_PASSWORD: 'p',
      RANDOM_UNKNOWN: 'u',
    },
    { DSH_HOME: 'D:/lab/home' },
  )
  assert.equal(env.Path, 'C:/windows')
  assert.equal(env.TEMP, 'C:/t')
  assert.equal(env.DSH_HOME, 'D:/lab/home')
  for (const banned of ['NPM_TOKEN', 'OPENAI_API_KEY', 'GH_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'DB_PASSWORD', 'RANDOM_UNKNOWN']) {
    assert.equal(env[banned], undefined, `${banned} 不该被继承`)
  }
})

test('启动 argv：端口 0、只绑回环、不开浏览器', () => {
  const plan = buildStartPlan({
    execPath: 'node.exe',
    isElectron: false,
    coreBin: 'D:/core/lib/bin.js',
    profile: 'rig-lab1',
    cwd: 'D:/w',
    home: 'D:/h',
    env: {},
  })
  const line = plan.args.join(' ')
  // 不能出现 `web` 子命令：`dsh web` 已是 `--profile web` 的别名，叠加会被 CLI 拒绝。
  assert.doesNotMatch(line, /\bweb\b/u, 'argv 里不该出现 web 子命令')
  assert.match(line, /--profile rig-lab1/)
  assert.match(line, /--port 0/)
  assert.match(line, /--no-open/)
  assert.match(line, /--host 127\.0\.0\.1/)
  assert.equal(plan.env.DSH_HOME, 'D:/h')
  assert.equal(plan.env.ELECTRON_RUN_AS_NODE, undefined, '非 Electron 不该带这个变量')
})

test('启动 env：桌面版必须带 ELECTRON_RUN_AS_NODE', () => {
  const plan = buildStartPlan({
    execPath: 'electron.exe',
    isElectron: true,
    coreBin: 'D:/core/lib/bin.js',
    profile: 'rig-lab1',
    cwd: 'D:/w',
    home: 'D:/h',
    env: {},
  })
  assert.equal(plan.env.ELECTRON_RUN_AS_NODE, '1')
})

test('建 profile 的计划：--dump-config 只算不建，别起服务', () => {
  const plan = buildSeedPlan({
    execPath: 'node.exe',
    isElectron: false,
    coreBin: 'D:/core/lib/bin.js',
    profile: 'rig-lab2',
    cwd: 'D:/w',
    home: 'D:/h',
    env: {},
  })
  const line = plan.args.join(' ')
  assert.match(line, /--from-default-profile web/)
  assert.match(line, /--dump-config/)
  assert.doesNotMatch(line, /--port/)
})

test('URL 解析：只认回环 + token 形态', () => {
  assert.deepEqual(parseLabUrl('dsh web: http://127.0.0.1:56292/?token=abc_DEF-1'), {
    port: 56292,
    token: 'abc_DEF-1',
    url: 'http://127.0.0.1:56292/?token=abc_DEF-1',
  })
  assert.equal(parseLabUrl('http://0.0.0.0:1/?token=x'), null)
  assert.equal(parseLabUrl('[info]: ready'), null)
})

test('状态机：不许跳级', () => {
  assert.equal(canTransition(STATUS.starting, STATUS.running), true)
  assert.equal(canTransition(STATUS.created, STATUS.running), false, '没经过 starting 不能直接 running')
  assert.equal(canTransition(STATUS.running, STATUS.crashed), true)
  assert.equal(isLive(STATUS.running), true)
  assert.equal(isLive(STATUS.stopped), false)
})

test('labs.json：坏文件降级成空状态而不是抛错', () => {
  for (const bad of ['', '{', 'null', '{"schemaVersion":99,"labs":[]}', '[]']) {
    const { state, problem } = parseState(bad)
    assert.equal(state.labs.length, 0)
    assert.equal(typeof problem, 'string')
  }
  const good = parseState('{"schemaVersion":1,"labs":[{"id":"lab1","name":"甲","version":"host"}]}')
  assert.equal(good.problem, null)
  assert.equal(good.state.labs.length, 1)
  assert.equal(good.state.labs[0].profile, 'rig-lab1', '缺 profile 时要按 id 补出来')
})

test('labs.json：只落静态字段，token/pid 不进盘', () => {
  const state = emptyState()
  addLab(state, { id: 'lab1', name: '甲', version: 'host' })
  const text = serializeState(state)
  assert.doesNotMatch(text, /token/u)
  assert.doesNotMatch(text, /pid/u)
  assert.match(text, /lab1/u)
  removeLab(state, 'lab1')
  assert.equal(findLab(state, 'lab1'), null)
})

test('日志脱敏：token / 用户名 / api key 三类都要打码', () => {
  const line = 'open http://127.0.0.1:1/?token=SECRETTOKEN at C:\\Users\\sample-user\\x key="sk-abc"'
  const out = redactLine(line)
  assert.doesNotMatch(out, /SECRETTOKEN/u)
  assert.doesNotMatch(out, /sample-user/u)
  assert.doesNotMatch(out, /sk-abc/u)
  assert.match(out, /token=\*\*\*/u)
})

test('id 与路径：白名单挡注入，容器名固定前缀', () => {
  for (const bad of ['../x', 'Lab1', 'lab 1', '', 'a'.repeat(40)]) assert.equal(isValidLabId(bad), false, `${bad} 应被拒`)
  for (const good of ['lab1', 'lab-2', 'a1']) assert.equal(isValidLabId(good), true)
  assert.equal(profileNameFor('lab1'), 'rig-lab1')
  assert.equal(nextLabId(['lab1', 'lab2']), 'lab3')
  const p = labPaths('D:/root', 'lab1')
  assert.match(p.home, /labs[\\/]lab1[\\/]home$/u)
  assert.equal(DEFAULTS.port, undefined, '默认值里不该有写死端口')
})

test('profile 判定：以安装路径为准，环境变量只是兜底', () => {
  assert.equal(
    profileFromInstallPath('file:///E:/h/profiles/web/node_modules/dsh-rig/lib/index.js'),
    'web',
  )
  assert.equal(
    profileFromInstallPath('E:\\\\h\\\\profiles\\\\desktop\\\\node_modules\\\\dsh-rig\\\\lib\\\\index.js'),
    'desktop',
  )
  assert.equal(profileFromInstallPath('D:/checkouts/dsh-rig/lib/index.js'), null)
  assert.equal(profileFromInstallPath(''), null)
})