param(
    [Parameter(Mandatory = $true)][string]$TextFile,
    [Parameter(Mandatory = $true)][string]$Out,
    [string]$Voice = "Microsoft Maria Desktop",
    [int]$Rate = 0
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Speech
$text = [System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8)
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    try { $synth.SelectVoice($Voice) }
    catch {
        $pt = $synth.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -eq "pt-BR" } | Select-Object -First 1
        if ($pt) { $synth.SelectVoice($pt.VoiceInfo.Name) }
    }
    if ($Rate -lt -10) { $Rate = -10 }
    if ($Rate -gt 10) { $Rate = 10 }
    $synth.Rate = $Rate
    $synth.SetOutputToWaveFile($Out)
    $synth.Speak($text)
}
finally {
    $synth.Dispose()
}
Write-Output "OK"
