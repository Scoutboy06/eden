export const runtime = String.raw`$words = @(
    $commandAst.CommandElements |
      Select-Object -Skip 1 |
      Where-Object { $_.Extent.EndOffset -lt $cursorPosition } |
      ForEach-Object {
        if ($_ -is [System.Management.Automation.Language.StringConstantExpressionAst]) { $_.Value }
        else { $_.Extent.Text }
      }
  )

  function Find-ValueOption([string]$word, [string[]]$flags) {
    foreach ($flag in $flags) {
      if ($word.Equals($flag, [System.StringComparison]::Ordinal)) {
        return @{ Flag = $flag; Prefix = '' }
      }
      if ($flag.StartsWith('--', [System.StringComparison]::Ordinal)) {
        if ($word.StartsWith($flag + '=', [System.StringComparison]::Ordinal)) {
          return @{ Flag = $flag; Prefix = $flag + '=' }
        }
      } elseif ($word.StartsWith($flag, [System.StringComparison]::Ordinal)) {
        return @{ Flag = $flag; Prefix = $flag }
      }
    }
    return $null
  }

  $id = '0'
  $position = 0
  $ended = $false
  $pending = $null

  foreach ($word in $words) {
    $command = $commands[$id]
    if ($pending) {
      $pending = $null
    } elseif (-not $ended -and $word -ceq '--') {
      $ended = $true
    } elseif (-not $ended -and $word.StartsWith('-', [System.StringComparison]::Ordinal)) {
      $match = Find-ValueOption $word $command.Values
      if ($match -and -not $match.Prefix) { $pending = $match.Flag }
    } elseif ($position -eq 0 -and $children.ContainsKey($id + ':' + $word)) {
      $id = $children[$id + ':' + $word]
      $position = 0
    } else {
      $position++
    }
  }

  $command = $commands[$id]
  $prefix = ''
  $candidates = @()

  if ($pending) {
    $key = $id + ':' + $pending
    if ($choices.ContainsKey($key)) { $candidates = $choices[$key] }
  } elseif (-not $ended -and $wordToComplete.StartsWith('-', [System.StringComparison]::Ordinal)) {
    $match = Find-ValueOption $wordToComplete $command.Values
    if ($match -and $match.Prefix) {
      $prefix = $match.Prefix
      $key = $id + ':' + $match.Flag
      if ($choices.ContainsKey($key)) { $candidates = $choices[$key] }
    } else {
      $candidates = $command.Options
    }
  } else {
    $key = $id + ':' + $position
    if ($choices.ContainsKey($key)) { $candidates = $choices[$key] }
    if ($position -eq 0) { $candidates = @($candidates) + @($command.Commands) }
  }

  foreach ($candidate in $candidates) {
    $text = $prefix + $candidate
    if (-not $text.StartsWith($wordToComplete, [System.StringComparison]::OrdinalIgnoreCase)) { continue }
    if ($text -notmatch '^[\w.:+/\\=-]+$') {
      $text = "'" + ($text -replace "['‘’‚‛]", '$&$&') + "'"
    }
    [System.Management.Automation.CompletionResult]::new($text, $candidate, 'ParameterValue', $candidate)
  }`;
