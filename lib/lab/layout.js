/**
 * dsh-rig · 落点布局（纯计算，无 IO）
 *
 * 只算路径，不 mkdir、不 stat。`node:path` 用在这里是**有意的例外**：
 * 手写 join 在 Windows 盘符与 UNC 上太容易错，而这一层本身没有副作用，测起来只是字符串断言。
 * 判据（隔离/命名）不在这里 —— 它们在 `naming.js`（零内建，可穷举）。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 一个实验室的全部落点。传 null/空 id 时只给根级路径。
 * 目录层级：`<root>/labs/<id>/{home,workspace,tasks}`，版本缓存另放 `<root>/core/<ver>/`。
 */
export function labPaths(root, id) {
  if (!root) throw new Error('labPaths: 缺少 root')
  const base = { root, labsFile: join(root, 'labs.json'), coreDir: join(root, 'core') }
  if (!id) return base
  const dir = join(root, 'labs', id)
  return {
    ...base,
    dir,
    home: join(dir, 'home'),
    workspace: join(dir, 'workspace'),
    tasks: join(dir, 'tasks'),
  }
}

/** 版本 core 的 bin 落点。 */
export function coreBinPath(root, version) {
  return join(root, 'core', version, 'lib', 'bin.js')
}

/** 实验室根目录：默认放本机应用数据目录，绝不放进宿主 DSH_HOME 里。 */
export function resolveLabRoot(configRoot, env) {
  if (typeof configRoot === 'string' && configRoot.trim() !== '') return configRoot.trim()
  // 三平台的「应用数据目录」不是一个变量：
  //   Windows → LOCALAPPDATA（APPDATA 是漫游目录，必要时才退）；
  //   macOS   → XDG_DATA_HOME 缺省为 ~/.local/share（APPDATA 不存在）；
  //   Linux   → 同上。
  // ⚠️ 兜底**不能是 '.'**：那会让实验室落在进程的当前工作目录里（vim 打开文件的那个目录），
  // 换一个 profile 起服务就换一处落点，日志与数据看起来像「凭空消失」。
  const home = env.HOME || homedir()
  const base = env.LOCALAPPDATA || env.APPDATA || env.XDG_DATA_HOME || join(home, '.local', 'share')
  return join(base, 'dsh-rig')
}
