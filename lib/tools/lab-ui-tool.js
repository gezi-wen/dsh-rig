/**
 * dsh-rig · 界面操作工具（**按权限动态注册**）
 *
 * 这个工具**平时不存在**。只有用户在面板里打开「允许智能体操作界面」之后才注册进来，
 * 关掉就当场注销。
 *
 * 为什么要这样：工具 schema 每轮都进 prompt。一个「点按钮 / 打字 / 截图」的工具带着
 * 七八个参数，占的是**每一轮**的上下文，而绝大多数会话根本用不到它。把它挂在权限后面，
 * 等于让成本跟着用法走，而不是让所有人平摊。
 *
 * 它和 `plugin_lab`（生命周期）分开而不是同一个工具加 action 枚举，也是同一个理由：
 * 生命周期的 schema 要一直留着，界面操作的不要。
 */
import { guardDrive } from '../lab/drive-guard.js'

const text = (s) => [{ type: 'text', text: String(s ?? '') }]

const ACTIONS = ['snapshot', 'screenshot', 'click', 'type', 'task']

export function createLabUiTool(supervisor) {
  return {
    name: 'lab_ui',
    description:
      '像人一样操作实验室（仅在用户于面板里打开「允许智能体操作界面」后可用）。' +
      'snapshot 看有哪些可点元素；screenshot 截图（返回文件路径，用读图工具看）；' +
      'click 按**文字**点按钮；type 往输入框打字（submit 决定是否回车）；task 直接把一句话当任务提交。' +
      '界面是按文字找的，找不到会把候选名列出来 —— 别猜坐标。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ACTIONS, description: '要做的界面动作' },
        id: { type: 'string', description: '实验室 id（list 里能看到）' },
        text: { type: 'string', description: 'click 的按钮文字 / type 与 task 的内容' },
        submit: { type: 'boolean', description: 'type 后是否敲回车，默认 false' },
        limit: { type: 'integer', minimum: 1, maximum: 120, description: 'snapshot 最多列多少条，默认 40' },
        force: { type: 'boolean', description: '实验室被别人驾驶时强行接手（会中断对方正在进行的操作）' },
      },
      required: ['action', 'id'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render(args, value) {
        const v = value ?? {}
        if (!v.ok) return text(`错误：${v.error ?? '未知错误'}`)
        return text(v.text)
      },
    },
    async execute(args, exec) {
      const action = String(args?.action || '')
      const id = String(args?.id || '')
      const sessionId = exec?.agent?.session?.id ? String(exec.agent.session.id) : ''
      try {
        if (!ACTIONS.includes(action)) return { ok: false, error: `未知动作 ${action}（可用：${ACTIONS.join(' / ')}）` }
        if (id === '') return { ok: false, error: '需要 id' }
        // 界面操作也是驾驶：别人的实验室不碰（拒绝文案带占用者 id）。
        const verdict = await supervisor.mutate(id, (lab) => guardDrive(lab, sessionId, { force: Boolean(args?.force) }))
        if (!verdict.allow) return { ok: false, error: verdict.reason }
        const result = await supervisor.ui(id, action, {
          text: args?.text,
          submit: Boolean(args?.submit),
          limit: args?.limit,
        })
        if (action === 'screenshot') return { ok: true, text: `截图已存：${result.path}（用读图工具看它）` }
        if (action === 'snapshot') {
          return { ok: true, text: `可交互元素 ${result.total} 个（后端 ${result.backend}）：\n${(result.items || []).join('\n')}` }
        }
        return { ok: true, text: JSON.stringify(result) }
      } catch (err) {
        return { ok: false, error: String(err?.message ?? err) }
      }
    },
  }
}
