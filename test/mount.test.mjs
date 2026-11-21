/**
 * dsh-rig · 组合根冒烟（假 ctx）
 *
 * 这个测试存在的唯一理由：2026-11-21 那天 `mountLabTools` 的 import 漏了，
 * 组合根里留了一句 `mountLabTools is not defined`。cordis 把 inject 回调里的异常**吞掉**，
 * 于是表现是「插件装了、日志正常、工具就是没有」——比报错难查一百倍。
 *
 * 用假 ctx 跑一遍 apply()，能在 200ms 内把这类「引用了不存在的东西」全部抓出来：
 * 工具必须真的注册上、而且不该有任何一条「挂工具失败」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/index.js'

test('组合根：apply 能跑通，plugin_lab 真的注册上', async () => {
  const labRoot = await mkdtemp(join(tmpdir(), 'dsh-rig-test-'))
  const registered = []
  const warnings = []
  const tools = {
    register(definition) {
      registered.push({ name: definition.name, hasOutput: Boolean(definition.output?.render) })
      return () => {}
    },
  }
  const fakeCtx = {
    get: (key) => (key === 'tools' ? tools : undefined),
    inject: (_deps, callback) => callback({ tools, webServer: null }),
    effect: (fn) => {
      const dispose = fn()
      return () => (typeof dispose === 'function' ? dispose() : undefined)
    },
  }
  const originalWarn = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  try {
    apply(fakeCtx, { labRoot, copyCredentials: false })
    // apply 里有异步 load()，给它一拍
    await new Promise((r) => setTimeout(r, 50))
  } finally {
    console.warn = originalWarn
    await rm(labRoot, { recursive: true, force: true })
  }

  assert.deepEqual(registered.map((r) => r.name), ['plugin_lab'], '生命周期工具必须注册，且界面工具默认不注册')
  assert.equal(registered[0].hasOutput, true, '工具的 output.render 必须存在，否则宿主要拒收')
  assert.deepEqual(warnings.filter((w) => /挂工具失败|注册失败/u.test(w)), [], '不该有挂载失败')
})

test('组合根：界面工具默认不进上下文（未授权时零 schema 占用）', async () => {
  const labRoot = await mkdtemp(join(tmpdir(), 'dsh-rig-test-'))
  const names = []
  const fakeCtx = {
    get: () => undefined,
    inject: (_deps, callback) => callback({ tools: { register: (d) => (names.push(d.name), () => {}) }, webServer: null }),
    effect: (fn) => fn(),
  }
  try {
    apply(fakeCtx, { labRoot, copyCredentials: false })
    await new Promise((r) => setTimeout(r, 30))
  } finally {
    await rm(labRoot, { recursive: true, force: true })
  }
  assert.equal(names.includes('lab_ui'), false, '没有授权时不该注册 lab_ui')
})
