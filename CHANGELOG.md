# Changelog

本项目的所有重要改动都会记在这里。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [0.6.1] - 2026-11-27

### Fixed

- **实验室的模型凭据停在创建那天**。`copyCredentials` 只在 `create()` 里跑一次，宿主之后新配的 key 不会同步 ——
  实验室里的智能体于是报 `llm-deepseek: no API key for provider route "deepseek-official"`，
  而面板上一切正常（有会话、有消息、就是没有回复）。实测宿主 `.credentials.yaml` 10.4 KB / 4 条记录，
  实验室只有 0.2 KB / 1 条。现在 `#provision()` 每次都刷新凭据，`start()` 也走它，所以每次启动都会同步。
- **安装失败时看不到原因**。`install` / `remove` 的日志过滤只放行 `err` 流，而 spawn 阶段的诊断走 `rig` 流 ——
  表现是「装插件失败：exit null」且实验室日志里什么都没有。现在 `rig` 流一律记录。

### Added

- `lib/bridge/plugin/`：内桥探针（装进实验室的独立小插件），三条端点是 `/bridge/health`、`/bridge/shape`、`/bridge/send`。
  **未接线、未随主包启用**，只是把验证过的东西留在仓库里，0.7.0 正式实现从它长出来。

## [0.6.0] - 2026-11-26

### Added

- **卸载**：「装插件」那一行加了「卸载」按钮，填包名点它 —— `dsh plugin remove`。
- **已装计数**：同一行末尾显示 `已装 N` / `未装`，鼠标悬停能看完整清单（`name spec` 每行一个）。
- `plugin_lab` 新增两个动作：`plugins`（列清单）、`uninstall`（带 `spec`）。
- HTTP：`GET /labs/:id/plugins`、`POST /labs/:id/plugins`（卸载）。
- 三条操作在宿主侧合成一个 `supervisor.pluginOp(id, 'install'|'list'|'remove', spec)` —— supervisor 已贴行数上限。

### Verified

- 真机完整往返：装一个 `file:` 本地最小插件 → 清单立刻出现 → 卸载 → 清单清空，两步都 `exit 0`。
- 顺带确认两件事实：实验室 profile 的 `dependencies` 才是「用户装的插件」，内核在 `dsh.profile.bundles`（`base` + `web-app`），
  所以初始清单为 0 是正常的；装进去若没声明 `dsh.bundle`，DSH 会警告
  `installed as a plain dependency, not a profile layer` —— 「装了却没生效」先看这句。

## [0.5.0] - 2026-11-26

### Added

- **面板里能装插件**：新增一行输入框，填包名 / `github:owner/repo` / `file:路径` / 本地目录，点「安装」。
  装进的是**实验室自己的 profile**，不是宿主。
- `plugin_lab` 新增 `action: 'install'`（参数 `spec`），智能体也能装。**没有新增工具** ——
  这个工具常驻，加一个 enum 几乎不花 token；新工具会让每轮都多背一份 schema。
- 底层走 DSH 自己的路：`DSH_HOME=<实验室 home> dsh plugin --profile <p> add <spec>` ——
  与界面「插件」页的「添加插件」是同一套（那条命令就是把参数转发给 pnpm）。
- 装完**不会自动生效**：DSH 的插件注入表是进程启动时收集一次的，日志会提示「重启实验室后生效」。

### Verified

- 真机：装一个不存在的包 → pnpm 回 `ERR_PNPM_FETCH_404`，工具返回 `{ok:false, exit:1, reason:'exit-nonzero'}`，
  日志带完整错误与实验室自己的 `.plugin-manager/logs/operation-*/pnpm.log` 路径。
- `npm test` 68 条全绿。

## [0.4.1] - 2026-11-24

### Fixed

- **「在右侧栏打开」实际打开了系统浏览器**。`browserOpener` 只在 `openLab()`（智能体首次驱动、自动展开那条路）里赋值，
  而用户直接点面板按钮时它还是 `null`，于是走了兜底的 `window.open` —— 两个按钮行为一模一样。
  现在 `apply()` 里就 `inject(['sidebarRight'])` 并接上入口，不等任何事件。

## [0.4.0] - 2026-11-24

### Added

- **内存上限滑块**（面板上，512 MB – 16 GB，步长 256 MB，默认 2 GB）。拖完停手 250ms 才落盘，
  下次启动沿用；旁边实时显示当前占用（`内存上限 [──●──] 2048 MB · 现 273 MB`）。
- 宿主每 5 秒采样一次实验室进程的常驻内存（Windows `tasklist` / POSIX `ps`，零新依赖），
  **超过上限先记日志再停掉实验室** —— 这是「实验室能把宿主拖死」唯一没防住的那条路。
- 采样值走运行时表（不落盘），随 `/state` 返回。

### Verified

- 真机：实验室起来后采样到 273 MB；把上限压到 100 MB，一轮巡检内被停，
  日志写明「内存 273 MB 超过 100 MB，已停；面板滑块可放宽」。
- `npm test` 68 条全绿。

## [0.3.0] - 2026-11-24

### Changed

- **面板重构成控制台**。去掉视框：它在桌面版里必然是那句 `dsh web authentication required`（`dsh-app://` 与
  `http://127.0.0.1:<port>` 跨站 + `SameSite=Strict` cookie），留着只会把一段英文错误糊在中间占掉半个面板。
  现在版面是：头带（名称/状态/端口/占用者）→ 操作带 → 授权带 → **日志占满剩余高度**。
- **所有操作摆到面上**，不再藏进 `⋯` 菜单：停止（只停进程，不删实验室与配置）、在右侧栏打开、
  在浏览器打开、重启、销毁。`⋯` 与它的三级子菜单一并删除。
- 去掉「可介入 / 已锁定」：锁原本是挡 iframe 里的误触，没有 iframe 就没有意义。
- 去掉「切换版本」整条线：面板入口、`GET /versions`、`POST /labs/:id/version`、
  `plugin_lab` 的 `versions` 与 `set_version` 两个动作、版本相关的工具参数。宿主 core 的解析保持不动。
- 项目描述改成现状：**在右侧栏的浏览器里起一个隔离的 DSH 实例用于开发测试**。

### Fixed

- 0.2.1 的 `client.js` 里有一处 `nonce is not defined`（重构时删了状态却漏了引用），面板会白屏。本版清掉，
  并把残留引用（`menu` / `drawer` / `locked` / `frameUrl` / `Viewport`）一并扫干净。

### Verified

- `npm test` 68 条全绿；`client.js` 548 行（单 bundle 上限 620）。

## [0.2.1] - 2026-11-24

### Fixed

- **面板里出现两个「启动」**：主按钮一个、`⋯` 菜单里一个。菜单那个退回「重启」，且只在运行时可用。
  （0.1.6 把菜单项改成「启动」是为了 `hostId` 锁死时也能有入口 —— 现在归属判据已按 pid 存活判，
  主按钮会正常显示「启动」，那个重复项该退场了。）
- **运行态视框不再挂 iframe**。桌面版里那个 iframe 必然显示 `dsh web authentication required`：
  面板 origin 是 `dsh-app://`、实验室是 `http://127.0.0.1:<port>`，跨站 + `SameSite=Strict` cookie，浏览器规则内无解。
  现在视框只显示状态与一个「在面板打开」按钮，画面在右栏「浏览器」标签里。
- 去掉「刷新」菜单项：iframe 移除后它没有作用了。

### Changed

- 视框文案：运行中显示「实验室在运行 / 画面在右侧「浏览器」标签里」，不再是那句点不动的提示。

## [0.2.0] - 2026-11-24

### Added

- **「在面板打开」**：实验室运行时，主操作带多一个按钮，把实验室的界面开进右栏官方的「浏览器」标签
  （`ctx.sidebarRight.openTab('browser', { params: { url } })`，地址自带一次性 token）。
  没有 browser 插件时退回系统浏览器。
- 0.2.0 起实验室的**可视形态**就是这条：原生渲染、原生输入，不再经过 iframe 或截图流。

### Changed

- 形态决策修正：原计划的「第二个 Electron 实例 + CDP 镜像」**不做**。
  实验室继续是 headless（独立进程 + 独立 `DSH_HOME`），画面交给官方的浏览器载体。
  `lib/backends/` 与 `lib/mirror/` 保留为**未接线**的备选（将来做多实验室并排、或在不带 browser 插件的宿主里用）。

### Fixed

- 内嵌视口在桌面版永远停在 `dsh web authentication required`。**不再尝试修 iframe**：
  面板所在页面的 origin 是 `dsh-app://app/`，而实验室是 `http://127.0.0.1:46000`，两者不同站，
  实验室的登录又是一颗 `SameSite=Strict` cookie —— 跨站 iframe 里这颗 cookie 不发送，
  303 之后必然 401。`dsh web` 没有关鉴权的开关。官方 browser 插件在桌面版用的是 Electron `<webview>`
  （独立 partition、自己就是顶层站点），同一个地址在那儿登录态正常。完整推导在 `docs/ROADMAP.md`。

### Verified

- 真机：右栏「浏览器」标签载入带 token 的实验室地址，界面正常渲染（2026-11-24）。
- `npm test` 68 条全绿；`client.js` 620 行（单 bundle 上限）。

## [0.1.6] - 2026-11-24

### Fixed

- **宿主重启后实验室被锁成只读**（0.1.5 引入的回归）。归属判据从 `hostId` 改成
  「记录里的 pid 还活着、且不是本进程管的那个」。0.1.5 用 `hostId` 判归属，而它是
  `randomBytes(6)` **每进程随机**的 —— 宿主重启一次，之前建的实验室全部变成「别人的」：
  主按钮恒「接手」、「重启」被 `!live` 挡、「销毁」被 `!mine` 挡，而 claim 只换会话不改归属，
  于是**没有任何可达的启动入口**（2026-11-24 实测把 lab1 彻底锁死，只能手删 `labs.json`）。
- **profile 建不出来时静默失败**。`start()` 前现在会验 `profiles/<profile>` 在不在，
  不在就补建一次；补建失败抛明确错误（带原因），不再一路走到
  `profile "rig-lab1" does not exist`。lab1 从 2026-11-22 创建那天起就没成功过
  （`labs/lab1/home/init.err` 里躺着 `Cannot find module 'E:\Program'`），之后每次启动都崩。
- **接手（claim）不换归属**：`POST /labs/:id/claim` 现在一并清掉 pid 标记，
  否则 `foreign` 会一直挂到那个进程自然退出。

### Changed

- `labs.json` 新增可选字段 `pid` / `pidStartedAt`，**版本号仍是 1**（加字段不动版本）。
  为什么不升：旧版看到不认识的版本号会当「未知格式 → 按空状态处理」，
  那会让一次回滚把整份 `labs.json` 读成空的、并在下一次写盘时清掉。
  按「只能新增、不覆盖」的纪律走；旧版读到多余字段会忽略，只是丢掉 pid 能力。
- 实验室根目录的兜底修了：非 Windows 上原来会退成 `USERPROFILE/dsh-rig`，
  连 `USERPROFILE` 都没有（macOS / Linux）时**退成当前工作目录** `./dsh-rig`。
  现在按 LOCALAPPDATA → APPDATA → XDG_DATA_HOME → `~/.local/share` 取值，最后一层是 `os.homedir()`，
  永远不会落到 cwd。
- 一次性准备（profile 与凭据）从 `supervisor.js` 抽到 `lib/lab/provision.js`，
  就绪等待抽到 `lib/lab/health.js` —— supervisor 加完 pid 与补种后已贴 420 行上限。
- 包里带了 `lib/backends/` 与 `lib/mirror/` 两个**尚未接线**的骨架（0.2.0 的桌面形态与画面镜像）：
  不参与任何现有路径，行为无变化。
- 面板 `⋯` 菜单：没在运行时「重启」变「启动」且可点（以前启动入口只在主按钮上，
  而主按钮此时正显示「接手」，等于两条路都断）。

### Verified

- 用**与桌面宿主相同的参数**（Electron exe + `Program Files` 空格路径）在临时目录跑
  create → seed → start：profile 补建成功（exit 0）、实例 running、`foreign=false`、
  端口 46000 复用。
- `npm test` 全绿（新增 6 条：pid 归属四种边界、老记录补默认字段、pid 往返、根目录三平台兜底）。

## [0.1.5] - 2026-11-21

### Fixed

- **面板里显示不出实验室**（`dsh web authentication required`）：`/frame` 的 302 现在把主机名换成
  **本次请求的主机名**。原因：实验室登录是「token → 303 换成 `SameSite=Strict` 的 HttpOnly cookie → 再请求 `/`」，
  宿主页面若是 `localhost:xxx` 而重定向到 `127.0.0.1:46xxx`，iframe 就跨站了，那颗 cookie 存不下。
  同一份代码 A/B 实测：页面 `127.0.0.1` 正常、页面 `localhost` 退回鉴权页；修完后两者都正常。
- **两个宿主进程互相吞实验室**：`labs.json` 的写盘改成「锁 → 读盘 → 合并 → 写」。
  桌面版与 web 版同时开着时，各自持一份内存状态、谁后写谁赢 —— 实测丢过一条记录。
  现在盘上有、内存没有的会留着；每条实验室带 `hostId`，不是本进程管的在面板里只读；
  老记录没有 `hostId` 的按「自己的」处理，升级不会把人锁在门外。
- `load()` 的裸 `catch` 会把任何异常（包括漏 import 的 `ReferenceError`）吞成「0 个实验室」：
  现在只有文件不存在才算空，其它错误如实上报并说明原因。

## [0.1.4] - 2026-11-21

### Added

- **占用**：实验室是全局资源、面板是会话级的，所以现在说清「谁在驾驶」。
  头带显示 `本会话` / `空闲` / `DSH 插件实验室开发规划 · 18:20 起`；动手才 claim（打开面板不占坑）；
  被别人占着时主按钮变「接手」。`plugin_lab` 与 `lab_ui` 也受同一套规则约束（传 `force: true` 强行接手）
- **别的会话驾驶时视口仍然可看**，只挡输入 —— 可观测性才是这个面板的价值
- **智能体第一次驱动实验室时，右栏自动展开到实验室页**：事件流提到页级单例，
  插件加载就连上，`open-lab` 因此能到达一个还没打开的面板（同一会话只展开一次）。
  被拒绝的驱动也会展开 —— 拒绝文案本来就叫你去面板点「接手」
- 自绘插件图标（双层窗口 + 状态点），开始页卡片与标签页共用，替代 🧪

### Changed

- 面板改成三带版式：头带（名称/状态/时长/占用者）· 主操作带（一个大按钮 + `⋯` 菜单）·
  视口 · 底带（锁定 / 授权 / 日志把手）。日志收进可展开的抽屉，不再常驻占高度
- 默认**不锁**：面板就是给你当手边机器用的；锁留给「只想看着」的时刻
- 销毁收进 `⋯`，带二次确认与「不能撤销」提示
- 未运行时不再挂 iframe：入口会回一张 503 HTML，那张页会把面板自己的占位说明顶掉
- 去掉会话头部的入口按钮，只从右栏进

### Fixed

- 占用者优先显示**会话标题**，与左侧栏列表逐字一致、随对话实时变：面板读槽位标准 prop
  `useSessions` 的 `byId[id].title`（覆盖全部会话），拿不到再退回宿主 `/state` 的 `ownerTitle`
  （只认正在跑的会话），最后才是短 id；`plugin_lab` 的拒绝文案同样带标题
- 会话短 id 从前缀后面取：真实 id 是 `session-240add47-…`，取前 8 位只会得到 `session-`
  （真机上被智能体吐槽「归 session- 使用」才发现）
- 日志面板后开时是空的：现在打开抽屉/切到实验室时补一次环形缓冲的历史
- `scripts/dev-reload.ps1`：`-DSHHome` 没同步到子进程环境（包装进一个 home、实例从另一个起）；
  `dsh plugin add` 的幂等 + lockfile 里旧的 integrity 会让「重装成功」却跑旧代码
  （改用 `pnpm remove` + `pnpm add` 重算）；`Start-Process` 参数不转义路径里的空格

## [0.1.3] - 2026-11-21

### Changed

- 实验室改用**固定端口**（从 46000 起找空位并落盘），不再每次启动让系统随机分配：
  端口一变就是换 origin，浏览器会把登录态与页面状态全部丢掉，内嵌视图因此每次重启都要重来。
  端口被占时自动换一个并写回记录

## [0.1.2] - 2026-11-21

### Added

- `plugin_lab` 新增 `orphans` / `reap`：列出并回收宿主被硬杀后残留的实验室进程
- HTTP 边新增 `GET /orphans` 与 `POST /orphans/reap`（只列不杀是默认，回收要显式请求）
- 回收的判据只有一条：命令行带 `--profile rig-<已知 lab>` 但当前没在管理的进程，
  不按端口或进程名杀

## [0.1.1] - 2026-11-21

### Fixed

- 面板内嵌视图在实验室重启后卡在 `dsh web authentication required`：iframe 现在指向宿主的稳定入口
  （每次 302 到实验室当前地址），不再持有会过期的端口与 token
- 实验室换地址时主动重导航一次内嵌视图（此前只更新状态、不触发重新加载）
- 事件流安静挂住时面板停在旧状态：新增 25 秒无事件即主动拉一次状态的看门狗

## [0.1.0] - 2026-11-21

第一个可用版本。

### Added

- 右栏「插件实验室」面板：创建 / 启动 / 重启 / 刷新 / 弹出 / 停止 / 销毁一个**真实、进程级隔离**的 DSH
- 内嵌实时界面，配「锁定 / 可介入」开关（锁定只挡输入，不是安全边界）
- 实时日志：跟随实验室的 stdout/stderr，token 与用户名自动打码
- 体检报告 `report`：profile 声明 / 组合补丁行 / 运行时 / 启动期被禁用或加载失败的插件行 / 工作区文件树
- 智能体工具 `plugin_lab`（生命周期，常驻）
- 智能体工具 `lab_ui`（看 / 拍 / 按文字点 / 打字 / 派任务），**只在用户授权期间注册**
- 界面驱动后端按可用性降级：Playwright（自带或系统浏览器 channel）→ 裸 CDP → 明确报告缺失项
- 切换实验室使用的 DSH 版本（仅已安装版本），重启后生效
- 中英双语 README、插件详情页与预览图

### Notes

- 实验室的 `DSH_HOME` 与宿主互不包含；创建与启动前都会校验，命中越界直接拒绝。
- 默认把宿主凭据复制进实验室，否则实验室里的智能体没有可用模型；可在配置里关闭。
- 已知边界：不能安装新的 DSH 版本；「向实验室派活」与施工可视化留待后续版本。
