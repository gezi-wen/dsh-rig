/**
 * dsh-rig · 界面驱动后端：CDP（系统浏览器）
 *
 * 零 npm 依赖的实现：用本机已装的 Edge/Chrome，`--headless=new` 起一个无头实例，
 * 通过 DevTools 协议（Node 24 自带全局 WebSocket）驱动。
 *
 * 它只是**兜底后端**：本机不保证有浏览器，所以上层（driver.js）会先试 Playwright，
 * 找不到才退到这里，两者都没有就明确告诉用户缺什么。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { findBrowserExecutable, launchBrowser } from '../browser.js'

const INTERACTIVE =
  'button,[role="button"],a,[role="menuitem"],[role="tab"],[role="treeitem"],input,textarea,[contenteditable="true"]'

/** 生成「按文字找元素」的注入脚本。参数走 JSON.stringify，不拼字符串。 */
function findElementScript(text) {
  return `(() => {
  const want = ${JSON.stringify(String(text ?? ''))}.trim().toLowerCase();
  const nodes = [...document.querySelectorAll(${JSON.stringify(INTERACTIVE)})].filter((el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0.05;
  });
  const labelOf = (el) =>
    (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || '')
      .replace(/\\s+/g, ' ').trim();
  const hit = nodes.find((el) => labelOf(el).toLowerCase().includes(want));
  if (!hit) {
    const candidates = [...new Set(nodes.map(labelOf).filter(Boolean))].slice(0, 20);
    return { ok: false, reason: 'not-found', candidates };
  }
  const r = hit.getBoundingClientRect();
  return { ok: true, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), label: labelOf(hit).slice(0, 60) };
})()`
}

const FIND_COMPOSER = `(() => {
  const nodes = [...document.querySelectorAll('textarea,[contenteditable="true"],input[type="text"]')].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 40 && r.height > 16 && getComputedStyle(el).visibility !== 'hidden';
  });
  if (!nodes.length) return { ok: false };
  nodes.sort((a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height);
  const el = nodes[0];
  const r = el.getBoundingClientRect();
  return { ok: true, x: Math.round(r.x + Math.min(40, r.width / 2)), y: Math.round(r.y + r.height / 2), tag: el.tagName.toLowerCase() };
})()`

export class CdpDriver {
  name = 'cdp'
  #labUrl
  #userDataDir
  #shotsDir
  #log
  #browserPath
  #handle = null
  #shotSeq = 0

  constructor({ labUrl, userDataDir, shotsDir, log, browserPath }) {
    this.#labUrl = labUrl
    this.#userDataDir = userDataDir
    this.#shotsDir = shotsDir
    this.#log = typeof log === 'function' ? log : () => {}
    this.#browserPath = browserPath || findBrowserExecutable()
  }

  /** 这个后端能不能用：只看有没有浏览器可执行文件。 */
  get available() {
    return Boolean(this.#browserPath)
  }

  get unavailableReason() {
    return this.available ? null : '本机没有 Edge/Chrome（可用 DSH_RIG_BROWSER 指定，或安装 playwright）'
  }

  async #ensure() {
    if (this.#handle) return this.#handle
    if (!this.#browserPath) throw new Error(this.unavailableReason)
    this.#log(`启动无头浏览器：${this.#browserPath}`)
    this.#handle = await launchBrowser({ browserPath: this.#browserPath, labUrl: this.#labUrl, userDataDir: this.#userDataDir })
    await this.#waitReady(this.#handle)
    return this.#handle
  }

  /**
   * 等页面真的可用，而不是睡一个固定时长。
   *
   * 2026-11-21 实测：固定等 800ms 时，第一次 snapshot 在冷启动下返回 **0 个元素**，
   * 调用方会以为「这个界面没有可点的东西」。判据改成：readyState=complete **且**
   * 至少有一个可交互元素（DSH 的首屏是异步渲染的，DOM ready 时按钮可能还没出来）。
   */
  async #waitReady(handle, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs
    const probe = `(() => ({ state: document.readyState, n: document.querySelectorAll(${INTERACTIVE}).length }))()`
    while (Date.now() < deadline) {
      try {
        const res = await handle.conn.send('Runtime.evaluate', { expression: probe, returnByValue: true })
        const value = res?.result?.value
        if (value && value.state === 'complete' && value.n > 0) return true
      } catch {
        /* 页面还在切，继续等 */
      }
      await new Promise((r) => setTimeout(r, 300))
    }
    this.#log('页面在 20 秒内没有进入可交互状态，仍继续（后续动作可能失败）')
    return false
  }

  async evaluate(expression, { awaitPromise = false } = {}) {
    const { conn } = await this.#ensure()
    const result = await conn.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
    if (result?.exceptionDetails) {
      throw new Error(String(result.exceptionDetails.exception?.description || result.exceptionDetails.text || '页面脚本异常'))
    }
    return result?.result?.value
  }

  async click(text) {
    const found = await this.evaluate(findElementScript(text))
    if (!found || found.ok !== true) {
      const list = found && found.candidates && found.candidates.length ? `；能点的有：${found.candidates.join(' / ')}` : ''
      throw new Error(`没找到「${text}」${list}`)
    }
    const { conn } = await this.#ensure()
    await conn.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: found.x, y: found.y })
    await conn.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: found.x, y: found.y, button: 'left', clickCount: 1 })
    await conn.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: found.x, y: found.y, button: 'left', clickCount: 1 })
    return { clicked: found.label, x: found.x, y: found.y }
  }

  async type(text, { submit = false } = {}) {
    const box = await this.evaluate(FIND_COMPOSER)
    if (!box || box.ok !== true) throw new Error('页面上找不到输入框（也许实验室还在加载）')
    const { conn } = await this.#ensure()
    await conn.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
    await conn.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
    await conn.send('Input.insertText', { text: String(text ?? '') })
    if (submit) {
      for (const type of ['keyDown', 'keyUp']) {
        await conn.send('Input.dispatchKeyEvent', {
          type,
          key: 'Enter',
          code: 'Enter',
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
        })
      }
    }
    return { typed: String(text ?? '').length, submit }
  }

  async screenshot() {
    const { conn } = await this.#ensure()
    const shot = await conn.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    if (!shot?.data) throw new Error('截图失败（没有数据）')
    await mkdir(this.#shotsDir, { recursive: true })
    this.#shotSeq += 1
    const file = join(this.#shotsDir, `${Date.now()}-${this.#shotSeq}.png`)
    await writeFile(file, Buffer.from(shot.data, 'base64'))
    return { path: file, bytes: Math.round((shot.data.length * 3) / 4) }
  }

  async snapshot(limit = 40) {
    const raw = await this.evaluate(`(() => {
      const nodes = [...document.querySelectorAll(${JSON.stringify(INTERACTIVE)})];
      const out = [];
      for (const el of nodes) {
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        const st = getComputedStyle(el);
        if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) <= 0.05) continue;
        const name = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').replace(/\\s+/g, ' ').trim();
        if (!name) continue;
        out.push((el.getAttribute('role') || el.tagName.toLowerCase()) + ': ' + name.slice(0, 60));
      }
      return [...new Set(out)];
    })()`)
    const list = Array.isArray(raw) ? raw : []
    return { total: list.length, items: list.slice(0, limit), backend: this.name }
  }

  async close() {
    const handle = this.#handle
    this.#handle = null
    if (handle) handle.kill()
  }
}
