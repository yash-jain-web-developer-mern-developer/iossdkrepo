# Security policy

## Reporting a vulnerability
Email **[security@example.com — replace before launch]** with details and, if possible, steps to reproduce. Please do not open public issues for security problems. We aim to acknowledge within 3 working days and to give a status update within 10. The same contact is published in `/.well-known/security.txt` (RFC 9116). Good-faith research that avoids privacy violations, data destruction and service disruption is welcome.

## Scope
The MobiAd application, its API, dashboard, SDK and deployment manifests. Third-party services are out of scope.

## What we do
Automated dependency, container, secret and static-analysis scanning (npm audit, Trivy, gitleaks, Semgrep, CodeQL in CI); chaos and failure testing; an audit log of security-relevant actions. An independent penetration test is **planned and not yet done** (see `docs/LAUNCH_CHECKLIST.md`).
