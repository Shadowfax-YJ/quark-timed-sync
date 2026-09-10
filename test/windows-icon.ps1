param([Parameter(Mandatory=$true)][long]$WindowHandle)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
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
        $green = 0; $opaque = 0
        for ($y=0; $y -lt $bitmap.Height; $y++) { for ($x=0; $x -lt $bitmap.Width; $x++) {
            $pixel = $bitmap.GetPixel($x,$y)
            if ($pixel.A -gt 127) {
                $opaque++
                if ($pixel.G -gt ($pixel.R+40) -and $pixel.G -gt ($pixel.B+5)) { $green++ }
            }
        } }
        if ($opaque -eq 0 -or $green / $opaque -lt 0.6) { throw "$kind icon does not contain the application's green download mark" }
        $checks += [pscustomobject]@{Kind=$kind; Width=$bitmap.Width; Height=$bitmap.Height; Branded=$true}
    } finally { $bitmap.Dispose() }
}
$checks | ConvertTo-Json -Compress
