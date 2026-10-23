// Generates OpenRTB messages produced by MobiAd, for strict validation by the prebid/openrtb Go library.
import { writeFileSync } from 'node:fs';
import { buildBidRequest } from '../../src/core/partners.js';
import { boot } from '../../test/lib/helpers.js';
const app = { id: 'app_1', name: 'Game', owner: 'usr_1', platform: 'ios', childDirected: false };
const reqs = [];
for (const format of ['banner', 'interstitial', 'video', 'rewarded']) {
  for (const personalize of [true, false]) reqs.push(buildBidRequest({ app, placement: { id: 'plc_1' }, format, floorEcpm: 1.5, country: 'US', sig: { lang: 'en-GB', osVersion: '17.2', deviceType: 'tablet', connection: 'wifi' }, ua: 'Mozilla/5.0', ip: '203.0.113.7', deviceId: 'ifa-1', personalize, consent: { gdpr: true, gdprConsent: 'CPabc', usPrivacy: '1YNN', coppa: false }, tmax: 150, blockedCategories: ['gambling'] }));
}
reqs.push(buildBidRequest({ app: { ...app, childDirected: true }, format: 'banner', personalize: false, consent: { coppa: true }, tmax: 120 }));
// real responses from our bidder endpoint
const t = await boot();
const adv = await t.signup('adv@x.io', 'advertiser'), pub = await t.signup('pub@x.io', 'publisher');
await t.call('/api/campaigns', 'POST', { name: 'B', model: 'CPM', bid: 5, budget: 100, clickUrl: 'https://example.com/l', image: 'https://cdn.example.com/i.png' }, adv);
await t.call('/api/campaigns', 'POST', { name: 'V', model: 'CPM', bid: 5, budget: 100, clickUrl: 'https://example.com/l', format: 'video', videoUrl: 'https://cdn.example.com/a.mp4', durationSec: 15 }, adv);
const a = (await t.call('/api/apps', 'POST', { name: 'ex' }, pub)).body;
const resp = [];
for (const imp of [{ id: '1', banner: { w: 320, h: 50 }, bidfloor: 0.5 }, { id: '1', video: { w: 640, h: 360, mimes: ['video/mp4'] }, bidfloor: 0.5 }]) {
  const r = await t.call('/rtb/v2.6/bid', 'POST', { id: 'req1', imp: [imp], app: { id: a.id }, device: { geo: { country: 'USA' } } });
  if (r.status === 200) resp.push(r.body);
}
writeFileSync('requests.json', JSON.stringify(reqs)); writeFileSync('responses.json', JSON.stringify(resp));
console.log('requests', reqs.length, 'responses', resp.length);
await t.stop();
