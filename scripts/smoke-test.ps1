<#
  PAYDER biller-feature smoke test
  ---------------------------------
  Manual, low-ceremony verification of the new biller endpoints. There is no
  automated Jest suite for this feature yet (none existed in the repo before
  it either), so this hits the real running API with real HTTP calls and
  prints PASS/FAIL per check. It does not create or mutate data by default;
  the one write it can do (creating a test biller) is opt-in via -CreateTestBiller.

  HOW TO GET TOKENS
  ------------------
  1. Start the backend (npm run start:dev) and log into the web app
     (http://localhost:3000 or your deployed URL) once as an ADMIN user and
     once as a BILLER user (any biller you've already created via the admin
     panel, or create one first).
  2. Open browser DevTools -> Application -> Local Storage (or Network tab,
     look at the Authorization header on any API call) and copy the JWT.
  3. Paste them into -AdminToken / -BillerToken below, or set the
     $env:PAYDER_ADMIN_TOKEN / $env:PAYDER_BILLER_TOKEN environment variables.

  USAGE
  -----
    .\smoke-test.ps1 -BaseUrl "http://localhost:3000" -AdminToken "eyJ..." -BillerToken "eyJ..."

  Any step whose token isn't supplied is skipped (reported as SKIP, not FAIL).
#>

param(
    [string]$BaseUrl = "http://localhost:3000",
    [string]$AdminToken = $env:PAYDER_ADMIN_TOKEN,
    [string]$BillerToken = $env:PAYDER_BILLER_TOKEN,
    [switch]$CreateTestBiller
)

$ErrorActionPreference = "Stop"
$results = @()

function Check {
    param(
        [string]$Name,
        [scriptblock]$Body
    )
    try {
        $r = & $Body
        Write-Host "[PASS] $Name" -ForegroundColor Green
        $script:results += [pscustomobject]@{ Name = $Name; Status = "PASS"; Detail = $r }
    } catch {
        Write-Host "[FAIL] $Name -> $($_.Exception.Message)" -ForegroundColor Red
        $script:results += [pscustomobject]@{ Name = $Name; Status = "FAIL"; Detail = $_.Exception.Message }
    }
}

function Skip {
    param([string]$Name, [string]$Reason)
    Write-Host "[SKIP] $Name ($Reason)" -ForegroundColor Yellow
    $script:results += [pscustomobject]@{ Name = $Name; Status = "SKIP"; Detail = $Reason }
}

function AuthHeader($token) {
    return @{ Authorization = "Bearer $token" }
}

Write-Host "== PAYDER biller feature smoke test ==" -ForegroundColor Cyan
Write-Host "Base URL: $BaseUrl`n"

# ---------------------------------------------------------------------------
# 1. Public / guest bill-pay catalog endpoints — no auth required
# ---------------------------------------------------------------------------
Check "GET /bill-pay/categories (public)" {
    $resp = Invoke-RestMethod -Uri "$BaseUrl/bill-pay/categories" -Method Get
    if (-not $resp) { throw "empty response" }
    "categories: $($resp.Count)"
}

$firstCategory = $null
try {
    $cats = Invoke-RestMethod -Uri "$BaseUrl/bill-pay/categories" -Method Get
    if ($cats -and $cats.Count -gt 0) { $firstCategory = $cats[0] }
} catch {}

if ($firstCategory) {
    Check "GET /bill-pay/categories/:type/billers (public)" {
        $resp = Invoke-RestMethod -Uri "$BaseUrl/bill-pay/categories/$firstCategory/billers" -Method Get
        "billers in '$firstCategory': $($resp.Count)"
    }
} else {
    Skip "GET /bill-pay/categories/:type/billers (public)" "no categories found yet (no published bills) — publish a bill first to exercise this"
}

# ---------------------------------------------------------------------------
# 2. Admin endpoints
# ---------------------------------------------------------------------------
if ($AdminToken) {
    Check "GET /admin/billers (admin)" {
        $resp = Invoke-RestMethod -Uri "$BaseUrl/admin/billers" -Method Get -Headers (AuthHeader $AdminToken)
        "billers: $($resp.Count)"
    }

    if ($CreateTestBiller) {
        Check "POST /admin/billers (admin, creates a test biller)" {
            $body = @{
                name      = "Smoke Test Biller $(Get-Date -Format 'yyyyMMddHHmmss')"
                type      = "SCHOOL"
                isJoint   = $false
                email     = "smoketest+$(Get-Random)@payder.internal"
                password  = "TempPass123!"
            } | ConvertTo-Json
            $resp = Invoke-RestMethod -Uri "$BaseUrl/admin/billers" -Method Post -Headers (AuthHeader $AdminToken) -ContentType "application/json" -Body $body
            "created biller id: $($resp.id)"
        }
    } else {
        Skip "POST /admin/billers (admin, creates a test biller)" "pass -CreateTestBiller to run this write"
    }
} else {
    Skip "GET /admin/billers (admin)" "no -AdminToken supplied"
    Skip "POST /admin/billers (admin)" "no -AdminToken supplied"
}

# ---------------------------------------------------------------------------
# 3. Biller self-service endpoints
# ---------------------------------------------------------------------------
if ($BillerToken) {
    Check "GET /billers/me (biller)" {
        $resp = Invoke-RestMethod -Uri "$BaseUrl/billers/me" -Method Get -Headers (AuthHeader $BillerToken)
        "biller: $($resp.name)"
    }

    Check "GET /billers/wallet/balance (biller)" {
        $resp = Invoke-RestMethod -Uri "$BaseUrl/billers/wallet/balance" -Method Get -Headers (AuthHeader $BillerToken)
        "balance: $($resp.balance)"
    }

    Check "GET /billers/bill (biller)" {
        $resp = Invoke-RestMethod -Uri "$BaseUrl/billers/bill" -Method Get -Headers (AuthHeader $BillerToken)
        "bill status: $($resp.status)"
    }

    Check "GET /billers/report-preference (biller)" {
        $resp = Invoke-RestMethod -Uri "$BaseUrl/billers/report-preference" -Method Get -Headers (AuthHeader $BillerToken)
        "frequency: $($resp.frequency)"
    }

    Check "GET /billers/payments (biller)" {
        $resp = Invoke-RestMethod -Uri "$BaseUrl/billers/payments" -Method Get -Headers (AuthHeader $BillerToken)
        "payments: $($resp.Count)"
    }
} else {
    Skip "GET /billers/me (biller)" "no -BillerToken supplied"
    Skip "GET /billers/wallet/balance (biller)" "no -BillerToken supplied"
    Skip "GET /billers/bill (biller)" "no -BillerToken supplied"
    Skip "GET /billers/report-preference (biller)" "no -BillerToken supplied"
    Skip "GET /billers/payments (biller)" "no -BillerToken supplied"
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
Write-Host "`n== Summary ==" -ForegroundColor Cyan
$results | Format-Table -AutoSize

$fails = ($results | Where-Object { $_.Status -eq "FAIL" }).Count
if ($fails -gt 0) {
    Write-Host "`n$fails check(s) FAILED." -ForegroundColor Red
    exit 1
} else {
    Write-Host "`nAll executed checks passed." -ForegroundColor Green
    exit 0
}
