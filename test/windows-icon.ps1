param(
    [Parameter(Mandatory=$true)][long]$WindowHandle,
    [string]$ReferenceIcon
)
$ErrorActionPreference = 'Stop'
if (!$ReferenceIcon) { $ReferenceIcon = Join-Path $PSScriptRoot '..\assets\icon.ico' }
Add-Type -AssemblyName System.Drawing
# Decode the embedded PNG directly: .NET Framework Icon.ToBitmap can misread
# PNG-compressed ICO frames even when Windows loads the same ICO correctly.
$iconData = [IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $ReferenceIcon).Path)
$frames = @{}
for ($i=0; $i -lt [BitConverter]::ToUInt16($iconData, 4); $i++) {
    $entry = 6 + 16 * $i
    $width = if ($iconData[$entry] -eq 0) { 256 } else { [int]$iconData[$entry] }
    $height = if ($iconData[$entry+1] -eq 0) { 256 } else { [int]$iconData[$entry+1] }
    $frames["${width}x${height}"] = @([BitConverter]::ToUInt32($iconData, $entry+12), [BitConverter]::ToUInt32($iconData, $entry+8))
}
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class WindowIconReader {
    [DllImport("user32.dll", SetLastError=true)]
    public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
}
'@
$checks = @()
foreach ($kind in @('small', 'large')) {
    $handle = [IntPtr]::Zero
    $result = [WindowIconReader]::SendMessageTimeout([IntPtr]$WindowHandle, 0x7F, [IntPtr]([int]($kind -eq 'large')), [IntPtr]::Zero, 2, 5000, [ref]$handle)
    if ($result -eq [IntPtr]::Zero -or $handle -eq [IntPtr]::Zero) { throw "Missing $kind native window icon" }
    # The HICON is owned by the application; dispose only our bitmap copy.
    $bitmap = [Drawing.Icon]::FromHandle($handle).ToBitmap()
    try {
        if ($bitmap.Width -gt 256 -or $bitmap.Height -gt 256) {
            throw "$kind taskbar/window icon is $($bitmap.Width)x$($bitmap.Height); use a Windows-sized ICO instead of the full-size PNG"
        }
        $frame = $frames["$($bitmap.Width)x$($bitmap.Height)"]
        if (!$frame) { throw "$kind icon dimensions do not match an available application ICO frame" }
        $stream = [IO.MemoryStream]::new($iconData, [int]$frame[0], [int]$frame[1], $false)
        $expected = [Drawing.Bitmap]::new($stream)
        try {
            if ($expected.Width -ne $bitmap.Width -or $expected.Height -ne $bitmap.Height) {
                throw "$kind icon dimensions do not match an available application ICO frame"
            }
            $opaque = 0; $difference = 0.0
            for ($y=0; $y -lt $bitmap.Height; $y++) { for ($x=0; $x -lt $bitmap.Width; $x++) {
                $pixel = $bitmap.GetPixel($x,$y); $target = $expected.GetPixel($x,$y)
                if ($pixel.A -gt 127) { $opaque++ }
                # Compare premultiplied pixels so transparent RGB does not affect the result.
                $difference += [Math]::Abs($pixel.A - $target.A)
                foreach ($channel in @('R', 'G', 'B')) {
                    $difference += [Math]::Abs(($pixel.$channel * $pixel.A - $target.$channel * $target.A) / 255.0)
                }
            } }
            $meanError = $difference / (4 * $bitmap.Width * $bitmap.Height)
            if ($opaque -eq 0 -or $meanError -gt 8) { throw "$kind icon differs from the application's ICO artwork (mean pixel error $meanError)" }
            $checks += [pscustomobject]@{Kind=$kind; Width=$bitmap.Width; Height=$bitmap.Height; Branded=$true; MeanPixelError=$meanError}
        } finally { $expected.Dispose(); $stream.Dispose() }
    } finally { $bitmap.Dispose() }
}
$checks | ConvertTo-Json -Compress
