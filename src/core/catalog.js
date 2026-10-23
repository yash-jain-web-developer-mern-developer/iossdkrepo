// In-process snapshot of servable campaigns + apps so the ad hot path never queries Postgres.
// Refreshed on an interval and invalidated immediately by control-plane writes.
export class Catalog {
  constructor({ repo, spend, refreshMs = 2000, log }) {
    this.repo = repo; this.spend = spend; this.refreshMs = refreshMs; this.log = log;
    this.campaigns = new Map(); this.apps = new Map(); this.placements = new Map(); this.partners = []; this.timer = null;
  }
  async refresh() {
    const [list, apps, placements, partners] = await Promise.all([this.repo.servableCampaigns(), this.repo.allApps(), this.repo.allPlacements(), this.repo.activePartners()]);
    const next = new Map();
    for (const c of list) {
      const live = await this.spend.get(c.id);
      const prev = this.campaigns.get(c.id);
      c.spent = Math.max(c.spent, live.total);
      c.spentToday = live.today;
      // keep fresher local counters (events not yet flushed to the ledger)
      if (prev) { c.impressions = Math.max(c.impressions, prev.impressions); c.clicks = Math.max(c.clicks, prev.clicks); }
      next.set(c.id, c);
    }
    this.campaigns = next;
    this.apps = new Map(apps.map((a) => [a.id, a])); // hot path never needs Postgres for known apps
    this.placements = new Map(placements.map((p) => [p.id, p]));
    this.partners = partners;
    this.loaded = true;
  }
  async app(id) {
    let a = this.apps.get(id);
    if (!a) { a = await this.repo.app(id); if (a) this.apps.set(id, a); }
    return a;
  }
  // Coalesced: many invalidations during one refresh trigger exactly one more refresh.
  requestRefresh() {
    if (this.refreshing) { this.pending = true; return this.refreshing; }
    this.refreshing = this.refresh().catch((e) => this.log?.error('catalog refresh failed', { err: e.message }))
      .finally(() => { this.refreshing = null; if (this.pending) { this.pending = false; this.requestRefresh(); } });
    return this.refreshing;
  }
  list() { return [...this.campaigns.values()]; }
  // Active external demand partners able to bid on this slot. Child-directed traffic only goes to partners flagged child-safe.
  partnersFor(format, { childDirected = false } = {}) {
    return this.partners.filter((p) => (!p.formats.length || p.formats.includes(format)) && (!childDirected || p.childSafe));
  }
  start() {
    this.timer = setInterval(() => this.refresh().catch((e) => this.log?.error('catalog refresh failed', { err: e.message })), this.refreshMs);
    this.timer.unref();
  }
  stop() { clearInterval(this.timer); }
}
