// Small UI toolkit for the dashboard: DOM builder, icons, toasts, empty states and an SVG chart.
// Everything is built with createElement/textContent (never innerHTML), so user-controlled data cannot inject markup.
const SVG_NS = 'http://www.w3.org/2000/svg';

export function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
}
export function svg(tag, attrs = {}, ...kids) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
  for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
}

const ICONS = {
  home: ['M3 11l9-8 9 8', 'M5 10v10h14V10'],
  megaphone: ['M3 11v3a1 1 0 001 1h3l8 4V6L7 10H4a1 1 0 00-1 1z', 'M19 8a5 5 0 010 8'],
  wallet: ['M3 7a2 2 0 012-2h13v4', 'M3 7v10a2 2 0 002 2h15a1 1 0 001-1V9a1 1 0 00-1-1H5a2 2 0 01-2-1z', 'M16 14h2'],
  chart: ['M4 20V4', 'M4 20h16', 'M8 16l4-5 3 3 5-7'],
  apps: ['M4 4h7v7H4z', 'M13 4h7v7h-7z', 'M4 13h7v7H4z', 'M13 13h7v7h-7z'],
  cash: ['M3 7h18v10H3z', 'M12 14.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z'],
  key: ['M14 10a4 4 0 11-3.4 6.1L4 17v3h3v-2h2v-2l1.6-1.6A4 4 0 0114 10z', 'M17 7h.01'],
  shield: ['M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z', 'M9 12l2 2 4-4'],
  users: ['M16 19v-1a4 4 0 00-4-4H7a4 4 0 00-4 4v1', 'M9.5 10a3.5 3.5 0 100-7 3.5 3.5 0 000 7z', 'M21 19v-1a3 3 0 00-2.2-2.9', 'M16 3.2a3.5 3.5 0 010 6.6'],
  flag: ['M5 21V4', 'M5 4h12l-2 4 2 4H5'],
  list: ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3 6h.01', 'M3 12h.01', 'M3 18h.01'],
  menu: ['M4 7h16', 'M4 12h16', 'M4 17h16'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  moon: ['M20 14.5A8 8 0 019.5 4 8 8 0 1020 14.5z'],
  logout: ['M10 17l-5-5 5-5', 'M5 12h11', 'M14 4h5v16h-5'],
  plus: ['M12 5v14', 'M5 12h14'],
  download: ['M12 4v11', 'M7 11l5 5 5-5', 'M5 20h14'],
  search: ['M11 18a7 7 0 100-14 7 7 0 000 14z', 'M21 21l-5-5'],
  check: ['M5 12.5l4.5 4.5L19 7'],
  eye: ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z', 'M12 15a3 3 0 100-6 3 3 0 000 6z'],
  play: ['M7 4l13 8-13 8z'],
  clock: ['M12 21a9 9 0 100-18 9 9 0 000 18z', 'M12 7v5l3 2'],
};
export function icon(name, size = 20) {
  return svg('svg', { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' },
    (ICONS[name] || []).map((d) => svg('path', { d })));
}

// Toasts: polite live region at the bottom right.
export function toast(text, kind = 'ok', ms = 4200) {
  let box = document.getElementById('toasts');
  if (!box) { box = h('div', { class: 'toasts', id: 'toasts', 'aria-live': 'polite', role: 'status' }); document.body.append(box); }
  const t = h('div', { class: 'toast ' + kind }, text);
  box.append(t);
  setTimeout(() => t.remove(), ms);
}

// Friendly empty state with a small illustration.
export function emptyState(title, text, action) {
  const art = svg('svg', { viewBox: '0 0 120 90', 'aria-hidden': 'true' },
    svg('rect', { x: 12, y: 14, width: 96, height: 62, rx: 12, fill: 'currentColor', opacity: '.08' }),
    svg('rect', { x: 24, y: 28, width: 40, height: 7, rx: 3.5, fill: 'currentColor', opacity: '.25' }),
    svg('rect', { x: 24, y: 42, width: 72, height: 6, rx: 3, fill: 'currentColor', opacity: '.15' }),
    svg('rect', { x: 24, y: 54, width: 56, height: 6, rx: 3, fill: 'currentColor', opacity: '.15' }),
    svg('circle', { cx: 94, cy: 22, r: 12, fill: '#5b3df5' }), svg('path', { d: 'M88 22h12M94 16v12', stroke: '#fff', 'stroke-width': 2.5, 'stroke-linecap': 'round' }));
  return h('div', { class: 'empty' }, art, h('b', {}, title), h('p', {}, text), action || null);
}

export const skeleton = (n = 3) => h('div', { class: 'skeletons', 'aria-busy': 'true' }, Array.from({ length: n }, () => h('div', { class: 'skel', style: undefined })));

// Multi-series line/area chart. series: [{ name, color, values: number[], fmt?: (n) => string }]. Each series is scaled to its own
// maximum (so impressions and spend can share one canvas); the tooltip shows true values. Includes a keyboard-reachable data table.
export function lineChart({ labels, series, height = 260 }) {
  const W = 760, H = height, pad = { l: 12, r: 12, t: 16, b: 28 };
  const innerW = W - pad.l - pad.r, innerH = H - pad.t - pad.b;
  const n = labels.length, hidden = new Set();
  const wrap = h('div', { class: 'chart' });
  if (!n) return wrap.appendChild(emptyState('No data yet', 'Numbers appear here after your first traffic.')), wrap;
  const x = (i) => pad.l + (n === 1 ? innerW / 2 : (innerW * i) / (n - 1));
  const maxOf = (s) => Math.max(...s.values, 0) || 1;
  const y = (s, v) => pad.t + innerH - (v / maxOf(s)) * innerH;

  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Daily performance chart: ' + series.map((s) => s.name).join(', '), class: 'chart-svg', preserveAspectRatio: 'none' });
  for (let g = 0; g <= 4; g++) root.append(svg('line', { x1: pad.l, x2: W - pad.r, y1: pad.t + (innerH * g) / 4, y2: pad.t + (innerH * g) / 4, class: 'grid' }));
  const step = Math.max(1, Math.ceil(n / 7));
  labels.forEach((l, i) => { if (i % step === 0 || i === n - 1) root.append(svg('text', { x: x(i), y: H - 8, class: 'axis', 'text-anchor': i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle' }, l.slice(5))); });
  const layers = series.map((s) => {
    const pts = s.values.map((v, i) => `${x(i).toFixed(1)},${y(s, v).toFixed(1)}`);
    const g = svg('g', { class: 'series' });
    if (n > 1) g.append(svg('path', { d: `M${x(0)},${pad.t + innerH} L${pts.join(' L')} L${x(n - 1)},${pad.t + innerH}Z`, fill: s.color, opacity: '.12' }));
    g.append(svg('path', { d: n > 1 ? `M${pts.join(' L')}` : `M${pts[0]}`, fill: 'none', stroke: s.color, 'stroke-width': 2.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke' }));
    if (n <= 31) s.values.forEach((v, i) => g.append(svg('circle', { cx: x(i), cy: y(s, v), r: 3.2, fill: s.color, class: 'pt' })));
    root.append(g); return g;
  });
  const cursor = svg('line', { y1: pad.t, y2: pad.t + innerH, class: 'cursor', opacity: '0' });
  root.append(cursor);
  const tip = h('div', { class: 'chart-tip', hidden: true });
  const stage = h('div', { class: 'chart-stage' }, root, tip);
  const fmt = (s, v) => (s.fmt ? s.fmt(v) : Number(v).toLocaleString());
  const move = (ev) => {
    const r = root.getBoundingClientRect(); const rel = (ev.clientX - r.left) / r.width;
    const i = Math.min(n - 1, Math.max(0, Math.round(((rel * W - pad.l) / innerW) * (n - 1))));
    cursor.setAttribute('x1', x(i)); cursor.setAttribute('x2', x(i)); cursor.setAttribute('opacity', '1');
    tip.hidden = false; tip.replaceChildren(h('b', {}, labels[i]), ...series.filter((s) => !hidden.has(s.name)).map((s) => h('div', {}, h('i', { class: 'dot', 'data-c': s.color }), s.name + ': ', h('b', {}, fmt(s, s.values[i])))));
    tip.querySelectorAll('.dot').forEach((d) => { d.style.background = d.dataset.c; });
    tip.style.left = Math.min(Math.max((x(i) / W) * r.width, 70), r.width - 70) + 'px';
  };
  root.addEventListener('pointermove', move);
  root.addEventListener('pointerleave', () => { cursor.setAttribute('opacity', '0'); tip.hidden = true; });

  const legend = h('div', { class: 'legend' }, series.map((s, i) => {
    const b = h('button', { type: 'button', class: 'legend-item', 'aria-pressed': 'true' }, h('i', { class: 'dot' }), s.name);
    b.firstChild.style.background = s.color;
    b.addEventListener('click', () => { const off = !hidden.has(s.name); off ? hidden.add(s.name) : hidden.delete(s.name); layers[i].style.display = off ? 'none' : ''; b.setAttribute('aria-pressed', String(!off)); });
    return b;
  }));
  const table = h('details', { class: 'chart-data' }, h('summary', {}, 'View data table'), h('div', { class: 'tbl-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'Date'), series.map((s) => h('th', { class: 'num' }, s.name)))),
    h('tbody', {}, labels.map((l, i) => h('tr', {}, h('td', {}, l), series.map((s) => h('td', { class: 'num' }, fmt(s, s.values[i])))))))));
  wrap.append(legend, stage, table);
  return wrap;
}

// Tiny inline sparkline for KPI cards.
export function sparkline(values, color = '#5b3df5') {
  const W = 100, H = 28, mx = Math.max(...values, 1), n = values.length;
  if (n < 2) return h('span');
  const pts = values.map((v, i) => `${((W * i) / (n - 1)).toFixed(1)},${(H - 2 - (v / mx) * (H - 4)).toFixed(1)}`).join(' L');
  return svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'spark', 'aria-hidden': 'true', preserveAspectRatio: 'none' }, svg('path', { d: 'M' + pts, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke' }));
}
