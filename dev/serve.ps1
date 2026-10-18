param([string]$Root, [int]$Port = 8780)
$types = @{ ".html"="text/html; charset=utf-8"; ".js"="text/javascript; charset=utf-8"; ".webmanifest"="application/manifest+json"; ".png"="image/png"; ".json"="application/json" }
$l = New-Object System.Net.HttpListener
$l.Prefixes.Add("http://localhost:$Port/")
$l.Start()
while ($l.IsListening) {
  $c = $l.GetContext()
  $p = [Uri]::UnescapeDataString($c.Request.Url.AbsolutePath).TrimStart("/")
  if ($p -eq "" -or $p.EndsWith("/")) { $p += "index.html" }
  $file = Join-Path $Root $p
  if (Test-Path $file -PathType Leaf) {
    $b = [IO.File]::ReadAllBytes($file)
    $ext = [IO.Path]::GetExtension($file)
    $c.Response.ContentType = $(if ($types[$ext]) { $types[$ext] } else { "application/octet-stream" })
    $c.Response.OutputStream.Write($b, 0, $b.Length)
  } else { $c.Response.StatusCode = 404 }
  $c.Response.Close()
}
