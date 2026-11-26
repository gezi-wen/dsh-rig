/**
 * dsh-rig · 给宿主智能体的工具（一个工具，动作枚举）
 *
 * 为什么只给一个工具而不是十个：工具 schema 每轮都在 prompt 里占地方，十个动词会让
 * 「我要不要用实验室」这件事本身变贵。一个 `plugin_lab` + `action` 枚举，成本一份。
 *
 * 失败是值不是异常：所有错误都返回 `{ok:false, error}` 的文本回执。
 * 工具抛错会打断模型那一轮，而「实验室没启动起来」不该有那么大的杀伤力。
 *
 * M1 的动作只到生命周期；「往实验室里投递任务」要等 in-lab 桥（M5），
 * 那时会新增 `dispatch`，而不是改现有动作的语义。
 */
import { renderReport } from '../lab/report.js'
import { guardDrive, isDriveAction } from '../lab/drive-guard.js'

const text = (s) => [{ type: 'text', text: String(s ?? '') }]

const ACTIONS = ['list', 'create', 'start', 'stop', 'restart', 'destroy', 'status', 'logs', 'report', 'install', 'uninstall', 'plugins', 'orphans', 'reap']

function renderLab(lab) {
  const head = `[${lab.id}] ${lab.name} · ${lab.status}${lab.port ? ` · :${lab.port}` : ''}`
  return `${head}\n    profile=${lab.profile}`
}

export function createLabTool(supervisor) {
  return {
    name: 'plugin_lab',
    description:
      '管理「插件实验室」：在独立进程 + 独立 DSH_HOME 里跑一个真实 DSH，用来开发与验收插件，崩了不牵连当前会话。' +
      '动作：list（列全部）/ create（新建）/ start / stop / restart / destroy / status（单个详情）/ logs（最近日志）/ orphans（列残留）/ reap（收残留）。' +
      '注意：实验室里的智能体是独立进程，本工具不能替它说话；要它干活需要人或它自己的会话。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ACTIONS, description: '要执行的动作' },
        id: { type: 'string', description: '实验室 id（list 里能看到，如 lab1）；list/create 之外必填' },
        name: { type: 'string', description: 'create 时的显示名' },
        since: { type: 'integer', minimum: 0, description: 'logs 的起点序号，默认 0' },
        lines: { type: 'integer', minimum: 1, maximum: 200, description: 'logs 最多返回多少行，默认 40' },
        spec: { type: 'string', description: 'install 要装的插件：包名 / github:owner/repo / file:路径 / 本地目录' },
        force: { type: 'boolean', description: '实验室被别人驾驶时强行接手（会中断对方正在进行的操作）' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    // ⚠️ `render` 必须放在 `output` **里面**：放成 definition 的兄弟会被宿主拒收，
    // 报错是 `tool "plugin_lab" must declare output { schema, render, presentationMeta? }`
    // （2026-11-21 实测，找了几分钟才发现是层级放错而不是少写）。
    output: {
      schema: { type: 'object' },
      render(args, value) {
        const v = value ?? {}
        return text(v.ok ? v.text : `错误：${v.error ?? '未知错误'}`)
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const action = String(args?.action || '')
      const id = String(args?.id || '')
      // 会话身份：工具是「谁在驾驶」的唯一来源（面板走 HTTP 时自带 sessionId）。
      const sessionId = exec?.agent?.session?.id ? String(exec.agent.session.id) : ''
      try {
        if (!ACTIONS.includes(action)) return { ok: false, error: `未知动作 ${action}` }
        if (action === 'list') {
          const labs = supervisor.list()
          if (labs.length === 0) return { ok: true, text: '还没有实验室。用 action=create 建一个。' }
          return { ok: true, text: labs.map(renderLab).join('\n') }
        }
        if (action === 'create') {
          const lab = await supervisor.create({ name: args?.name })
          if (sessionId) await supervisor.mutate(lab.id, (record) => guardDrive(record, sessionId))
          supervisor.announce(lab.id, sessionId)
          return { ok: true, text: `已创建：\n${renderLab(lab)}` }
        }
        if (id === '') return { ok: false, error: '这个动作需要 id' }
        // 占用：动手才 claim。别人的实验室一律拒绝，拒绝文案带上占用者 id（用户可在面板接手）。
        if (isDriveAction(action)) {
          const verdict = await supervisor.mutate(id, (lab) => guardDrive(lab, sessionId, { force: Boolean(args?.force) }))
          // **被拒绝也要广播**：拒绝文案让人「去面板里点接手」，那就把面板打开给他看。
          supervisor.announce(id, sessionId)
          if (!verdict.allow) return { ok: false, error: verdict.reason }
        }
        if (action === 'status') {
          const lab = supervisor.get(id)
          if (!lab) return { ok: false, error: `没有实验室 ${id}` }
          return { ok: true, text: `${renderLab(lab)}\n    URL: ${lab.url ? lab.url.replace(/token=[^&]+/u, 'token=***') : '（未运行）'}` }
        }
        if (action === 'logs') {
          const { entries } = supervisor.logs(id, Number(args?.since || 0))
          const limit = Math.min(Number(args?.lines || 40), 200)
          const tail = entries.slice(-limit)
          if (tail.length === 0) return { ok: true, text: '（没有日志）' }
          return { ok: true, text: tail.map((e) => `${e.seq} ${e.stream === 'err' ? '!' : '·'} ${e.text}`).join('\n') }
        }
        if (action === 'report') {
          const report = await supervisor.report(id)
          return { ok: true, text: renderReport(report) }
        }
        if (action === 'install') {
          if (!args?.spec) return { ok: false, error: 'install 需要 spec（包名 / GitHub 地址 / 本地路径 / file:tgz）' }
          const result = await supervisor.pluginOp(id, 'install', String(args.spec))
          return result.ok
            ? { ok: true, text: `已装 ${args.spec}；重启实验室后生效（面板点「重启」）。` }
            : { ok: false, error: `装插件失败：${result.reason}（exit ${result.exit ?? 'null'}）` }
        }
        if (action === 'plugins') {
          const list = await supervisor.pluginOp(id, 'list')
          return { ok: true, text: list.length === 0 ? '实验室还没装任何插件。' : list.map((p) => `${p.name}  ${p.spec}`).join('\n') }
        }
        if (action === 'uninstall') {
          if (!args?.spec) return { ok: false, error: 'uninstall 需要 spec（要卸的包名）' }
          const result = await supervisor.pluginOp(id, 'remove', String(args.spec))
          return result.ok ? { ok: true, text: `已卸载 ${args.spec}；重启实验室后生效。` } : { ok: false, error: `卸载失败：${result.reason}` }
        }
        if (action === 'orphans' || action === 'reap') {
          const tracked = supervisor.list().filter((lab) => lab.status === 'running' || lab.status === 'starting')
          const result = await reapOrphans({
            trackedProfileNames: tracked.map((lab) => lab.profile),
            dryRun: action === 'orphans',
          })
          if (result.found.length === 0) return { ok: true, text: '没有残留的实验室进程。' }
          const lines = result.found.map((item) => `${item.pid} · ${item.profile}`)
          if (action === 'orphans') {
            return { ok: true, text: `发现 ${result.found.length} 个残留实验室进程（未处理）：\n${lines.join('\n')}\n要清掉就把 action 换成 reap。` }
          }
          return {
            ok: true,
            text: `回收完成：清掉 ${result.killed.length} 个${result.failed.length ? `，失败 ${result.failed.length} 个` : ''}\n${lines.join('\n')}`,
          }
        }
        if (action === 'start') {
          const lab = await supervisor.start(id)
          return { ok: true, text: `已启动：\n${renderLab(lab)}` }
        }
        if (action === 'stop') {
          const lab = await supervisor.stop(id)
          return { ok: true, text: `已停止：\n${renderLab(lab)}` }
        }
        if (action === 'restart') {
          const lab = await supervisor.restart(id)
          return { ok: true, text: `已重启：\n${renderLab(lab)}` }
        }
        if (action === 'destroy') {
          await supervisor.destroy(id)
          return { ok: true, text: `已销毁 ${id}（目录与 profile 一并清掉）` }
        }
        return { ok: false, error: `动作 ${action} 还没有实现` }
      } catch (err) {
        return { ok: false, error: String(err?.message ?? err) }
      }
    },
  }
}
