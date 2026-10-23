// Feeds a BidRequest built by the prebid/openrtb Go library into MobiAd's bidder endpoint, as a real exchange would.
import { readFileSync } from 'node:fs';
import { boot } from '../../test/lib/helpers.js';
const t = await boot();
const adv = await t.signup('adv@x.io', 'advertiser'), pub = await t.signup('pub@x.io', 'publisher');
await t.call('/api/campaigns', 'POST', { name: 'B', model: 'CPM', bid: 5, budget: 100, clickUrl: 'https://example.com/l', countries: ['US'] }, adv);
const a = (await t.call('/api/apps', 'POST', { name: 'ex' }, pub)).body;
const req = JSON.parse(readFileSync('go-request.json', 'utf8').replace('app_x', a.id));
const r = await t.call('/rtb/v2.6/bid', 'POST', req);
console.log('status', r.status, 'bid price', r.body?.seatbid?.[0]?.bid?.[0]?.price, 'cur', r.body?.cur);
const ok = r.status === 200 && r.body.seatbid[0].bid[0].price >= 0.25;
await t.stop(); process.exit(ok ? 0 : 1);
