/**
 * dsh-rig · 界面驱动后端：Playwright（可选依赖）
 *
 * 为什么它排在 CDP 前面：Playwright 能自带浏览器，不必假设用户机器上装了 Edge/Chrome。
 * 为什么不写进 dependencies：它连同 Chromium 是几百 MB，绝大多数人用不上「点按钮」这条能力，
 * 不该为它把整个包撑大。所以是 **optional peer**：装了就用，没装就退到 CDP。
 *
 * 2026-11-21 实测的坑：**包在 ≠ 浏览器在**。
 * `import('playwright')` 成功、`available` 判真，第一次点击却报
 * `Executable doesn't exist at ...ms-playwright/chromium_headless_shell-...`。
 * 所以探测必须验到**可执行文件**；验不到时还有一条路 —— 让 Playwright 直接用系统
 * Edge/Chrome（`channel: 'msedge' | 'chrome'`），那条路不需要下载。
 */
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { findBrowserExecutable } from '../browser.js'

const INTERACTIVE = [
  'button',
  '[role="button"]',
  'a',
  '[role="menuitem"]',
  '[role="tab"]',
  '[role="treeitem"]',
  'input',
  'textarea',
  '[contenteditable="true"]',
].join(',')

/** 系统浏览器对应的 channel 名（Playwright 的命名）。 */
const SYSTEM_CHANNELS = ['msedge', 'chrome']

/**
 * 探测 Playwright 到底能不能用。
 * @returns {Promise<{ok: boolean, mode: 'bundled'|'channel'|'none', reason: string|null}>}
 */
export async function probePlaywright() {
  let chromium
  try {
    ;({ chromium } = await import('playwright'))
  } catch (err) {
    return { ok: false, mode: 'none', reason: `没有安装 playwright（${String(err?.code || err?.message || err).slice(0, 80)}）` }
  }
  // 1) 自带浏览器在不在
  try {
    const bundled = chromium.executablePath()
    if (bundled && existsSync(bundled)) return { ok: true, mode: 'bundled', reason: null }
  } catch {
    /* 没有自带浏览器时这里会抛或给空路径，都当「没有」 */
  }
  // 2) 退一步：用系统 Edge/Chrome（不用下载）
  if (findBrowserExecutable()) return { ok: true, mode: 'channel', reason: null }
  return {
    ok: false,
    mode: 'none',
    reason: 'playwright 装了但浏览器没下载；执行 `npx playwright install`，或安装 Edge/Chrome',
  }
}

export class PlaywrightDriver {
  #labUrl
  #log
  #shotsDir
  #browser = null
  #page = null
  #shotSeq = 0
  #mode
  name = 'playwright'

  constructor({ labUrl, shotsDir, log, mode = 'bundled' }) {
    this.#labUrl = labUrl
    this.#shotsDir = shotsDir
    this.#log = typeof log === 'function' ? log : () => {}
    this.#mode = mode
  }

  get available() {
    return true
  }

  get unavailableReason() {
    return null
  }

  /** 起浏览器：先按探测结果来，失败再换 channel 兜一层。 */
  async #launchChromium() {
    const { chromium } = await import('playwright')
    if (this.#mode === 'bundled') {
      try {
        return { browser: await chromium.launch({ headless: true }), label: 'playwright' }
      } catch (err) {
        this.#log(`自带 Chromium 起不来（${String(err?.message || err).slice(0, 100)}），改用系统浏览器`)
      }
    }
    for (const channel of SYSTEM_CHANNELS) {
      try {
        return { browser: await chromium.launch({ headless: true, channel }), label: `playwright:${channel}` }
      } catch {
        /* 换下一个 channel */
      }
    }
    throw new Error('Playwright 起不来：自带浏览器未安装，系统 Edge/Chrome 也不可用')
  }

  async #ensure() {
    if (this.#page) return this.#page
    const { browser, label } = await this.#launchChromium()
    this.name = label
    this.#browser = browser
    this.#log(`启动 ${label}（无头）`)
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    this.#page = await context.newPage()
    await this.#page.goto(this.#labUrl, { waitUntil: 'domcontentloaded' })
    return this.#page
  }

  async evaluate(expression, { awaitPromise = false } = {}) {
    const page = await this.#ensure()
    // 表达式是调用方给的一段 JS；包成函数体再进页面执行。
    return page.evaluate(`(async () => { return (${expression}) })()`, undefined, { awaitPromise })
  }

  async click(text) {
    const page = await this.#ensure()
    const want = String(text ?? '').trim()
    const locator = page.locator(INTERACTIVE).filter({ hasText: want }).first()
    if ((await locator.count()) === 0) {
      const names = await page
        .locator(INTERACTIVE)
        .evaluateAll((els) =>
          [...new Set(els.map((el) => (el.innerText || el.value || el.getAttribute('aria-label') || '').trim()).filter(Boolean))].slice(0, 20),
        )
      throw new Error(`没找到「${want}」${names.length ? `；能点的有：${names.join(' / ')}` : ''}`)
    }
    await locator.click({ timeout: 8_000 })
    return { clicked: want, backend: this.name }
  }

  async type(text, { submit = false } = {}) {
    const page = await this.#ensure()
    const composer = page.locator('textarea,[contenteditable="true"],input[type="text"]').first()
    await composer.click({ timeout: 8_000 })
    await page.keyboard.insertText(String(text ?? ''))
    if (submit) await page.keyboard.press('Enter')
    return { typed: String(text ?? '').length, submit, backend: this.name }
  }

  async screenshot() {
    const page = await this.#ensure()
    await mkdir(this.#shotsDir, { recursive: true })
    this.#shotSeq += 1
    const file = join(this.#shotsDir, `${Date.now()}-${this.#shotSeq}.png`)
    await page.screenshot({ path: file })
    return { path: file, backend: this.name }
  }

  async snapshot(limit = 40) {
    const page = await this.#ensure()
    const items = await page.locator(INTERACTIVE).evaluateAll((els) =>
      [
        ...new Set(
          els
            .map((el) => {
              const r = el.getBoundingClientRect()
              if (r.width < 2 || r.height < 2) return null
              const name = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '')
                .replace(/\s+/g, ' ')
                .trim()
              return name ? `${el.getAttribute('role') || el.tagName.toLowerCase()}: ${name.slice(0, 60)}` : null
            })
            .filter(Boolean),
        ),
      ],
    )
    return { total: items.length, items: items.slice(0, limit), backend: this.name }
  }

  async close() {
    const browser = this.#browser
    this.#browser = null
    this.#page = null
    if (browser) await browser.close().catch(() => {})
  }
}
