param($Script, $Lines)

. $Script
$results = @(
    ConvertFrom-Json -InputObject $Lines | ForEach-Object {
        $Line = $_
        $result = TabExpansion2 -inputScript $Line -cursorColumn $Line.Length
        ,@($result.CompletionMatches | ForEach-Object CompletionText)
    }
)
ConvertTo-Json -InputObject $results -Depth 4 -Compress
