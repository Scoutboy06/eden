param($Script, $Line)

. $Script
$result = TabExpansion2 -inputScript $Line -cursorColumn $Line.Length
ConvertTo-Json -InputObject @($result.CompletionMatches | ForEach-Object CompletionText) -Compress
