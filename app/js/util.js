/* KiLive — shared helpers */
(function () {
  'use strict';
  const N = (window.Noeti = window.Noeti || {});

  N.el = function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') e.className = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
        else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
        else if (k === 'html') e.innerHTML = v;
        else if (k === 'text') e.textContent = v;
        else if (k === 'dataset') Object.assign(e.dataset, v);
        else e.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return e;
  };

  N.svg = function (markup, cls) {
    const s = document.createElement('span');
    s.className = 'ico' + (cls ? ' ' + cls : '');
    s.innerHTML = markup;
    return s;
  };

  // 16px line icons (stroke = currentColor)
  const I = (d, extra = '') => `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${d}</svg>`;
  N.icons = {
    star: I('<path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z"/>'),
    starFill: I('<path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z" fill="currentColor"/>'),
    download: I('<path d="M8 2v8M4.5 6.8L8 10.3l3.5-3.5M2.5 13.5h11"/>'),
    share: I('<path d="M6.6 9.4l2.8-2.8M7 4.6l1-1a2.8 2.8 0 014 4l-1 1M9 11.4l-1 1a2.8 2.8 0 01-4-4l1-1"/>'),
    cube: I('<path d="M8 1.8l5.5 3v6.4L8 14.2l-5.5-3V4.8z"/><path d="M2.5 4.8L8 7.8l5.5-3M8 7.8v6.4"/>'),
    pcb: I('<rect x="2" y="2" width="12" height="12" rx="1.5"/><path d="M5 5h3v3h3M5 11h2"/><circle cx="11" cy="11" r="1"/>'),
    sch: I('<path d="M1.5 8h3M11.5 8h3"/><rect x="4.5" y="5" width="7" height="6" rx=".6"/><path d="M7 5V3M9 11v2"/>'),
    bom: I('<rect x="2" y="2.5" width="12" height="11" rx="1.2"/><path d="M2 6h12M2 9.5h12M6 2.5v11"/>'),
    checks: I('<rect x="3" y="2" width="10" height="12.5" rx="1.2"/><path d="M6 2V1.2h4V2M5.5 8.3l1.7 1.6 3.3-3.4"/>'),
    files: I('<path d="M4 1.8h5l3 3v9.4H4z"/><path d="M9 1.8v3h3"/>'),
    history: I('<path d="M2.3 8a5.7 5.7 0 101.7-4L2.3 5.7"/><path d="M2.3 2.4v3.3h3.3M8 5v3.2l2.2 1.4"/>'),
    info: I('<circle cx="8" cy="8" r="6.2"/><path d="M8 7.2V11M8 5v.1"/>'),
    expand: I('<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/>'),
    chevron: I('<path d="M4 6l4 4 4-4"/>'),
    right: I('<path d="M6 3.5L10.5 8 6 12.5"/>'),
    fit: I('<path d="M2.5 5.5v-3h3M10.5 2.5h3v3M13.5 10.5v3h-3M5.5 13.5h-3v-3"/>'),
    view: I('<circle cx="8" cy="8" r="6"/><path d="M10.8 5.2L9.2 9.2 5.2 10.8 6.8 6.8z"/>'),
    light: I('<path d="M5.8 11.2c-.9-.7-1.8-1.9-1.8-3.6a4 4 0 118 0c0 1.7-.9 2.9-1.8 3.6M6.2 13.2h3.6M6.8 11.2h2.4"/>'),
    scale: I('<rect x="1.5" y="5" width="13" height="6" rx="1"/><path d="M4 5v2.5M6.5 5v1.5M9 5v2.5M11.5 5v1.5"/>'),
    search: I('<circle cx="7" cy="7" r="4.5"/><path d="M10.4 10.4l3.3 3.3"/>'),
    layers: I('<path d="M8 2l6 3-6 3-6-3z"/><path d="M2 8l6 3 6-3M2 11l6 3 6-3"/>'),
    flip: I('<path d="M8 1.5v13M5.5 4.5L2 8l3.5 3.5V4.5zM10.5 4.5L14 8l-3.5 3.5"/>'),
    ruler: I('<path d="M2 11.5L11.5 2 14 4.5 4.5 14z"/><path d="M5 8.5l1.3 1.3M7 6.5l1.3 1.3M9 4.5l1.3 1.3"/>'),
    link: I('<path d="M6.6 9.4l2.8-2.8M7 4.6l1-1a2.8 2.8 0 014 4l-1 1M9 11.4l-1 1a2.8 2.8 0 01-4-4l1-1"/>'),
    ext: I('<path d="M9 2.5h4.5V7M13.5 2.5L7.5 8.5M11.5 9.5v4h-9v-9h4"/>'),
    comment: I('<path d="M2.5 3h11v7.5H7L4 13v-2.5H2.5z"/>'),
    close: I('<path d="M4 4l8 8M12 4l-8 8"/>'),
    send: I('<path d="M2 8l11.5-5.5L10 14l-2-4.5z"/><path d="M8 9.5l5.5-7"/>'),
    stop: I('<rect x="4" y="4" width="8" height="8" rx="1"/>'),
    spark: I('<path d="M8 1.5l1.3 3.9 3.9 1.3-3.9 1.3L8 11.9 6.7 8 2.8 6.7l3.9-1.3z"/><path d="M12.7 10.6l.5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5-1.5-.5 1.5-.5z"/>'),
    probe: I('<path d="M13.5 2.5l-5 5M9.8 3.4l2.8 2.8M3.6 12.4L7.2 8.8l1 1-3.6 3.6-1.8.6z"/>'),
    law: I('<path d="M8 2v12M4 14h8M3 5h10M3 5l-1.6 4a1.7 1.7 0 003.2 0zM13 5l-1.6 4a1.7 1.7 0 003.2 0z"/>'),
    folder: I('<path d="M1.8 4.2h4.3l1.3 1.5h6.8v7.3H1.8z"/>'),
    copy: I('<rect x="5" y="5" width="8.5" height="8.5" rx="1"/><path d="M11 5V2.5H2.5V11H5"/>'),
    trash: I('<path d="M3 4.5h10M6.3 4.5V3h3.4v1.5M4.5 4.5l.6 9h5.8l.6-9"/>'),
    grid: I('<rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/>'),
    list: I('<path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.1M2.5 8h.1M2.5 12h.1"/>'),
    compare: I('<path d="M5 2.5v11M11 2.5v11M2.5 5.5L5 3l2.5 2.5M8.5 10.5L11 13l2.5-2.5"/>'),
    target: I('<circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="2"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2"/>'),
    bug: I('<rect x="5" y="5" width="6" height="8" rx="3"/><path d="M8 5V3.5M6 3.3L5 2M10 3.3l1-1.3M5 8H2.5M13.5 8H11M5 11l-2 1.5M11 11l2 1.5"/>'),
    plus: I('<path d="M8 3v10M3 8h10"/>'),
    code: I('<path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5M9.2 2.8l-2.4 10.4"/>'),
    chip: I('<rect x="4" y="4" width="8" height="8" rx="1"/><path d="M6 1.5V4M10 1.5V4M6 12v2.5M10 12v2.5M1.5 6H4M1.5 10H4M12 6h2.5M12 10h2.5"/>'),
    play: I('<path d="M5 3.5l7 4.5-7 4.5z" fill="currentColor" stroke="none"/>'),
    pulse: I('<path d="M1.5 8.5h2.8l1.6-4.5 3 8.5 1.8-5.2.9 1.2h2.9"/>'),
    pen: I('<path d="M10.8 2.7l2.5 2.5-7.6 7.6-3.2.7.7-3.2z"/><path d="M9.5 4l2.5 2.5"/>'),
    upload: I('<path d="M8 11V3M4.5 6.2L8 2.7l3.5 3.5M2.5 13.5h11"/>'),
    doc: I('<path d="M4 1.8h5l3 3v9.4H4z"/><path d="M9 1.8v3h3M6 8.5h4M6 11h4"/>'),
  };

  N.fmt = {
    num(n) { return (n ?? 0).toLocaleString('en-US'); },
    k(n) { return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k' : String(n); },
    mm(v, d = 2) { return (+v).toFixed(d).replace(/\.?0+$/, '') + ' mm'; },
    bytes(b) { return b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : b > 1e3 ? Math.round(b / 1e3) + ' kB' : b + ' B'; },
    date(s) {
      if (!s) return '';
      const d = new Date(s + (s.length === 10 ? 'T12:00:00' : ''));
      if (isNaN(d)) return s;
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    },
    ago(ms) {
      const s = (Date.now() - ms) / 1000;
      if (s < 60) return 'just now';
      if (s < 3600) return Math.floor(s / 60) + ' min ago';
      if (s < 86400) return Math.floor(s / 3600) + ' h ago';
      return Math.floor(s / 86400) + ' d ago';
    },
    shortNet(n) { return n ? n.split('/').pop() : n; },
  };

  // Tiny event bus + shared selection state
  N.bus = {
    h: {},
    on(ev, fn) { (this.h[ev] = this.h[ev] || []).push(fn); return () => { this.h[ev] = this.h[ev].filter(f => f !== fn); }; },
    emit(ev, data) { (this.h[ev] || []).slice().forEach(f => { try { f(data); } catch (e) { console.error(e); } }); },
  };

  N.store = {
    get(k, d) { try { const v = localStorage.getItem('noeti:' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('noeti:' + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
  };

  // Fetch a JSON file that may be gzip-compressed
  const cache = new Map();
  N.loadJSON = function (url) {
    if (cache.has(url)) return cache.get(url);
    const p = (async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error('Could not load ' + url + ' (' + res.status + ')');
      let buf = new Uint8Array(await res.arrayBuffer());
      // base64-wrapped gzip ("H4sI" is how a gzip header starts in base64)
      if (buf[0] === 0x48 && buf[1] === 0x34 && buf[2] === 0x73 && buf[3] === 0x49) {
        const b = atob(new TextDecoder().decode(buf).trim());
        buf = new Uint8Array(b.length);
        for (let i = 0; i < b.length; i++) buf[i] = b.charCodeAt(i);
      }
      let text;
      if (buf[0] === 0x1f && buf[1] === 0x8b) {
        if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot unpack board data. Update to a current browser.');
        const ds = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
        text = await new Response(ds).text();
      } else {
        text = new TextDecoder().decode(buf);
      }
      return JSON.parse(text);
    })();
    cache.set(url, p);
    p.catch(() => cache.delete(url));
    return p;
  };

  // Minimal, safe markdown renderer (headings, lists, code, tables, emphasis, links)
  const esc = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  N.esc = esc;
  function inline(s, opts) {
    s = esc(s);
    s = s.replace(/`([^`]+)`/g, (m, c) => '<code>' + c + '</code>');
    // badges (an image inside a link: build status, licence, chat) say nothing here
    s = s.replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, '');
    s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (m, alt) => alt ? '<span class="md-img">[image: ' + alt + ']</span>' : '');
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (m, t, u) => {
      let href = u.replace(/&amp;/g, '&');
      if (!/^https?:\/\//.test(href)) {
        if (opts && opts.base && !href.startsWith('#') && !href.startsWith('mailto:')) href = opts.base + href.replace(/^\.\//, '');
        else return t;
      }
      return '<a href="' + esc(href) + '" target="_blank" rel="noopener">' + t + '</a>';
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/&lt;br\s*\/?&gt;/g, '<br>');
    return s;
  }
  N.inlineMd = inline;
  N.markdown = function (src, opts) {
    src = src.replace(/\r/g, '').replace(/<!--[\s\S]*?-->/g, '');
    // strip raw html tags but keep text
    src = src.replace(/<\/?(p|div|img|a|picture|source|center|h\d|br|b|i|table|tr|td|th|details|summary)[^>]*>/gi, ' ');
    const lines = src.split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      let l = lines[i];
      if (/^```/.test(l)) {
        const buf = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
        i++;
        out.push('<pre><code>' + esc(buf.join('\n')) + '</code></pre>');
        continue;
      }
      let m;
      if ((m = l.match(/^(#{1,6})\s+(.*)$/))) {
        const lv = Math.min(6, m[1].length + 1);
        out.push(`<h${lv}>${inline(m[2].replace(/#+\s*$/, ''), opts)}</h${lv}>`);
        i++;
        continue;
      }
      if (/^\s*([-*+]|\d+[.)])\s+/.test(l)) {
        const ordered = /^\s*\d/.test(l);
        const items = [];
        while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, ''));
          i++;
          while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) items[items.length - 1] += ' ' + lines[i++].trim();
        }
        const t = ordered ? 'ol' : 'ul';
        out.push(`<${t}>` + items.map(x => '<li>' + inline(x, opts) + '</li>').join('') + `</${t}>`);
        continue;
      }
      if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\s*\|?\s*:?-+/.test(lines[i + 1])) {
        const row = s => s.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
        const head = row(l);
        i += 2;
        const rows = [];
        while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(row(lines[i++]));
        out.push('<div class="md-table"><table><thead><tr>' + head.map(h => '<th>' + inline(h, opts) + '</th>').join('') + '</tr></thead><tbody>' +
          rows.map(r => '<tr>' + r.map(c => '<td>' + inline(c, opts) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>');
        continue;
      }
      if (/^>\s?/.test(l)) {
        const buf = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
        out.push('<blockquote>' + inline(buf.join(' '), opts) + '</blockquote>');
        continue;
      }
      if (/^\s*(-{3,}|\*{3,})\s*$/.test(l)) { out.push('<hr>'); i++; continue; }
      if (!l.trim()) { i++; continue; }
      const buf = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\s*([-*+]|\d+[.)])\s+|>|\s*\|)/.test(lines[i])) buf.push(lines[i++].trim());
      if (buf.length) out.push('<p>' + inline(buf.join(' '), opts) + '</p>');
      else i++;
    }
    return out.join('\n');
  };

  N.debounce = function (fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  };

  N.copyText = async function (text, fallbackEl) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      if (fallbackEl) {
        const r = document.createRange();
        r.selectNodeContents(fallbackEl);
        const s = getSelection();
        s.removeAllRanges();
        s.addRange(r);
      }
      return false;
    }
  };

  N.toast = function (msg, kind) {
    let host = document.getElementById('toasts');
    if (!host) { host = N.el('div', { id: 'toasts', 'aria-live': 'polite' }); document.body.append(host); }
    const t = N.el('div', { class: 'toast' + (kind ? ' ' + kind : '') }, msg);
    host.append(t);
    setTimeout(() => t.classList.add('out'), 2600);
    setTimeout(() => t.remove(), 3100);
  };

  N.cssVar = function (name, el) {
    return getComputedStyle(el || document.documentElement).getPropertyValue(name).trim();
  };

  // Popover menu anchored to a button
  N.menu = function (anchor, items, opts = {}) {
    document.querySelectorAll('.menu-pop').forEach(m => m.remove());
    const pop = N.el('div', { class: 'menu-pop' + (opts.cls ? ' ' + opts.cls : ''), role: 'menu' });
    for (const it of items) {
      if (it === '-') { pop.append(N.el('div', { class: 'menu-sep' })); continue; }
      if (it.header) { pop.append(N.el('div', { class: 'menu-head' }, it.header)); continue; }
      if (it.node) { pop.append(it.node); continue; }
      const b = N.el(it.href ? 'a' : 'button', {
        class: 'menu-item' + (it.active ? ' active' : ''), role: 'menuitem', href: it.href, target: it.href ? '_blank' : null, rel: it.href ? 'noopener' : null,
        onclick: e => { if (!it.href) { e.preventDefault(); } close(); it.onClick && it.onClick(); },
      }, it.icon ? N.svg(it.icon) : null, N.el('span', { class: 'mi-label' }, it.label), it.hint ? N.el('span', { class: 'mi-hint' }, it.hint) : null);
      pop.append(b);
    }
    document.body.append(pop);
    const r = anchor.getBoundingClientRect();
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    let x = opts.alignRight ? r.right - pw : r.left;
    let y = opts.up ? r.top - ph - 6 : r.bottom + 6;
    x = Math.max(8, Math.min(x, innerWidth - pw - 8));
    if (y + ph > innerHeight - 8) y = Math.max(8, r.top - ph - 6);
    pop.style.left = x + 'px';
    pop.style.top = y + 'px';
    function close() { pop.remove(); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', esc_); }
    function outside(e) { if (!pop.contains(e.target) && !anchor.contains(e.target)) close(); }
    function esc_(e) { if (e.key === 'Escape') close(); }
    setTimeout(() => { document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', esc_); }, 0);
    const first = pop.querySelector('.menu-item');
    if (first) first.focus({ preventScroll: true });
    return { close, el: pop };
  };

  // reference designator natural sort
  N.refKey = function (r) {
    const m = /^([A-Za-z_#]*)(\d*)(.*)$/.exec(r || '');
    return [m[1], m[2] ? +m[2] : 0, m[3]];
  };
  N.refCmp = function (a, b) {
    const x = N.refKey(a), y = N.refKey(b);
    return x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] - y[1] || (x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0);
  };

  N.csv = function (rows) {
    return rows.map(r => r.map(c => {
      const s = c == null ? '' : String(c);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',')).join('\n') + '\n';
  };

  // rotate like KiCad (degrees, CCW visually in y-down space)
  N.rot = function (x, y, deg) {
    if (!deg) return [x, y];
    const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    return [x * c + y * s, -x * s + y * c];
  };
})();
