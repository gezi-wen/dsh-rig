# ROADMAP · 0.1.6 → 0.3.0

> 2026-11-24 定。本文件是**施工计划**，不是愿望清单：每一版都写清改动落到哪个文件、怎么验收、失败怎么退。
> 面板版式与交互仍在 `DESIGN.md`；本文件只管「下一个版本要动什么」。

## 零、四条已定决策

1. **单一形态**。实验室 = 第二个 DSH 桌面实例（同一个可执行文件，独立 `--user-data-dir` 与 `DSH_HOME`）。
   **不提供 runtime 切换**（web / desktop 二选一的开关不做）——分支越少越稳。
2. **无图形会话自动兜底**。宿主跑在 SSH / 无 DISPLAY 的 Linux 上时，自动退回 headless（现在的形态）并记一行日志。
   这是兜底，不是选项，面板上不体现。
3. **隔离目标 = 别把宿主炸死**，不是防定向攻击。VM / 沙盒 / 独立用户不做；
   需要更强隔离的用户，README 指路「换一台机器或远程主机」。
4. **硬需求**：面板里能直接看见实验室的桌面窗口，并在里面点。不接受「弹出去单独看」。

## 一、模块边界（降耦的唯一标准）

依赖只能从上往下，反向依赖由结构测试拦：

```
接线    index.js · http/routes.js · tools/mount.js · tools/lab-*.js
选择    backends/index.js          ← 全仓唯一「用哪个后端」的地方
后端    backends/web-core.js       headless（兜底）
        backends/desktop-shell.js  第二 Electron 实例（默认）
镜像    mirror/server.js           宿主侧帧/输入通道
        mirror/plugin/             显微镜插件（装进实验室 profile）
看管    lab/supervisor.js          生命周期，只认 backend 契约，不认识 Electron
纯逻辑  lab/{constants,naming,registry,spawn-plan,merge,drive-guard,limits}
客户端  client.js + client/        渲染层，<IframeView/> 与 <MirrorView/> 是两个组件
```

三条硬规矩：

- `supervisor.js` 不认识 `electron`、不认识 `ws`、不认识 canvas —— 它只调 `backend.*`。
- `mirror/` 不认识 lab 状态机 —— 它只收发帧与输入，不知道自己被谁托管。
- `client.js` 不认识后端种类 —— 它看 `lab.mirror` 有没有值来选组件。

## 二、0.1.6 · 治根（先做，1.5–2 小时）

目标：解锁死 + 启动自愈。**不引入任何新依赖、不改形态。**

| # | 文件 | 改动 |
|---|---|---|
| 1 | `lib/lab/merge.js` | 归属判据改成「pid 存活且不是本进程管的那个」；`hostId` 降级为诊断字段，不再参与判定（**实施时的修正**：原计划新建 `host-id.js` 做机器级持久 id，实际不需要 —— 判据换成运行时事实后，hostId 保留即可） |
| 2 | `lib/lab/registry.js` | lab 增 `pid` / `pidStartedAt`（落盘，用于判断「谁真在跑」）；**版本号保持 1**（加字段不动版本，否则回滚到 0.1.5 会把文件读成空的） |
| 3 | `lib/lab/state-store.js` | 不用改：缺字段补默认值发生在 `parseState`，store 只管读写 |
| 4 | `lib/lab/process.js` | `isAlive(pid)` 用 `process.kill(pid, 0)`，三平台一致；`EPERM` 算活着 |
| 5 | `lib/lab/layout.js` | 根目录兜底修了：非 Windows 原来会退成 `./dsh-rig`（当前工作目录）。现在 LOCALAPPDATA → APPDATA → XDG_DATA_HOME → `~/.local/share` |
| 5 | `lib/lab/provision.js`（新） | 一次性准备抽出来：`ensureProfile()` 在 start 前验目录、缺失就补建；`seedProfile()` 认 `Cannot find module` 这类指纹并落日志 |
| 6 | `lib/lab/health.js`（新） | 就绪等待从 supervisor 抽出（它已贴 420 行上限） |
| 7 | `lib/lab/supervisor.js` | ① `start()` 前调 `ensureProfile`，失败抛明确原因；② `start/stop/exit` 写清 pid；③ `list()` 用 `{ownedPid, alive}` 判 foreign |
| 8 | `lib/http/routes.js` | claim 成功时清 pid（接手 = 接管记录） |
| 9 | `lib/client.js` | 非 running 态菜单里的「重启」改文案「启动」并放行 |
| 10 | `test/merge.test.mjs` / `test/pure.test.mjs` / `test/structure.test.mjs` | pid 归属四例 + v1→v2 迁移幂等 + 白名单补两个新文件 |

验收（缺一不算完）：

- 重启宿主 → 面板上 lab 仍可启动（不再「接手」锁死）。
- 删掉某个 lab 的 `profiles/` → 点启动 → 自动补种 → 起来。
- `npm test` 全绿，结构守卫全绿。
- lab1 现状：能启动成功，或至少报出**新**的错（不是 profile 不存在）。

## 三、0.2.0 · 桌面形态（2–3 天）

目标：实验室跑成真桌面实例，面板里能看见并点。**这是硬需求那一版。**

### 后端契约

```js
// lib/backends/contract.js
{ kind,                      // 'web-core' | 'desktop-shell'
  prepare(lab)  → void,      // 建目录、seed、复制凭据
  launch(lab)   → {pid},     // 起进程；不阻塞等就绪
  stop(lab)     → void,
  probe(lab)    → {ok, url?} }
```

`backends/index.js` 只有一个函数 `pick({ hasDisplay })`：有图形会话 → `desktop-shell`，否则 `web-core`。

### 镜像契约（2026-11-24 修订：走 CDP，不走插件）

原计划「实验室里装显微镜插件，用 `webContents.capturePage()` 推帧」**不成立**。
核实结果：正式版桌面把 DSH 跑在 `@deepseek-ai/dsh-desktop-host` 里
（`DeepSeek Harness.exe --expose-internals … dsh-desktop-host/lib/index.js …`，Electron 二进制 + `ELECTRON_RUN_AS_NODE`），
插件处于**纯 Node 上下文**：`process.versions.electron` 为真，但 `require('electron')` 给不出 BrowserWindow，
`capturePage` / `sendInputEvent` 都拿不到。

实测可行的通道是 **CDP**：

```
DeepSeek Harness.exe --user-data-dir=<lab>/userdata --remote-debugging-port=<47000+n>
  → GET http://127.0.0.1:<port>/json/version  →  { "Browser": "Chrome/152.0.7977.130", "Electron/44.7.0" }
  → WS 连 page target
      Page.captureScreenshot { format: 'jpeg', quality: 60 }   → 帧
      Input.dispatchMouseEvent / dispatchKeyEvent              → 输入
```

已实测（2026-11-24，探针脚本未随仓库发布）：

| 项 | 结果 |
|---|---|
| 第二实例能不能起 | 能。pid 独立、窗口独立、与正式版并存 |
| `--user-data-dir` 生不生效 | 生效（隔离目录里出现 `Cache` / `Code Cache` / `desktop` 等） |
| `DSH_HOME` 生不生效 | 生效（隔离 home 里自动建 `profiles` / `sessions` / `storages` / `.credentials.yaml`） |
| CDP 端口 | 可达，返回 Chrome 152 / Electron 44.7.0 + `webSocketDebuggerUrl` |

**踩到的坑**：`ELECTRON_RUN_AS_NODE=1` 会从宿主继承进子进程，此时 `DeepSeek Harness.exe` 走 node 模式，
任何 GUI 开关都报 `bad option`（exit 9）。spawn 前必须删掉这个变量。

代价：看不到窗口装饰与原生对话框。DSH 的 UI 全在 renderer 里，够用；壳自己的欢迎页/更新弹窗看不到，
需要时用「弹出到窗口」（`window.open` 那个动作）人工看。

### 为什么 0.1.x 的内嵌视口在桌面版里救不回来（2026-11-24 定案）

0.1.5 修的是「`localhost` 页面 iframe 到 `127.0.0.1:46000`」—— 那是 http 对 http，换主机名就同站了。
桌面版还有更深的一层：**面板所在的 origin 是 `dsh-app://app/`**（自定义协议，CDP 的 page target 就是这个 URL），
而 iframe 里的实验室是 `http://127.0.0.1:46000`。两者**不同站**，实验室登录用的却是一颗
`SameSite=Strict` 的 cookie（实测响应头：`set-cookie: dsh-auth-…; Path=/; HttpOnly; SameSite=Strict`）
→ 跨站 iframe 里这颗 cookie 不发送 → 303 之后请求 `/` 得到 401 → 面板里只看到
`dsh web authentication required`。web 版没这个问题，因为顶层就是 `http://127.0.0.1:<端口>`，与实验室同站
（SameSite 只比较 scheme + 可注册域，不看端口）。

`dsh web` 没有关鉴权的开关（`--help` 只有 host / port / no-open / public-url / trusted-host / tls-*），
`--trusted-host` 管的是 `/api` 的 browser-trust 栅栏，管不到登录 cookie。
反向代理能绕，但要连 WebSocket/SSE 一起转发，成本和收益不成比例。

**所以 0.1.x 不再修这个**：CDP 镜像不走 iframe、不碰 cookie，是这一族的根治。

`lib/mirror/plugin/` 保留为**备选**（若将来壳开放推帧桥），默认不启用。

```js
// lib/mirror/contract.js（已实现，保留）
frame  { seq, mime: 'image/jpeg', bytes, w, h }
input  { type: 'mouse'|'key'|'wheel', x, y, button, key, delta }
```

### 改动清单

| # | 文件 | 内容 |
|---|---|---|
| 1 | `lib/backends/contract.js` | 上面那份契约 + `assertBackend()` |
| 2 | `lib/backends/web-core.js` | 把现在 `spawn-plan.buildStartPlan` 那条路搬进来，行为不变 |
| 3 | `lib/backends/desktop-shell.js` | 启 Electron：`[exe, '--user-data-dir', <lab>/userdata]` + `DSH_HOME=<lab>/home`，其余参数同 web-core |
| 4 | `lib/backends/index.js` | `pick()` 判图形会话：Win/mac 恒 true；Linux 看 `DISPLAY`/`WAYLAND_DISPLAY` |
| 5 | `lib/mirror/server.js` | 宿主侧通道：token 鉴权、帧广播、输入回传，复用现有 `x-dsh-rig` 头 |
| 6 | `lib/mirror/plugin/` | 显微镜插件（独立包，装进 lab profile）：`webContents.capturePage` 定时推帧 + `sendInputEvent` 接输入；另带一行「实验室已就绪」遥测 |
| 7 | `lib/client/mirror-view.js` | `<MirrorView/>` 组件：canvas 渲染 + 输入采集 + 断流重连；`client.js` 只做 `lab.mirror ? MirrorView : IframeView` |
| 8 | `lib/lab/supervisor.js` | 注入 backend；`describe` 多返回 `mirror: {ok, w, h}` |
| 9 | 文档 | README「已知边界」改写：桌面实例、多窗口与托盘、mac 屏幕录制权限、Wayland 说明 |

验收：

- 面板里看见实验室桌面窗口，点击坐标正确命中（点一个按钮，实验室里状态真的变）。
- 连续 10 分钟不掉线；宿主重启后能重连或自动重启实验室。
- 正式版 DSH 无感知：单实例锁不冲突、托盘两个图标可辨、更新检查不互相干扰。

### 风险 R1（2026-11-24 读代码发现，必须处理）

`labRoot` 默认是 `%LOCALAPPDATA%/dsh-rig`，**与环境变量无关**。所以第二个实例若也加载了 dsh-rig 插件，
它会和宿主共用同一份 `labs.json`，把同一批实验室当成自己的来管 —— 两层实验室互相 spawn 是灾难。

对策（0.2.0 内必须落地）：给实验室进程注入 `DSH_RIG_LAB=1`；`lib/index.js` 看到这个变量就
**只打一行日志然后 return**（不建 supervisor、不挂路由、不注册工具）。实验室里不需要管理能力。

## 四、0.2.1 · 不炸死宿主（1 天）

| # | 文件 | 内容 |
|---|---|---|
| 1 | `lib/lab/limits.js` | 采样实验室进程 RSS/CPU（Win `tasklist`、POSIX `ps`），超阈值先记日志再 `stop()`；阈值可配 |
| 2 | `lib/lab/reaper.js` | 把 `orphans` 从「手动调」改成定时（默认 10 分钟）+ 宿主退出时扫一次 |
| 3 | `lib/lab/supervisor.js` | 接上这两个，配置项进 `config` 表 |

验收：故意让实验室吃 2 GB，宿主内存曲线不抖，实验室被停且日志写清原因。

## 五、0.3.0 · 内桥（1 周，后置）

显微镜插件扩两条通道：`dispatch`（往实验室里的会话投一条用户消息）、`events`（订阅实验室的轮次/工具事件）。
**前置**：0.2.0 的插件通道跑稳。唯一未验证的技术点仍是「程序化提交一条用户消息」的确切调用，先写探针再定。

## 六、跨平台矩阵（要写进 README）

| 能力 | Windows | macOS | Linux (X11) | Linux (Wayland) |
|---|---|---|---|---|
| 第二桌面实例 | ✅ | ✅ | ✅ | ✅ |
| 帧推送（capturePage） | ✅ | ✅（首次要屏幕录制权限） | ✅ | ⚠️ 退回 capturePage，不依赖 portal |
| 输入注入（sendInputEvent） | ✅ | ✅ | ✅ | ✅ |
| 资源限额采样 | ✅ tasklist | ✅ ps | ✅ ps | ✅ ps |
| 无图形会话兜底 | n/a | n/a | ✅ web-core | ✅ web-core |

展开成正文的是 `docs/PLATFORMS.md`（每格写清怎么实现、要什么权限、失败什么样、怎么自救）。
**macOS 那格要拆成两条路线读**：默认路线是 `capturePage` + `sendInputEvent`，都在实验室自己的进程里，不走 TCC；
「屏幕录制权限」是备用路线（`desktopCapturer` / 系统级注入）的代价。真机复核后回填这一格。

## 七、队友分工与写作用域

| 任务 | 写作用域 | 依赖 |
|---|---|---|
| T1 · 0.1.6 治根 | `lib/lab/*` `lib/client.js` `test/*` | 无（我本人做） |
| T2 · 0.2.0 后端抽象 | `lib/backends/*` | T1 完成（都改 supervisor） |
| T3 · 显微镜插件骨架 | `lib/mirror/*` | 无（新目录，可并行） |
| T4 · 跨平台与验收文档 | `docs/*` `README.md` | 无（可并行） |

规矩：任何人不动 `package.json` 的版本号（发版由我统一做），不 push，不 publish。

## 八、回滚（每一版出问题怎么退）

退版本比修 bug 快，前提是**顺序对**。三条先决：

1. **先停实验室，再退插件。** 实验室的进程与记录不会因为换插件版本消失，但新版写进 `labs.json` 的字段旧版可能不认（0.1.6 那条就是），
   而旧版一旦「按空状态处理」，下一次写盘就把记录写空了。
2. **退之前备份 `<labRoot>/labs.json`。** 实验室的数据在 `<labRoot>/labs/<id>/{home,workspace}`，退版本不动它们；
   会打架的只有 `labs.json` 的格式。
3. **先退出宿主进程（桌面版 / `dsh web`），再动 profile。** 装完 / 退完必须**重启宿主**：
   profile 的 bundle 注入表是启动时收集一次的，不重启跑的还是旧代码。

### 通用退法

| 场景 | 命令 | 为什么要这么写 |
|---|---|---|
| 退已装版本的 profile | `dsh plugin --profile <p> remove dsh-rig` 然后 `dsh plugin --profile <p> add dsh-rig@0.1.5` | 必须 `remove` 再 `add`：只 `add` 旧版会把 lockfile 里的旧 integrity 留着，「装成功」但跑旧代码 |
| 从 git tag 现场打包 | `git checkout v0.1.5` → `npm test` → `npm pack` → `dsh plugin --profile <p> add file:<绝对路径>/dsh-rig-0.1.5.tgz` | npm 上拿不到、或要带本地改动时用；tag 与 `package.json` 的版本必须一致，否则装出来是别的号 |
| 在界面里装（不想开终端） | 插件工具 `plugin_manager` 的 `install_bundle`，`target` 传 `dsh-rig@0.1.5` | 与命令行同一条路，区别是它不能在宿主运行中替换正在跑的包 |
| 撤回 npm 的 `latest` | `npm dist-tag add dsh-rig@0.1.5 latest`，必要时 `npm deprecate dsh-rig@0.1.6 "回滚：<原因>"` | 改 dist-tag 不删包，已装的人不受影响；`npm unpublish` 只在发布 72 小时内可用，别把它当回滚手段 |
| 查有哪些版本可退 | `npm view dsh-rig versions --json`；`git tag -l` | 线上版本与 tag 应当一一对应 |

### 冷却期（真正会挡你的那一条）

| 事实 | 影响 | 怎么办 |
|---|---|---|
| 若 profile 里配了 `minimumReleaseAge`（分钟） | 它只挡**太新**的版本，所以「退到上一版」不受影响；受影响的是「退完又想装回刚才那个坏版本」 | 等过窗口；或把版本号加进 `minimumReleaseAgeExclude` |
| 同一条规则插件市场也读 | 市场里显示「新版等待中」，看不出发过新版 | 同上，别在市场里反复点更新 |
| `minimumReleaseAgeExclude` 一个包**只能有一行** | 第二行起被静默忽略 | 加版本号时改那一行，不要追加 |
| 没配 `minimumReleaseAge` 的 profile | 只剩 pnpm 自己的窗口（pnpm 11 的供应链策略默认 24 小时） | 要当天版本就在命令行装 |
| `--config.minimum-release-age=0` | 只在命令行有效，宿主内置的市场不接受附加参数 | 命令行退版本时可以用 |

### 按版本

| 版本 | 什么算「出问题」 | 退到 | 退完要注意 |
|---|---|---|---|
| 0.1.6 | 宿主重启后实验室仍锁成只读；启动不再自愈；结构守卫红 | 0.1.5 | `labs.json` **格式兼容**：版本号仍是 `1`，只多了 `pid` / `pidStartedAt`，旧版会忽略它们。但注意 —— 退回后「宿主重启即锁死」那个问题会一起回来（0.1.5 用随机 `hostId` 判归属），真发生了就手删 `labs.json` 重建 |
| 0.2.0 | 面板没有画面；点不中；实验室起来就崩；第二个实例影响正式版 | 0.1.6（或直接 0.1.5） | 退回即回到 headless，插件、日志、`report`、`lab_ui` 全在。0.2.0 新加在记录里的字段旧版忽略；桌面实例留下的 `userdata/` 可以删 |
| 0.2.1 | 限额误杀正常实验室；reaper 杀掉正在用的进程 | 0.2.0 | 改阈值比退版本快（配置项在 `config` 表里）；退版本后残留的定时器随进程退出消失 |
| 0.3.0 | 内桥把实验室的会话写乱 | 0.2.1 | 内桥是纯新增通道，摘掉不影响 0.2.x 的镜像 |

**比回滚更快的退路**：0.1.x 只有 headless。0.2.0 的桌面实例如果在某台机器上起不来，退回 0.1.5 就是「回到没有桌面实例的形态」——
能用，只是看不见画面。这也是 `docs/PLATFORMS.md` 里那几台待实测机器的兜底方案。
