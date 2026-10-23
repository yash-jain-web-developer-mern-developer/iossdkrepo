// MobiAd dashboard. All user-controlled data is rendered with textContent (never innerHTML) to prevent XSS.
// One-time tokens (email verification, password reset) arrive in the URL FRAGMENT so they are never sent to any server.
import { h, icon, toast, emptyState, skeleton, lineChart, sparkline } from './ui.js';
const root = document.getElementById('root'), nav = document.getElementById('topnav');
const store = {
  get token() { try { return sessionStorage.getItem('t'); } catch { return null; } },
  set(t) { try { sessionStorage.setItem('t', t); } catch { /* storage blocked: session lasts until reload */ } },
  clear() { try { sessionStorage.clear(); } catch { /* ignore */ } },
};
const state = { me: null, tab: null, adminTab: null, newCampaign: false, newApp: false, campQ: '', campF: 'all', invoice: null, openCampaign: null };
const resetSession = () => { store.clear(); state.me = null; state.tab = null; state.adminTab = null; state.newCampaign = false; state.newApp = false; };
const CATEGORIES = ['general', 'games', 'shopping', 'travel', 'education', 'entertainment', 'utilities', 'health', 'finance', 'gambling', 'adult', 'alcohol', 'tobacco', 'crypto', 'political'];

async function call(path, method = 'GET', body, { raw = false } = {}) {
  const r = await fetch(path, { method, headers: { 'content-type': 'application/json', ...(store.token && { authorization: 'Bearer ' + store.token }) }, body: body && JSON.stringify(body) });
  if (raw) { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Request failed (' + r.status + ')'); return r; }
  const data = r.status === 204 ? null : await r.json().catch(() => ({}));
  if (r.status === 401 && store.token && data?.error === 'unauthenticated') { resetSession(); render(); }
  if (!r.ok) { const e = new Error(data?.reasons?.length ? data.reasons.join('; ') : data?.detail || data?.error || 'Request failed (' + r.status + ')'); e.code = data?.error; e.data = data; throw e; }
  return data;
}
const money = (n) => '$' + Number(n || 0).toFixed(Math.abs(n) < 1 && n !== 0 ? 4 : 2);
const pct = (n) => (n * 100).toFixed(2) + '%';
const field = (label, input, hint) => h('div', { class: 'f' }, h('label', {}, label), input, hint != null ? h('small', {}, hint) : null);
const msgBox = () => h('p', { class: 'msg', role: 'status' });
const say = (box, text, ok = false) => { box.className = 'msg ' + (ok ? 'ok' : 'err'); box.textContent = text; };
const tbl = (head, rows) => h('table', {}, h('thead', {}, h('tr', {}, head.map((x) => h('th', {}, x)))), h('tbody', {}, rows));
const tag = (text, kind = '') => h('span', { class: 'tag ' + kind }, text);

async function download(path, filename) {
  const r = await call(path, 'GET', undefined, { raw: true });
  const url = URL.createObjectURL(await r.blob());
  const a = h('a', { href: url, download: filename }); document.body.append(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------- signed-out views
function authView() {
  let mode = 'login', needCode = false;
  const msg = msgBox();
  const email = h('input', { type: 'email', required: true, autocomplete: 'email' });
  const pw = h('input', { type: 'password', required: true, autocomplete: 'current-password', minlength: 10 });
  const code = h('input', { inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: '123456 or recovery code' });
  const role = h('select', {}, h('option', { value: 'advertiser' }, 'Advertiser'), h('option', { value: 'publisher' }, 'Publisher'));
  const title = h('h2', {}), submit = h('button', { class: 'btn' }), toggle = h('button', { type: 'button', class: 'link' }), forgot = h('button', { type: 'button', class: 'link' }, 'Forgot password?');
  const terms = h('input', { type: 'checkbox' }), termsBox = h('label', { class: 'chk' }, terms, ' I accept the ', h('a', { href: '/terms', target: '_blank', rel: 'noopener' }, 'Terms of Service'), ' and ', h('a', { href: '/privacy', target: '_blank', rel: 'noopener' }, 'Privacy Policy'));
  const invite = h('input', { placeholder: 'MA-XXXX-XXXX-XXXX', autocomplete: 'off', spellcheck: 'false' });
  const inviteBox = field('Invite code', invite, 'Sign-up is by invitation during the private beta.'); let inviteOnly = false;
  const pwBox = field('Password', pw, ''), roleBox = field('I am a', role), codeBox = field('Authentication code', code, 'From your authenticator app, or a one-time recovery code.');
  const sync = () => {
    title.textContent = mode === 'login' ? 'Log in' : mode === 'signup' ? 'Create account' : 'Reset your password';
    submit.textContent = mode === 'login' ? 'Log in' : mode === 'signup' ? 'Create account' : 'Send reset link';
    inviteBox.hidden = !(mode === 'signup' && inviteOnly); invite.required = !inviteBox.hidden;
    roleBox.hidden = mode !== 'signup'; termsBox.hidden = mode !== 'signup'; terms.required = mode === 'signup'; pwBox.hidden = mode === 'forgot'; pw.required = mode !== 'forgot'; codeBox.hidden = !(mode === 'login' && needCode);
    toggle.textContent = mode === 'signup' ? 'Have an account? Log in' : mode === 'forgot' ? 'Back to log in' : 'Need an account? Sign up';
    forgot.hidden = mode !== 'login';
    pwBox.querySelector('small').textContent = mode === 'signup' ? 'At least 10 characters; avoid common passwords.' : '';
    pw.autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
  };
  toggle.addEventListener('click', () => { mode = mode === 'login' ? 'signup' : 'login'; needCode = false; msg.textContent = ''; sync(); });
  forgot.addEventListener('click', () => { mode = 'forgot'; msg.textContent = ''; sync(); });
  const form = h('form', { class: 'card auth', onsubmit: async (e) => {
    e.preventDefault(); msg.textContent = '';
    try {
      if (mode === 'forgot') { await call('/api/forgot-password', 'POST', { email: email.value }); say(msg, 'If that email has an account, a reset link is on its way.', true); return; }
      const d = await call('/api/' + mode, 'POST', { email: email.value, password: pw.value, role: role.value, ...(mode === 'signup' ? { acceptTerms: terms.checked, ...(inviteOnly ? { inviteCode: invite.value } : {}) } : {}), ...(needCode ? { code: code.value } : {}) });
      store.set(d.token); state.me = null; state.tab = null; state.adminTab = null; location.hash = ''; render();
    } catch (err) {
      if (err.code === 'mfa_required') { needCode = true; sync(); say(msg, 'Enter the code from your authenticator app.'); code.focus(); return; }
      say(msg, err.code === 'invalid_code' ? 'That code is not valid.' : err.message);
    }
  } }, title, field('Email', email), pwBox, roleBox, inviteBox, termsBox, codeBox, submit, msg, toggle, forgot);
  sync();
  call('/api/public-config').then((c) => { inviteOnly = !!c.inviteOnly; const h2 = new URLSearchParams(location.hash.slice(1)); if (h2.get('signup')) { invite.value = h2.get('signup'); if (['advertiser', 'publisher'].includes(h2.get('role'))) role.value = h2.get('role'); mode = 'signup'; } sync(); }).catch(() => {});
  return form;
}

function resetView(token) {
  const msg = msgBox(), pw = h('input', { type: 'password', required: true, minlength: 10, autocomplete: 'new-password' }), code = h('input', { inputmode: 'numeric', placeholder: 'Only if you use 2-step login' });
  return h('form', { class: 'card auth', onsubmit: async (e) => {
    e.preventDefault();
    try { await call('/api/reset-password', 'POST', { token, password: pw.value, ...(code.value ? { code: code.value } : {}) }); location.hash = ''; say(msg, 'Password changed. You can log in now.', true); setTimeout(render, 1200); }
    catch (err) { say(msg, err.code === 'mfa_required' ? 'Enter your authentication code too.' : err.message); }
  } }, h('h2', {}, 'Choose a new password'), field('New password', pw, 'At least 10 characters.'), field('Authentication code', code), h('button', { class: 'btn' }, 'Change password'), msg);
}

async function verifyView(token) {
  const box = h('div', { class: 'card auth' }, h('h2', {}, 'Verifying your email…'));
  call('/api/verify-email', 'POST', { token }).then(() => { box.replaceChildren(h('h2', {}, 'Email verified'), h('p', {}, 'Thank you. You can now create campaigns and apps.'), h('a', { class: 'btn', href: '/app', onclick: () => { location.hash = ''; } }, 'Continue')); })
    .catch((e) => { box.replaceChildren(h('h2', {}, 'Link not valid'), h('p', { class: 'err' }, e.message), h('p', {}, 'Verification links work once and expire after 24 hours. If you already verified your email, just log in. Otherwise log in and use “Resend email”.'), h('a', { class: 'btn', href: '/app', onclick: () => { location.hash = ''; } }, 'Go to login')); });
  return box;
}

// ---------------------------------------------------------------- shared pieces
function kpis(items) {
  return h('div', { class: 'kpis' }, items.map(([l, v, extra]) => h('div', { class: 'kpi' + (extra?.accent ? ' accent' : '') }, h('b', {}, v), h('span', {}, l), extra?.spark ? sparkline(extra.spark, extra.accent ? '#fff' : '#5b3df5') : null)));
}
// The last n calendar days (UTC, ending today), with zeros for days that had no traffic, so charts always show a continuous timeline.
const lastDays = (rep, n = 14) => {
  const zero = { impressions: 0, clicks: 0, invalidClicks: 0, conversions: 0, spend: 0, publisherRevenue: 0 }, out = [], now = Date.now();
  for (let k = n - 1; k >= 0; k--) { const d = new Date(now - k * 86_400_000).toISOString().slice(0, 10); out.push([d, rep.daily[d] || zero]); }
  return out;
};
function reportChart(rep, role) {
  const adv = role === 'advertiser', days = lastDays(rep);
  const series = [{ name: 'Impressions', color: '#5b3df5', values: days.map(([, v]) => v.impressions) }, { name: 'Clicks', color: '#00c2b8', values: days.map(([, v]) => v.clicks) },
    { name: adv ? 'Spend' : 'Earnings', color: '#ff7a59', values: days.map(([, v]) => (adv ? v.spend : v.publisherRevenue)), fmt: money }];
  if (adv && days.some(([, v]) => v.conversions)) series.push({ name: 'Conversions', color: '#ff4fa3', values: days.map(([, v]) => v.conversions || 0) });
  return lineChart({ labels: days.map(([d]) => d), series });
}
function reportCard(rep, role) {
  const t = rep.total, adv = role === 'advertiser';
  const rows = Object.entries(rep.daily).reverse();
  return h('div', {},
    kpis([['Impressions', t.impressions.toLocaleString()], ['Clicks', t.clicks.toLocaleString()], ['CTR', pct(t.ctr)], ['Invalid clicks', t.invalidClicks.toLocaleString()],
      ...(t.videoCompletes ? [['Video completes', t.videoCompletes.toLocaleString()]] : []), ...(t.viewables ? [['Viewability', pct(t.viewability)]] : []), ...(adv && t.conversions ? [['Conversions', t.conversions.toLocaleString()], ['Conversion value', money(t.conversionValue)]] : []),
      [adv ? 'Spend' : 'Earnings', money(adv ? t.spend : t.publisherRevenue), { accent: true }]]),
    h('div', { class: 'card' }, h('div', { class: 'bar' }, h('h3', {}, 'Daily performance'), h('button', { class: 'btn small ghost', type: 'button', onclick: () => download('/api/report.csv', 'mobiad-report.csv').catch((e) => toast(e.message, 'err')) }, icon('download', 16), 'Download CSV')),
      rows.length ? h('div', {}, reportChart(rep, role), h('div', { class: 'tbl-wrap' }, tbl(['Date', 'Impr.', 'Clicks', 'CTR', 'Viewable', 'Invalid', adv ? 'Spend' : 'Earnings'], rows.map(([d, v]) => h('tr', {}, h('td', {}, d), h('td', { class: 'num' }, v.impressions.toLocaleString()), h('td', { class: 'num' }, v.clicks.toLocaleString()), h('td', { class: 'num' }, pct(v.ctr)), h('td', { class: 'num' }, v.viewables ? pct(v.viewability) : '—'), h('td', { class: 'num' }, v.invalidClicks.toLocaleString()), h('td', { class: 'num' }, money(adv ? v.spend : v.publisherRevenue)))))))
        : emptyState('No activity yet', adv ? 'Launch a campaign and your results will appear here.' : 'Integrate the SDK in an app and your traffic will appear here.')));
}
function statementButton() {
  const month = h('input', { type: 'month', value: new Date().toISOString().slice(0, 7), 'aria-label': 'Statement month' });
  return h('div', { class: 'row inline' }, field('Monthly statement', month), h('button', { class: 'btn small ghost', type: 'button', onclick: () => download('/api/billing/statement?month=' + month.value, `mobiad-statement-${month.value}.csv`).catch((e) => toast(e.message, 'err')) }, icon('download', 16), 'Download CSV'));
}
function verifyBanner() {
  if (!state.me || state.me.emailVerified || state.me.role === 'admin') return null;
  return h('div', { class: 'banner', role: 'alert' }, h('b', {}, 'Verify your email.'), 'We sent a link to ' + state.me.email + '. You cannot create campaigns, apps or add funds until you do.',
    h('button', { class: 'link', type: 'button', onclick: async () => { try { await call('/api/resend-verification', 'POST', {}); toast('Verification email sent.'); } catch (e) { toast(e.message, 'err'); } } }, 'Resend email'));
}
const pageHead = (title, sub, ...actions) => h('div', { class: 'page-head' }, h('div', {}, h('h2', {}, title), sub ? h('p', {}, sub) : null), h('div', { class: 'row inline' }, actions));
const reviewTag = (c) => tag(c.reviewStatus, c.reviewStatus === 'approved' ? 'ok' : c.reviewStatus === 'rejected' ? 'bad' : 'warn');
const checklist = (items) => h('ul', { class: 'checklist' }, items.map(([done, text, action]) => h('li', { class: done ? 'done' : '' }, h('span', { class: 'ck' }, icon('check', 14)), h('span', {}, text), done ? null : action)));

// ---------------------------------------------------------------- security tab (all roles)
async function securityView() {
  const wrap = h('div', {});
  const draw = () => {
    const mfa = state.me.mfaEnabled;
    const msgMfa = msgBox(), msgPw = msgBox();
    const mfaBox = h('div', { class: 'card' }, h('h3', {}, 'Two-step login'), h('p', {}, mfa ? 'Enabled. You will be asked for a code from your authenticator app each time you log in.' : 'Protect your account with a code from an authenticator app (Google Authenticator, 1Password, Authy…).'));
    if (!mfa) {
      const pwd = h('input', { type: 'password', autocomplete: 'current-password' });
      const out = h('div', {});
      mfaBox.append(field('Confirm your password', pwd), h('button', { class: 'btn', type: 'button', onclick: async () => {
        try {
          const s = await call('/api/mfa/setup', 'POST', { password: pwd.value });
          const codeIn = h('input', { inputmode: 'numeric', placeholder: '6-digit code' });
          out.replaceChildren(h('p', {}, 'Add this key to your authenticator app, then enter the 6-digit code it shows:'), h('pre', {}, s.secret), h('p', {}, h('a', { href: s.otpauthUrl }, 'Open in authenticator app')),
            field('Code', codeIn), h('button', { class: 'btn', type: 'button', onclick: async () => {
              try {
                const r = await call('/api/mfa/enable', 'POST', { code: codeIn.value }); store.set(r.token); state.me.mfaEnabled = true;
                out.replaceChildren(h('h4', {}, 'Save your recovery codes'), h('p', {}, 'Each code works once if you lose your phone. They are shown only now.'), h('pre', {}, r.recoveryCodes.join('\n')), h('button', { class: 'btn', type: 'button', onclick: draw }, 'I saved them'));
              } catch (e) { say(msgMfa, e.message); }
            } }, 'Enable'));
        } catch (e) { say(msgMfa, e.message); }
      } }, 'Set up'), out);
    } else {
      const pwd = h('input', { type: 'password', autocomplete: 'current-password' }), code = h('input', { placeholder: 'Authenticator or recovery code' });
      mfaBox.append(field('Password', pwd), field('Code', code), h('button', { class: 'btn ghost', type: 'button', onclick: async () => {
        try { const r = await call('/api/mfa/disable', 'POST', { password: pwd.value, code: code.value }); store.set(r.token); state.me.mfaEnabled = false; draw(); } catch (e) { say(msgMfa, e.message); }
      } }, 'Turn off'));
    }
    mfaBox.append(msgMfa);
    const cur = h('input', { type: 'password', autocomplete: 'current-password' }), nw = h('input', { type: 'password', autocomplete: 'new-password', minlength: 10 });
    const pwBox = h('form', { class: 'card', onsubmit: async (e) => { e.preventDefault(); try { const r = await call('/api/change-password', 'POST', { currentPassword: cur.value, newPassword: nw.value }); store.set(r.token); cur.value = nw.value = ''; say(msgPw, 'Password changed. Other devices were signed out.', true); } catch (er) { say(msgPw, er.message); } } },
      h('h3', {}, 'Change password'), field('Current password', cur), field('New password', nw, 'At least 10 characters.'), h('button', { class: 'btn' }, 'Change password'), msgPw);
    const privacy = h('div', { class: 'card' }, h('h3', {}, 'Sessions and your data'),
      h('div', { class: 'row inline' },
        h('button', { class: 'btn ghost', type: 'button', onclick: async () => { await call('/api/logout-all', 'POST', {}); resetSession(); render(); } }, 'Sign out everywhere'),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => download('/api/account/export', 'mobiad-account-export.json').catch((e) => toast(e.message, 'err')) }, 'Export my data'),
        h('button', { class: 'btn danger', type: 'button', onclick: deleteAccount }, 'Delete my account')));
    wrap.replaceChildren(mfaBox, pwBox, privacy);
  };
  draw();
  return wrap;
}
async function deleteAccount() {
  if (!confirm('Permanently delete your account, campaigns and apps? Billing records are retained as required by law. This cannot be undone.')) return;
  const password = prompt('Enter your password to confirm deletion:'); if (!password) return;
  const code = state.me.mfaEnabled ? prompt('Enter your authentication code:') : undefined;
  try { await call('/api/account', 'DELETE', { password, confirm: 'DELETE', code }); resetSession(); render(); alert('Your account has been deleted.'); } catch (e) { toast(e.message, 'err'); }
}

// ---------------------------------------------------------------- more features: breakdowns, invoices, creatives, placements, rewards, webhooks, partners
const WEBHOOK_LABELS = { 'campaign.approved': 'Campaign approved', 'campaign.rejected': 'Campaign rejected', 'campaign.exhausted': 'Campaign budget spent', 'payout.approved': 'Payout approved', 'payout.paid': 'Payout paid', 'payout.rejected': 'Payout rejected', 'wallet.credited': 'Wallet credited', 'payment.failed': 'Payment failed', 'payment.refunded': 'Payment refunded', 'payment.disputed': 'Payment disputed', 'payment.dispute_closed': 'Dispute decided', 'verification.reviewed': 'KYC/tax reviewed' };

function breakdownCard(role) {
  const dims = role === 'advertiser' ? [['campaign', 'Campaign'], ['creative', 'Creative'], ['app', 'App'], ['country', 'Country'], ['format', 'Format']] : [['app', 'App'], ['placement', 'Placement'], ['country', 'Country'], ['format', 'Format']];
  const adv = role === 'advertiser', body = h('div', {}), sel = h('select', { 'aria-label': 'Break down by' }, dims.map(([v, l]) => h('option', { value: v }, l)));
  const load = async () => {
    body.replaceChildren(skeleton(1));
    try {
      const rows = await call('/api/report/breakdown?by=' + sel.value);
      body.replaceChildren(rows.length ? h('div', { class: 'tbl-wrap' }, tbl([dims.find(([v]) => v === sel.value)[1], 'Impr.', 'Clicks', 'CTR', 'Viewable', ...(adv ? ['Conv.'] : []), adv ? 'Spend' : 'Earnings'], rows.map((r) => h('tr', {}, h('td', {}, r.name || r.key), h('td', { class: 'num' }, r.impressions.toLocaleString()), h('td', { class: 'num' }, r.clicks.toLocaleString()), h('td', { class: 'num' }, pct(r.ctr)), h('td', { class: 'num' }, r.viewables ? pct(r.viewability) : '—'), ...(adv ? [h('td', { class: 'num' }, (r.conversions || 0).toLocaleString())] : []), h('td', { class: 'num' }, money(adv ? r.spend : r.publisherRevenue)))))) : emptyState('No data yet', 'Breakdowns appear after your first traffic.'));
    } catch (e) { body.replaceChildren(h('p', { class: 'err' }, e.message)); }
  };
  sel.addEventListener('change', load); load();
  return h('div', { class: 'card' }, h('div', { class: 'bar' }, h('h3', {}, 'Breakdown'), h('div', { class: 'f' }, sel)), body);
}

function invoicesCard(bal) {
  const wrap = h('div', { class: 'card' }), msg = msgBox();
  const months = Array.from({ length: 12 }, (_, k) => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1 - k); return d.toISOString().slice(0, 7); });
  const month = h('select', { 'aria-label': 'Invoice month' }, months.map((m) => h('option', { value: m }, m)));
  const draw = async () => {
    const [inv, notes] = await Promise.all([call('/api/billing/invoices'), call('/api/billing/credit-notes')]);
    wrap.replaceChildren(h('h3', {}, 'Invoices and credit notes'), h('p', { class: 'sub' }, 'Invoices are issued for completed months. Amounts are net of tax; tax invoices are not provided.'),
      h('div', { class: 'row inline' }, field('Month', month), h('button', { class: 'btn', type: 'button', onclick: async () => { try { const r = await call('/api/billing/invoices/generate', 'POST', { month: month.value }); toast('Invoice ' + r.number + ' ready.'); draw(); } catch (e) { say(msg, e.message); } } }, 'Generate invoice')), msg,
      inv.length ? h('div', { class: 'tbl-wrap' }, tbl(['Number', 'Period', 'Total', ''], inv.map((i) => h('tr', {}, h('td', {}, i.number), h('td', {}, i.period), h('td', { class: 'num' }, money(i.total)),
        h('td', {}, h('button', { class: 'link', type: 'button', onclick: async () => { state.invoice = await call('/api/billing/invoice?id=' + i.id); render(); } }, 'View / print'), h('button', { class: 'link', type: 'button', onclick: () => download('/api/billing/invoice?format=csv&id=' + i.id, i.number + '.csv').catch((e) => toast(e.message, 'err')) }, 'CSV')))))) : h('p', { class: 'sub' }, 'No invoices yet.'),
      notes.length ? h('div', {}, h('h4', {}, 'Credit notes'), h('div', { class: 'tbl-wrap' }, tbl(['Number', 'Date', 'Amount', 'Reason'], notes.map((n) => h('tr', {}, h('td', {}, n.number), h('td', {}, new Date(n.issuedAt).toLocaleDateString()), h('td', { class: 'num' }, money(n.amount)), h('td', {}, n.reason)))))) : '');
  };
  draw();
  return wrap;
}
const KIND_LABELS = { topup: 'Top-up', refund: 'Refund', dispute_hold: 'Dispute: amount held', dispute_release: 'Dispute: released', dispute_fee: 'Dispute fee', adjustment: 'Adjustment' };
const PAY_KIND = (s) => (s === 'paid' ? 'ok' : ['failed', 'disputed', 'dispute_lost'].includes(s) ? 'bad' : ['pending', 'expired', 'partially_refunded'].includes(s) ? 'warn' : '');
const party = (title, p) => h('div', {}, h('b', {}, title), p ? h('div', { class: 'sub' }, [p.name || p.legalName, p.address, p.country, p.taxId ? 'Tax ID ' + p.taxId : null].filter(Boolean).join(' · ')) : h('div', { class: 'sub' }, '—'));
function invoiceView(inv) {
  const tax = inv.taxInvoice;
  return h('div', {}, pageHead((tax ? 'Tax invoice ' : 'Invoice ') + inv.number, 'Period ' + inv.period, h('button', { class: 'btn', type: 'button', onclick: () => window.print() }, 'Print / save as PDF'), h('button', { class: 'btn ghost', type: 'button', onclick: () => { state.invoice = null; render(); } }, 'Back')),
    h('div', { class: 'card invoice' }, h('div', { class: 'bar' }, h('h3', {}, tax ? 'Tax invoice' : 'MobiAd'), h('div', {}, h('b', {}, inv.number), h('span', { class: 'sub' }, 'Issued ' + new Date(inv.issuedAt).toLocaleDateString() + ' · ' + inv.currency))),
      tax ? h('div', { class: 'row' }, party('From', inv.seller), party('Billed to', inv.buyer)) : null,
      h('div', { class: 'tbl-wrap' }, tbl(['Description', 'Impressions', 'Clicks', 'Conversions', tax ? 'Amount (incl. tax)' : 'Amount'], inv.lines.map((l) => h('tr', {}, h('td', {}, l.description), h('td', { class: 'num' }, l.impressions.toLocaleString()), h('td', { class: 'num' }, l.clicks.toLocaleString()), h('td', { class: 'num' }, (l.conversions || 0).toLocaleString()), h('td', { class: 'num' }, money(l.amount)))))),
      tax ? h('div', { class: 'invoice-sums' }, h('p', {}, 'Net amount ', h('b', {}, money(inv.subtotal))), h('p', {}, (inv.taxLabel || 'Tax') + ' ' + inv.taxRate + '% (included in the amounts above) ', h('b', {}, money(inv.tax)))) : null,
      h('p', { class: 'invoice-total' }, tax ? 'Total paid ' : 'Total ', h('b', {}, money(inv.total))), inv.taxNote ? h('p', { class: 'sub' }, inv.taxNote) : null));
}

// Advertiser: the details printed on tax invoices. Saved per account; invoices keep a frozen copy at issue time.
function billingCard() {
  const wrap = h('div', { class: 'card' }), msg = msgBox();
  (async () => {
    const p = await call('/api/billing/profile');
    const f = { legalName: h('input', { value: p.legalName, maxlength: 120, 'aria-label': 'Legal name' }), address: h('input', { value: p.address, maxlength: 300, placeholder: 'Street, city, postcode', 'aria-label': 'Address' }), country: h('input', { value: p.country, maxlength: 2, placeholder: 'GB', 'aria-label': 'Country' }), taxId: h('input', { value: p.taxId, maxlength: 40, placeholder: 'optional', 'aria-label': 'Tax ID' }) };
    wrap.replaceChildren(h('h3', {}, 'Billing details'), h('p', { class: 'sub' }, p.taxMode === 'none' ? 'Optional: shown on your invoices.' : 'Needed before an invoice can be issued: your legal name, address and country appear on every tax invoice, and decide the ' + p.taxLabel + ' rate applied.'),
      h('div', { class: 'row' }, field('Legal name', f.legalName), field('Address', f.address), field('Country (2 letters)', f.country), field('Tax / VAT ID', f.taxId)),
      h('p', {}, h('button', { class: 'btn', type: 'button', onclick: async () => { try { await call('/api/billing/profile', 'POST', { legalName: f.legalName.value, address: f.address.value, country: f.country.value, taxId: f.taxId.value }); say(msg, 'Saved.', true); } catch (e) { say(msg, e.message); } } }, 'Save billing details'), msg));
  })();
  return wrap;
}
// Advertiser: payment attempts with their outcome (paid, failed with the reason, expired, refunded, disputed).
function paymentsCard() {
  const wrap = h('div', { class: 'card', hidden: true });
  (async () => {
    const list = await call('/api/billing/payments');
    if (!list.length) return;
    wrap.hidden = false;
    wrap.replaceChildren(h('h3', {}, 'Payments'), h('div', { class: 'tbl-wrap' }, tbl(['Date', 'Amount', 'Status', 'Details'], list.map((p) => h('tr', {}, h('td', {}, new Date(p.createdAt).toLocaleString()), h('td', { class: 'num' }, money(p.amount)), h('td', {}, tag(p.status.replace('_', ' '), PAY_KIND(p.status))), h('td', {}, [p.failure, p.refunded ? 'refunded ' + money(p.refunded) : ''].filter(Boolean).join(' · ')))))));
  })().catch(() => {});
  return wrap;
}

// Per-campaign creatives: list, and add another one (rotation / A-B test). Adding sends the campaign back through review.
async function creativePanel(c) {
  const msg = msgBox(), t = h('input', { placeholder: 'Headline', maxlength: 120 }), img = h('input', { type: 'url', placeholder: 'Image URL (optional)' }), cta = h('input', { placeholder: 'Button text', maxlength: 30 }), url = h('input', { type: 'url', placeholder: 'Landing URL (optional, defaults to the campaign’s)' });
  const list = (c.creatives && c.creatives.length ? c.creatives : [c.creative]);
  return h('div', { class: 'card' }, h('div', { class: 'bar' }, h('h3', {}, 'Creatives: ' + c.name), h('button', { class: 'link', type: 'button', onclick: () => { state.openCampaign = null; render(); } }, 'Close')),
    h('p', { class: 'sub' }, 'Up to 5 creatives rotate automatically; better performers get more traffic. Adding one sends the campaign back to review.'),
    h('div', { class: 'tbl-wrap' }, tbl(['Headline', 'Image', 'Button', 'Landing'], list.map((x) => h('tr', {}, h('td', {}, x.title), h('td', {}, x.image ? h('code', {}, x.image.slice(0, 40)) : '—'), h('td', {}, x.cta || '—'), h('td', {}, h('code', {}, (x.clickUrl || '').slice(0, 40))))))),
    list.length < 5 ? h('div', {}, h('h4', {}, 'Add a creative'), h('div', { class: 'row' }, field('Headline', t), field('Image URL', img), field('Button text', cta), field('Landing URL', url)),
      h('p', {}, h('button', { class: 'btn', type: 'button', onclick: async () => { try { const r = await call('/api/campaigns/creative', 'POST', { campaignId: c.id, creative: { title: t.value || undefined, image: img.value || undefined, cta: cta.value || undefined, clickUrl: url.value || undefined } }); toast('Creative added' + (r.reviewStatus === 'pending' ? '; the campaign is back in review.' : '.')); state.openCampaign = null; render(); } catch (e) { say(msg, e.message); } } }, 'Add creative'), msg)) : h('p', { class: 'sub' }, 'This campaign has the maximum number of creatives.'));
}

// Publisher: placements, rewarded video, ads.txt and a test-ad probe for one app.
async function appTools(a) {
  const pMsg = msgBox(), rMsg = msgBox(), out = h('pre', { hidden: true });
  const pName = h('input', { placeholder: 'Level complete', maxlength: 80 }), pFormat = h('select', {}, ['banner', 'interstitial', 'native', 'video', 'playable', 'rewarded'].map((f) => h('option', { value: f }, f))), pFloor = h('input', { type: 'number', min: '0', step: '0.01', value: '0' });
  const rUrl = h('input', { type: 'url', placeholder: 'https://your-server.example/mobiad-reward', value: a.rewardCallbackUrl || '' }), rAmt = h('input', { type: 'number', min: '1', value: String(a.rewardAmount || 1) }), rItem = h('input', { value: a.rewardItem || 'reward', maxlength: 40 });
  const secretBox = h('div', {});
  return h('div', { class: 'tools' },
    h('h4', {}, 'Test your integration'), h('p', { class: 'sub' }, 'Sends a test-mode request: you get a canned ad; nothing is auctioned, billed or recorded.'),
    h('div', { class: 'row inline' }, h('button', { class: 'btn small ghost', type: 'button', onclick: async () => { try { const r = await fetch('/v1/ad', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ appId: a.id, format: 'banner', test: true }) }); out.hidden = false; out.textContent = r.status + ' ' + JSON.stringify(await r.json(), null, 2); } catch (e) { out.hidden = false; out.textContent = e.message; } } }, 'Send test ad request')), out,
    h('h4', {}, 'Add a placement'), h('div', { class: 'row inline' }, field('Name', pName), field('Format', pFormat), field('Floor eCPM ($)', pFloor), h('button', { class: 'btn small', type: 'button', onclick: async () => { try { const p = await call('/api/placements', 'POST', { appId: a.id, name: pName.value, format: pFormat.value, floorEcpm: +pFloor.value || 0 }); toast('Placement ' + p.id + ' created.'); render(); } catch (e) { say(pMsg, e.message); } } }, 'Add')), pMsg,
    h('h4', {}, 'Rewarded video'), h('p', { class: 'sub' }, 'After a verified full playback MobiAd calls your server (signed). Grant the reward only when that callback arrives.'),
    h('div', { class: 'row' }, field('Callback URL (https)', rUrl), field('Reward amount', rAmt), field('Reward item', rItem)),
    h('p', {}, h('button', { class: 'btn small', type: 'button', onclick: async () => { try { const r = await call('/api/apps/reward', 'POST', { id: a.id, callbackUrl: rUrl.value, amount: +rAmt.value, item: rItem.value }); say(rMsg, 'Saved.', true); if (r.secret) secretBox.replaceChildren(h('h4', {}, 'Signing secret (shown once)'), h('pre', {}, r.secret), h('p', { class: 'sub' }, r.note)); } catch (e) { say(rMsg, e.message); } } }, 'Save rewarded settings'),
      ' ', a.hasRewardSecret ? h('button', { class: 'link', type: 'button', onclick: async () => { try { const r = await call('/api/apps/reward', 'POST', { id: a.id, callbackUrl: rUrl.value, amount: +rAmt.value, item: rItem.value, rotateSecret: true }); secretBox.replaceChildren(h('h4', {}, 'New signing secret (shown once)'), h('pre', {}, r.secret)); } catch (e) { say(rMsg, e.message); } } }, 'Rotate secret') : null), rMsg, secretBox);
}
async function adsTxtCard() {
  let r; try { r = await call('/api/ads-txt'); } catch { return null; }
  return h('div', { class: 'card' }, h('h3', {}, 'app-ads.txt'), h('p', { class: 'sub' }, r.note), h('pre', {}, h('code', {}, r.text)), h('button', { class: 'btn small ghost', type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(r.text); toast('Copied.'); } catch { toast('Copy failed.', 'err'); } } }, 'Copy'));
}

// Webhooks management (inside the Developers page)
async function webhooksCard() {
  const [hooks, events] = await Promise.all([call('/api/webhooks'), call('/api/webhooks/events')]);
  const msg = msgBox(), url = h('input', { type: 'url', placeholder: 'https://your-server.example/webhooks/mobiad' }), shown = h('div', {});
  const boxes = events.map((e) => ({ e, box: h('input', { type: 'checkbox', checked: true }) }));
  return h('div', { class: 'card' }, h('h3', {}, 'Webhooks'), h('p', { class: 'sub' }, 'We POST signed JSON events to your server (at-least-once; retried for up to ~15 hours). Verify X-MobiAd-Signature, and de-duplicate on the event id.'),
    hooks.length ? h('div', { class: 'tbl-wrap' }, tbl(['URL', 'Events', 'Status', ''], hooks.map((k) => h('tr', {}, h('td', {}, h('code', {}, k.url)), h('td', {}, k.events.length ? k.events.length + ' selected' : 'all'), h('td', {}, tag(k.status, k.status === 'active' ? 'ok' : 'bad'), k.failures ? h('span', { class: 'sub' }, k.failures + ' recent failures') : null),
      h('td', {}, h('button', { class: 'link', type: 'button', onclick: async () => { try { await call('/api/webhooks/test', 'POST', { id: k.id }); toast('Test event queued.'); } catch (e) { toast(e.message, 'err'); } } }, 'Send test'),
        h('button', { class: 'link', type: 'button', onclick: async () => { const d = await call('/api/webhooks/deliveries?id=' + k.id); shown.replaceChildren(h('h4', {}, 'Recent deliveries'), d.length ? tbl(['Time', 'Event', 'Status', 'Attempts', 'Last error'], d.map((x) => h('tr', {}, h('td', {}, new Date(x.createdAt).toLocaleString()), h('td', {}, x.event), h('td', {}, tag(x.status, x.status === 'delivered' ? 'ok' : x.status === 'failed' ? 'bad' : 'warn')), h('td', { class: 'num' }, x.attempts), h('td', {}, x.lastError || '')))) : h('p', { class: 'sub' }, 'No deliveries yet.')); } }, 'Deliveries'),
        h('button', { class: 'link', type: 'button', onclick: async () => { if (!confirm('Delete this webhook?')) return; await call('/api/webhooks/delete', 'POST', { id: k.id }); render(); } }, 'Delete')))))) : h('p', { class: 'sub' }, 'No webhooks yet.'), shown,
    h('h4', {}, 'Add a webhook'), field('Endpoint URL', url), h('div', { class: 'row' }, boxes.map(({ e, box }) => h('label', { class: 'chk' }, box, ' ' + (WEBHOOK_LABELS[e] || e)))),
    h('p', {}, h('button', { class: 'btn', type: 'button', onclick: async () => { try { const sel = boxes.filter((x) => x.box.checked).map((x) => x.e); const r = await call('/api/webhooks', 'POST', { url: url.value, events: sel.length === events.length ? [] : sel }); shown.replaceChildren(h('h4', {}, 'Signing secret (shown once)'), h('pre', {}, r.secret), h('p', { class: 'sub' }, r.note)); toast('Webhook created.'); url.value = ''; } catch (e) { say(msg, e.message); } } }, 'Create webhook'), msg));
}

// Admin: external demand partners
async function partnersPanel(body) {
  const list = await call('/api/admin/partners'), msg = msgBox();
  const f = { name: h('input', { placeholder: 'Partner name' }), url: h('input', { type: 'url', placeholder: 'https://dsp.example.com/openrtb' }), auth: h('input', { placeholder: 'Authorization header value (optional)' }), timeout: h('input', { type: 'number', min: '50', max: '500', value: '150' }), kids: h('input', { type: 'checkbox' }) };
  const fmts = ['banner', 'interstitial', 'video', 'rewarded'].map((x) => ({ x, box: h('input', { type: 'checkbox', checked: true }) }));
  body.append(h('div', { class: 'card' }, h('h3', {}, 'External demand partners (OpenRTB)'), h('p', { class: 'sub' }, 'Partners bid in the same second-price auction as MobiAd campaigns. Their revenue is booked as publisher earnings; settlement with the partner is outside this system.'),
    list.length ? h('div', { class: 'tbl-wrap' }, tbl(['Name', 'Endpoint', 'Timeout', 'Formats', 'Impr.', 'Gross', 'Status', ''], list.map((p) => h('tr', {}, h('td', {}, p.name, p.childSafe ? h('span', { class: 'sub' }, 'child-safe') : null), h('td', {}, h('code', {}, p.endpointUrl.slice(0, 44))), h('td', { class: 'num' }, p.timeoutMs + ' ms'), h('td', {}, p.formats.length ? p.formats.join(', ') : 'all'), h('td', { class: 'num' }, p.impressions.toLocaleString()), h('td', { class: 'num' }, money(p.grossUsd)), h('td', {}, tag(p.status, p.status === 'active' ? 'ok' : 'warn')),
      h('td', {}, h('button', { class: 'link', type: 'button', onclick: async () => { await call('/api/admin/partners/status', 'POST', { id: p.id, status: p.status === 'active' ? 'paused' : 'active' }); render(); } }, p.status === 'active' ? 'Pause' : 'Activate')))))) : h('p', { class: 'sub' }, 'No partners yet.')));
  body.append(h('div', { class: 'card' }, h('h3', {}, 'Add a partner'), h('div', { class: 'row' }, field('Name', f.name), field('Endpoint URL (https)', f.url), field('Auth header', f.auth), field('Timeout (ms)', f.timeout)),
    h('div', { class: 'row' }, fmts.map(({ x, box }) => h('label', { class: 'chk' }, box, ' ' + x)), h('label', { class: 'chk' }, f.kids, ' Approved for child-directed apps')),
    h('p', {}, h('button', { class: 'btn', type: 'button', onclick: async () => { try { const sel = fmts.filter((y) => y.box.checked).map((y) => y.x); await call('/api/admin/partners', 'POST', { name: f.name.value, endpointUrl: f.url.value, authHeader: f.auth.value || undefined, timeoutMs: +f.timeout.value, formats: sel.length === fmts.length ? [] : sel, childSafe: f.kids.checked }); toast('Partner added.'); render(); } catch (e) { say(msg, e.message); } } }, 'Add partner'), msg)));
}
function creditNoteForm() {
  const uid = h('input', { placeholder: 'advertiser user id (usr_…)' }), amt = h('input', { type: 'number', step: '0.01', min: '0.01' }), reason = h('input', { placeholder: 'Reason (shown on the document)', maxlength: 500 }), inv = h('input', { placeholder: 'Invoice id (optional)' }), msg = msgBox();
  return h('form', { class: 'card', onsubmit: async (e) => { e.preventDefault(); try { const r = await call('/api/admin/credit-notes', 'POST', { userId: uid.value, amountUsd: +amt.value, reason: reason.value, invoiceId: inv.value || undefined }); say(msg, 'Credit note ' + r.number + ' issued; wallet credited.', true); } catch (er) { say(msg, er.message); } } },
    h('h3', {}, 'Issue a credit note'), h('div', { class: 'row' }, field('Advertiser', uid), field('Amount ($)', amt), field('Reason', reason), field('Invoice', inv)), h('button', { class: 'btn' }, 'Issue credit note'), msg);
}

// ---------------------------------------------------------------- advertiser
const FORMAT_LABEL = { banner: 'Banner', interstitial: 'Interstitial', native: 'Native', video: 'Video', playable: 'Playable' };

function campaignWizard(bal) {
  const msg = msgBox();
  const i = {
    name: h('input', { required: true, maxlength: 120, placeholder: 'Spring launch' }), title: h('input', { maxlength: 120, placeholder: 'Headline shown on the ad' }), url: h('input', { type: 'url', required: true, placeholder: 'https://example.com/landing' }),
    image: h('input', { type: 'url', placeholder: 'https://… (optional)' }), cta: h('input', { maxlength: 30, placeholder: 'Install now' }), video: h('input', { type: 'url', placeholder: 'https://… .mp4 / .webm / .m3u8' }), dur: h('input', { type: 'number', min: '1', max: '60', placeholder: 'seconds' }),
    playable: h('input', { type: 'url', placeholder: 'https://… HTML5 bundle' }), bid: h('input', { type: 'number', required: true, step: '0.01', min: '0.01', placeholder: '2.00' }), budget: h('input', { type: 'number', required: true, step: '1', min: '1', placeholder: '500' }),
    daily: h('input', { type: 'number', step: '1', min: '0', placeholder: '0 = no daily limit' }), countries: h('input', { placeholder: 'US,IN (blank = everywhere)' }), cap: h('input', { type: 'number', min: '0', max: '100', placeholder: '0 = no cap' }),
    convEvent: h('input', { maxlength: 32, placeholder: 'purchase' }), window: h('input', { type: 'number', min: '1', max: '30', placeholder: '7' }),
  };
  const format = h('select', {}, Object.entries(FORMAT_LABEL).map(([v, l]) => h('option', { value: v }, l)));
  const model = h('select', {}, h('option', { value: 'CPM' }, 'CPM: pay per 1,000 views'), h('option', { value: 'CPC' }, 'CPC: pay per click'), h('option', { value: 'CPA' }, 'CPA: pay per conversion'));
  const platform = h('select', {}, h('option', { value: '' }, 'All platforms'), h('option', { value: 'android' }, 'Android'), h('option', { value: 'ios' }, 'iOS'));
  const category = h('select', {}, CATEGORIES.map((c) => h('option', { value: c }, c)));
  const childSafe = h('input', { type: 'checkbox' });
  Object.assign(i, { body: h('input', { maxlength: 200, placeholder: 'One sentence about your app' }), icon: h('input', { type: 'url', placeholder: 'https://… icon (optional)' }), sponsor: h('input', { maxlength: 60, placeholder: 'Your brand' }), rating: h('input', { type: 'number', min: '0', max: '5', step: '0.1', placeholder: '4.5' }),
    langs: h('input', { placeholder: 'en,fr (blank = any)' }), minOs: h('input', { type: 'number', min: '0', step: '0.1', placeholder: 'e.g. 14' }), hFrom: h('input', { type: 'number', min: '0', max: '23', placeholder: '0' }), hTo: h('input', { type: 'number', min: '0', max: '23', placeholder: '23' }),
    allow: h('input', { placeholder: 'app ids, comma separated (only these)' }), block: h('input', { placeholder: 'app ids, comma separated (never these)' }) });
  const devTypes = ['phone', 'tablet'].map((d) => ({ d, box: h('input', { type: 'checkbox' }) })), conn = h('select', {}, h('option', { value: '' }, 'Any connection'), h('option', { value: 'wifi' }, 'Wi-Fi only'), h('option', { value: 'cellular' }, 'Cellular only'));
  const extras = []; const extraBox = h('div', {});
  const addExtra = () => {
    if (extras.length >= 4) return;
    const x = { title: h('input', { placeholder: 'Headline', maxlength: 120 }), image: h('input', { type: 'url', placeholder: 'Image URL' }), cta: h('input', { placeholder: 'Button text', maxlength: 30 }) };
    extras.push(x); extraBox.append(h('div', { class: 'row' }, field('Headline (variant ' + (extras.length + 1) + ')', x.title), field('Image URL', x.image), field('Button text', x.cta)));
  };
  const addBtn = h('button', { class: 'btn small ghost', type: 'button', onclick: addExtra }, '+ Add a creative variant (A/B test)');
  const F = { name: field('Campaign name', i.name, 'Only you see this.'), title: field('Headline', i.title), format: field('Format', format), category: field('Category', category, 'Restricted categories need manual review.'),
    url: field('Landing URL', i.url, 'Where people go after tapping.'), image: field('Image URL', i.image), cta: field('Button text', i.cta), video: field('Video URL', i.video, 'https only, up to 60 seconds.'), dur: field('Video length (s)', i.dur),
    playable: field('Playable URL', i.playable, 'Runs third-party code, so it is always manually reviewed.'), body: field('Body text (native)', i.body), icon: field('Icon URL (native)', i.icon), sponsor: field('Sponsor (native)', i.sponsor), rating: field('Rating 0-5 (native)', i.rating), model: field('Pricing', model), bid: field('Bid ($)', i.bid, 'Per 1,000 views, per click or per conversion.'),
    convEvent: field('Conversion event', i.convEvent, 'The event you pay for. Report it from your server.'), window: field('Attribution window (days)', i.window), budget: field('Total budget ($)', i.budget), daily: field('Daily budget ($)', i.daily),
    platform: field('Platform', platform), countries: field('Countries', i.countries), cap: field('Frequency cap per device per day', i.cap) };
  const T = { langs: field('Languages', i.langs, 'ISO codes, e.g. en,fr'), minOs: field('Minimum OS version', i.minOs), conn: field('Connection', conn), hFrom: field('Active from hour (UTC)', i.hFrom), hTo: field('Active until hour (UTC)', i.hTo), allow: field('Only these apps', i.allow), block: field('Never these apps', i.block) };
  const devRow = h('div', { class: 'f' }, h('label', {}, 'Devices'), h('div', { class: 'row inline' }, devTypes.map(({ d, box }) => h('label', { class: 'chk' }, box, ' ' + d)), h('small', {}, 'Leave both unticked for all devices.')));
  const steps = [['Basics', [F.name, F.title, F.format, F.category]], ['Creative', [F.url, F.image, F.cta, F.video, F.dur, F.playable, F.body, F.icon, F.sponsor, F.rating]], ['Budget', [F.model, F.bid, F.convEvent, F.window, F.budget, F.daily, F.cap]], ['Targeting', [F.platform, F.countries, T.langs, devRow, T.conn, T.minOs, T.hFrom, T.hTo, T.allow, T.block]]];
  let step = 0;
  const syncFields = () => {
    const f = format.value, m = model.value;
    for (const k of ['body', 'icon', 'sponsor', 'rating']) F[k].hidden = f !== 'native';
    F.video.hidden = F.dur.hidden = f !== 'video'; F.playable.hidden = f !== 'playable'; F.convEvent.hidden = F.window.hidden = m !== 'CPA';
    i.video.required = f === 'video'; i.dur.required = f === 'video'; i.playable.required = f === 'playable';
    previewMedia(); previewBody();
  };
  const pvMedia = h('div', { class: 'media' }), pvTitle = h('b', {}), pvSub = h('span', {}), pvBtn = h('button', { class: 'btn', type: 'button', tabindex: '-1' });
  const previewMedia = () => {
    pvMedia.replaceChildren();
    if (i.image.value && /^https:\/\//.test(i.image.value)) pvMedia.append(h('img', { src: i.image.value, alt: '', referrerpolicy: 'no-referrer' }));
    else pvMedia.append(icon(format.value === 'video' ? 'play' : 'megaphone', 40));
    pvMedia.append(h('span', { class: 'ptag' }, 'Ad · ' + FORMAT_LABEL[format.value]));
  };
  const previewBody = () => { pvTitle.textContent = i.title.value || i.name.value || 'Your headline'; pvSub.textContent = category.value === 'general' ? 'Sponsored' : 'Sponsored · ' + category.value; pvBtn.textContent = i.cta.value || 'Learn more'; };
  const panels = steps.map(([, fields]) => h('div', { class: 'row' }, fields));
  const pills = h('div', { class: 'steps-nav' });
  const back = h('button', { class: 'btn ghost', type: 'button' }, 'Back'), next = h('button', { class: 'btn', type: 'button' }), cancel = h('button', { class: 'link', type: 'button' }, 'Cancel');
  const draw = () => {
    pills.replaceChildren(...steps.map(([t], n) => h('div', { class: 'step-pill' + (n === step ? ' on' : n < step ? ' done' : '') }, h('i', {}, n < step ? '✓' : String(n + 1)), t)));
    panels.forEach((p, n) => { p.hidden = n !== step; });
    back.hidden = step === 0; next.textContent = step === steps.length - 1 ? 'Submit campaign' : 'Continue';
  };
  const targetingPayload = () => {
    const t = {}; const csv = (el) => el.value.split(',').map((x) => x.trim()).filter(Boolean);
    if (csv(i.langs).length) t.languages = csv(i.langs); const dts = devTypes.filter((x) => x.box.checked).map((x) => x.d); if (dts.length) t.deviceTypes = dts; if (conn.value) t.connections = [conn.value];
    if (+i.minOs.value > 0) t.minOs = +i.minOs.value;
    if (i.hFrom.value !== '' || i.hTo.value !== '') { const a = +(i.hFrom.value || 0), b = +(i.hTo.value || 23); t.hours = []; for (let x = a; x !== (b + 1) % 24 && t.hours.length < 24; x = (x + 1) % 24) t.hours.push(x); }
    if (csv(i.allow).length) t.appAllow = csv(i.allow); if (csv(i.block).length) t.appBlock = csv(i.block);
    return t;
  };
  const submit = async () => {
    msg.textContent = '';
    try {
      const c = await call('/api/campaigns', 'POST', { name: i.name.value, title: i.title.value || undefined, model: model.value, bid: +i.bid.value, budget: +i.budget.value, dailyBudget: +i.daily.value || 0, clickUrl: i.url.value, image: i.image.value || undefined, format: format.value,
        conversionEvent: model.value === 'CPA' ? i.convEvent.value || undefined : undefined, attributionDays: +i.window.value || undefined, videoUrl: format.value === 'video' ? i.video.value || undefined : undefined, durationSec: format.value === 'video' ? +i.dur.value || undefined : undefined,
        playableUrl: format.value === 'playable' ? i.playable.value || undefined : undefined, cta: i.cta.value || undefined, platforms: platform.value ? [platform.value] : [], countries: i.countries.value.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
        category: category.value, childSafe: childSafe.checked, freqCap: +i.cap.value || 0,
        body: format.value === 'native' ? i.body.value || undefined : undefined, iconUrl: format.value === 'native' ? i.icon.value || undefined : undefined, sponsor: format.value === 'native' ? i.sponsor.value || undefined : undefined, rating: format.value === 'native' ? i.rating.value || undefined : undefined,
        ...(extras.some((x) => x.title.value || x.image.value) ? { creatives: [{}, ...extras.filter((x) => x.title.value || x.image.value).map((x) => ({ title: x.title.value || undefined, image: x.image.value || undefined, cta: x.cta.value || undefined }))] } : {}),
        targeting: targetingPayload() });
      toast(c.reviewStatus === 'approved' ? 'Campaign launched.' : 'Submitted. It starts serving once our team approves it' + (c.reviewNote ? ' (' + c.reviewNote + ')' : '') + '.');
      state.newCampaign = false; render();
    } catch (err) { say(msg, err.code === 'insufficient_funds' ? `Not enough funds: you need ${money(err.data.requiredUsd)} but have ${money(err.data.availableUsd)} available. Add funds in Wallet.` : err.message); }
  };
  back.addEventListener('click', () => { step--; draw(); });
  cancel.addEventListener('click', () => { state.newCampaign = false; render(); });
  next.addEventListener('click', () => {
    const invalid = [...panels[step].querySelectorAll('input,select')].find((el) => !el.closest('[hidden]') && !el.checkValidity());
    if (invalid) { invalid.reportValidity(); return; }
    if (step < steps.length - 1) { step++; draw(); } else submit();
  });
  for (const el of [i.title, i.name, i.image, i.cta]) el.addEventListener('input', () => { previewMedia(); previewBody(); });
  for (const el of [format, model, category]) el.addEventListener('change', syncFields);
  panels[0].append(h('label', { class: 'chk' }, childSafe, ' Suitable for child-directed apps'));
  panels[1].append(h('div', {}, h('h4', {}, 'Creative variants'), h('p', { class: 'sub' }, 'Up to 5 creatives rotate automatically; better performers get more traffic.'), extraBox, addBtn));
  syncFields(); draw();
  return h('div', { class: 'wizard' },
    h('form', { class: 'card', novalidate: true, onsubmit: (e) => e.preventDefault() }, h('div', { class: 'bar' }, h('h3', {}, 'New campaign'), cancel), pills, ...panels, msg, h('div', { class: 'step-actions' }, back, next)),
    h('div', { class: 'preview' }, h('h4', {}, 'Live preview'), h('div', { class: 'ad-preview' }, pvMedia, h('div', { class: 'body' }, pvTitle, pvSub, pvBtn)),
      bal ? h('p', { class: 'sub' }, 'Wallet available: ' + money(bal.available) + '. A campaign budget is reserved when you submit.') : null));
}

function campaignsTable(camps, { limit } = {}) {
  const q = state.campQ || '', f = state.campF || 'all';
  let list = camps.filter((c) => (f === 'all' || (f === 'active' ? c.status === 'active' && c.reviewStatus === 'approved' : f === 'review' ? c.reviewStatus !== 'approved' : c.status === f)) && (!q || c.name.toLowerCase().includes(q.toLowerCase())));
  if (limit) list = list.slice(0, limit);
  if (!list.length) return emptyState(camps.length ? 'No campaigns match' : 'No campaigns yet', camps.length ? 'Try a different search or filter.' : 'Create your first campaign to start reaching people.', camps.length ? null : h('button', { class: 'btn', type: 'button', onclick: () => { state.tab = 'campaigns'; state.newCampaign = true; render(); } }, icon('plus', 16), 'New campaign'));
  return h('div', { class: 'tbl-wrap' }, tbl(['Campaign', 'Review', 'Status', 'Pricing', 'Impr.', 'Clicks', 'Conv.', 'Spend', ''], list.map((c) => h('tr', {},
    h('td', { class: 'name-cell' }, h('b', {}, c.name), h('span', { class: 'sub' }, FORMAT_LABEL[c.format] || c.format, c.reviewNote ? ' · ' + c.reviewNote : '')), h('td', {}, reviewTag(c)), h('td', {}, tag(c.status, c.status === 'active' ? 'ok' : 'bad')),
    h('td', {}, c.model + ' ' + money(c.bid)), h('td', { class: 'num' }, c.stats.impressions.toLocaleString()), h('td', { class: 'num' }, c.stats.clicks.toLocaleString()), h('td', { class: 'num' }, (c.stats.conversions || 0).toLocaleString()), h('td', { class: 'num' }, money(c.stats.spend)),
    h('td', {}, h('button', { class: 'link', type: 'button', onclick: () => { state.openCampaign = c.id; render(); } }, 'Creatives'), c.status === 'exhausted' ? '' : h('button', { class: 'link', type: 'button', onclick: async () => { try { await call('/api/campaigns/status', 'POST', { id: c.id, status: c.status === 'active' ? 'paused' : 'active' }); toast(c.status === 'active' ? 'Campaign paused.' : 'Campaign resumed.'); render(); } catch (e) { toast(e.message, 'err'); } } }, c.status === 'active' ? 'Pause' : 'Resume'))))));
}

async function advertiserView(page) {
  const [bal, camps, rep] = await Promise.all([call('/api/billing/summary'), call('/api/campaigns'), call('/api/report')]);
  const t = rep.total, days = lastDays(rep);
  if (page === 'campaigns') {
    if (state.newCampaign) return h('div', {}, pageHead('Create a campaign', 'Three quick steps. You can pause or edit status any time.'), campaignWizard(bal));
    if (state.openCampaign) { const c = camps.find((x) => x.id === state.openCampaign); if (c) return h('div', {}, pageHead('Campaigns', c.name), await creativePanel(c)); state.openCampaign = null; }
    const q = h('input', { type: 'search', placeholder: 'Search campaigns', value: state.campQ || '', 'aria-label': 'Search campaigns' });
    const body = h('div', {}), redraw = () => body.replaceChildren(campaignsTable(camps));
    q.addEventListener('input', () => { state.campQ = q.value; redraw(); });
    const chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Filter by status' }, [['all', 'All'], ['active', 'Live'], ['review', 'In review'], ['paused', 'Paused'], ['exhausted', 'Budget spent']].map(([k, l]) => h('button', { class: 'chip', type: 'button', 'aria-pressed': String((state.campF || 'all') === k), onclick: (e) => { state.campF = k; chips.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', 'false')); e.currentTarget.setAttribute('aria-pressed', 'true'); redraw(); } }, l)));
    redraw();
    return h('div', {}, pageHead('Campaigns', camps.length + ' total', h('button', { class: 'btn', type: 'button', onclick: () => { state.newCampaign = true; render(); } }, icon('plus', 16), 'New campaign')),
      h('div', { class: 'card' }, h('div', { class: 'toolbar' }, h('div', { class: 'search' }, icon('search', 18), q), chips), body));
  }
  if (state.invoice && page === 'wallet') return invoiceView(state.invoice);
  if (page === 'wallet') {
    const amount = h('input', { type: 'number', min: String(bal.minTopupUsd), step: '1', value: String(Math.max(bal.minTopupUsd, 50)), 'aria-label': 'Amount in dollars' });
    return h('div', {}, pageHead('Wallet', 'Funds are reserved when you launch a campaign and spent as it delivers.'),
      kpis([['Credits', money(bal.credits)], ['Spent', money(bal.spent)], ['Reserved for campaigns', money(bal.reserved)], ['Available', money(bal.available), { accent: true }]]),
      h('div', { class: 'grid-2' },
        h('div', { class: 'card' }, h('h3', {}, 'Add funds'), bal.paymentsMode === 'none' ? h('p', {}, 'Online payments are not enabled yet. Contact support to fund your account.') : h('div', { class: 'row inline' }, field('Amount ($)', amount), h('button', { class: 'btn', type: 'button', onclick: async () => {
          try { const r = await call('/api/billing/topup', 'POST', { amountUsd: +amount.value }); if (r.checkoutUrl) location.href = r.checkoutUrl; else { toast('Credited (test mode).'); render(); } } catch (e) { toast(e.message, 'err'); } } }, 'Add funds'))),
        h('div', { class: 'card' }, h('h3', {}, 'Statements'), statementButton())),
      bal.available < 0 ? h('div', { class: 'banner' }, 'Your available balance is negative (for example after a refund or a card dispute). New campaigns are blocked until you add funds.') : null,
      paymentsCard(), billingCard(), invoicesCard(bal),
      h('div', { class: 'card' }, h('h3', {}, 'Recent transactions'), bal.entries.length ? h('div', { class: 'tbl-wrap' }, tbl(['Date', 'Type', 'Amount', 'Note'], bal.entries.slice(0, 20).map((e) => h('tr', {}, h('td', {}, new Date(e.at).toLocaleDateString()), h('td', {}, KIND_LABELS[e.kind] || e.kind), h('td', { class: 'num' }, money(e.amount)), h('td', {}, e.note || ''))))) : emptyState('No transactions yet', 'Credits and charges will be listed here.')));
  }
  if (page === 'reports') return h('div', {}, pageHead('Reports', 'Performance across all your campaigns.'), reportCard(rep, 'advertiser'), breakdownCard('advertiser'));
  // overview
  const steps = checklist([[bal.credits > 0, 'Add funds to your wallet', h('button', { class: 'btn small', type: 'button', onclick: () => { state.tab = 'wallet'; render(); } }, 'Add funds')],
    [camps.length > 0, 'Create your first campaign', h('button', { class: 'btn small', type: 'button', onclick: () => { state.tab = 'campaigns'; state.newCampaign = true; render(); } }, 'Create')],
    [camps.some((c) => c.reviewStatus === 'approved'), 'Get it approved (usually a few hours)', null], [t.impressions > 0, 'See your first impressions', null]]);
  return h('div', {}, pageHead('Overview', 'Here is how your advertising is doing.', h('button', { class: 'btn', type: 'button', onclick: () => { state.tab = 'campaigns'; state.newCampaign = true; render(); } }, icon('plus', 16), 'New campaign')),
    kpis([['Spend', money(t.spend), { accent: true, spark: days.map(([, v]) => v.spend) }], ['Impressions', t.impressions.toLocaleString(), { spark: days.map(([, v]) => v.impressions) }], ['Clicks', t.clicks.toLocaleString(), { spark: days.map(([, v]) => v.clicks) }], ['CTR', pct(t.ctr)],
      ...(t.conversions ? [['Conversions', t.conversions.toLocaleString()]] : []), ['Wallet available', money(bal.available)]]),
    camps.length && t.impressions ? h('div', { class: 'card' }, h('h3', {}, 'Last 14 days'), reportChart(rep, 'advertiser')) : h('div', { class: 'card' }, h('h3', {}, 'Get started'), steps),
    h('div', { class: 'card' }, h('div', { class: 'bar' }, h('h3', {}, 'Campaigns'), camps.length ? h('button', { class: 'link', type: 'button', onclick: () => { state.tab = 'campaigns'; render(); } }, 'View all') : null), campaignsTable(camps, { limit: 5 })));
}

// ---------------------------------------------------------------- publisher
function integrationSnippet(appId) {
  const snippets = {
    JavaScript: `import { MobiAd } from './mobiad-sdk.js';\n\nconst ads = new MobiAd({ appId: '${appId}', baseUrl: '${location.origin}' });\nconst ad = await ads.requestAd({ format: 'banner', country: 'US' });\nif (ad) { render(ad.creative); await ad.onShown(); }`,
    Kotlin: `val ads = MobiAd(appId = "${appId}", baseUrl = "${location.origin}")\n// blocking: call from a background thread\nval ad = ads.requestAd(country = "US")\nad?.let { render(it.title, it.imageUrl); it.onShown() }`,
    Swift: `let ads = try MobiAd(appId: "${appId}", baseUrl: "${location.origin}")\nif let ad = await ads.requestAd(country: "US") {\n    render(ad.title, ad.imageUrl)\n    await ad.onShown()\n}`,
  };
  const pre = h('pre', {}, h('code', {})); const tabs = h('div', { class: 'code-tabs', role: 'tablist' });
  const show = (k) => { pre.firstChild.textContent = snippets[k]; tabs.querySelectorAll('button').forEach((b) => { b.setAttribute('aria-selected', String(b.textContent === k)); b.classList.toggle('on', b.textContent === k); }); };
  Object.keys(snippets).forEach((k) => tabs.append(h('button', { class: 'tabbtn', type: 'button', role: 'tab', onclick: () => show(k) }, k)));
  show('JavaScript');
  return h('div', {}, tabs, pre, h('button', { class: 'btn small ghost', type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(pre.textContent); toast('Copied.'); } catch { toast('Copy failed: select the text manually.', 'err'); } } }, 'Copy'));
}

async function publisherView(page) {
  const [bal, apps, rep] = await Promise.all([call('/api/billing/summary'), call('/api/apps'), call('/api/report')]);
  const t = rep.total, days = lastDays(rep);
  if (page === 'apps') {
    const msg = msgBox(), name = h('input', { required: true, maxlength: 120, placeholder: 'My app' }), floor = h('input', { type: 'number', step: '0.01', min: '0', value: '0' });
    const platform = h('select', {}, h('option', { value: 'android' }, 'Android'), h('option', { value: 'ios' }, 'iOS'));
    const kids = h('input', { type: 'checkbox' }), blocked = h('select', { multiple: true, size: '5' }, CATEGORIES.filter((c) => c !== 'general').map((c) => h('option', { value: c }, c)));
    const form = h('form', { class: 'card', hidden: !state.newApp, onsubmit: async (e) => {
      e.preventDefault(); msg.textContent = '';
      try { await call('/api/apps', 'POST', { name: name.value, platform: platform.value, floorEcpm: +floor.value, childDirected: kids.checked, blockedCategories: [...blocked.selectedOptions].map((o) => o.value) }); toast('App added. Copy its App ID below.'); state.newApp = false; render(); } catch (err) { say(msg, err.message); }
    } }, h('div', { class: 'bar' }, h('h3', {}, 'Add an app'), h('button', { class: 'link', type: 'button', onclick: () => { state.newApp = false; render(); } }, 'Cancel')),
      h('div', { class: 'row' }, field('App name', name), field('Platform', platform), field('Floor eCPM ($)', floor, 'Ads below this price will not serve.'), field('Block ad categories', blocked, 'Hold Ctrl/Cmd to pick several.')),
      h('label', { class: 'chk' }, kids, ' This app is directed to children (child-safe ads only, no personalisation)'), msg, h('div', {}, h('button', { class: 'btn' }, 'Add app')));
    const cards = apps.map((a) => h('div', { class: 'app-card' }, h('h4', {}, h('span', {}, a.name), a.flagged ? tag('under review', 'warn') : tag(a.platform)),
      h('div', {}, h('span', { class: 'sub' }, 'App ID'), h('code', {}, a.id), ' ', h('button', { class: 'link', type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(a.id); toast('App ID copied.'); } catch { toast('Copy failed.', 'err'); } } }, 'Copy')),
      h('div', { class: 'stats' }, h('div', {}, h('b', {}, a.stats.impressions.toLocaleString()), h('span', {}, 'Impressions')), h('div', {}, h('b', {}, a.stats.clicks.toLocaleString()), h('span', {}, 'Clicks')), h('div', {}, h('b', {}, a.stats.invalidClicks.toLocaleString()), h('span', {}, 'Invalid'))),
      h('span', { class: 'sub' }, 'Floor ' + money(a.floorEcpm) + ' eCPM' + (a.childDirected ? ' · child-directed' : '')),
      h('details', {}, h('summary', {}, 'Integration code'), integrationSnippet(a.id)), h('details', { 'data-app': a.id }, h('summary', {}, 'Placements, rewarded video and test ad'), h('div', { class: 'tools-slot' }))));
    for (const d of cards) d.querySelectorAll('details[data-app]').forEach((el) => { el.addEventListener('toggle', async () => { const slot = el.querySelector('.tools-slot'); if (el.open && !slot.children.length) slot.append(await appTools(apps.find((x) => x.id === el.dataset.app))); }); });
    const placements = await call('/api/placements'), adsTxt = await adsTxtCard();
    return h('div', {}, pageHead('Apps', apps.length + ' connected', h('button', { class: 'btn', type: 'button', onclick: () => { state.newApp = true; render(); } }, icon('plus', 16), 'Add app')), form,
      apps.length ? h('div', { class: 'cards' }, cards) : h('div', { class: 'card' }, emptyState('No apps yet', 'Add your first app to get an App ID and integration code.', h('button', { class: 'btn', type: 'button', onclick: () => { state.newApp = true; render(); } }, icon('plus', 16), 'Add app'))),
      placements.length ? h('div', { class: 'card' }, h('h3', {}, 'Placements'), h('div', { class: 'tbl-wrap' }, tbl(['Name', 'ID', 'Format', 'Floor', 'App'], placements.map((p) => h('tr', {}, h('td', {}, p.name), h('td', {}, h('code', {}, p.id)), h('td', {}, p.format), h('td', { class: 'num' }, money(p.floorEcpm)), h('td', {}, (apps.find((x) => x.id === p.appId) || {}).name || p.appId)))))) : null, adsTxt);
  }
  if (page === 'payouts') {
    const hashq = new URLSearchParams(location.hash.slice(1)).get('connect');
    const [prof, conn] = await Promise.all([call('/api/billing/payout-profile'), call('/api/billing/connect/status' + (hashq ? '?refresh=1' : ''))]);
    if (hashq) history.replaceState(null, '', location.pathname + location.search);
    const pMsg = msgBox(), pf = { name: h('input', { value: prof.legalName, maxlength: 120 }), country: h('input', { value: prof.country, maxlength: 2, placeholder: 'GB' }), method: h('select', {}, ['bank', 'paypal', 'wise'].map((m) => h('option', { value: m, selected: prof.method === m }, m))), ref: h('input', { value: prof.methodRef, maxlength: 120, placeholder: 'PayPal email, or last 4 digits' }) };
    const statusTag = (st) => tag(st, st === 'verified' ? 'ok' : st === 'rejected' ? 'bad' : st === 'submitted' ? 'warn' : '');
    const submitBtn = (kind, st) => (st === 'none' || st === 'rejected' ? h('button', { class: 'btn small ghost', type: 'button', onclick: async () => { try { await call('/api/billing/payout-profile/submit', 'POST', { kind }); toast('Submitted for review.'); render(); } catch (e) { toast(e.message, 'err'); } } }, 'I completed it: submit for review') : null);
    const profileCard = h('div', { class: 'card' }, h('h3', {}, 'Payout details'),
      h('p', { class: 'sub' }, 'We only keep your name, country and a payout reference. Identity and tax documents are handled outside MobiAd by our finance team; never enter full account numbers or tax IDs here.'),
      h('div', { class: 'row' }, field('Legal name', pf.name), field('Country (2 letters)', pf.country), field('Method', pf.method), field('Payout reference', pf.ref)),
      h('p', {}, h('button', { class: 'btn', type: 'button', onclick: async () => { try { const r = await call('/api/billing/payout-profile', 'POST', { legalName: pf.name.value, country: pf.country.value, method: pf.method.value, methodRef: pf.ref.value }); toast(r.reverificationRequired ? 'Saved. Name or country changed, so verification must be repeated.' : 'Saved.'); render(); } catch (e) { say(pMsg, e.message); } } }, 'Save details'), pMsg),
      h('div', { class: 'row inline' }, h('span', {}, 'Identity (KYC) '), statusTag(prof.kycStatus), submitBtn('kyc', prof.kycStatus), h('span', {}, 'Tax '), statusTag(prof.taxStatus), submitBtn('tax', prof.taxStatus)),
      prof.reviewNote ? h('p', { class: 'sub' }, 'Reviewer note: ', prof.reviewNote) : null, prof.verificationRequired ? h('p', { class: 'sub' }, 'Payouts require verified identity and tax status.') : null);
    const connectCard = conn.mode !== 'stripe_connect' ? null : h('div', { class: 'card' }, h('h3', {}, 'Payout account'),
      h('p', { class: 'sub' }, 'Payouts are sent by bank transfer through Stripe. Stripe collects your identity, bank and tax details on its own secure page; MobiAd never sees them.'),
      h('div', { class: 'row inline' }, conn.payoutsEnabled ? tag('ready to be paid', 'ok') : conn.connected ? tag('setup incomplete', 'warn') : tag('not set up'),
        h('button', { class: 'btn', type: 'button', onclick: async () => { try { const r = await call('/api/billing/connect/start', 'POST', {}); location.href = r.url; } catch (e) { toast(e.message, 'err'); } } }, conn.payoutsEnabled ? 'Update payout details' : conn.connected ? 'Continue setup' : 'Set up payouts'),
        conn.connected ? h('button', { class: 'link', type: 'button', onclick: () => { location.hash = 'connect=refresh'; } }, 'Refresh status') : null),
      conn.requirements.length ? h('p', { class: 'sub' }, 'Stripe still needs: ', conn.requirements.join(', ')) : null,
      conn.autoPayoutMaxUsd > 0 ? h('p', { class: 'sub' }, `Requests up to ${money(conn.autoPayoutMaxUsd)} are paid out automatically.`) : null);
    const payMsg = msgBox(), amt = h('input', { type: 'number', min: String(bal.minPayoutUsd), step: '1', placeholder: 'min $' + bal.minPayoutUsd, 'aria-label': 'Payout amount in dollars' });
    return h('div', {}, pageHead('Earnings and payouts', 'Your share of net auction revenue.'),
      kpis([['Earned', money(bal.earned)], ['Held (under review)', money(bal.held)], ...(bal.pending > 0 ? [['Pending (' + bal.holdDays + '-day hold)', money(bal.pending)]] : []), ['Requested', money(bal.requested)], ['Paid', money(bal.paid)], ['Payable now', money(bal.payable), { accent: true }]]),
      connectCard,
      bal.held > 0 ? h('div', { class: 'banner' }, 'Earnings from apps flagged for unusual traffic are held until our team clears them.') : null,
      h('div', { class: 'card' }, h('h3', {}, 'Request a payout'), h('div', { class: 'row inline' }, field('Amount ($)', amt), h('button', { class: 'btn', type: 'button', onclick: async () => { try { await call('/api/billing/payout', 'POST', { amountUsd: +amt.value }); toast('Payout requested.'); render(); } catch (e) { say(payMsg, e.message); } } }, 'Request payout')), payMsg, statementButton()),
      conn.mode === 'stripe_connect' ? null : profileCard,
      h('div', { class: 'card' }, h('h3', {}, 'Payout history'), bal.payouts.length ? h('div', { class: 'tbl-wrap' }, tbl(['Date', 'Amount', 'Status', 'Note'], bal.payouts.map((p) => h('tr', {}, h('td', {}, new Date(p.at).toLocaleDateString()), h('td', { class: 'num' }, money(p.amount)), h('td', {}, tag(p.status, p.status === 'paid' ? 'ok' : p.status === 'rejected' ? 'bad' : 'warn')), h('td', {}, [p.note, p.reference ? 'ref ' + p.reference : ''].filter(Boolean).join(' · ')))))) : emptyState('No payouts yet', 'Requests and payments will be listed here.')));
  }
  if (page === 'reports') return h('div', {}, pageHead('Reports', 'Traffic and earnings across all your apps.'), reportCard(rep, 'publisher'), breakdownCard('publisher'));
  const steps = checklist([[apps.length > 0, 'Add your first app', h('button', { class: 'btn small', type: 'button', onclick: () => { state.tab = 'apps'; state.newApp = true; render(); } }, 'Add app')], [t.impressions > 0, 'Integrate the SDK and serve your first ad', null], [bal.earned > 0, 'Start earning', null]]);
  return h('div', {}, pageHead('Overview', 'Your inventory at a glance.', h('button', { class: 'btn', type: 'button', onclick: () => { state.tab = 'apps'; state.newApp = true; render(); } }, icon('plus', 16), 'Add app')),
    kpis([['Earnings', money(t.publisherRevenue), { accent: true, spark: days.map(([, v]) => v.publisherRevenue) }], ['Impressions', t.impressions.toLocaleString(), { spark: days.map(([, v]) => v.impressions) }], ['Clicks', t.clicks.toLocaleString()], ['Payable now', money(bal.payable)]]),
    apps.length && t.impressions ? h('div', { class: 'card' }, h('h3', {}, 'Last 14 days'), reportChart(rep, 'publisher')) : h('div', { class: 'card' }, h('h3', {}, 'Get started'), steps),
    apps.length ? h('div', { class: 'card' }, h('div', { class: 'bar' }, h('h3', {}, 'Your apps'), h('button', { class: 'link', type: 'button', onclick: () => { state.tab = 'apps'; render(); } }, 'Manage')),
      h('div', { class: 'tbl-wrap' }, tbl(['App', 'Platform', 'Impr.', 'Clicks', 'Invalid', ''], apps.slice(0, 5).map((a) => h('tr', {}, h('td', {}, a.name), h('td', {}, a.platform), h('td', { class: 'num' }, a.stats.impressions.toLocaleString()), h('td', { class: 'num' }, a.stats.clicks.toLocaleString()), h('td', { class: 'num' }, a.stats.invalidClicks.toLocaleString()), h('td', {}, a.flagged ? tag('under review', 'warn') : '')))))) : null);
}

// ---------------------------------------------------------------- admin console
async function adminView() {
  const tabs = ['Overview', 'Review', 'Flagged apps', 'Payouts', 'Payments', 'Partners', 'Wallet credit', 'Users', 'Invites', 'Audit log'];
  state.adminTab ||= 'Overview';
  const body = h('div');
  const bar = h('div', { class: 'tabs' }, tabs.map((t) => h('button', { class: 'tabbtn' + (t === state.adminTab ? ' on' : ''), onclick: () => { state.adminTab = t; render(); } }, t)));
  const t = state.adminTab;
  if (t === 'Overview') { const o = await call('/api/admin/overview'); body.append(kpis([['Campaigns awaiting review', o.pendingCampaigns], ['Flagged apps', o.flaggedApps], ['Payout requests', o.pendingPayouts], ['Users', o.users]])); }
  if (t === 'Review') {
    const list = await call('/api/admin/campaigns?status=pending');
    body.append(h('div', { class: 'card' }, h('h3', {}, 'Campaigns awaiting review'), list.length ? list.map((c) => {
      const note = h('input', { placeholder: 'Note (required to reject)' });
      return h('div', { class: 'review' }, h('b', {}, c.name), ' ', tag(c.category, c.category === 'general' ? '' : 'warn'), c.childSafe ? tag('child-safe') : null,
        h('div', { class: 'sub' }, 'Landing URL: ', h('code', {}, c.creative.clickUrl)), c.creative.image ? h('div', { class: 'sub' }, 'Image: ', h('code', {}, c.creative.image)) : null, h('div', { class: 'sub' }, 'Headline: ', c.creative.title),
        h('div', { class: 'sub' }, `${c.model} bid ${money(c.bid)}, budget ${money(c.budget)}, owner ${c.owner}`), c.reviewNote ? h('div', { class: 'sub warn' }, c.reviewNote) : null,
        h('div', { class: 'row inline' }, note, h('button', { class: 'btn small', onclick: async () => { await call('/api/admin/campaigns/review', 'POST', { id: c.id, decision: 'approve', note: note.value }); render(); } }, 'Approve'),
          h('button', { class: 'btn small danger', onclick: async () => { try { await call('/api/admin/campaigns/review', 'POST', { id: c.id, decision: 'reject', note: note.value }); render(); } catch (e) { toast(e.message, 'err'); } } }, 'Reject')));
    }) : h('p', {}, 'Nothing waiting. 🎉')));
  }
  if (t === 'Flagged apps') {
    const list = await call('/api/admin/apps/flagged');
    body.append(h('div', { class: 'card' }, h('h3', {}, 'Flagged apps (earnings held)'), list.length ? tbl(['App', 'ID', 'Reason', ''], list.map((a) => h('tr', {}, h('td', {}, a.name), h('td', {}, h('code', {}, a.id)), h('td', {}, a.flagReason || ''), h('td', {}, h('button', { class: 'link', onclick: async () => { await call('/api/admin/apps/flag', 'POST', { id: a.id, flagged: false }); render(); } }, 'Clear flag'))))) : h('p', {}, 'No flagged apps.')));
  }
  if (t === 'Payouts') {
    const [requested, approved, queue] = await Promise.all([call('/api/admin/payouts?status=requested'), call('/api/admin/payouts?status=approved'), call('/api/admin/payout-profiles?status=submitted')]);
    const stripeBtn = (p, approve) => h('button', { class: 'btn small', type: 'button', disabled: !p.stripeReady, title: p.stripeReady ? 'Send a Stripe transfer to the publisher' : 'Publisher has not finished Stripe onboarding', onclick: async () => { try { const r = await call('/api/admin/payouts/send', 'POST', { id: p.id, approve }); toast('Paid via Stripe: ' + r.reference); render(); } catch (e) { toast(e.message, 'err'); } } }, approve ? 'Approve and pay via Stripe' : 'Pay via Stripe');
    const act = (id, status, extra = {}) => async () => { try { await call('/api/admin/payouts/resolve', 'POST', { id, status, ...extra }); render(); } catch (e) { toast(e.message, 'err'); } };
    body.append(h('div', { class: 'card' }, h('h3', {}, 'Identity / tax review queue'), queue.length ? tbl(['Publisher', 'Legal name', 'Country', 'Method', 'KYC', 'Tax', ''], queue.map((p) => {
      const note = h('input', { placeholder: 'Note (required to reject)' });
      const review = (kind, status) => async () => { try { await call('/api/admin/payout-profiles/review', 'POST', { userId: p.userId, kind, status, note: note.value }); render(); } catch (e) { toast(e.message, 'err'); } };
      const btns = [];
      for (const kind of ['kyc', 'tax']) if ((kind === 'kyc' ? p.kycStatus : p.taxStatus) === 'submitted') btns.push(h('button', { class: 'btn small', onclick: review(kind, 'verified') }, 'Verify ' + kind), h('button', { class: 'btn small danger', onclick: review(kind, 'rejected') }, 'Reject ' + kind));
      return h('tr', {}, h('td', {}, p.email), h('td', {}, p.legalName), h('td', {}, p.country), h('td', {}, p.method + ' · ' + p.methodRef), h('td', {}, p.kycStatus), h('td', {}, p.taxStatus), h('td', {}, note, btns));
    })) : h('p', {}, 'Nothing waiting for review.')));
    body.append(h('div', { class: 'card' }, h('h3', {}, 'Payout requests'), requested.length ? tbl(['Requested', 'Publisher', 'Amount', ''], requested.map((p) => {
      const note = h('input', { placeholder: 'Note / reason' });
      return h('tr', {}, h('td', {}, new Date(p.created_at).toLocaleString()), h('td', {}, h('code', {}, p.user_id)), h('td', {}, money(p.amount_micros / 1e6)),
        h('td', {}, note, h('button', { class: 'btn small', onclick: () => act(p.id, 'approved', { note: note.value })() }, 'Approve'), p.viaStripe ? stripeBtn(p, true) : null, h('button', { class: 'btn small danger', onclick: () => act(p.id, 'rejected', { note: note.value })() }, 'Reject')));
    })) : h('p', {}, 'No pending payout requests.')));
    body.append(h('div', { class: 'card' }, h('div', { class: 'bar' }, h('h3', {}, 'Approved: ready to pay'), h('button', { class: 'link', onclick: () => download('/api/admin/payouts.csv?status=approved', 'payouts-approved.csv').catch((e) => toast(e.message, 'err')) }, 'Export CSV for finance')),
      approved.length ? tbl(['Approved', 'Publisher', 'Amount', ''], approved.map((p) => {
        const ref = h('input', { placeholder: 'Bank / PayPal transaction id (required)' });
        return h('tr', {}, h('td', {}, new Date(p.created_at).toLocaleString()), h('td', {}, h('code', {}, p.user_id)), h('td', {}, money(p.amount_micros / 1e6)),
          h('td', {}, p.viaStripe ? stripeBtn(p, false) : null, ref, h('button', { class: 'btn small', onclick: () => act(p.id, 'paid', { reference: ref.value })() }, 'Mark paid'), h('button', { class: 'btn small danger', onclick: () => act(p.id, 'rejected', {})() }, 'Reject')));
      })) : h('p', {}, 'Nothing approved yet.')));
  }

  if (t === 'Partners') await partnersPanel(body);
  if (t === 'Wallet credit') {
    body.append(creditNoteForm());
    const uid = h('input', { placeholder: 'advertiser user id (usr_…)' }), amt = h('input', { type: 'number', step: '0.01' }), note = h('input', { placeholder: 'Reason / bank reference' }), ref = h('input', { placeholder: 'Unique reference (prevents double credit)' }), msg = msgBox();
    body.append(h('form', { class: 'card', onsubmit: async (e) => { e.preventDefault(); try { const r = await call('/api/admin/wallet/credit', 'POST', { userId: uid.value, amountUsd: +amt.value, note: note.value, reference: ref.value || undefined }); say(msg, r.applied ? 'Credit applied.' : 'Ignored: duplicate reference.', r.applied); } catch (er) { say(msg, er.message); } } },
      h('h3', {}, 'Manual wallet credit / adjustment'), h('div', { class: 'row' }, field('User', uid), field('Amount ($, negative to deduct)', amt), field('Note', note), field('Reference', ref)), h('button', { class: 'btn' }, 'Apply'), msg));
  }
  if (t === 'Payments') {
    const [pays, disputes] = await Promise.all([call('/api/admin/payments'), call('/api/admin/disputes')]);
    const rows = pays.map((p) => {
      const amt = h('input', { type: 'number', step: '0.01', min: '0.01', placeholder: 'full ($' + p.refundableUsd + ')', 'aria-label': 'Refund amount' }), why = h('input', { placeholder: 'Reason (required)', 'aria-label': 'Refund reason' });
      const can = ['paid', 'partially_refunded'].includes(p.status) && p.refundableUsd > 0;
      return h('tr', {}, h('td', {}, new Date(p.createdAt).toLocaleString()), h('td', {}, p.email || p.userId), h('td', { class: 'num' }, money(p.amount)), h('td', {}, tag(p.status.replace('_', ' '), PAY_KIND(p.status)), p.failure ? h('small', {}, ' ' + p.failure) : null), h('td', { class: 'num' }, p.refunded ? money(p.refunded) : '—'),
        h('td', {}, can ? h('div', { class: 'row inline' }, amt, why, h('button', { class: 'btn small', type: 'button', onclick: async () => {
          try { const r = await call('/api/admin/payments/refund', 'POST', { paymentId: p.id, amountUsd: amt.value || undefined, reason: why.value }); toast(r.status === 'refunded' ? 'Refunded.' : 'Refund requested: the wallet is debited when Stripe confirms.'); setTimeout(render, r.status === 'refunded' ? 0 : 3000); } catch (e) { toast(e.message, 'err'); } } }, 'Refund')) : ''));
    });
    body.append(h('div', { class: 'card' }, h('h3', {}, 'Payments (advertiser top-ups)'), h('p', { class: 'sub' }, 'A refund goes back to the card through Stripe and removes the same amount from the advertiser’s wallet. Money already spent on ads cannot be refunded.'),
      pays.length ? h('div', { class: 'tbl-wrap' }, tbl(['Date', 'Advertiser', 'Amount', 'Status', 'Refunded', 'Refund'], rows)) : h('p', {}, 'No payments yet.')));
    body.append(h('div', { class: 'card' }, h('h3', {}, 'Card disputes (chargebacks)'), h('p', { class: 'sub' }, 'When a card issuer opens a dispute, the disputed amount is held in the advertiser’s wallet. If we win it is released; if we lose it stays removed.'),
      disputes.length ? h('div', { class: 'tbl-wrap' }, tbl(['Opened', 'Advertiser', 'Amount', 'Reason', 'Status', 'Evidence'], disputes.map((d) => h('tr', {}, h('td', {}, new Date(d.createdAt).toLocaleString()), h('td', {}, d.email || ''), h('td', { class: 'num' }, money(d.amount)), h('td', {}, d.reason || ''), h('td', {}, tag(d.status.replace('_', ' '), d.status === 'won' ? 'ok' : d.status === 'lost' ? 'bad' : 'warn')), h('td', {}, disputeEvidence(d)))))) : h('p', {}, 'No disputes.')));
  }
  if (t === 'Invites') await invitesPanel(body);
  if (t === 'Users') { const u = await call('/api/admin/users'); body.append(h('div', { class: 'card' }, h('h3', {}, 'Users'), tbl(['Email', 'Role', 'Verified', '2-step', 'ID'], u.map((x) => h('tr', {}, h('td', {}, x.email), h('td', {}, x.role), h('td', {}, x.email_verified ? 'yes' : 'no'), h('td', {}, x.totp_enabled ? 'yes' : 'no'), h('td', {}, h('code', {}, x.id))))))); }
  if (t === 'Audit log') { const a = await call('/api/admin/audit?limit=200'); body.append(h('div', { class: 'card' }, h('h3', {}, 'Audit log (newest first)'), tbl(['Time', 'Actor', 'Action', 'Target', 'Detail'], a.map((x) => h('tr', {}, h('td', {}, new Date(x.at).toLocaleString()), h('td', {}, x.actor || ''), h('td', {}, x.action), h('td', {}, x.target || ''), h('td', {}, h('small', {}, JSON.stringify(x.detail)))))))); }
  return h('div', {}, bar, body);
}

// Evidence for an open card dispute: the admin explains, MobiAd adds the account's own records and sends it to Stripe (once).
function disputeEvidence(d) {
  if (d.evidence === 'submitted') return tag('submitted', 'ok');
  if (!d.canRespond) return '';
  const why = h('input', { placeholder: 'Why this charge is valid (20+ characters)', 'aria-label': 'Evidence explanation' });
  return h('div', { class: 'row inline' }, why, h('button', { class: 'btn small', type: 'button', onclick: async () => {
    try { await call('/api/admin/disputes/evidence', 'POST', { disputeId: d.id, explanation: why.value }); toast('Evidence sent to Stripe.'); render(); } catch (e) { toast(e.message, 'err'); } } }, 'Send evidence'));
}

async function invitesPanel(body) {
  const list = await call('/api/admin/invites');
  const role = h('select', { 'aria-label': 'Account type' }, h('option', { value: 'advertiser' }, 'Advertiser'), h('option', { value: 'publisher' }, 'Publisher'));
  const email = h('input', { type: 'email', placeholder: 'Optional: lock to this e-mail and send it', 'aria-label': 'Invitee e-mail' }), note = h('input', { placeholder: 'Note (who is this for?)', 'aria-label': 'Note' });
  const uses = h('input', { type: 'number', min: 1, max: 50, value: 1, 'aria-label': 'Uses' }), days = h('input', { type: 'number', min: 1, max: 90, value: 14, 'aria-label': 'Valid days' });
  const shown = h('div'), msg = msgBox();
  body.append(h('form', { class: 'card', onsubmit: async (e) => { e.preventDefault(); try {
    const r = await call('/api/admin/invites', 'POST', { role: role.value, email: email.value || undefined, note: note.value, maxUses: +uses.value, expiresInDays: +days.value });
    const link = `${location.origin}/app#signup=${encodeURIComponent(r.code)}&role=${r.role}`;
    shown.replaceChildren(h('div', { class: 'invoice-sums' }, h('b', {}, 'Invite code (shown once): '), h('code', { id: 'new-invite-code' }, r.code), h('div', { class: 'sub' }, 'Link: ', h('code', {}, link)), r.emailed ? h('div', { class: 'sub' }, 'Also e-mailed to ' + r.email + '.') : null));
    say(msg, 'Invite created. Copy it now: only a hash is stored.', true);
  } catch (er) { say(msg, er.message); } } }, h('h3', {}, 'Private-beta invites'), h('p', { class: 'sub' }, 'Sign-up is closed to the public. Each code works for one account type, can be locked to an e-mail, expires, and is stored only as a hash.'),
  h('div', { class: 'row' }, field('Account type', role), field('E-mail', email), field('Note', note), field('Uses', uses), field('Valid (days)', days)), h('button', { class: 'btn' }, 'Create invite'), msg, shown));
  body.append(h('div', { class: 'card' }, h('h3', {}, 'Invites'), list.length ? h('div', { class: 'tbl-wrap' }, tbl(['Created', 'Type', 'E-mail', 'Note', 'Used', 'Expires', 'Status', ''], list.map((i) => h('tr', {}, h('td', {}, new Date(i.createdAt).toLocaleDateString()), h('td', {}, i.role), h('td', {}, i.email || 'any'), h('td', {}, i.note || ''), h('td', { class: 'num' }, `${i.uses}/${i.maxUses}`), h('td', {}, new Date(i.expiresAt).toLocaleDateString()), h('td', {}, tag(i.status, i.status === 'open' ? 'ok' : 'warn')),
    h('td', {}, i.status === 'open' ? h('button', { class: 'link', onclick: async () => { await call('/api/admin/invites/revoke', 'POST', { id: i.id }); render(); } }, 'Revoke') : ''))))) : h('p', {}, 'No invites yet.')));
}

// ---------------------------------------------------------------- team + API keys (account owners only)
async function accessView() {
  const wrap = h('div', {});
  const when = (ms) => (ms ? new Date(ms).toLocaleString() : '—');
  const draw = async () => {
    const [keys, team] = await Promise.all([call('/api/keys'), call('/api/team')]);
    const kMsg = msgBox(), tMsg = msgBox(), shown = h('div', {});
    const kName = h('input', { placeholder: 'e.g. Reporting script', maxlength: 80 }), kScope = h('select', {}, h('option', { value: 'read' }, 'Read only'), h('option', { value: 'write' }, 'Read + create/edit campaigns and apps')), kDays = h('input', { type: 'number', min: 0, max: 730, placeholder: '0 = never expires' });
    const keyCard = h('div', { class: 'card' }, h('h3', {}, 'API keys'),
      h('p', {}, 'Use a key as a Bearer token in the Authorization header for scripts. Keys can never move money, change account security, or manage the team or other keys. They are shown once.'),
      keys.length ? tbl(['Name', 'Scope', 'Created', 'Last used', 'Expires', 'Status', ''], keys.map((k) => h('tr', {}, h('td', {}, k.name), h('td', {}, k.scope), h('td', {}, when(k.createdAt)), h('td', {}, when(k.lastUsedAt)), h('td', {}, k.expiresAt ? when(k.expiresAt) : 'never'),
        h('td', {}, k.revoked ? tag('revoked', 'bad') : k.expiresAt && k.expiresAt < Date.now() ? tag('expired', 'bad') : tag('active', 'ok')),
        h('td', {}, k.revoked ? '' : h('button', { class: 'link', onclick: async () => { if (!confirm('Revoke this key? Anything using it stops working immediately.')) return; try { await call('/api/keys/revoke', 'POST', { id: k.id }); draw(); } catch (e) { say(kMsg, e.message); } } }, 'Revoke'))))) : h('p', {}, 'No keys yet.'),
      h('div', { class: 'row inline' }, field('Name', kName), field('Access', kScope), field('Expires in (days)', kDays),
        h('button', { class: 'btn', type: 'button', onclick: async () => {
          try {
            const r = await call('/api/keys', 'POST', { name: kName.value, scope: kScope.value, ...(kDays.value ? { expiresInDays: Number(kDays.value) } : {}) });
            await draw();
            const out = wrap.querySelector('#newkey'); out.replaceChildren(h('h4', {}, 'Copy your new key now'), h('p', {}, 'It will not be shown again.'), h('pre', {}, r.key));
          } catch (e) { say(kMsg, e.message); }
        } }, 'Create key')), kMsg, h('div', { id: 'newkey' }));
    const tEmail = h('input', { type: 'email', placeholder: 'colleague@company.com' }), tRole = h('select', {}, h('option', { value: 'viewer' }, 'Viewer (read only)'), h('option', { value: 'admin' }, 'Admin (create/edit campaigns and apps)'));
    const rows = [
      ...team.members.map((m) => h('tr', {}, h('td', {}, m.email), h('td', {}, m.role), h('td', {}, tag('member', 'ok')), h('td', {}, h('button', { class: 'link', onclick: async () => { if (!confirm('Remove ' + m.email + '? They are signed out immediately.')) return; try { await call('/api/team/remove', 'POST', { id: m.id }); draw(); } catch (e) { say(tMsg, e.message); } } }, 'Remove')))),
      ...team.invites.map((i) => h('tr', {}, h('td', {}, i.email), h('td', {}, i.role), h('td', {}, tag('invited until ' + when(i.expiresAt))), h('td', {}, h('button', { class: 'link', onclick: async () => { try { await call('/api/team/remove', 'POST', { id: i.id }); draw(); } catch (e) { say(tMsg, e.message); } } }, 'Cancel')))),
    ];
    const teamCard = h('div', { class: 'card' }, h('h3', {}, 'Team'),
      h('p', {}, 'Colleagues sign in with their own login and see this account\u2019s data. Members can never add funds, request payouts, or manage the team or API keys.'),
      rows.length ? tbl(['Email', 'Role', 'Status', ''], rows) : h('p', {}, 'No team members yet.'),
      h('div', { class: 'row inline' }, field('Email', tEmail), field('Role', tRole), h('button', { class: 'btn', type: 'button', onclick: async () => {
        try { await call('/api/team/invite', 'POST', { email: tEmail.value, role: tRole.value }); say(tMsg, 'Invitation sent.', true); const m = tMsg.textContent; await draw(); const b = wrap.querySelector('#tmsg'); if (b) say(b, m, true); } catch (e) { say(tMsg, e.message); }
      } }, 'Send invitation')), tMsg);
    tMsg.id = 'tmsg';
    const convCard = state.me.role === 'advertiser' ? h('div', { class: 'card' }, h('h3', {}, 'Conversion postback (attribution)'),
      h('p', {}, 'Every accepted click sends the user to your landing URL with a mobiad_click_id parameter. Keep it with the user and send it back from your server when they convert, using a write-scope API key. For CPA campaigns the campaign’s conversion event is billed; other events are recorded free. Repeats are never double-counted.'),
      h('pre', {}, 'POST ' + location.origin + '/v1/conversion\nAuthorization: Bearer mak_…\n{ "clickId": "<mobiad_click_id>", "event": "purchase", "eventId": "order-123", "value": 24.5 }')) : null;
    wrap.replaceChildren(keyCard, convCard || '', await webhooksCard(), teamCard);
  };
  await draw();
  return wrap;
}

function inviteView(token) {
  const msg = msgBox(), pw = h('input', { type: 'password', required: true, minlength: 10, autocomplete: 'new-password' }), terms = h('input', { type: 'checkbox' });
  return h('form', { class: 'card auth', onsubmit: async (e) => {
    e.preventDefault();
    try { const r = await call('/api/team/accept', 'POST', { token, password: pw.value, acceptTerms: terms.checked }); store.set(r.token); state.me = null; state.tab = null; location.hash = ''; render(); }
    catch (err) { say(msg, err.message); }
  } }, h('h2', {}, 'Join your team on MobiAd'), h('p', {}, 'Choose a password to accept the invitation.'), field('Password', pw, 'At least 10 characters.'),
    h('label', { class: 'check' }, terms, ' I accept the ', h('a', { href: '/terms', target: '_blank', rel: 'noopener' }, 'Terms'), ' and ', h('a', { href: '/privacy', target: '_blank', rel: 'noopener' }, 'Privacy Policy')), h('button', { class: 'btn' }, 'Create my login'), msg);
}

// ---------------------------------------------------------------- shell
const NAV = {
  advertiser: [['overview', 'Overview', 'home'], ['campaigns', 'Campaigns', 'megaphone'], ['wallet', 'Wallet', 'wallet'], ['reports', 'Reports', 'chart']],
  publisher: [['overview', 'Overview', 'home'], ['apps', 'Apps', 'apps'], ['payouts', 'Earnings and payouts', 'cash'], ['reports', 'Reports', 'chart']],
  admin: [['admin', 'Admin console', 'shield']],
};
const TITLES = { overview: 'Overview', campaigns: 'Campaigns', wallet: 'Wallet', reports: 'Reports', apps: 'Apps', payouts: 'Earnings and payouts', access: 'Developers', security: 'Security', admin: 'Admin console' };

const themeStore = { get() { try { return localStorage.getItem('mobiad-theme'); } catch { return null; } }, set(v) { try { localStorage.setItem('mobiad-theme', v); } catch { /* storage blocked */ } } };
{ const t = themeStore.get(); if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t; }
function toggleTheme() {
  const root = document.documentElement, dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = dark ? 'light' : 'dark'; themeStore.set(root.dataset.theme);
}
const setNav = (open) => { document.body.classList.toggle('nav-open', open); menuBtn.setAttribute('aria-expanded', String(open)); };
const menuBtn = document.getElementById('menubtn'), sideFoot = document.getElementById('sidefoot'), pageTitle = document.getElementById('pagetitle');
menuBtn.append(icon('menu', 22));
menuBtn.addEventListener('click', () => setNav(!document.body.classList.contains('nav-open')));
document.getElementById('scrim').addEventListener('click', () => setNav(false));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setNav(false); });

const authBrand = () => h('div', { class: 'auth-brand' }, h('a', { class: 'logo', href: '/' }, 'MobiAd'));

let renderSeq = 0; // overlapping renders (e.g. hashchange + explicit call) must not both write the page
async function render() {
  const seq = ++renderSeq;
  const hash = new URLSearchParams(location.hash.slice(1));
  const anon = !store.token || hash.get('verify') || hash.get('reset') || hash.get('invite');
  document.body.classList.toggle('anon', !!anon); setNav(false);
  nav.replaceChildren(); sideFoot.replaceChildren();
  if (hash.get('verify')) { root.replaceChildren(authBrand(), await verifyView(hash.get('verify'))); return; }
  if (hash.get('reset')) { root.replaceChildren(authBrand(), resetView(hash.get('reset'))); return; }
  if (hash.get('invite')) { root.replaceChildren(authBrand(), inviteView(hash.get('invite'))); return; }
  if (!store.token) { root.replaceChildren(authBrand(), authView(), h('p', { class: 'auth-foot' }, h('a', { href: '/' }, '← Back to mobiad.com'))); return; }
  if (!root.children.length) root.replaceChildren(skeleton(3));
  try {
    state.me ||= await call('/api/me');
    if (seq !== renderSeq) return;
    const me = state.me, owner = me.role !== 'admin' && !me.teamRole;
    const primary = NAV[me.role] || [];
    const account = [...(owner ? [['access', 'Developers', 'key']] : []), ['security', 'Security', 'shield']];
    const valid = new Set([...primary, ...account].map(([k]) => k));
    let tab = state.tab || primary[0][0];
    if (!valid.has(tab)) tab = primary[0][0];
    const item = ([key, label, ic]) => h('button', { class: 'nav-item', type: 'button', 'aria-current': key === tab ? 'page' : undefined, onclick: () => { state.tab = key; state.newCampaign = false; state.newApp = false; state.invoice = null; state.openCampaign = null; render(); } }, icon(ic), label);
    nav.append(...primary.map(item), h('div', { class: 'nav-sep' }, 'Account'), ...account.map(item));
    if (me.demo) sideFoot.append(h('div', { class: 'demo-badge', role: 'note' }, 'Demo environment: simulated data'));
    sideFoot.append(h('a', { class: 'nav-item', href: '/help', target: '_blank', rel: 'noopener' }, icon('list'), 'Help center'));
    sideFoot.append(h('div', { class: 'me' }, h('div', { class: 'avatar', 'aria-hidden': 'true' }, me.email[0].toUpperCase()), h('div', { class: 'who' }, h('b', {}, me.email), h('span', {}, me.role + (me.teamRole ? ' · ' + me.teamRole : '')))),
      h('div', { class: 'side-tools' }, h('button', { class: 'btn small ghost', type: 'button', onclick: toggleTheme, 'aria-label': 'Toggle dark mode' }, icon('moon', 16), 'Theme'), h('button', { class: 'btn small ghost', type: 'button', onclick: () => { resetSession(); render(); } }, icon('logout', 16), 'Log out')));
    pageTitle.textContent = TITLES[tab] || 'Dashboard'; document.title = (TITLES[tab] || 'Dashboard') + ' · MobiAd';
    if (state.invoice && tab !== 'wallet') state.invoice = null;
    const view = tab === 'security' ? await securityView() : tab === 'access' ? await accessView() : me.role === 'admin' ? await adminView() : me.role === 'advertiser' ? await advertiserView(tab) : await publisherView(tab);
    if (seq !== renderSeq) return;
    root.replaceChildren(verifyBanner() || '', h('div', {}, view));
  } catch (e) {
    if (state.me === null && !store.token) return;
    root.replaceChildren(h('div', { class: 'card' }, emptyState('Something went wrong', e.message, h('button', { class: 'btn', type: 'button', onclick: render }, 'Try again'))));
  }
}
window.addEventListener('hashchange', render);
render();
