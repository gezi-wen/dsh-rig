/**
 * dsh-rig · 跨进程状态合并与落盘
 *
 * 这条线是 2026-11-21 真机上撞出来的：桌面版和 web 版同时装着插件，共用一份 `labs.json`，
 * 各自的旧内存状态一写就把对方的实验室抹掉（实测丢过一条记录）。所以现在写盘是
 * 「锁 → 读盘 → 合并 → 写」，规则在 merge.js。
 *
 * 覆盖三件事：合并规则本身、`isForeign` 的判定、以及两个 store 实例交替写盘不互相吞记录。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isForeign, mergeStates } from '../lib/lab/merge.js'
import { LabStateStore } from '../lib/lab/state-store.js'

const lab = (id, hostId) => ({ id, name: id, version: 'host', profile: `rig-${id}`, port: 46000, hostId })

test('合并：盘上有、内存没有的实验室不会被写没', () => {
  const disk = { schemaVersion: 1, labs: [lab('lab1', 'host-a'), lab('lab2', 'host-a')] }
  const ours = { schemaVersion: 1, labs: [] }
  const merged = mergeStates(disk, ours)
  assert.deepEqual(merged.labs.map((l) => l.id), ['lab1', 'lab2'], '空内存不能清空盘')
})

test('合并：两边都有的同一个 id 用内存那份，内存多出来的追加在后面', () => {
  const disk = { schemaVersion: 1, labs: [lab('lab1', 'host-a')] }
  const ours = { schemaVersion: 1, labs: [{ ...lab('lab1', 'host-b'), name: '我改过的名字' }, lab('lab2', 'host-b')] }
  const merged = mergeStates(disk, ours)
  assert.deepEqual(merged.labs.map((l) => l.id), ['lab1', 'lab2'])
  assert.equal(merged.labs[0].name, '我改过的名字', '同 id 以本进程为准')
})

test('合并：不改入参（纯函数）', () => {
  const disk = { schemaVersion: 1, labs: [lab('lab1', 'host-a')] }
  const ours = { schemaVersion: 1, labs: [] }
  mergeStates(disk, ours)
  assert.equal(disk.labs.length, 1)
  assert.equal(ours.labs.length, 0)
})

test('归属：没有 pid 就是自己的（从没跑过 / 已正常停止）', () => {
  assert.equal(isForeign({ id: 'lab1' }, { ownedPid: null, alive: () => true }), false)
  assert.equal(isForeign({ id: 'lab1', pid: null }, { ownedPid: null, alive: () => true }), false)
  assert.equal(isForeign(null, {}), false)
})

test('归属：pid 就是本进程管的那个 → 自己的', () => {
  assert.equal(isForeign({ id: 'lab1', pid: 4242 }, { ownedPid: 4242, alive: () => true }), false)
})

test('归属：pid 活着且不是我的 → 别人的（真孤儿，交给 orphans 收）', () => {
  assert.equal(isForeign({ id: 'lab1', pid: 4242 }, { ownedPid: null, alive: (pid) => pid === 4242 }), true)
})

test('归属：pid 已经死了 → 自己的（宿主重启后不该被锁死）', () => {
  assert.equal(isForeign({ id: 'lab1', pid: 4242 }, { ownedPid: null, alive: () => false }), false)
})

test('归属：hostId 不同不再导致只读 —— 0.1.5 锁死事故的回归用例', () => {
  // 0.1.5 用 hostId（每进程随机）判归属：宿主一重启，自己的实验室全变成「别人的」，
  // 主按钮恒「接手」、销毁恒灰，claim 又不改 hostId，于是没有任何可达的启动入口。
  assert.equal(isForeign({ id: 'lab1', hostId: '某个上一个进程的随机值' }, { ownedPid: null, alive: () => true }), false)
})

test('兼容：老记录缺 pid 时补 null，版本号不动（回滚安全）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-rig-merge-'))
  const file = join(root, 'labs.json')
  try {
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        labs: [
          {
            id: 'lab1',
            name: '实验台 lab1',
            version: 'host',
            profile: 'rig-lab1',
            port: 46000,
            ownerSessionId: null,
            ownerSince: null,
            hostId: null,
            createdAt: '2026-11-22T08:37:32.369Z',
          },
        ],
      }),
      'utf8',
    )
    const store = new LabStateStore({ file })
    const { state, problem } = await store.load()
    assert.equal(problem, null)
    assert.equal(state.schemaVersion, 1, '版本号必须还是 1：升版本会让旧版把整份文件读成空的')
    assert.equal(state.labs[0].pid, null, '老记录没有 pid，补成 null')
    assert.equal(state.labs[0].pidStartedAt, null)

    await store.save(state)
    const onDisk = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(onDisk.schemaVersion, 1)
    assert.equal(onDisk.labs[0].profile, 'rig-lab1', '补字段不搬内容')

    const again = await store.load()
    assert.deepEqual(again.state, state, '幂等：再读一次结果相同')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('兼容：pid 这类新字段能往返（旧版读到会忽略，但不该被本版自己丢掉）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-rig-merge-'))
  const file = join(root, 'labs.json')
  try {
    const store = new LabStateStore({ file })
    await store.save({
      schemaVersion: 1,
      labs: [{ ...lab('lab1', null), pid: 4242, pidStartedAt: '2026-11-24T00:00:00.000Z' }],
    })
    const { state } = await store.load()
    assert.equal(state.labs[0].pid, 4242)
    assert.equal(state.labs[0].pidStartedAt, '2026-11-24T00:00:00.000Z')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('落盘：两个宿主进程交替写，谁也不会吞掉对方的实验室', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-rig-merge-'))
  const file = join(root, 'labs.json')
  try {
    const a = new LabStateStore({ file })
    const b = new LabStateStore({ file })
    assert.deepEqual((await a.load()).state.labs, [], '空目录读成空状态，不报错')

    await a.save({ schemaVersion: 1, labs: [lab('lab1', 'host-a')] })
    // B 手里是空的旧状态，工作区里却已经有 A 的 lab1：这次保存不能把它抹掉
    const bMerged = await b.save({ schemaVersion: 1, labs: [lab('lab2', 'host-b')] })
    assert.deepEqual(bMerged.labs.map((l) => l.id), ['lab1', 'lab2'])

    const onDisk = JSON.parse(await readFile(file, 'utf8'))
    assert.deepEqual(onDisk.labs.map((l) => l.id), ['lab1', 'lab2'], '盘上两条都在')
    assert.equal(onDisk.labs[0].hostId, 'host-a', '对方那条保持原样')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('落盘：坏文件降级成空状态并说明原因，不会抛', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-rig-merge-'))
  const file = join(root, 'labs.json')
  try {
    await writeFile(file, '{ 这不是 json', 'utf8')
    const { state, problem } = await new LabStateStore({ file }).load()
    assert.deepEqual(state.labs, [])
    assert.equal(problem, 'invalid-json')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('落盘：写完不留锁文件，也不留临时文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-rig-merge-'))
  const file = join(root, 'labs.json')
  try {
    await new LabStateStore({ file }).save({ schemaVersion: 1, labs: [lab('lab1', 'host-a')] })
    const { readdir } = await import('node:fs/promises')
    assert.deepEqual(await readdir(root), ['labs.json'], '锁与 .tmp 都必须收干净')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
