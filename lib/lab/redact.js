/**
 * dsh-rig · 日志脱敏（纯逻辑层）
 *
 * 为什么要独立成模块：脱敏是**判据**（什么算敏感、打到什么程度），
 * 它跟「环形缓冲怎么存」、「日志怎么推给面板」是两件事。
 * 混在一起时，改一个打码规则要去翻 500 行的看管者。
 *
 * 三类必打码：
 *   1. URL 里的 token（实验室每次启动都会打一行带 token 的 URL）；
 *   2. Windows 用户目录（`C:\Users\<name>`）；
 *   3. 键值形态的 api key / secret / password。
 */

const TOKEN_IN_URL = /([?&]token=)[A-Za-z0-9_-]+/gu
const WINDOWS_USER_DIR = /([A-Za-z]:\\Users\\)[^\\/\s]+/gu
const SECRET_PAIR = /("?(?:api[_-]?key|apikey|token|secret|password|passwd|credential|authorization|key)"?\s*[:=]\s*")([^"]+)(")/giu

export function redactLine(line) {
  return String(line ?? '')
    .replace(TOKEN_IN_URL, '$1***')
    .replace(WINDOWS_USER_DIR, '$1***')
    .replace(SECRET_PAIR, '$1***$3')
}
