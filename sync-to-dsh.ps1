# 把插件源码同步进 desktop profile。
# pnpm 的 `file:` 依赖是「复制」不是软链，改完源码必须重装一次副本才会更新。
# 需要以管理员/放宽沙箱的方式运行（要写 %USERPROFILE%\.dsh\profiles\desktop）。
$dsh = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
# 默认以脚本自身所在目录作为源码目录，方便直接在本仓库根目录运行。
$src = $PSScriptRoot

& $dsh plugin --profile desktop remove dsh-clash-proxy 2>&1 | Select-Object -Last 3
& $dsh plugin --profile desktop add "file:$src" 2>&1 | Select-Object -Last 6

$dst = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-clash-proxy"
foreach ($f in @("lib\index.js", "lib\core\rules.js", "lib\core\manager.js", "cordis.patch.yml")) {
	$a = if (Test-Path "$src\$f") { (Get-FileHash "$src\$f").Hash.Substring(0, 8) } else { "MISSING" }
	$b = if (Test-Path "$dst\$f") { (Get-FileHash "$dst\$f").Hash.Substring(0, 8) } else { "MISSING" }
	"{0,-24} src={1} dst={2} {3}" -f $f, $a, $b, $(if ($a -eq $b) { "OK" } else { "STALE" })
}

$profile = "$env:USERPROFILE\.dsh\profiles\desktop\package.json"
$bundles = (Get-Content $profile -Raw | ConvertFrom-Json).dsh.profile.bundles
"bundles contains dsh-clash-proxy: " + ($bundles -contains "dsh-clash-proxy")
