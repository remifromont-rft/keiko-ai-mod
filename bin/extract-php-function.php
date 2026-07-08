#!/usr/bin/env php
<?php
// Usage: php bin/extract-php-function.php <file> <function_name>
// Extracts a function body from a PHP file using the tokenizer.

if ($argc < 3) {
    fwrite(STDERR, "Usage: php bin/extract-php-function.php <file> <function_name>\n");
    exit(1);
}

$file = $argv[1];
// Accept "Class.method" or just "method" — only the function name matters for matching
$target = $argv[2];
if (str_contains($target, '.')) {
    $target = explode('.', $target, 2)[1];
}

if (!file_exists($file)) {
    fwrite(STDERR, "File not found: $file\n");
    exit(1);
}

$tokens = token_get_all(file_get_contents($file));
$found = false;
$depth = 0;
$startLine = 0;
$endLine = 0;
$currentLine = 1;

for ($i = 0; $i < count($tokens); $i++) {
    // Track current line through all tokens (array tokens carry line info, single-char tokens don't)
    if (is_array($tokens[$i])) {
        $currentLine = $tokens[$i][2];
    }

    if (!$found) {
        if (is_array($tokens[$i]) && $tokens[$i][0] === T_FUNCTION) {
            for ($j = $i + 1; $j < count($tokens); $j++) {
                if (is_array($tokens[$j]) && $tokens[$j][0] === T_WHITESPACE) continue;
                if (is_array($tokens[$j]) && $tokens[$j][0] === T_STRING && $tokens[$j][1] === $target) {
                    $found = true;
                    $startLine = $tokens[$i][2];
                }
                break;
            }
        }
    } else {
        $tok = is_array($tokens[$i]) ? $tokens[$i][1] : $tokens[$i];
        if ($tok === '{') $depth++;
        if ($tok === '}') {
            $depth--;
            if ($depth === 0) {
                $endLine = $currentLine;
                break;
            }
        }
    }

    // Advance currentLine by counting newlines in token content
    $content = is_array($tokens[$i]) ? $tokens[$i][1] : $tokens[$i];
    $currentLine += substr_count($content, "\n");
}

if (!$found) {
    fwrite(STDERR, "Function '$target' not found in $file\n");
    exit(1);
}

$lines = file($file);
$extracted = [];
for ($l = $startLine - 1; $l <= $endLine - 1 && $l < count($lines); $l++) {
    $extracted[] = [$l + 1, $lines[$l]];
}

// Dedent: find minimum leading whitespace across non-empty lines
$minIndent = PHP_INT_MAX;
foreach ($extracted as [$num, $line]) {
    if (trim($line) === '') continue;
    $stripped = ltrim($line);
    $indent = strlen($line) - strlen($stripped);
    if ($indent < $minIndent) $minIndent = $indent;
}
if ($minIndent === PHP_INT_MAX) $minIndent = 0;

foreach ($extracted as [$num, $line]) {
    echo $num . "\t" . (trim($line) === '' ? "\n" : substr($line, $minIndent));
}
