# Final plan: product UI overhaul and delivery

Decision record: the user asked for one complete plan, executed without further questions, with a much better UI than the
current one. Scope below is what was planned *and* delivered; anything not delivered is listed in "Not in scope".

## Goals
1. A marketing site that looks and feels like a modern enterprise ad-tech platform (original brand, original illustrations, honest copy).
2. A dashboard that is pleasant and fast to use: app shell with sidebar, real charts, clear empty states, mobile support, dark mode.
3. Keep every security property (CSP `default-src 'self'`, textContent-only rendering, no inline scripts/styles) and every existing behaviour (tests).

## Design system (`public/tokens.css`)
- Colour tokens for light and dark (`prefers-color-scheme`, plus a manual toggle stored in `localStorage` with try/catch).
- System font stack (CSP allows no external fonts); fluid type scale; 8-pt spacing; radii and elevation tokens.
- Components: buttons, inputs, selects, switches/checkboxes, cards, tags, tables, tabs, toasts, skeletons, modals/drawers, empty states.
- Accessibility: visible focus rings, 44 px touch targets, `prefers-reduced-motion`, WCAG AA contrast, landmarks and aria on tabs/menus.

## Marketing site (`index.html`, `site.css`, `site.js`)
Sections: nav (mobile menu) - hero with composed product illustration - honest proof strip - Advertisers/Publishers tabs - formats gallery
(banner, interstitial, native, video, playable) - how it works - platform pillars - developers (real JS/Kotlin/Swift snippets, OpenRTB)
- pricing models (CPM/CPC/CPA, 70% default publisher share) - trust and safety - FAQ - CTA - footer.
Rules: no invented customer logos, testimonials, statistics or unsupported SDK claims. All imagery is inline SVG drawn for MobiAd.

## Dashboard (`app.html`, `app.css`, `app.js`)
- App shell: sidebar (role-aware), top bar (page title, theme toggle, account menu); collapses to a drawer on mobile.
- Advertiser: Overview (KPIs, performance chart, top campaigns), Campaigns (search/filter, status chips, 3-step creation wizard with live ad preview), Wallet, Reports.
- Publisher: Overview, Apps (cards with integration snippets in JS/Kotlin/Swift), Earnings and payouts, Reports.
- Admin: same shell, restyled tabs and tables.
- Shared: SVG chart component (dual-axis line/area, accessible table fallback), toasts instead of `alert`, skeleton loading, empty states.

## Verification
- Drive every view in the browser at desktop and 375 px mobile widths, light and dark; check console for CSP violations.
- Full hermetic suite, plus the existing dashboard check script, plus a grep-based guard that no inline `style=`/`<script>` bodies/`innerHTML` of user data exist.

## Not in scope (needs people/outside systems)
Real customer logos/testimonials, brand photography, translated UI, a design review with real users, and everything listed in `LAUNCH_CHECKLIST.md`.

## Delivery status
- Design system (`tokens.css`), marketing site (`index.html`, `site.css`, `site.js`), legal pages, and dashboard (`app.html`, `app.css`, `app.js`, `ui.js`) are rebuilt. The old `style.css` is removed.
- Dashboard: app shell with sidebar and mobile drawer, light/dark theme, advertiser (Overview, Campaigns with 3-step wizard and live preview, Wallet, Reports), publisher (Overview, Apps with JS/Kotlin/Swift snippets, Earnings and payouts, Reports), admin (restyled tabs), toasts, empty states, accessible SVG charts with a data-table fallback.
- Verified by driving it in a real browser: every advertiser, publisher and admin page loads without JS errors, the campaign wizard creates a campaign, the mobile drawer opens/closes, no horizontal overflow at 375 px, dark mode, marketing tabs and menu.
- Guard checks: no inline `style=` attributes, no `innerHTML`/`eval` in `public/`.
- Not done: an automated accessibility audit (axe/Lighthouse), cross-browser testing beyond the embedded Chromium, and real brand photography (all imagery is inline SVG).
