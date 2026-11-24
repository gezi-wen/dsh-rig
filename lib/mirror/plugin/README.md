# dsh-rig-mirror · 显微镜插件（宿主半）

一段话：这个包装进**实验室**那个 DSH 实例里，把实验室窗口的画面按「最长边 1280 / JPEG q60」定时截下来，
经一条 WebSocket 推给宿主（`ws://127.0.0.1:<宿主端口>/dsh-rig/api/mirror/<labId>`），并把宿主回传的
鼠标 / 键盘 / 滚轮帧灌进 `webContents.sendInputEvent()` —— 于右栏面板就能看见并点实验室的桌面窗口。
它是 `lib/mirror/` 的**插件侧**（`lib/mirror/plugin/`），宿主侧通道（`lib/mirror/server.js`）还没写；
这一版是**骨架**：通道、背压、重连、暂停、销毁都实现了，帧源按 Electron 能力探测，拿不到就明说。

## 一条必须先知道的进程模型事实（2026-11-24 实测）

正式版 DSH 桌面**不是**「插件跑在 Electron 主进程里」。Electron 主进程（`resources/app/lib/main.js`）
只是壳，它 `spawn` 一个**纯 Node** 宿主进程（`runtime/primary-runtime/.../node.exe` 跑
`@deepseek-ai/dsh-desktop-host/lib/index.js`），DSH 与插件都在那个进程里。所以在插件里：

- `process.versions.electron` 是 `undefined`；
- 拿不到 `webContents`，`capturePage()` / `sendInputEvent()` 这两条**在本进程内不可能生效**。

`host.js` 照官方 Electron API 把它们完整实现了（这样一旦本模块被放进 Electron 进程就直接可用），
但**不会假装成功**：探测失败时它仍然连上宿主、发一条带原因的 `hello`，然后不推帧。日志长这样：

```
[dsh-rig-mirror] 帧源不可用：process.versions.electron 缺失：本进程是纯 Node 宿主，不是 Electron
```

两条可行接法（都还没做，见文末）：① 实验室以 `--remote-debugging-port` 启动，插件改走 CDP
`Page.captureScreenshot` + `Input.dispatchMouseEvent`（宿主侧本来就有 `lib/lab/ui/cdp-impl.js` 的先例）；
② 桌面壳开一条 `capturePage` 桥（要改 Electron main，不属于本仓）。

## 通道为什么选 WebSocket

用 **Node 内建的全局 `WebSocket`**（undici，Node ≥ 22；本机宿主运行时实测 `runtime/versions.json`
= node 24.21.0，`typeof WebSocket === 'function'`）。零依赖：不 import `node:` 内建，也不 import `ws`。

- 不选「手写 `node:http` upgrade 客户端」：要自己算 `Sec-WebSocket-Key`、逐帧掩码、拼帧头、
  处理分片与 ping/pong，一百多行样板只为省掉一个内建能力。
- 不选「HTTP POST 分片推帧」：每帧一次请求 + chunked 头，输入还得另开一条长轮询，5 fps 时开销比帧还大。

一帧 = 一条 JSON 文本帧（`{t:'frame',seq,mime,bytes,w,h}`）**紧跟**一条二进制帧（JPEG 字节）。
不要 base64：一张 1280 宽的 JPEG base64 后多约 33%。契约在 `../contract.js`（零依赖纯逻辑，两侧共用）。

已实现的四条行为：窗口最小化 / 隐藏时暂停推帧（`status` 报给宿主，恢复再继续）；断线指数退避
1s→2s→4s→8s 封顶、连上即归零；帧队列只留 1 帧（新帧顶掉旧帧，`bufferedAmount` 超 512 KB 直接丢）；
`dispose` 幂等（清两个定时器 + 关连接 + 摘事件）。

## 怎么装进实验室 profile

实验室落点：`<labRoot>/labs/<id>/home`（labRoot 默认 `%LOCALAPPDATA%\dsh-rig`），profile 名是
`rig-<id>`（拼法只在 `lib/lab/naming.js`）。以 `lab1` 为例：

```powershell
# 1) 把插件装进实验室的 profile（dsh plugin 就是把剩下的参数转发给该 profile 里的 pnpm；
#    首次使用会自动初始化 profile）
$env:DSH_HOME = "$env:LOCALAPPDATA\dsh-rig\labs\lab1\home"
dsh plugin --profile rig-lab1 add file:E:\projects\dsh-rig\lib\mirror\plugin

# 2) 让实验室加载它：编辑 $env:DSH_HOME\profiles\rig-lab1\cordis.patch.yml，加一条
#      - insert:
#          - id: dsh-rig-mirror
#            name: 'dsh-rig-mirror'

# 3) 告诉它连哪：环境变量（写进实验室的启动环境）或 patch 里的 config
#      DSH_RIG_MIRROR_URL=ws://127.0.0.1:52324/dsh-rig/api/mirror/lab1?token=<token>
#    或者给 hostPort + labId 让它自己拼：
#      DSH_RIG_MIRROR_PORT=52324  DSH_RIG_LAB_ID=lab1
```

启动后实验室日志里应出现 `[dsh-rig-mirror] 加载 · stage=skeleton-1 · target=...`（这是三级验证的
第三级：`MIRROR_STAGE` 出现在日志里 = 插件真的被 apply 了）。

## 依赖哪些 Electron API

`webContents.getAllWebContents()` / `getType()` / `isDestroyed()` / `getOwnerBrowserWindow()` ·
`BrowserWindow.isMinimized()` / `isVisible()` · `webContents.capturePage()` ·
`NativeImage.isEmpty()` / `getSize()` / `resize({width,height,quality})` / `toJPEG(quality)` ·
`webContents.sendInputEvent()`。三平台零系统权限（不像 OS 级注入要辅助功能 / uinput）。

## 还没做什么

- **帧源接不上**（见上）：缺 CDP 那条路或桌面壳桥，所以正式版里目前推不出画面。
- 没有宿主侧 `lib/mirror/server.js`（`registerUpgrade` 收帧、按 lab 广播、token 校验）—— 不在本包。
- 没有客户端 `<MirrorView/>`（canvas 渲染 + 输入采集），也没有 `client.js` 的改动。
- 单窗口：只截第一个 `type === 'window'` 的 webContents；多窗口选择、窗口切换未做。
- 输入只做鼠标 / 键盘 / 滚轮三类基本事件；拖拽、双击（`clickCount` 已有但面板没发）、输入法未做。
- 没有测试；`../contract.js` 的纯函数靠结构守卫与手工快速验证（`node --check` + 一段 import 冒烟）。
- 没有遥测（ROADMAP 里那句「实验室已就绪」）：`hello` 只带 `stage` 与 `surface`。
