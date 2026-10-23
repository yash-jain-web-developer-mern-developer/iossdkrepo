// Webhooks, invoices and credit notes, plus the supply-chain transparency files (sellers.json, ads.txt lines).
import { json, readJson } from '../http.js';
import { id, toCsv, usdToMicros, microsToUsd, monthRe } from './util.js';
import { validateOutboundUrl } from '../core/safeHttp.js';
import { WEBHOOK_EVENTS, newWebhookSecret } from '../core/webhooks.js';
import { taxFor, splitInclusive } from '../billing/tax.js';

const MAX_HOOKS = 5;
const usd = (m) => microsToUsd(m);
const hostOf = (u) => { try { return new URL(u).hostname; } catch { return 'localhost'; } };

export function extrasRoutes(ctx) {
  const { repo, cfg } = ctx;
  const owner = (u) => u.id; // members are mapped to the owner account by the router

  // ---- supply-chain transparency (public) ----
  const sellerDomain = cfg.sellerDomain || hostOf(cfg.publicUrl);
  const routes = {
    // IAB sellers.json: publishers are listed as confidential PUBLISHER entries (no names), and MobiAd itself as the intermediary.
    'GET /sellers.json': { public: true, handler: async ({ res }) => {
      const ids = await repo.publisherIds(50000);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' });
      return res.end(JSON.stringify({ contact_email: cfg.sellerContact || 'ads-support@' + sellerDomain, version: '1.0', identifiers: [], sellers: [
        { seller_id: cfg.sellerId || 'mobiad', name: 'MobiAd', domain: sellerDomain, seller_type: 'INTERMEDIARY' },
        ...ids.map((pid) => ({ seller_id: pid, seller_type: 'PUBLISHER', is_confidential: 1 })),
      ] }));
    } },
    // The lines a publisher adds to their app-ads.txt so buyers can verify MobiAd is authorised to sell their inventory.
    'GET /api/ads-txt': { role: 'publisher', handler: async ({ res, u }) => {
      const line = `${sellerDomain}, ${owner(u)}, DIRECT`;
      return json(res, 200, { lines: [line], text: line + '\n', note: 'Add this line to the app-ads.txt file on your developer website (as listed in your app store page).' });
    } },
  };

  // ---- webhooks ----
  Object.assign(routes, {
    'GET /api/webhooks/events': { handler: async ({ res }) => json(res, 200, WEBHOOK_EVENTS.filter((e) => e !== 'ping')) },
    'POST /api/webhooks': { verified: true, handler: async ({ req, res, u }) => {
      const b = await readJson(req);
      const problem = validateOutboundUrl(String(b.url || ''), { allowPrivate: cfg.allowPrivateCallbacks, allowHttp: cfg.allowPrivateCallbacks });
      if (problem) return json(res, 400, { error: 'url ' + problem });
      const events = Array.isArray(b.events) ? [...new Set(b.events.map(String))] : [];
      if (events.some((e) => !WEBHOOK_EVENTS.includes(e) || e === 'ping')) return json(res, 400, { error: 'unknown event; see GET /api/webhooks/events' });
      if ((await repo.webhooksByUser(owner(u))).length >= MAX_HOOKS) return json(res, 409, { error: `at most ${MAX_HOOKS} webhooks` });
      const h = { id: id('whk'), userId: owner(u), url: String(b.url), secret: newWebhookSecret(), events };
      await repo.createWebhook(h);
      await ctx.audit(null, u.id, 'webhook_created', h.id, { url: h.url, events });
      return json(res, 201, { id: h.id, url: h.url, events, secret: h.secret, note: 'Store this secret now; it cannot be shown again. Verify X-MobiAd-Signature = t=<unix>,v1=HMAC-SHA256(secret, "<t>.<raw body>").' });
    } },
    'GET /api/webhooks': { handler: async ({ res, u }) => json(res, 200, (await repo.webhooksByUser(owner(u))).map((h) => ({ id: h.id, url: h.url, events: h.events, status: h.status, failures: h.failures, createdAt: h.createdAt }))) },
    'POST /api/webhooks/delete': { handler: async ({ req, res, u }) => {
      const b = await readJson(req);
      if (!(await repo.deleteWebhook(owner(u), String(b.id || '')))) return json(res, 404, { error: 'webhook not found' });
      await ctx.audit(null, u.id, 'webhook_deleted', String(b.id), {}); return json(res, 200, { ok: true });
    } },
    'POST /api/webhooks/test': { handler: async ({ req, res, u }) => {
      const b = await readJson(req), hook = await repo.webhook(String(b.id || ''));
      if (!hook || hook.userId !== owner(u)) return json(res, 404, { error: 'webhook not found' });
      await repo.enqueueDelivery({ id: id('dlv'), webhookId: hook.id, userId: hook.userId, event: 'ping', payload: JSON.stringify({ id: id('evt'), event: 'ping', createdAt: Date.now(), data: { hello: 'from MobiAd' } }) });
      return json(res, 202, { queued: true });
    } },
    'GET /api/webhooks/deliveries': { handler: async ({ res, u, url }) => {
      const rows = await repo.deliveriesFor(owner(u), String(url.searchParams.get('id') || ''), 50);
      return json(res, 200, rows.map((d) => ({ id: d.id, event: d.event, status: d.status, attempts: d.attempts, lastError: d.last_error, createdAt: +d.created_at, deliveredAt: +d.delivered_at })));
    } },
  });

  // ---- invoices and credit notes (advertisers) ----
  Object.assign(routes, {
    'POST /api/billing/invoices/generate': { role: 'advertiser', verified: true, handler: async ({ req, res, u }) => {
      const b = await readJson(req), month = String(b.month || '');
      if (!monthRe.test(month)) return json(res, 400, { error: 'month must be YYYY-MM' });
      if (month >= new Date().toISOString().slice(0, 7)) return json(res, 409, { error: 'month_not_closed', detail: 'Invoices are issued for completed months only.' });
      const existing = await repo.invoiceByPeriod(owner(u), month);
      if (existing) return json(res, 200, present(existing));
      const profile = await repo.billingProfile(owner(u));
      if (cfg.taxMode !== 'none' && (!profile.legalName || !profile.address || !profile.country)) return json(res, 409, { error: 'billing_profile_required', detail: 'A tax invoice needs your legal name, address and country. Add them under Wallet > Billing details, then generate the invoice.' });
      const rows = await repo.statement('advertiser', owner(u), month), by = new Map();
      for (const r of rows) { const l = by.get(r.id) || { campaignId: r.id, description: r.name, impressions: 0, clicks: 0, conversions: 0, amountMicros: 0 }; l.impressions += r.impressions; l.clicks += r.clicks; l.conversions += r.conversions || 0; l.amountMicros += Math.round(r.spend * 1e6); by.set(r.id, l); }
      const lines = [...by.values()].filter((l) => l.amountMicros > 0);
      if (!lines.length) return json(res, 409, { error: 'nothing_to_invoice', detail: 'There was no billable spend in that month.' });
      const gross = lines.reduce((s, l) => s + l.amountMicros, 0);
      let tax = { rateBp: 0, label: null, note: null }, subtotal = null, taxMicros = 0, seller = null, buyer = null;
      if (cfg.taxMode !== 'none') { tax = taxFor(cfg, profile); const s = splitInclusive(gross, tax.rateBp); subtotal = s.netMicros; taxMicros = s.taxMicros; seller = cfg.taxSeller; buyer = profile; } // seller and buyer are frozen on the document
      const inv = await repo.createInvoice({ userId: owner(u), period: month, lines, totalMicros: gross, subtotalMicros: subtotal, taxMicros, taxRateBp: tax.rateBp, taxLabel: tax.label, taxNote: tax.note, seller, buyer });
      await ctx.audit(null, u.id, 'invoice_issued', inv.id, { number: inv.number, month });
      return json(res, 201, present(inv));
    } },
    'GET /api/billing/invoices': { role: 'advertiser', handler: async ({ res, u }) => json(res, 200, (await repo.invoicesByUser(owner(u))).map((i) => ({ id: i.id, number: i.number, period: i.period, total: usd(i.total_micros), issuedAt: +i.issued_at }))) },
    'GET /api/billing/invoice': { role: 'advertiser', handler: async ({ res, u, url }) => {
      const inv = await repo.invoice(String(url.searchParams.get('id') || ''));
      if (!inv || inv.user_id !== owner(u)) return json(res, 404, { error: 'invoice not found' });
      if (url.searchParams.get('format') === 'csv') {
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${inv.number}.csv"` });
        const p = present(inv);
        const rows = p.lines.map((l) => [inv.number, inv.period, l.description, l.impressions, l.clicks, l.conversions, l.amount]);
        if (p.taxInvoice) rows.push([inv.number, inv.period, 'Net amount', '', '', '', p.subtotal], [inv.number, inv.period, `${p.taxLabel || 'Tax'} ${p.taxRate}% (included in the amounts above)`, '', '', '', p.tax], [inv.number, inv.period, 'Total paid', '', '', '', p.total]);
        return res.end(toCsv(['invoice', 'period', 'campaign', 'impressions', 'clicks', 'conversions', 'amount_usd'], rows));
      }
      return json(res, 200, present(inv));
    } },
    'GET /api/billing/credit-notes': { role: 'advertiser', handler: async ({ res, u }) => json(res, 200, (await repo.creditNotesByUser(owner(u))).map((c) => ({ id: c.id, number: c.number, amount: usd(c.amount_micros), tax: usd(Number(c.tax_micros || 0)), taxRate: Number(c.tax_rate_bp || 0) / 100, reason: c.reason, invoiceId: c.invoice_id, issuedAt: +c.issued_at }))) },
    // Admin: issue a credit note (adds the amount to the advertiser's wallet and records the document).
    'POST /api/admin/credit-notes': { role: 'admin', admin: true, handler: async ({ req, res, u }) => {
      const b = await readJson(req), target = await repo.userById(String(b.userId || '')), amount = Number(b.amountUsd), reason = String(b.reason || '').trim();
      if (!target || target.role !== 'advertiser' || target.account_id) return json(res, 400, { error: 'userId must be an advertiser account owner' });
      if (!(amount > 0 && amount <= 100000) || !reason || reason.length > 500) return json(res, 400, { error: 'amountUsd (0-100000) and reason (max 500 chars) required' });
      let linked = null;
      if (b.invoiceId) { linked = await repo.invoice(String(b.invoiceId)); if (!linked || linked.user_id !== target.id) return json(res, 400, { error: 'invoiceId does not belong to that advertiser' }); }
      // the credit note reverses the same share of tax: the linked invoice's rate, else the buyer country's current rate
      const rateBp = cfg.taxMode === 'none' ? 0 : linked && linked.subtotal_micros != null ? Number(linked.tax_rate_bp) : taxFor(cfg, await repo.billingProfile(target.id)).rateBp;
      const cn = await repo.createCreditNote({ userId: target.id, amountMicros: usdToMicros(amount), reason, invoiceId: b.invoiceId ? String(b.invoiceId) : null, by: u.id, taxRateBp: rateBp, taxMicros: splitInclusive(usdToMicros(amount), rateBp).taxMicros });
      await repo.addWalletEntry({ id: id('wal'), userId: target.id, kind: 'topup', amountMicros: cn.amountMicros, provider: 'credit_note', providerRef: 'credit_note:' + cn.id, note: `Credit note ${cn.number}: ${reason}`.slice(0, 300) });
      await ctx.audit(null, u.id, 'credit_note_issued', cn.id, { number: cn.number, amountUsd: amount, userId: target.id });
      ctx.emit?.(target.id, 'wallet.credited', { amountUsd: amount, creditNote: cn.number, reason });
      return json(res, 201, { id: cn.id, number: cn.number, amountUsd: amount });
    } },
  });

  function present(inv) {
    const lines = (Array.isArray(inv.lines) ? inv.lines : JSON.parse(inv.lines || '[]')).map((l) => ({ ...l, amount: usd(l.amountMicros), amountMicros: undefined }));
    const parse = (v) => (v == null ? null : typeof v === 'string' ? JSON.parse(v) : v);
    const taxInvoice = inv.subtotal_micros != null; // invoices issued while tax invoicing was on carry a breakdown, seller and buyer
    return { id: inv.id, number: inv.number, period: inv.period, issuedAt: +inv.issued_at, currency: 'USD', lines, total: usd(inv.total_micros), taxInvoice,
      subtotal: taxInvoice ? usd(Number(inv.subtotal_micros)) : usd(inv.total_micros), tax: usd(Number(inv.tax_micros || 0)), taxRate: Number(inv.tax_rate_bp || 0) / 100, taxLabel: inv.tax_label || null,
      seller: parse(inv.seller), buyer: parse(inv.buyer), pricesIncludeTax: taxInvoice,
      taxNote: taxInvoice ? (inv.tax_note || null) : 'No tax breakdown: this invoice was issued before tax invoicing was enabled.' };
  }
  return routes;
}
