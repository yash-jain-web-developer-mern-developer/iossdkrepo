# Automated security scan: OWASP ZAP (2026-10-21)

**What:** `zap-api-scan.py` (ZAP stable, passive + active rules) driven by `docs/openapi.yaml` against a locally running instance (in-memory database, development configuration, rate limit raised so the scan is not throttled).

**Result:** 117 rules passed, **0 failures**, 3 warnings.

| Warning | Verdict |
|---|---|
| Cross-Origin-Resource-Policy header missing (6 URLs) | **Fixed:** dashboard/API responses now send `same-origin`; the ad plane (`/v1`, `/t`, `/rtb`, `/sellers.json`) sends `cross-origin` on purpose (SDKs, pixels and exchanges must be able to fetch it). Covered by a test. |
| Cross-domain misconfiguration (`Access-Control-Allow-Origin: *` on `/v1/ad`) | **Accepted by design:** a public, credential-free endpoint called from SDKs and web pages; no cookies or ambient authentication. Annotated in the code. |
| Unexpected content type (pixel GIF, redirect, HTML pages) | **Accepted:** ZAP expected JSON from the spec; these responses are intentionally GIF, 302 and HTML. |

The scan found a real defect on the way: the OpenAPI file contained invalid YAML that our linter tolerated and strict parsers (ZAP) rejected. Fixed, and CI now parses the spec strictly.

**Limits:** unauthenticated API scan of a development build. It did not exercise logged-in flows with real data, the Kubernetes deployment, TLS configuration, or business-logic abuse. **It is not a penetration test**, which still needs an independent firm.
