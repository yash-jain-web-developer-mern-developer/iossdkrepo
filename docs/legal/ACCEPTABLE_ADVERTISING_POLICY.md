# Acceptable Advertising Policy (DRAFT)

This policy is enforced by (1) **automated screening** at submission (`src/policy.js`), (2) **mandatory human review** in production, (3) takedown and audit by admins. Counsel should review the wording.

## Rejected automatically (HTTP 400 with reasons)
- Landing or image URLs that are not valid public `https` URLs (when `REQUIRE_HTTPS_CREATIVES` is on), contain credentials, or point to private, loopback, link-local or internal addresses (blocks SSRF and internal-network probing), or to a blocked domain (`BLOCKED_DOMAINS`).
- Unknown categories. A "child-safe" claim on a category that can never be child-safe (gambling, adult, alcohol, tobacco, crypto, political, finance).

## Always routed to manual review
URL shorteners, internationalized/punycode domains (look-alike risk), scam-style phrases ("you have won", "virus detected", "free money", …), and the **restricted categories**: gambling, adult, alcohol, tobacco, crypto, political, finance, health.

## Prohibited content (reviewers reject; list is not exhaustive)
Illegal goods or services; malware, deceptive installs, fake system/security warnings; phishing or impersonation of brands, officials or the platform; hate, harassment or violence; sexually explicit content outside permitted adult placements; weapons, counterfeit goods, drugs; misleading financial or health claims; ads targeted at children for anything not child-safe; political ads without required disclosures; landing pages that differ materially from the ad.

## Brand safety for publishers
Publishers can block categories per app. Child-directed apps only receive campaigns marked child-safe by the advertiser **and** approved by a reviewer.

## Enforcement
Rejected campaigns stop serving immediately on every replica and the advertiser is emailed the reason. Repeat violations may lead to account suspension. Appeals: **[contact]**. Every decision is recorded in the audit log.
