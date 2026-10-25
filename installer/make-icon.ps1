param(
    [string]$Output = (Join-Path $PSScriptRoot 'assets\SystemMonitor.ico'),
    [string]$PreviewDir = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

function New-IconBitmap([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $gfx = [System.Drawing.Graphics]::FromImage($bmp)
    $brush = $null
    $pen = $null
    try {
        $gfx.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $gfx.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $gfx.Clear([System.Drawing.Color]::Transparent)

        $inset = [Math]::Max(0.5, $size * 0.04)
        $rect = New-Object System.Drawing.RectangleF(
            [float]$inset, [float]$inset,
            [float]($size - 2 * $inset), [float]($size - 2 * $inset))
        $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
            $rect,
            [System.Drawing.Color]::FromArgb(52, 211, 153),
            [System.Drawing.Color]::FromArgb(5, 150, 105),
            [float]45)
        $gfx.FillEllipse($brush, $rect)

        $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, [float]([Math]::Max(1.4, $size * 0.095)))
        $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
        $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
        $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
        $points = [System.Drawing.PointF[]]@(
            (New-Object System.Drawing.PointF([float]($size * 0.23), [float]($size * 0.54))),
            (New-Object System.Drawing.PointF([float]($size * 0.37), [float]($size * 0.54))),
            (New-Object System.Drawing.PointF([float]($size * 0.44), [float]($size * 0.37))),
            (New-Object System.Drawing.PointF([float]($size * 0.53), [float]($size * 0.68))),
            (New-Object System.Drawing.PointF([float]($size * 0.62), [float]($size * 0.46))),
            (New-Object System.Drawing.PointF([float]($size * 0.75), [float]($size * 0.46))),
            (New-Object System.Drawing.PointF([float]($size * 0.80), [float]($size * 0.54)))
        )
        $gfx.DrawLines($pen, $points)
        return $bmp
    }
    finally {
        if ($pen) { $pen.Dispose() }
        if ($brush) { $brush.Dispose() }
        $gfx.Dispose()
    }
}

function Get-IconImageBytes([System.Drawing.Bitmap]$bmp) {
    $size = $bmp.Width
    $rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
    $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $stride = [Math]::Abs($data.Stride)
    $raw = New-Object byte[] ($stride * $size)
    [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $raw, 0, $raw.Length)
    $bmp.UnlockBits($data)

    $maskStride = [int]([Math]::Floor(($size + 31) / 32) * 4)
    $stream = New-Object System.IO.MemoryStream
    $writer = New-Object System.IO.BinaryWriter($stream)
    try {
        $writer.Write([UInt32]40)
        $writer.Write([Int32]$size)
        $writer.Write([Int32]($size * 2))
        $writer.Write([UInt16]1)
        $writer.Write([UInt16]32)
        $writer.Write([UInt32]0)
        $writer.Write([UInt32]($size * $size * 4 + $maskStride * $size))
        $writer.Write([Int32]0)
        $writer.Write([Int32]0)
        $writer.Write([UInt32]0)
        $writer.Write([UInt32]0)

        for ($y = $size - 1; $y -ge 0; $y--) {
            $writer.Write($raw, $y * $stride, $size * 4)
        }

        for ($y = $size - 1; $y -ge 0; $y--) {
            $mask = New-Object byte[] $maskStride
            for ($x = 0; $x -lt $size; $x++) {
                $alpha = $raw[$y * $stride + $x * 4 + 3]
                if ($alpha -lt 128) {
                    $byteIndex = [int][Math]::Floor($x / 8)
                    $mask[$byteIndex] = $mask[$byteIndex] -bor (1 -shl (7 - ($x % 8)))
                }
            }
            $writer.Write($mask, 0, $maskStride)
        }

        $writer.Flush()
        return $stream.ToArray()
    }
    finally {
        $writer.Dispose()
        $stream.Dispose()
    }
}

$sizes = @(16, 24, 32, 48, 64, 128, 256)
$images = New-Object System.Collections.ArrayList

foreach ($size in $sizes) {
    $bmp = New-IconBitmap $size
    try {
        [void]$images.Add((Get-IconImageBytes $bmp))
        if ($PreviewDir) {
            $preview = Join-Path $PreviewDir ("icon-$size.png")
            $bmp.Save($preview, [System.Drawing.Imaging.ImageFormat]::Png)
        }
    }
    finally {
        $bmp.Dispose()
    }
}

$headerSize = 6 + 16 * $sizes.Count
$offset = $headerSize
$iconStream = New-Object System.IO.MemoryStream
$writer = New-Object System.IO.BinaryWriter($iconStream)
try {
    $writer.Write([UInt16]0)
    $writer.Write([UInt16]1)
    $writer.Write([UInt16]$sizes.Count)

    for ($i = 0; $i -lt $sizes.Count; $i++) {
        $size = $sizes[$i]
        $bytes = [byte[]]$images[$i]
        $dimension = if ($size -ge 256) { 0 } else { $size }
        $writer.Write([byte]$dimension)
        $writer.Write([byte]$dimension)
        $writer.Write([byte]0)
        $writer.Write([byte]0)
        $writer.Write([UInt16]1)
        $writer.Write([UInt16]32)
        $writer.Write([UInt32]$bytes.Length)
        $writer.Write([UInt32]$offset)
        $offset += $bytes.Length
    }

    foreach ($bytes in $images) {
        $writer.Write([byte[]]$bytes)
    }

    $writer.Flush()
    $dir = Split-Path -Parent $Output
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    [System.IO.File]::WriteAllBytes($Output, $iconStream.ToArray())
}
finally {
    $writer.Dispose()
    $iconStream.Dispose()
}

Write-Output ("icon written: {0} ({1} bytes)" -f $Output, (Get-Item -LiteralPath $Output).Length)
