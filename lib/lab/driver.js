/**
 * dsh-rig · 界面驱动门面（IO 层）
 *
 * 只做一件事：**按可用性挑一个后端**，然后交出统一的五个动作。
 *
 * 选择顺序（配置 `uiBackend` 可强制）：
 *   1. `playwright` —— 自带浏览器，不假设用户装了 Edge/Chrome。**可选依赖**：没装就跳过。
 *   2. `cdp` —— 用本机 Edge/Chrome，零下载。找不到就说明没有可用后端。
 *
 * 为什么不当场把 Chromium 打进包里：几百 MB + postinstall 下载，属于「为了一个可选能力
 * 让所有用户付账」，也踩供应链审查的红线。插件只声明它是 optional peer。
 */
import { probePlaywright, PlaywrightDriver } from './ui/playwright-impl.js'
import { CdpDriver } from './ui/cdp-impl.js'

/**
 * @returns {Promise<{driver: object|null, backend: string, reason: string|null}>}
 */
export async function createDriver({ labUrl, userDataDir, shotsDir, log, preference = 'auto', browserPath }) {
  const pref = String(preference || 'auto')
  let playwrightReason = '未尝试'

  if (pref !== 'cdp') {
    const probe = await probePlaywright()
    if (probe.ok) {
      return {
        driver: new PlaywrightDriver({ labUrl, shotsDir, log, mode: probe.mode }),
        backend: probe.mode === 'channel' ? 'playwright(channel)' : 'playwright',
        reason: null,
      }
    }
    playwrightReason = probe.reason
    if (pref === 'playwright') return { driver: null, backend: 'none', reason: playwrightReason }
  }

  const cdp = new CdpDriver({ labUrl, userDataDir, shotsDir, log, browserPath })
  if (cdp.available) return { driver: cdp, backend: 'cdp', reason: null }
  return { driver: null, backend: 'none', reason: cdp.unavailableReason || playwrightReason }
}

/** 只问「有没有得用」，不启动浏览器。给诊断与面板提示用。 */
export async function probeDriver({ preference = 'auto', browserPath } = {}) {
  const pref = String(preference || 'auto')
  if (pref !== 'cdp') {
    const probe = await probePlaywright()
    if (probe.ok) return { backend: probe.mode === 'channel' ? 'playwright(channel)' : 'playwright', available: true, reason: null }
    if (pref === 'playwright') return { backend: 'none', available: false, reason: probe.reason }
  }
  const cdp = new CdpDriver({ labUrl: 'about:blank', userDataDir: '', shotsDir: '', log: () => {}, browserPath })
  if (cdp.available) return { backend: 'cdp', available: true, reason: null }
  return { backend: 'none', available: false, reason: cdp.unavailableReason }
}
