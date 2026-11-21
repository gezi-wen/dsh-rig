/**
 * dsh-rig · 工具挂载（接线层）
 *
 * 两件事：把生命周期工具挂上去，并且**按权限动态增减**界面操作工具。
 *
 * 为什么这段不在组合根里：它带着「注册 / 注销 / 订阅权限变化 / 卸载清理」四个动作，
 * 属于有状态的接线逻辑，塞进 `index.js` 会把装配层撑成第二个业务层（结构守卫盯着 150 行上限）。
 */
import { createLabTool } from './lab-tool.js'
import { createLabUiTool } from './lab-ui-tool.js'

/**
 * @param {object} tools 宿主 tools 服务（inner ctx 上的）
 * @param {{supervisor: object, versions?: object, titleOf?: (id: string) => string, log?: (line: string) => void}} deps
 * @returns {() => void} 卸载函数（注销两个工具并退订）
 */
export function mountLabTools(tools, { supervisor, versions, titleOf, log }) {
  const say = typeof log === 'function' ? log : () => {}
  let disposeUi = null

  const syncUiTool = (enabled) => {
    if (enabled && !disposeUi) {
      try {
        disposeUi = tools.register(createLabUiTool(supervisor))
        say('[dsh-rig] lab_ui 已注册（用户已授权界面操作）')
      } catch (err) {
        disposeUi = null
        say(`[dsh-rig] lab_ui 注册失败：${err?.message ?? err}`)
      }
    } else if (!enabled && disposeUi) {
      try {
        disposeUi()
      } catch {
        /* 已注销 */
      }
      disposeUi = null
      say('[dsh-rig] lab_ui 已注销（界面操作权限关闭）')
    }
  }

  try {
    tools.register(createLabTool(supervisor, versions, { titleOf }))
    say('[dsh-rig] plugin_lab 工具已注册')
  } catch (err) {
    say(`[dsh-rig] plugin_lab 注册失败：${err?.message ?? err}`)
  }

  syncUiTool(supervisor.uiMode())
  const off = supervisor.subscribe((event) => {
    if (event && event.type === 'ui-mode') syncUiTool(event.enabled)
  })

  return () => {
    off()
    if (disposeUi) {
      try {
        disposeUi()
      } catch {
        /* 已注销 */
      }
      disposeUi = null
    }
  }
}
