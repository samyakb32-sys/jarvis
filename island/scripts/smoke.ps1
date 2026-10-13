# End-to-end check of a built Jarvis Island on Windows (run by CI after `tauri build`).
#
# 1. With the app closed, the hook must exit at once and print nothing.
# 2. With the app running in self-test mode (it answers cards by itself after
#    1.5 s), a PermissionRequest piped into jarvis-hook.exe must come back as
#    Claude Code's "allow" JSON — through the real named pipe, the real webview
#    rendering the card, and the real ack/decision path.
# 3. A screenshot is taken while the card is on screen.
param([string]$Out = "smoke")

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$app = Join-Path $root "target\release\jarvis-island.exe"
$hook = Join-Path $root "target\release\jarvis-hook.exe"
foreach ($f in @($app, $hook)) { if (-not (Test-Path $f)) { throw "missing $f (run tauri build first)" } }

New-Item -ItemType Directory -Force $Out | Out-Null
$tmp = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
$env:JARVIS_ISLAND_DIR = Join-Path $tmp "jarvis-island-smoke"
$env:JARVIS_ISLAND_PIPE = "\\.\pipe\jarvis-island-smoke-$PID"
$env:JARVIS_ISLAND_SELFTEST = "allow"
Remove-Item -Recurse -Force $env:JARVIS_ISLAND_DIR -ErrorAction SilentlyContinue

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
function Save-Screen([string]$path) {
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Host "screenshot: $path"
}

# Start jarvis-hook with $json on stdin; returns the process (stdout still to be read).
function Start-Hook([string]$event, [string]$json) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo $hook
  $psi.Arguments = $event
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.UseShellExecute = $false
  $p = [System.Diagnostics.Process]::Start($psi)
  $p.StandardInput.Write($json)
  $p.StandardInput.Close()
  return $p
}

function Finish-Hook($p, [int]$timeoutMs) {
  $read = $p.StandardOutput.ReadToEndAsync()
  if (-not $p.WaitForExit($timeoutMs)) { $p.Kill(); throw "hook did not exit within $timeoutMs ms" }
  if ($p.ExitCode -ne 0) { throw "hook exited $($p.ExitCode)" }
  return $read.Result.Trim()
}

$permission = @{
  session_id = "smoke"; cwd = "C:\demo\sample-app"; hook_event_name = "PermissionRequest"
  tool_name = "Bash"; tool_input = @{ command = "npm run build"; description = "Build the app" }
} | ConvertTo-Json -Compress

# A freshly built exe is scanned by Windows Defender on its first start, which is
# not the hook's own latency: start it once, unmeasured, before timing anything.
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$null = Finish-Hook (Start-Hook "PermissionRequest" $permission) 15000
Write-Host "warm-up (first start, includes antivirus scan): $($sw.ElapsedMilliseconds) ms"

# 1. App closed: no token yet.
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$out = Finish-Hook (Start-Hook "PermissionRequest" $permission) 5000
$sw.Stop()
if ($out -ne "") { throw "app closed, but the hook printed: $out" }
if ($sw.ElapsedMilliseconds -gt 1500) { throw "app closed, but the hook took $($sw.ElapsedMilliseconds) ms" }
Write-Host "ok: no app -> no opinion in $($sw.ElapsedMilliseconds) ms"

# 2. Start the app and wait for its token.
$proc = Start-Process -FilePath $app -PassThru
try {
  $token = Join-Path $env:JARVIS_ISLAND_DIR "token"
  $deadline = (Get-Date).AddSeconds(45)
  while (-not (Test-Path $token)) {
    if ((Get-Date) -gt $deadline) { throw "the app did not write its token" }
    if ($proc.HasExited) { throw "the app exited with $($proc.ExitCode)" }
    Start-Sleep -Milliseconds 200
  }
  Start-Sleep -Seconds 3   # let the webview finish loading and subscribe to events
  Save-Screen (Join-Path $Out "1-idle.png")

  # A fire-and-forget event first: it must not wait.
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $stop = @{ session_id = "smoke"; cwd = "C:\demo\sample-app"; hook_event_name = "UserPromptSubmit"; prompt = "Build it" } | ConvertTo-Json -Compress
  $out = Finish-Hook (Start-Hook "UserPromptSubmit" $stop) 5000
  if ($out -ne "") { throw "UserPromptSubmit printed: $out" }
  Write-Host "ok: event forwarded in $($sw.ElapsedMilliseconds) ms"

  # The permission request: the self-test page answers "allow" after 1.5 s.
  $p = Start-Hook "PermissionRequest" $permission
  Start-Sleep -Milliseconds 900
  Save-Screen (Join-Path $Out "2-permission-card.png")
  $out = Finish-Hook $p 20000
  Write-Host "hook output: $out"
  $reply = $out | ConvertFrom-Json
  if ($reply.hookSpecificOutput.hookEventName -ne "PermissionRequest") { throw "unexpected output: $out" }
  if ($reply.hookSpecificOutput.decision.behavior -ne "allow") { throw "expected allow, got: $out" }
  Write-Host "ok: island answered allow"
  Start-Sleep -Milliseconds 800
  Save-Screen (Join-Path $Out "3-after.png")
}
finally {
  if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
}

# 3. App gone, stale token left behind: still no wait.
Start-Sleep -Milliseconds 500
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$out = Finish-Hook (Start-Hook "PermissionRequest" $permission) 5000
$sw.Stop()
if ($out -ne "") { throw "app gone, but the hook printed: $out" }
if ($sw.ElapsedMilliseconds -gt 1500) { throw "app gone, but the hook took $($sw.ElapsedMilliseconds) ms" }
Write-Host "ok: stale token -> no opinion in $($sw.ElapsedMilliseconds) ms"
Write-Host "smoke test passed"
