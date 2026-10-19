<#
.SYNOPSIS
Checks a Kaggle (or any OpenAI-compatible) endpoint from this Windows machine.

.DESCRIPTION
Asks for the base URL and the API key, performs a real model list request, a
real non-streaming inference request and a real streaming request, and prints
a sanitized JSON report. The API key is read with hidden input, kept in memory
only and never written to a file, a log, the command line or the output.

Run it from the project folder:

  powershell -ExecutionPolicy Bypass -File .\tools\check-kaggle-connection.ps1

Press Ctrl+C to stop. No administrator rights are required.
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$Model = 'Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf',
    [int]$TimeoutSeconds = 45
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Mask-Url {
    param([string]$Url)
    try {
        $uri = [Uri]$Url
        $hostName = $uri.Host
        if ($hostName.Length -le 10) {
            $maskedHost = $hostName.Substring(0, 2) + '***'
        } else {
            $maskedHost = $hostName.Substring(0, 4) + '***' + $hostName.Substring($hostName.Length - 6)
        }
        $path = $uri.AbsolutePath
        return "$($uri.Scheme)://$maskedHost$path"
    } catch {
        return '[invalid URL]'
    }
}

function Show-Error {
    param([string]$Step, [System.Exception]$Exception)
    $text = $Exception.Message
    if ($script:ApiKey) { $text = $text.Replace($script:ApiKey, '[redacted]') }
    [ordered]@{
        step = $Step
        outcome = 'failed'
        error = $text
    } | ConvertTo-Json -Depth 5 -Compress
}

function Normalize-BaseUrl {
    param([string]$Value)
    $trimmed = $Value.Trim()
    if (-not $trimmed) { throw 'The base URL is empty.' }
    if ($trimmed -notmatch '^[a-zA-Z][a-zA-Z0-9+.-]*://') { $trimmed = 'https://' + $trimmed }
    $uri = [Uri]$trimmed
    if ($uri.Scheme -ne 'http' -and $uri.Scheme -ne 'https') { throw 'Only http and https are supported.' }
    if ($uri.UserInfo) { throw 'The URL contains embedded credentials; remove them.' }
    if ($uri.Query) { throw 'The URL contains a query string; use the plain base URL.' }

    $path = $uri.AbsolutePath.TrimEnd('/')
    $path = $path -replace '(?i)/chat/completions$', ''
    $path = $path -replace '(?i)/completions$', ''
    $path = $path.TrimEnd('/')
    if ($path -match '(?i)(?:/v1){2,}$') {
        $path = $path -replace '(?i)(?:/v1)+$', '/v1'
    }
    if ($path -notmatch '(?i)/v1$') {
        $path = $path + '/v1'
    }
    return "$($uri.Scheme)://$($uri.Authority)$path"
}

function New-AuthClient {
    param([string]$Key)
    $client = New-Object System.Net.Http.HttpClient
    $client.Timeout = [TimeSpan]::FromSeconds($TimeoutSeconds)
    $client.DefaultRequestHeaders.Authorization =
        New-Object System.Net.Http.Headers.AuthenticationHeaderValue('Bearer', $Key)
    $client.DefaultRequestHeaders.Add('User-Agent', 'Kaggle-Kit-Connection-Check/1.0')
    return $client
}

Write-Host 'Kaggle-Kit connection check' -ForegroundColor Cyan
Write-Host 'The key is typed with hidden input and is never stored or printed.' -ForegroundColor DarkGray

$enteredUrl = Read-Host 'Base URL of the notebook (for example https://....trycloudflare.com)'
$secureKey = Read-Host 'Model API key' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
try {
    $script:ApiKey = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}

$report = [ordered]@{
    checkedAt = (Get-Date).ToUniversalTime().ToString('o')
    environment = [ordered]@{
        os = [Environment]::OSVersion.VersionString
        powershell = $PSVersionTable.PSVersion.ToString()
    }
    baseUrl = Mask-Url (Normalize-BaseUrl $enteredUrl)
    model = $Model
    models = $null
    inference = $null
    streaming = $null
}

$base = Normalize-BaseUrl $enteredUrl
$client = New-AuthClient $script:ApiKey

try {
    $started = [Diagnostics.Stopwatch]::StartNew()
    $modelsResponse = $client.GetAsync("$base/models").GetAwaiter().GetResult()
    $modelsText = $modelsResponse.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    $started.Stop()
    $status = [int]$modelsResponse.StatusCode
    $ids = @()
    if ($status -ge 200 -and $status -lt 300) {
        try {
            $parsed = $modelsText | ConvertFrom-Json
            $ids = @($parsed.data | ForEach-Object { $_.id } | Where-Object { $_ })
        } catch {
            $ids = @()
        }
    }
    $report.models = [ordered]@{
        outcome = if ($status -ge 200 -and $status -lt 300) { 'ok' } else { 'failed' }
        httpStatus = $status
        durationMs = [int]$started.ElapsedMilliseconds
        count = $ids.Count
        firstIds = @($ids | Select-Object -First 5)
        bodyBytes = $modelsText.Length
    }
} catch {
    $report.models = Show-Error 'models' $_.Exception
    $report | ConvertTo-Json -Depth 6
    exit 1
}

$usableModel = $Model
if (-not $usableModel -and $report.models.count -gt 0) { $usableModel = $report.models.firstIds[0] }
if (-not $usableModel) {
    $report.inference = [ordered]@{ outcome = 'not_run'; error = 'No model ID is available.' }
} else {
    try {
        $payload = @{
            model = $usableModel
            messages = @(@{ role = 'user'; content = 'Reply with exactly: OK' })
            max_tokens = 24
            temperature = 0
            stream = $false
        } | ConvertTo-Json -Depth 6 -Compress
        $content = New-Object System.Net.Http.StringContent($payload, [Text.Encoding]::UTF8, 'application/json')
        $started = [Diagnostics.Stopwatch]::StartNew()
        $inferenceResponse = $client.PostAsync("$base/chat/completions", $content).GetAwaiter().GetResult()
        $inferenceText = $inferenceResponse.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        $started.Stop()
        $status = [int]$inferenceResponse.StatusCode
        $answer = ''
        $finish = ''
        if ($status -ge 200 -and $status -lt 300) {
            try {
                $parsed = $inferenceText | ConvertFrom-Json
                $choice = @($parsed.choices)[0]
                $answer = [string]$choice.message.content
                if (-not $answer) { $answer = [string]$choice.message.reasoning_content }
                $finish = [string]$choice.finish_reason
            } catch { }
        }
        $report.inference = [ordered]@{
            outcome = if ($status -ge 200 -and $status -lt 300 -and $answer.Length -gt 0) { 'ok' } else { 'failed' }
            httpStatus = $status
            durationMs = [int]$started.ElapsedMilliseconds
            answerCharacters = $answer.Length
            finishReason = $finish
        }
    } catch {
        $report.inference = Show-Error 'inference' $_.Exception
    }
}

try {
    $payload = @{
        model = $usableModel
        messages = @(@{ role = 'user'; content = 'Reply with exactly: OK' })
        max_tokens = 24
        temperature = 0
        stream = $true
    } | ConvertTo-Json -Depth 6 -Compress
    $content = New-Object System.Net.Http.StringContent($payload, [Text.Encoding]::UTF8, 'application/json')
    $request = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Post, "$base/chat/completions")
    $request.Content = $content
    $started = [Diagnostics.Stopwatch]::StartNew()
    $streamResponse = $client.SendAsync($request, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
    $status = [int]$streamResponse.StatusCode
    $contentType = [string]$streamResponse.Content.Headers.ContentType
    $stream = $streamResponse.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
    try { $stream.ReadTimeout = $TimeoutSeconds * 1000 } catch { }
    $reader = New-Object System.IO.StreamReader($stream)
    $events = 0
    $characters = 0
    $finish = ''
    $sawDone = $false
    while (-not $reader.EndOfStream -and $started.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
        $line = $reader.ReadLine()
        if ($null -eq $line) { break }
        if (-not $line.StartsWith('data:')) { continue }
        $data = $line.Substring(5).Trim()
        if ($data -eq '[DONE]') { $sawDone = $true; break }
        if (-not $data) { continue }
        try {
            $parsed = $data | ConvertFrom-Json
            $delta = @($parsed.choices)[0].delta
            if ($delta.content) { $characters += ([string]$delta.content).Length }
            if ($delta.reasoning_content) { $characters += ([string]$delta.reasoning_content).Length }
            if (@($parsed.choices)[0].finish_reason) { $finish = [string]@($parsed.choices)[0].finish_reason }
            $events += 1
        } catch { }
        if ($events -ge 500) { break }
    }
    $reader.Dispose()
    $started.Stop()
    $report.streaming = [ordered]@{
        outcome = if ($status -ge 200 -and $status -lt 300 -and $characters -gt 0 -and ($finish -or $sawDone)) { 'ok' } else { 'failed' }
        httpStatus = $status
        contentType = $contentType
        events = $events
        contentCharacters = $characters
        finishReason = $finish
        doneMarker = $sawDone
        durationMs = [int]$started.ElapsedMilliseconds
    }
} catch {
    $report.streaming = Show-Error 'streaming' $_.Exception
}

$report | ConvertTo-Json -Depth 6
