# Build script : APK WebView PlayTesteur (sans Gradle)
# Prerequis :
#   - JDK (javac, jar, keytool dans le PATH)
#   - Android SDK dans %LOCALAPPDATA%\Android\Sdk avec build-tools >= 35.0.0
#     et platforms\android-34 (installer via cmdline-tools sdkmanager)
#   - release.keystore + keystore-info.txt a la racine du repo (non commites)
# Sortie : playtesteur.apk a la racine du repo
$ErrorActionPreference = "Stop"

$sdk = "$env:LOCALAPPDATA\Android\Sdk"
$proj = $PSScriptRoot
$repo = Split-Path $proj -Parent

$buildTools = (Get-ChildItem "$sdk\build-tools" | Sort-Object Name -Descending | Select-Object -First 1).FullName
$platform = (Get-ChildItem "$sdk\platforms" | Sort-Object Name -Descending | Select-Object -First 1).FullName
$androidJar = "$platform\android.jar"
Write-Host "build-tools: $buildTools"
Write-Host "platform: $platform"

Remove-Item -Recurse -Force "$proj\out" -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force "$proj\out\classes", "$proj\out\dex" | Out-Null

# 1. Compiler les ressources
& "$buildTools\aapt2.exe" compile --dir "$proj\res" -o "$proj\out\res.zip"
if ($LASTEXITCODE -ne 0) { throw "aapt2 compile a echoue" }

# 2. Lier ressources + manifest -> APK squelette
& "$buildTools\aapt2.exe" link -o "$proj\out\app.unsigned.apk" -I $androidJar --manifest "$proj\AndroidManifest.xml" "$proj\out\res.zip" --auto-add-overlay
if ($LASTEXITCODE -ne 0) { throw "aapt2 link a echoue" }

# 3. Compiler le Java
& javac --release 8 -classpath $androidJar -d "$proj\out\classes" "$proj\src\com\app\playtesteur\MainActivity.java"
if ($LASTEXITCODE -ne 0) { throw "javac a echoue" }

# 4. Dex
$classFiles = Get-ChildItem "$proj\out\classes" -Recurse -Filter *.class | ForEach-Object { $_.FullName }
& "$buildTools\d8.bat" --release --lib $androidJar --min-api 24 --output "$proj\out\dex" @classFiles
if ($LASTEXITCODE -ne 0) { throw "d8 a echoue" }

# 5. Ajouter classes.dex a l'APK
Set-Location "$proj\out\dex"
& jar --update --file "$proj\out\app.unsigned.apk" classes.dex
if ($LASTEXITCODE -ne 0) { throw "jar update a echoue" }
Set-Location $proj

# 6. Zipalign
& "$buildTools\zipalign.exe" -f 4 "$proj\out\app.unsigned.apk" "$proj\out\app.aligned.apk"
if ($LASTEXITCODE -ne 0) { throw "zipalign a echoue" }

# 7. Signer (mot de passe lu depuis keystore-info.txt, jamais commite)
$passLine = (Get-Content "$repo\keystore-info.txt" | Select-String "Password").Line
$pass = $passLine.Split(":")[1].Trim()
& "$buildTools\apksigner.bat" sign --ks "$repo\release.keystore" --ks-key-alias playtesteur --ks-pass "pass:$pass" --key-pass "pass:$pass" --out "$repo\playtesteur.apk" "$proj\out\app.aligned.apk"
if ($LASTEXITCODE -ne 0) { throw "apksigner a echoue" }

# 8. Verifier la signature
& "$buildTools\apksigner.bat" verify --print-certs "$repo\playtesteur.apk"
if ($LASTEXITCODE -ne 0) { throw "verification signature a echoue" }

Get-Item "$repo\playtesteur.apk" | Select-Object Name, Length
Write-Host "BUILD OK"
