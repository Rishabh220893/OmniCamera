# Total CPU time (as the operating system counts it, including process start-up) of one frame grab and one frame-gate fingerprint.
# ffmpeg's own -benchmark figure leaves start-up out, and on a small CPU start-up is most of the cost, so this is the number the capacity
# model uses. The grab is measured on a local 720p clip (so no network or RTSP session set-up is included).
#
#   powershell -NoProfile -File scripts/capacity/os-costs.ps1
$d = Join-Path $env:TEMP 'os-costs'; New-Item -ItemType Directory -Force $d | Out-Null
& ffmpeg -hide_banner -loglevel error -f lavfi -i "testsrc2=size=1280x720:rate=15" -t 4 -c:v libx264 -preset veryfast -g 30 -bf 0 -pix_fmt yuv420p -y "$d\c.mp4"
& ffmpeg -hide_banner -loglevel error -f lavfi -i "testsrc2=size=1280x720" -frames:v 1 -q:v 3 -y "$d\f.jpg"

function Measure-Cpu([string]$arguments, [string]$stdinFile) {
  $cpu = @()
  for ($i = 0; $i -lt 15; $i++) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo 'ffmpeg'
    $psi.Arguments = $arguments; $psi.RedirectStandardOutput = $true; $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
    if ($stdinFile) { $psi.RedirectStandardInput = $true }
    $p = [Diagnostics.Process]::Start($psi)
    if ($stdinFile) { $bytes = [IO.File]::ReadAllBytes($stdinFile); $p.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length); $p.StandardInput.Close() }
    $null = $p.StandardOutput.BaseStream.CopyTo([IO.Stream]::Null)
    $p.WaitForExit()
    $cpu += $p.TotalProcessorTime.TotalSeconds
    $p.Dispose()
  }
  ($cpu | Sort-Object)[7]
}

$grab = Measure-Cpu "-y -loglevel error -i `"$d\c.mp4`" -vframes 1 -f image2 -q:v 3 pipe:1" $null
$gate = Measure-Cpu "-loglevel error -i pipe:0 -vf scale=64:36:flags=area,format=gray -frames:v 1 -f rawvideo pipe:1" "$d\f.jpg"
$cpuName = (Get-CimInstance Win32_Processor | Select-Object -First 1).Name
[pscustomobject]@{ machine = $cpuName; grabCpuSeconds = [math]::Round($grab, 3); gateCpuSeconds = [math]::Round($gate, 3); method = 'median of 15 runs of total process CPU time' } | ConvertTo-Json
Remove-Item -Recurse -Force $d
