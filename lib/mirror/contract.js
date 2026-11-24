/**
 * dsh-rig · 镜像契约（frame / input）
 *
 * 纯逻辑层：不 import `node:` 内建、不 import 任何外部包，只做「长什么样算合法」的判定与
 * 少量纯计算（缩放、地址、编解码）。和 `lab/` 那边结构守卫的理由一样 —— 判据只许有一份，
 * 而且必须能在任何进程里单独测。宿主侧 `mirror/server.js` 与插件侧 `mirror/plugin/host.js`
 * 都从这里取；两边各写一遍是这套东西最先漂的地方。
 *
 * 同一条 WebSocket 上跑两种载体：
 *   - **文本帧**：JSON，控制面。`{ t: 'hello' | 'frame' | 'input' | 'status' | 'bye', ... }`
 *   - **二进制帧**：JPEG 字节，数据面。**紧跟**在上一条 `t:'frame'` 文本帧之后发送。
 * 分开是因为截图是二进制，不该 base64 —— 一张 1280 宽 JPEG base64 后多约 33%，每秒 5 帧纯属白烧。
 *
 * 与 ROADMAP 第三节那张契约的差异（有意，已缩到最小）：
 *   frame  { seq, mime, bytes, w, h }               —— 与 ROADMAP 一致
 *   input  { type, x, y, button, key, delta, ... }  —— 在 ROADMAP 的骨架上补了 action/clickCount/
 *                                                      modifiers：鼠标「按下」与「抬起」必须可区分，
 *                                                      否则点一下按钮永远不会触发。
 */

/** 协议版本：字段语义变了就加一，宿主与插件握手时对不上就拒绝连接。 */
export const PROTOCOL_VERSION = 1

/** 帧的 MIME 只有这一种。PNG 一条 1280 宽的截图动辄 1–2 MB，JPEG q60 通常不到 150 KB。 */
export const FRAME_MIME = 'image/jpeg'

/** 最长边缩放到这个像素数（ROADMAP 定 1280）。 */
export const MAX_EDGE = 1280

/** JPEG 质量（ROADMAP 定 60）。 */
export const JPEG_QUALITY = 60

/** 单帧字节上限：超过它一定是编码参数写错了，早点拒绝比让宿主内存爆掉好。 */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024

/** 单条输入消息的字节上限（文本帧）。 */
export const MAX_INPUT_BYTES = 64 * 1024

/** 坐标上限：Electron/Chromium 的整数坐标是 32 位，但面板永远到不了这个量级。 */
export const MAX_COORD = 32767

/** 滚轮单次刻度上限（正负都算）。 */
export const MAX_DELTA = 10000

/** keyCode 字符串上限（Chromium 的键名最长是 'GamepadRightShoulder' 这类，32 足够）。 */
export const MAX_KEY_LENGTH = 32

/** 推帧间隔（毫秒）与断线重连退避序列 —— 上限 8s，之后一直 8s。 */
export const DEFAULT_INTERVAL_MS = 200
export const DEFAULT_BACKOFF_MS = Object.freeze([1000, 2000, 4000, 8000])

/** 发送缓冲上限：超过就丢帧（丢旧不丢新），别让 socket 缓冲吃满内存。 */
export const MAX_BUFFERED_BYTES = 512 * 1024

/** 镜像通道的宿主前缀。**必须**与 `lab/constants.js` 的 API_PREFIX 同源：那里是 `/dsh-rig/api`。 */
export const MIRROR_API_PREFIX = '/dsh-rig/api/mirror'

/** 控制面消息类型。 */
export const MESSAGE_TYPES = Object.freeze(['hello', 'frame', 'input', 'status', 'bye'])

/** 输入帧的三大类（对应 Electron 的鼠标 / 键盘 / 滚轮）。 */
export const INPUT_TYPES = Object.freeze(['mouse', 'key', 'wheel'])

/** 鼠标动作：位移、按下、抬起。`click` 是 down+up 的糖，宿主侧展开成两条事件。 */
export const MOUSE_ACTIONS = Object.freeze(['move', 'down', 'up', 'click'])

/** 按键动作。`char` 用 key 当字符直接注入（中文输入法之外的可打印字符）。 */
export const KEY_ACTIONS = Object.freeze(['down', 'up', 'char'])

/** Electron 认的鼠标键名。 */
export const BUTTONS = Object.freeze(['left', 'middle', 'right'])

/** 修饰键（Electron 的事件修饰位名字）。 */
export const MODIFIERS = Object.freeze(['shift', 'control', 'alt', 'meta', 'isAutoRepeat'])

/** 实验室 id 的形状（与 `lab/naming.js` 的白名单同口径：小写字母数字与短横线）。 */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u

const isInt = (value, min, max) => Number.isInteger(value) && value >= min && value <= max
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value)

/**
 * 校验实验室 id。返回规范化后的 id；不合法返回 null。
 * 单独一个函数是因为路径与地址都要用它 —— 不要在调用点拼正则。
 */
export function normalizeLabId(id) {
  const text = typeof id === 'string' ? id.trim() : ''
  return ID_PATTERN.test(text) ? text : null
}

/** 镜像端点的路径：`/dsh-rig/api/mirror/<id>`。id 不合法直接抛，别把坏地址往外递。 */
export function mirrorPath(id) {
  const labId = normalizeLabId(id)
  if (labId === null) throw new Error(`mirrorPath: 非法实验室 id ${JSON.stringify(id)}`)
  return `${MIRROR_API_PREFIX}/${labId}`
}

/**
 * 把宿主的 HTTP 地址（`http://127.0.0.1:52324`）换成镜像通道的 ws 地址。
 * https 对应 wss；token 走查询串（浏览器与 Node 的 WebSocket 都不能自定义头）。
 */
export function mirrorUrl(base, id, token = '') {
  const parsed = new URL(String(base))
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`mirrorUrl: 只接受 http(s) 基地址，收到 ${parsed.protocol}`)
  }
  const scheme = parsed.protocol === 'https:' ? 'wss:' : 'ws:'
  const suffix = token ? `?token=${encodeURIComponent(String(token))}` : ''
  return `${scheme}//${parsed.host}${mirrorPath(id)}${suffix}`
}

/**
 * 等比缩放到最长边不超过 maxEdge 的整数尺寸（最小 1）。
 * 纯计算：插件侧拿它算 `image.resize()` 的入参，宿主侧拿它判「这帧尺寸对不对」。
 * 已经够小就原样返回 —— 放大截图没有任何好处。
 */
export function fitWithin(width, height, maxEdge = MAX_EDGE) {
  if (!isInt(width, 1, Number.MAX_SAFE_INTEGER) || !isInt(height, 1, Number.MAX_SAFE_INTEGER)) {
    throw new Error(`fitWithin: 尺寸必须是正整数，收到 ${width}×${height}`)
  }
  if (!isInt(maxEdge, 1, Number.MAX_SAFE_INTEGER)) throw new Error('fitWithin: maxEdge 必须是正整数')
  const longest = Math.max(width, height)
  if (longest <= maxEdge) return { w: width, h: height }
  const scale = maxEdge / longest
  return { w: Math.max(1, Math.round(width * scale)), h: Math.max(1, Math.round(height * scale)) }
}

/**
 * 校验一条 frame 元数据。成功返回 `{ ok: true, frame }`（附补齐后的副本），失败返回 `{ ok: false, error }`。
 * 只判元数据 —— 二进制体由调用方按 `bytes` 长度对拍（契约不碰 Buffer，保持零内建）。
 */
export function validateFrame(frame) {
  if (frame === null || typeof frame !== 'object') return { ok: false, error: 'frame 必须是对象' }
  const { seq, mime, bytes, w, h } = frame
  if (!isInt(seq, 0, Number.MAX_SAFE_INTEGER)) return { ok: false, error: 'seq 必须是非负整数' }
  if (mime !== FRAME_MIME) return { ok: false, error: `mime 必须是 ${FRAME_MIME}` }
  if (!isInt(bytes, 1, MAX_FRAME_BYTES)) return { ok: false, error: `bytes 必须是 1..${MAX_FRAME_BYTES} 的整数` }
  if (!isInt(w, 1, MAX_EDGE) || !isInt(h, 1, MAX_EDGE)) return { ok: false, error: `w/h 必须是 1..${MAX_EDGE} 的整数` }
  if (Math.max(w, h) > MAX_EDGE) return { ok: false, error: `最长边超过 ${MAX_EDGE}` }
  return { ok: true, frame: { seq, mime, bytes, w, h } }
}

/** frame 的布尔版（给调用方省一次解构）。 */
export function isValidFrame(frame) {
  return validateFrame(frame).ok
}

/**
 * 校验并**补齐**一条输入。返回 `{ ok: true, input }`（含默认值）或 `{ ok: false, error }`。
 * 补默认值这件事放在契约里，是为了让宿主侧不必猜：默认左键、单击、鼠标默认 move。
 */
export function normalizeInput(input) {
  if (input === null || typeof input !== 'object') return { ok: false, error: 'input 必须是对象' }
  const type = input.type
  if (!INPUT_TYPES.includes(type)) return { ok: false, error: `type 必须是 ${INPUT_TYPES.join(' / ')}` }

  if (type === 'key') {
    const action = input.action ?? 'down'
    if (!KEY_ACTIONS.includes(action)) return { ok: false, error: `key.action 必须是 ${KEY_ACTIONS.join(' / ')}` }
    const key = input.key
    if (typeof key !== 'string' || key === '' || key.length > MAX_KEY_LENGTH) {
      return { ok: false, error: `key.key 必须是 1..${MAX_KEY_LENGTH} 字符的字符串` }
    }
    const modifiers = Array.isArray(input.modifiers) ? input.modifiers.filter((m) => MODIFIERS.includes(m)) : []
    return { ok: true, input: { type, action, key, modifiers } }
  }

  const x = input.x
  const y = input.y
  if (!isInt(x, 0, MAX_COORD) || !isInt(y, 0, MAX_COORD)) {
    return { ok: false, error: `x/y 必须是 0..${MAX_COORD} 的整数（客户端先按 canvas 尺寸换算好）` }
  }

  if (type === 'wheel') {
    const delta = input.delta ?? 0
    const deltaX = input.deltaX ?? 0
    if (!isFiniteNumber(delta) || !isFiniteNumber(deltaX)) return { ok: false, error: 'delta 必须是数字' }
    if (Math.abs(delta) > MAX_DELTA || Math.abs(deltaX) > MAX_DELTA) {
      return { ok: false, error: `delta 的绝对值不能超过 ${MAX_DELTA}` }
    }
    return { ok: true, input: { type, x, y, delta, deltaX } }
  }

  const action = input.action ?? 'move'
  if (!MOUSE_ACTIONS.includes(action)) return { ok: false, error: `mouse.action 必须是 ${MOUSE_ACTIONS.join(' / ')}` }
  const button = input.button ?? 'left'
  if (!BUTTONS.includes(button)) return { ok: false, error: `button 必须是 ${BUTTONS.join(' / ')}` }
  const clickCount = input.clickCount ?? 1
  if (!isInt(clickCount, 1, 3)) return { ok: false, error: 'clickCount 必须是 1..3' }
  return { ok: true, input: { type, action, x, y, button, clickCount } }
}

/** 组装一条 frame 元数据（不做校验，调用方发之前仍要过 validateFrame）。 */
export function makeFrame({ seq, bytes, w, h }) {
  return { seq, mime: FRAME_MIME, bytes, w, h }
}

/** 把控制面消息编码成文本帧内容；超过上限返回 null（调用方据此丢弃）。 */
export function encodeMessage(message) {
  const text = JSON.stringify(message)
  return text.length > MAX_INPUT_BYTES ? null : text
}

/**
 * 解码一条文本帧。**只认契约里有的类型** —— 收到别的东西一律 `{ ok: false }`，
 * 不抛出（一条坏消息不该把整条连接打死）。
 */
export function decodeMessage(text) {
  if (typeof text !== 'string' || text === '' || text.length > MAX_INPUT_BYTES) {
    return { ok: false, error: '文本帧为空或超长' }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, error: '不是合法 JSON' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: '消息必须是对象' }
  }
  if (!MESSAGE_TYPES.includes(parsed.t)) return { ok: false, error: `未知消息类型 ${JSON.stringify(parsed.t)}` }
  return { ok: true, message: parsed }
}

/** 给诊断面板 / 日志用的一份契约摘要（冻结，防止有人改到手）。 */
export const CONTRACT = Object.freeze({
  protocolVersion: PROTOCOL_VERSION,
  frame: Object.freeze({ mime: FRAME_MIME, maxEdge: MAX_EDGE, quality: JPEG_QUALITY, maxBytes: MAX_FRAME_BYTES }),
  input: Object.freeze({
    types: INPUT_TYPES,
    mouseActions: MOUSE_ACTIONS,
    keyActions: KEY_ACTIONS,
    buttons: BUTTONS,
    modifiers: MODIFIERS,
  }),
  path: MIRROR_API_PREFIX,
})
