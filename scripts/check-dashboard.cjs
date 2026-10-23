// Evaluates every Grafana panel expression against a live Prometheus and reports errors/empty panels.
//   node scripts/check-dashboard.cjs [http://localhost:59090]
const fs = require('fs'), http = require('http'), path = require('path');
const prom = process.argv[2] || 'http://localhost:59090';
const dash = JSON.parse(fs.readFileSync(path.join(__dirname, '../infra/observability/grafana/dashboards/mobiad.json'), 'utf8'));
const exprs = [];
for (const p of dash.panels) for (const t of p.targets || []) exprs.push([p.title, t.expr]);
const get = (u) => new Promise((res, rej) => http.get(u, (r) => { let s = ''; r.on('data', (d) => (s += d)).on('end', () => res(JSON.parse(s))); }).on('error', rej));
(async () => {
  const tg = await get(prom + '/api/v1/targets');
  console.log('targets:', tg.data.activeTargets.map((x) => `${x.labels.job}=${x.health}`).join(', '));
  const rules = (await get(prom + '/api/v1/rules')).data.groups.flatMap((g) => g.rules);
  console.log(`alert rules loaded: ${rules.length}; firing now: ${rules.filter((r) => r.state === 'firing').map((r) => r.name).join(', ') || 'none'}`);
  let bad = 0, empty = 0;
  for (const [title, e] of exprs) {
    const r = await get(prom + '/api/v1/query?query=' + encodeURIComponent(e));
    const n = r.data?.result?.length || 0;
    if (r.status !== 'success') bad++; else if (!n) empty++;
    console.log(r.status !== 'success' ? 'ERR ' : n ? 'ok  ' : 'empty', title.padEnd(52), r.status !== 'success' ? r.error : n + ' series');
  }
  console.log(`\n${exprs.length} expressions: ${bad} errors, ${empty} empty`);
  process.exit(bad ? 1 : 0);
})();
