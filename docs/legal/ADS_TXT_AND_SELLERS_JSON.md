# ads.txt, app-ads.txt and sellers.json (IAB supply-chain transparency) — templates

These files let buyers verify who is authorized to sell inventory. They require **your real business identity and seller ids**, so they are templates, not served by the app.

## app-ads.txt — published by each **publisher** on their developer website
One line per authorized seller (the publisher adds a line for MobiAd):
```
mobiad.example.com, [PUBLISHER-ACCOUNT-ID], DIRECT, [CERTIFICATION-AUTHORITY-ID-IF-ANY]
```
Give publishers the exact line to copy from the dashboard (**not built yet**: show the account id and this line on the app detail page).

## sellers.json — published by MobiAd at `https://mobiad.example.com/sellers.json`
```json
{
  "contact_email": "[ADOPS CONTACT]",
  "version": "1.0",
  "identifiers": [],
  "sellers": [
    { "seller_id": "[PUBLISHER-ACCOUNT-ID]", "name": "[PUBLISHER NAME]", "domain": "[PUBLISHER DOMAIN]", "seller_type": "PUBLISHER" },
    { "seller_id": "[OTHER-ID]", "name": "Confidential", "is_confidential": 1, "seller_type": "PUBLISHER" }
  ]
}
```
`seller_type` is `PUBLISHER`, `INTERMEDIARY` or `BOTH`. Real publisher identities must come from verified onboarding (KYC) — **not implemented**. Generate this file from the `users`/`apps` tables once publisher verification exists.

## Also needed for programmatic/OpenRTB sales (not built)
`schain` object support, TCF vendor registration, and a Global Vendor List entry if you will process EU programmatic traffic.
