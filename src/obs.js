// Structured JSON logging + Prometheus-format metrics. No dependencies.
export function createLogger(level = process.env.LOG_LEVEL || 'info', out = process.stdout) {
  const order = { debug: 0, info: 1, warn: 2, error: 3 };
  const emit = (lvl) => (msg, fields = {}) => {
    if (order[lvl] < order[level]) return;
    out.write(JSON.stringify({ ts: new Date().toISOString(), level: lvl, msg, ...fields }) + '\n');
  };
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
}

export class Metrics {
  constructor() { this.counters = new Map(); this.hist = new Map(); }
  inc(name, labels = {}, by = 1) {
    const k = name + fmt(labels);
    this.counters.set(k, (this.counters.get(k) || 0) + by);
  }
  observe(name, labels, seconds) {
    const k = name + fmt(labels), h = this.hist.get(k) || { sum: 0, count: 0, b: BUCKETS.map(() => 0) };
    h.sum += seconds; h.count++;
    BUCKETS.forEach((le, i) => { if (seconds <= le) h.b[i]++; });
    this.hist.set(k, h);
  }
  render() {
    const lines = [];
    for (const [k, v] of this.counters) lines.push(`${k} ${v}`);
    for (const [k, h] of this.hist) {
      const i = k.indexOf('{'), name = i < 0 ? k : k.slice(0, i), lab = i < 0 ? '' : k.slice(i + 1, -1);
      const sep = lab ? ',' : '';
      BUCKETS.forEach((le, j) => lines.push(`${name}_bucket{${lab}${sep}le="${le}"} ${h.b[j]}`));
      lines.push(`${name}_bucket{${lab}${sep}le="+Inf"} ${h.count}`, `${name}_sum${i < 0 ? '' : '{' + lab + '}'} ${h.sum}`, `${name}_count${i < 0 ? '' : '{' + lab + '}'} ${h.count}`);
    }
    return lines.join('\n') + '\n';
  }
}
const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1];
const fmt = (l) => { const e = Object.entries(l); return e.length ? '{' + e.map(([k, v]) => `${k}="${String(v).replace(/"/g, '')}"`).join(',') + '}' : ''; };
