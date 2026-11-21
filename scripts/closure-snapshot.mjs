#!/usr/bin/env node
/**
 * 宿主依赖闭包快照 / 对比。
 *
 * 为什么必须有它：任何一次**真实启动** dsh（包括开发时起的试验实例）都会跑 profile 闭包重建，
 * 而 `$DSH_HOME/profiles/node_modules` 是桌面版和网页版**共用**的那一份。
 * 2026-09-17 那天就是起了一次预演实例，生产闭包里 95 个 junction 被重指，最后 250 条不可达。
 * 所以：起实例前 snapshot，收工后 diff，`changed > 0` 就要查。
 *
 * 用法：
 *   node scripts/closure-snapshot.mjs --save <out.json>
 *   node scripts/closure-snapshot.mjs --diff <before.json> <after.json>
 *
 * 只读：不修、不删、不跟随链接。
 */
import { readdirSync, lstatSync, readlinkSync, writeFileSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'

const DSH_HOME = process.env.DSH_HOME
if (!DSH_HOME) {
  console.error('需要 DSH_HOME 环境变量（指向你的 DSH home，例如包含 profiles/ 的那个目录）。')
  process.exit(1)
}

/** 列一层目录；@scope 下钻一层拿真实包。 */
function walk(root) {
  const out = {}
  const visit = (dir, prefix, depth) => {
    let names = []
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names.sort()) {
      const abs = join(dir, name)
      const rel = prefix ? `${prefix}/${name}` : name
      let st
      try {
        st = lstatSync(abs)
      } catch {
        out[rel] = { kind: 'unreadable' }
        continue
      }
      if (st.isSymbolicLink()) {
        let target = null
        try {
          target = readlinkSync(abs)
        } catch {
          target = null
        }
        out[rel] = { kind: 'link', target }
        continue
      }
      if (st.isDirectory()) {
        if (name.startsWith('@') && depth === 0) {
          visit(abs, rel, depth + 1)
        } else {
          out[rel] = { kind: 'dir' }
        }
        continue
      }
      out[rel] = { kind: 'file' }
    }
  }
  visit(root, '', 0)
  return out
}

function snapshot() {
  const profileNodeModules = join(DSH_HOME, 'profiles', 'node_modules')
  const entries = walk(profileNodeModules)
  return {
    savedAt: new Date().toISOString(),
    dshHome: DSH_HOME,
    root: profileNodeModules,
    count: Object.keys(entries).length,
    entries,
  }
}

/** 只比形状与链接目标；file↔dir 的变化也算变化。 */
function diff(before, after) {
  const changed = []
  const names = new Set([...Object.keys(before.entries), ...Object.keys(after.entries)])
  for (const name of [...names].sort()) {
    const a = before.entries[name]
    const b = after.entries[name]
    if (!a) changed.push({ name, why: 'added', after: b })
    else if (!b) changed.push({ name, why: 'removed', before: a })
    else if (a.kind !== b.kind) changed.push({ name, why: 'kind', before: a, after: b })
    else if (a.kind === 'link' && a.target !== b.target) changed.push({ name, why: 'retargeted', before: a, after: b })
  }
  return changed
}

const argv = process.argv.slice(2)
if (argv[0] === '--save') {
  const out = resolve(argv[1] || 'closure.json')
  const snap = snapshot()
  writeFileSync(out, JSON.stringify(snap, null, 2))
  console.log(`saved ${snap.count} entries -> ${out}`)
} else if (argv[0] === '--diff') {
  const before = JSON.parse(readFileSync(resolve(argv[1]), 'utf8'))
  const after = JSON.parse(readFileSync(resolve(argv[2]), 'utf8'))
  const changed = diff(before, after)
  console.log(`before=${before.count} after=${after.count} changed=${changed.length}`)
  for (const item of changed.slice(0, 40)) {
    const detail =
      item.why === 'retargeted'
        ? `\n    was: ${item.before.target}\n    now: ${item.after.target}`
        : ''
    console.log(`  [${item.why}] ${item.name}${detail}`)
  }
  if (changed.length > 40) console.log(`  …以及另外 ${changed.length - 40} 条`)
  process.exitCode = changed.length === 0 ? 0 : 2
} else {
  console.error('用法: --save <out.json> | --diff <before.json> <after.json>')
  process.exitCode = 1
}
