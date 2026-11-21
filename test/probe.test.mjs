/**
 * dsh-rig · 探针单测
 *
 * 为什么单独一个文件：它会真起一个本地 http 服务（回环、随机端口、用完就关），
 * 属于「有 IO 但很小」的那类。放在这里而不是纯逻辑文件里，是为了让 pure.test.mjs 保持零 IO。
 *
 * 这条测的意义：2026-11-21 踩过一次「探针用 fetch、在宿主进程里被 DSH 自己接管 → 假阴性」，
 * 结果是实验室明明起来了却被判启动超时并杀掉。用 node:http 之后这里必须钉住：
 * 200 要判活、404 要判活（服务起来了就算活）、连不上要判死。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { probeOnce } from '../lib/lab/probe.js'

/** 起一个临时服务，返回 { url, close }。 */
async function withServer(handler, run) {
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    return await run(`http://127.0.0.1:${port}/`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('探针：200 判活', async () => {
  const result = await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<html></html>')
  }, (url) => probeOnce(`${url}?token=abc`))
  assert.equal(result.ok, true)
  assert.equal(result.reason, 'HTTP 200')
})

test('探针：404 也算活着（服务在就是活，路由对不对是另一回事）', async () => {
  const result = await withServer((req, res) => {
    res.writeHead(404)
    res.end()
  }, (url) => probeOnce(url))
  assert.equal(result.ok, true)
})

test('探针：连不上要判死，且给得出原因', async () => {
  const result = await probeOnce('http://127.0.0.1:1/?token=x', 800)
  assert.equal(result.ok, false)
  assert.match(String(result.reason), /ECONNREFUSED|超时|failed/u)
})
