# dsh-rig

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的**右栏插件实验室**：在会话旁边跑一个真实、进程级隔离的 DSH，装插件、看日志、换版本，崩了不牵连你正在用的这个。

[English](README.en.md) · [更新日志](CHANGELOG.md)

![右栏里的插件实验室：一个真实 DSH 正在运行](docs/screenshot-panel.png)

## 它解决什么

开发 DSH 插件时，最难受的是**没有一块可以随便弄坏的地方**：图省事把插件挂进自己在用的 profile，一次坏的 `apply()` 就把整个 harness 拖下去。

dsh-rig 给你一块试验台：

- 实验室是**另一个进程**，有自己的 `DSH_HOME`、profile、端口和工作区；
- 它崩了、它的依赖树乱了，都只发生在它自己身上（宿主依赖闭包实测零变化）；
- 面板就在右栏，状态、日志、重启、体检都在一处。

![插件详情页](docs/screenshot-detail.png)

## 装

```bash
dsh plugin --profile web add dsh-rig
```

或在 DSH 里：**插件 → 添加插件 → dsh-rig**。

装完刷新页面，会话头部会多一个「插件实验室」按钮；右栏开始页也会多一张卡片。

## 用

1. 点右栏「插件实验室」→「创建实验室」；
2. 「启动」：起一个真实 DSH（十秒左右到「运行中」），右栏里直接嵌着它的界面；
3. 「锁定 / 可介入」：锁定只挡你的鼠标键盘（防误触），解锁就直接在里面点；
4. 「重启 / 刷新 / 弹出 / 停止 / 销毁」：生命周期都在这一行；
5. 「日志」：跟着它的 stdout/stderr，token 与用户名自动打码。

实验室默认落在 `%LOCALAPPDATA%\dsh-rig\`（Windows 上；其它平台回落到应用数据目录），
每个实验室一份 `home/`（DSH_HOME）、`workspace/`、`shots/`。

## 隔离到什么程度

| 层 | 做到 | 没做到 |
|---|---|---|
| 进程 | 独立进程、崩溃不连坐、独立端口 | — |
| DSH 数据 | 独立 `DSH_HOME`（凭据、会话、profile、依赖全隔离） | — |
| 文件系统 | 默认 `workspace-write`，cwd 锁在实验室工作区 | 不防实验室里的智能体按它的权限读写你机器别处 |
| 内核 | — | 家庭版 Windows 没有 Sandbox / Hyper-V，所以不是虚拟机级隔离 |
| 输入 | 锁定态挡鼠标键盘 | 挡不住实验室自己的智能体；这不是安全边界 |

## 工具面

装好后，智能体多两个工具：

| 工具 | 什么时候在 | 干什么 |
|---|---|---|
| `plugin_lab` | 常驻 | `list / create / start / stop / restart / destroy / status / logs / report / versions / set_version` |
| `lab_ui` | **只在你授权期间** | `snapshot / screenshot / click / type / task` —— 按**文字**找按钮，找不到会把候选名列出来 |

`lab_ui` 不是常驻的：工具 schema 每轮都进上下文，而大多数时候用不到「点按钮」。
所以它挂在权限后面——面板里打开「智能体操作界面」才注册，关掉即注销。

界面驱动的后端按可用性降级，**不假设你机器上有浏览器**：

1. Playwright（自带浏览器）；
2. Playwright 借用系统 Edge/Chrome（不下载）；
3. 裸 CDP 直连系统 Chromium 系浏览器（零 npm 依赖）；
4. 都没有就明说缺什么。

## 体检（`report`）

比「能点」更值钱的是「看得清」。`report` 给出一份分块报告，每块有各自的证据来源：

- **declared**：profile 声明了哪些 bundle；
- **patched**：组合补丁里的行；
- **runtime**：状态、端口、退出码；
- **logFacts**：启动期被版本闸门禁用或加载失败的插件行；
- **workspace**：工作区文件树。

读不到就写「读不到」加原因，不拿空数组冒充「没有」。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `labRoot` | 应用数据目录下的 `dsh-rig` | 实验室根目录；**必须与宿主 `DSH_HOME` 互不包含**，否则拒绝创建 |
| `copyCredentials` | `true` | 把宿主 `.credentials.yaml` 复制进实验室（否则实验室里的智能体没有可用模型） |
| `maxLabs` | `8` | 同时存在的实验室上限 |
| `startTimeoutMs` | `60000` | 等 HTTP 就绪的上限 |
| `logRingLines` | `2000` | 每个实验室保留的日志行数 |
| `uiBackend` | `auto` | `auto / playwright / cdp`；也可用环境变量 `DSH_RIG_UI_BACKEND` |

## 已知边界

- 换 DSH 版本目前只能切到**已装**的版本（安装新版本的入口还没做）。
- 「派活给实验室里的智能体」与「施工过程可视化」还没做——现在靠你在解锁态下自己输入，或让智能体用 `lab_ui` 去点。
- 无头浏览器会开一个本地调试端口；它随实验室起停、只在授权期间存在，但这是「模拟点击」这条路的固有代价。

## 许可

Apache-2.0，见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。
