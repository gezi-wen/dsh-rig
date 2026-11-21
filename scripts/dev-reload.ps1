<#
  dsh-rig 开发循环：打包 → 装进 web profile → 重启试验实例 → 报 URL 与启动标记。

  为什么不用 `link:`：双半插件在 junction 部署下 **client 半不会被注入**（技能里实测过），
  所以每次都用 `file:` tgz 实体部署，顺便验证打包清单本身。
  为什么要换文件名：pnpm 对同名同路径的 `file:` 依赖不会重解析，改了内容也说 "Already up to date"。

  用法：
    pwsh -File scripts/dev-reload.ps1              # 全流程
    pwsh -File scripts/dev-reload.ps1 -NoRestart   # 只打包安装
    pwsh -File scripts/dev-reload.ps1 -Stop        # 只停实例

  需要的两个环境事实（不写死任何本机路径）：
    - `DSH_HOME`：DSH 的 home（profile 与实验室都挂在这里）；
    - DSH 的 core 入口：优先 `DSH_INSTALL_DIR\lib\bin.js`，也可用 `-DSHBin` 直接指定。
#>
param(
  [switch]$NoRestart,
  [switch]$Stop,
  [int]$WaitSeconds = 45,
  [string]$DSHHome = $env:DSH_HOME,
  [string]$DSHBin = $env:DSH_INSTALL_DIR
)
$ErrorActionPreference = 'Stop'

$root   = Split-Path -Parent $PSScriptRoot
$vendor = Join-Path $root '.vendor'
$snap   = Join-Path $root '.snap'
$pidFile = Join-Path $snap 'instance.pid'
$outLog  = Join-Path $snap 'instance-out.log'
$errLog  = Join-Path $snap 'instance-err.log'

if (-not $DSHHome) { throw '需要 DSH_HOME：设置同名环境变量，或传 -DSHHome <路径>。' }
if ($DSHBin -and (Test-Path (Join-Path $DSHBin 'lib\bin.js'))) {
  $bin = Join-Path $DSHBin 'lib\bin.js'
} elseif ($DSHBin -and (Test-Path $DSHBin)) {
  $bin = $DSHBin
} else {
  throw '找不到 DSH core：设置 DSH_INSTALL_DIR，或用 -DSHBin <.../dsh/lib/bin.js> 指定。'
}

function Stop-Instance {
  if (Test-Path $pidFile) {
    $old = (Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ($old) {
      & taskkill /PID $old /T /F 2>&1 | Out-Null
      "已停掉旧实例 pid=$old"
    }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  }
}

# ⚠️ `-DSHHome` 只改了本脚本自己的路径是不够的：子进程 `dsh` / `pnpm` 看的是**环境变量**。
# 不同步的话，脚本会把包装进 A 家、实例却从 B 家启动 —— 2026-11-21 就踩了：
# 装进了 A 家、实例却从 B 家起，两边都以为自己是对的。
$env:DSH_HOME = $DSHHome
if ($DSHBin -and (Test-Path (Join-Path $DSHBin 'lib\bin.js'))) { $env:DSH_INSTALL_DIR = $DSHBin }

Stop-Instance
if ($Stop) { return }

# ── 打包 ─────────────────────────────────────────────────────────────
# 文件名**固定**：profile 的依赖 spec 记的是这个路径，改名会让 pnpm 找不到已记录的 spec。
# 让它重解析靠删 node_modules/dsh-rig（见下），不靠换文件名。
$ver = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$tgz = Join-Path $vendor "dsh-rig-$ver.tgz"
Remove-Item $tgz -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $vendor -Force | Out-Null
Push-Location $root
try { npm pack --pack-destination $vendor 2>&1 | Out-Null } finally { Pop-Location }
if (-not (Test-Path $tgz)) { throw "打包产物没落在 $tgz（package.json 的 name/version 改过？）" }
"打包: $tgz  ($([math]::Round((Get-Item $tgz).Length/1KB,1)) KB)"

# pnpm 对同名同路径的 file: 依赖不重解析，旧目录必须删掉
$installed = Join-Path $DSHHome 'profiles\web\node_modules\dsh-rig'
if (Test-Path $installed) {
  Remove-Item $installed -Recurse -Force
  "已删旧装: $installed"
}

# ── 安装进 web profile ───────────────────────────────────────────────
$spec = 'file:' + ($tgz -replace '\\', '/')
$install = & dsh plugin --profile web add $spec 2>&1 | Out-String
# ⚠️ `dsh plugin add` 只在**清单变化**时才真的写盘；spec 没变时它当自己幂等、直接返回。
# 而 lockfile 里的 integrity 还是旧 tgz 的，`pnpm install --force` 也会照旧 integrity 从 store 装
# —— 于是「重装成功」但跑的还是上一版的代码（2026-11-21 实测，hash 对不上才发现）。
# 只有 remove + add 会让 pnpm 重新读 tgz、重算 integrity。
Push-Location (Join-Path $DSHHome 'profiles\web')
try {
  & pnpm remove dsh-rig 2>&1 | Out-Null
  & pnpm add $spec 2>&1 | Out-Null
} finally { Pop-Location }
# 判据是**装完能穿透读到 package.json**，不是退出码：dsh 会因不相干的插件行不兼容而回非零，
# 那种噪声不代表我们没装上（这里踩过一次）。
$okFile = Join-Path $installed 'package.json'
if (-not (Test-Path $okFile)) { "安装输出:`n$install"; throw '安装失败：profile 里读不到 dsh-rig/package.json' }
"已装: $spec"

if ($NoRestart) { return }

# ── 起实例 ───────────────────────────────────────────────────────────
Remove-Item $outLog, $errLog -Force -ErrorAction SilentlyContinue
# ⚠️ Start-Process 把 -ArgumentList 用空格拼起来，**不做引号处理**：
# 安装路径里有空格（`C:\Program Files\…`）时必须自己加引号，否则 node 会去找 `C:\Program`。
$p = Start-Process -FilePath 'node' `
  -ArgumentList @("`"$bin`"", '--profile', 'web', '--port', '0', '--no-open') `
  -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru -WindowStyle Hidden
$p.Id | Set-Content $pidFile
"实例 pid=$($p.Id)，等 $WaitSeconds 秒…"
Start-Sleep -Seconds $WaitSeconds

$line = Get-Content $outLog -ErrorAction SilentlyContinue | Select-String -Pattern 'dsh web: http' | Select-Object -Last 1
if ($line) { "URL: " + ($line.Line -replace '.*(http\S+)', '$1') } else { 'URL: 没抓到（看 .snap/instance-err.log）' }
$marker = Get-Content $outLog -ErrorAction SilentlyContinue | Select-String -Pattern '\[dsh-rig\]' | Select-Object -Last 3
if ($marker) { $marker | ForEach-Object { "标记: " + $_.Line.Trim() } } else { '标记: 没打到 stdout（宿主半没执行？）' }

# ── 闭包体检（技能里的铁律：真启动前后必须 diff） ─────────────────────
# 基线只建一次；之后每次启动都跟它比。变了就大声说出来 —— 这意味着宿主依赖闭包被动过。
$baseline = Join-Path $snap 'closure-baseline.json'
$current = Join-Path $snap 'closure-now.json'
if (-not (Test-Path $baseline)) {
  node (Join-Path $root 'scripts\closure-snapshot.mjs') --save $baseline | Out-Null
  "闭包基线已建立: $baseline"
}
node (Join-Path $root 'scripts\closure-snapshot.mjs') --save $current | Out-Null
$diff = node (Join-Path $root 'scripts\closure-snapshot.mjs') --diff $baseline $current 2>&1 | Out-String
if ($LASTEXITCODE -eq 0) { '闭包: 与基线一致（0 变化）' } else { "闭包: ⚠️ 变了！`n$diff" }
