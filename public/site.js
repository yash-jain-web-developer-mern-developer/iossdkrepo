// Marketing-site behaviour: theme toggle, mobile menu, accessible tabs. No dependencies; storage access is always guarded.
(() => {
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } } };
  const root = document.documentElement;
  const saved = store.get('mobiad-theme');
  if (saved === 'dark' || saved === 'light') root.dataset.theme = saved;
  document.getElementById('theme')?.addEventListener('click', () => {
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark'; store.set('mobiad-theme', root.dataset.theme);
  });

  const burger = document.getElementById('burger'), menu = document.getElementById('menu');
  const setMenu = (open) => { menu.classList.toggle('open', open); burger.setAttribute('aria-expanded', String(open)); };
  burger?.addEventListener('click', () => setMenu(!menu.classList.contains('open')));
  menu?.addEventListener('click', (e) => { if (e.target.closest('a')) setMenu(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setMenu(false); });

  // Tabs: click or arrow keys; one panel visible.
  function tabs(list, panelOf, activate) {
    const btns = [...list.querySelectorAll('[role="tab"]')];
    const select = (b, focus) => {
      for (const x of btns) { const on = x === b; x.setAttribute('aria-selected', String(on)); x.tabIndex = on ? 0 : -1; panelOf(x).hidden = !on; x.classList?.toggle('on', on); }
      if (focus) b.focus(); activate?.(b);
    };
    btns.forEach((b) => b.addEventListener('click', () => select(b, false)));
    list.addEventListener('keydown', (e) => {
      const i = btns.indexOf(document.activeElement); if (i < 0) return;
      const n = e.key === 'ArrowRight' ? (i + 1) % btns.length : e.key === 'ArrowLeft' ? (i - 1 + btns.length) % btns.length : e.key === 'Home' ? 0 : e.key === 'End' ? btns.length - 1 : -1;
      if (n >= 0) { e.preventDefault(); select(btns[n], true); }
    });
  }
  const sol = document.querySelector('.tabs[aria-label="Solutions"]');
  if (sol) tabs(sol, (b) => document.getElementById(b.getAttribute('aria-controls')));
  const code = document.querySelector('.code-tabs');
  if (code) tabs(code, (b) => document.getElementById('code-' + b.dataset.code));
})();
