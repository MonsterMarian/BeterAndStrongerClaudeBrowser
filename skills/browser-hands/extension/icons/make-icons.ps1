# Builds icon16/32/48/128.png from a square source image: transparent anti-aliased rounded corners, no white fringe.
# Usage: powershell -File make-icons.ps1 <source.jpg|png> [cornerRadiusFraction=0.24] [insetFraction=0.006]
param([Parameter(Mandatory)][string]$Source, [double]$Radius = 0.24, [double]$Inset = 0.006)
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile((Resolve-Path $Source))
$n = $src.Width
$cut = [int]($n * $Inset)                      # trims the source's own anti-aliased white edge
$side = $n - 2 * $cut
$r = [int]($side * $Radius)

$big = New-Object System.Drawing.Bitmap $side, $side, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($big)
$g.SmoothingMode = 'AntiAlias'
$g.Clear([System.Drawing.Color]::Transparent)
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$d = 2 * $r
$path.AddArc(0, 0, $d, $d, 180, 90); $path.AddArc($side - $d, 0, $d, $d, 270, 90)
$path.AddArc($side - $d, $side - $d, $d, $d, 0, 90); $path.AddArc(0, $side - $d, $d, $d, 90, 90); $path.CloseFigure()
$brush = New-Object System.Drawing.TextureBrush($src)
$brush.TranslateTransform(-$cut, -$cut)
$g.FillPath($brush, $path)                      # FillPath is anti-aliased, a clip region would not be
$g.Dispose()

foreach ($s in 16, 32, 48, 128) {
  $bmp = New-Object System.Drawing.Bitmap $s, $s, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $gs = [System.Drawing.Graphics]::FromImage($bmp)
  $gs.InterpolationMode = 'HighQualityBicubic'; $gs.PixelOffsetMode = 'HighQuality'; $gs.CompositingQuality = 'HighQuality'
  $gs.Clear([System.Drawing.Color]::Transparent)
  $gs.DrawImage($big, 0, 0, $s, $s)
  $bmp.Save((Join-Path $PSScriptRoot "icon$s.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $gs.Dispose(); $bmp.Dispose()
}
$big.Dispose(); $src.Dispose()
# self-check: corners must be transparent, centre opaque
$chk = New-Object System.Drawing.Bitmap (Join-Path $PSScriptRoot 'icon128.png')
if ($chk.GetPixel(0, 0).A -ne 0 -or $chk.GetPixel(127, 127).A -ne 0 -or $chk.GetPixel(64, 64).A -ne 255) { $chk.Dispose(); throw 'icon self-check failed' }
$chk.Dispose()
'icons written'
