param(
    [string]$Executable = 'target/debug/lazymidi.exe',
    [switch]$Converter,
    [string]$EnvironmentManifest
)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
$taskExe = (Resolve-Path -LiteralPath (Join-Path $taskRoot $Executable)).Path
$taskReceipt = Join-Path $taskRoot 'target/bugfix-preview/native-modules.json'
if ($EnvironmentManifest) {
    $Converter = $true
    $taskReceipt = Join-Path $taskRoot 'target/environment-preview/native-modules.json'
}
New-Item -ItemType Directory -Force -Path (Split-Path $taskReceipt) | Out-Null
$taskArguments = @('--smoke-test', ('"' + $taskReceipt + '"'), '--overlays')
if ($Converter) {
    $taskData = [IO.Path]::ChangeExtension($taskReceipt, 'converter')
    New-Item -ItemType Directory -Force -Path (Join-Path $taskData 'runtimes'),(Join-Path $taskData 'data/converted') | Out-Null
    if ($EnvironmentManifest) {
        $taskSelection = Get-Content -LiteralPath $EnvironmentManifest -Raw
        $taskEnvironment = $taskSelection | ConvertFrom-Json
        $taskPython = $taskEnvironment.python
        if (-not [IO.Path]::IsPathFullyQualified($taskPython) -or -not (Test-Path -LiteralPath $taskPython -PathType Leaf)) { throw 'Invalid environment interpreter.' }
        [IO.File]::WriteAllText((Join-Path $taskData 'active.json'), $taskSelection)
    } else {
        $taskPack = Join-Path $taskRoot 'target/converter-cpu-1'
        $taskPython = Join-Path $taskPack 'python/python.exe'
        if (-not (Test-Path -LiteralPath $taskPython)) { throw 'Build the CPU converter runtime first.' }
        $taskLink = Join-Path $taskData 'runtimes/cpu'
        if (-not (Test-Path -LiteralPath $taskLink)) {
            New-Item -ItemType Junction -Path $taskLink -Target $taskPack | Out-Null
        }
        [IO.File]::WriteAllText((Join-Path $taskData 'active.json'), '"cpu"')
    }
    & $taskPython -I -B -c 'import pretty_midi,sys; m=pretty_midi.PrettyMIDI(); p=pretty_midi.Instrument(0); p.notes.append(pretty_midi.Note(80,60,0,1)); m.instruments.append(p); m.write(sys.argv[1])' (Join-Path $taskData 'data/converted/smoke.mid')
    if ($LASTEXITCODE -ne 0) { throw 'Cannot generate MIDI fixture.' }
    @'
import io,os,sys
sys.path.insert(0,sys.argv[1])
os.environ['LAZYMIDI_CONVERTER_DATA']=sys.argv[2]
os.environ['LAZYMIDI_CONVERTER_TOKEN']='isolated-smoke-upload'
import service
from PIL import Image
image=io.BytesIO();Image.new('RGB',(8,8),'#d8d4c4').save(image,format='PNG')
client=service.app.test_client();headers={'X-Lazymidi-Token':'isolated-smoke-upload'}
uploaded=client.post('/api/visualizer-background',headers=headers,data={'file':(io.BytesIO(image.getvalue()),'smoke.png')})
assert uploaded.status_code==200,uploaded.data
saved=client.post('/api/settings',headers=headers,json={'visualizer_style':'sketch','visualizer_soundfont':'builtin','visualizer_scenes':{'sketch':{'keyboard':'sketch','mode':'image','media_type':'image','media_url':uploaded.json['url']}}})
assert saved.status_code==200,saved.data
'@ | & $taskPython -I -B - (Join-Path $taskRoot 'converter') (Join-Path $taskData 'data')
    if ($LASTEXITCODE -ne 0) { throw 'Cannot import isolated background fixture.' }
    New-Item -ItemType Directory -Force -Path (Join-Path $taskData 'data/soundfonts') | Out-Null
    $taskFont = [IO.File]::Open((Join-Path $taskData 'data/soundfonts/smoke-large.sf2'),[IO.FileMode]::Create)
    try { $taskFont.SetLength(65 * 1024 * 1024) } finally { $taskFont.Dispose() }
    $taskArguments += '--converter'
}
$taskStarted = [DateTime]::UtcNow
$taskProcess = Start-Process -FilePath $taskExe -ArgumentList $taskArguments -WindowStyle Hidden -PassThru
if (-not $taskProcess.WaitForExit(30000)) {
    Stop-Process -Id $taskProcess.Id
    throw 'Native modules did not complete within 30 seconds.'
}
if ($taskProcess.ExitCode -ne 0) { throw "Native app failed: $($taskProcess.ExitCode)" }
if ((Get-Item -LiteralPath $taskReceipt).LastWriteTimeUtc -lt $taskStarted) { throw 'No new completion receipt.' }
$taskResult = Get-Content -LiteralPath $taskReceipt -Raw | ConvertFrom-Json
if (-not $taskResult.native_frontend_ready -or $taskResult.overlays.Count -ne 2) { throw 'Floating windows failed.' }
if ($Converter -and -not $taskResult.converter) { throw 'Native converter check did not complete.' }
if ($taskResult.snapshot.analog_enabled -or $taskResult.snapshot.qwerty_enabled -or $taskResult.snapshot.sdk_version) { throw 'Optional musical output started during testing.' }
Write-Output 'Native frontend, both floating windows, and requested converter checks passed; SDK and generated keys stayed off.'
