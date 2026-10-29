/* KiLive - in-browser KiCad importer.
 *
 * Faithful port of the offline Python pipeline in tools/ (sexpr.py, kicad_pcb.py, kicad_sch.py,
 * classify.py, checks.py, build.py) so users can upload their own KiCad 6+ projects.
 * The output has the same shape as data/<key>.json: {pcb, sch, bom, checks, power, stats}.
 *
 * Python semantics that matter for identical output are emulated on purpose:
 *   - round(x, n) (correctly rounded, half-even on exact ties), round(x) -> int (half-even)
 *   - math.hypot (CPython 3.11 vector_norm), float(), int(), str(float), format(x, '.nf')
 *   - dict insertion order (Map where keys may look like integers)
 *   - iteration order of CPython int sets (power-net set and USB data-line set)
 *   - Python regex \w, \d, \s and `$` (also matches before a trailing newline)
 * Where Python would raise on malformed input, this port falls back to a lenient default.
 */
(function (root) {
  'use strict';
  const N = root.Noeti = root.Noeti || {};

  // =====================================================================================
  // Python compatibility helpers
  // =====================================================================================
  const hasOwn = Object.prototype.hasOwnProperty;
  function own(o, k) { return o != null && hasOwn.call(o, k); }
  function get(o, k, d) { return o != null && hasOwn.call(o, k) ? o[k] : d; }
  function put(o, k, v) {
    if (k === '__proto__') Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
    else o[k] = v;
  }
  function objFromMap(m) { const o = {}; for (const [k, v] of m) put(o, k, v); return o; }

  // Python str() of a token (tokens are strings or lists)
  function reprStr(s) {
    const q = (s.indexOf("'") >= 0 && s.indexOf('"') < 0) ? '"' : "'";
    let out = q;
    for (const ch of s) {
      if (ch === '\\') out += '\\\\';
      else if (ch === q) out += '\\' + q;
      else if (ch === '\n') out += '\\n';
      else if (ch === '\r') out += '\\r';
      else if (ch === '\t') out += '\\t';
      else out += ch;
    }
    return out + q;
  }
  function reprList(l) { return '[' + l.map((x) => Array.isArray(x) ? reprList(x) : reprStr(String(x))).join(', ') + ']'; }
  function S(x) {
    if (typeof x === 'string') return x;
    if (x === null || x === undefined) return 'None';
    if (Array.isArray(x)) return reprList(x);
    if (typeof x === 'number') return floatRepr(x);
    return String(x);
  }

  // Python code-point string comparison (JS < compares UTF-16 units)
  function cmpStr(a, b) {
    if (a === b) return 0;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const ca = a.charCodeAt(i), cb = b.charCodeAt(i);
      if (ca !== cb) {
        if (ca < 0xD800 && cb < 0xD800) return ca - cb;
        return a.codePointAt(i) - b.codePointAt(i) || (ca - cb);
      }
    }
    return a.length - b.length;
  }
  function cmpNum(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

  // Python slicing s[:n] counts code points
  const SURR = /[\uD800-\uDFFF]/;
  function pySlice(s, n) {
    if (s.length <= n) return s;
    if (!SURR.test(s)) return s.slice(0, n);
    return Array.from(s).slice(0, n).join('');
  }
  // Python str.replace (all occurrences, literal)
  function replaceAll(s, a, b) { return s.indexOf(a) < 0 ? s : s.split(a).join(b); }

  // ---- numbers
  const P10 = [1, 10, 100, 1000, 10000, 100000, 1000000];
  // round(x) -> int, half-even
  function round0(x) {
    const f = Math.floor(x);
    const d = x - f;
    let r;
    if (d > 0.5) r = f + 1;
    else if (d < 0.5) r = f;
    else r = (f % 2 === 0) ? f : f + 1;
    return r || 0; // no negative zero for ints
  }
  // round(x, n) for floats: correctly rounded, half-even on exact binary ties
  function pyRound(x, n) {
    if (x !== x || x === Infinity || x === -Infinity) return x;
    if (n === 0) return round0(x);
    const p = P10[n];
    const y = x * p;
    const fl = Math.floor(y);
    const fr = y - fl;
    if ((fr < 0.4999 || fr > 0.5001) && y < 1e9 && y > -1e9) {
      const r = fr > 0.5 ? fl + 1 : fl;
      return (r === 0 && x < 0) ? -0 : r / p;
    }
    return roundSlow(x, n);
  }
  function roundSlow(x, n) {
    const p = P10[n];
    const ax = Math.abs(x);
    const t = ax * Math.pow(2, n + 1);
    if (Number.isInteger(t) && t < 9007199254740992 && t % 2 === 1) {
      // exact tie: |x| * 10^n = k + 1/2
      const big = t * Math.pow(5, n);
      if (big < 9007199254740992) {
        const k = (big - 1) / 2;
        const r = (k % 2 === 0) ? k : k + 1;
        const v = r / p;
        return x < 0 ? -v : v;
      }
    }
    if (ax >= 1e21) return x;
    return Number(x.toFixed(n));
  }
  const R = (v) => pyRound(v, 3);

  // format(x, '.nf') - Python rounds half-even on exact ties; toFixed rounds them away from zero
  function fmtF(x, n) {
    if (x !== x) return 'nan';
    if (x === Infinity) return 'inf';
    if (x === -Infinity) return '-inf';
    const ax = Math.abs(x);
    const t = ax * Math.pow(2, n + 1);
    if (Number.isInteger(t) && t < 9007199254740992 && t % 2 === 1 && ax < 1e15) {
      const big = t * Math.pow(5, n);
      if (big < 9007199254740992) {
        const k = (big - 1) / 2;
        const r = (k % 2 === 0) ? k : k + 1;
        let s = String(r);
        if (n > 0) {
          while (s.length <= n) s = '0' + s;
          s = s.slice(0, s.length - n) + '.' + s.slice(s.length - n);
        }
        return (x < 0 || Object.is(x, -0) ? '-' : '') + s;
      }
    }
    if (ax >= 1e21) return floatRepr(x);
    return x.toFixed(n);
  }
  // Python repr(float)
  function floatRepr(x) {
    if (x !== x) return 'nan';
    if (x === Infinity) return 'inf';
    if (x === -Infinity) return '-inf';
    if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
    const e = x.toExponential(); // shortest round-trip digits
    const m = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(e);
    const sign = m[1], digits = m[2] + (m[3] || ''), exp = parseInt(m[4], 10);
    const decpt = exp + 1;
    if (decpt > -4 && decpt <= 16) {
      let s;
      if (decpt <= 0) s = '0.' + '0'.repeat(-decpt) + digits;
      else if (decpt >= digits.length) s = digits + '0'.repeat(decpt - digits.length) + '.0';
      else s = digits.slice(0, decpt) + '.' + digits.slice(decpt);
      return sign + s;
    }
    const mant = digits.length > 1 ? digits[0] + '.' + digits.slice(1) : digits;
    const ae = Math.abs(exp);
    return sign + mant + 'e' + (exp < 0 ? '-' : '+') + (ae < 10 ? '0' + ae : String(ae));
  }
  // str() of a value that Python holds as int when 0 and as float otherwise (minTrack / minDrill)
  function numStr(x) { return x === 0 ? '0' : (Number.isInteger(x) ? floatRepr(x) : floatRepr(x)); }

  // float(x) with Python's accepted syntax; returns d for non-strings / invalid strings
  const FLOAT_SLOW = /^[+-]?(?:[0-9](?:_?[0-9])*(?:\.(?:[0-9](?:_?[0-9])*)?)?|\.[0-9](?:_?[0-9])*)(?:[eE][+-]?[0-9](?:_?[0-9])*)?$/;
  function fnum(x, d) {
    if (d === undefined) d = 0;
    if (typeof x !== 'string') return d;
    const c0 = x.charCodeAt(0);
    if ((c0 >= 48 && c0 <= 57) || c0 === 45 || c0 === 46 || c0 === 43) {
      const v = +x;
      if (v === v) {
        if (c0 === 48 && x.length > 2) {
          const c1 = x.charCodeAt(1) | 32;
          if (c1 === 120 || c1 === 98 || c1 === 111) return d; // 0x.. 0b.. 0o.. are not floats
        }
        return v;
      }
    }
    return floatSlow(x, d);
  }
  function floatSlow(x, d) {
    const t = x.replace(PY_WS_TRIM, '');
    if (!t) return d;
    const low = t.toLowerCase();
    const neg = low[0] === '-';
    const body = (low[0] === '+' || low[0] === '-') ? low.slice(1) : low;
    if (body === 'inf' || body === 'infinity') return neg ? -Infinity : Infinity;
    if (body === 'nan') return NaN;
    if (!FLOAT_SLOW.test(t)) return d;
    const v = Number(t.replace(/_/g, ''));
    return v === v ? v : d;
  }
  // int(s) for strings (ASCII digits); null when Python would raise ValueError
  function pyInt(s) {
    if (typeof s !== 'string') return null;
    const t = s.replace(PY_WS_TRIM, '');
    if (!/^[+-]?\d(?:_?\d)*$/.test(t)) return null;
    return parseInt(t.replace(/_/g, ''), 10);
  }

  // math.hypot - CPython 3.11 vector_norm for two coordinates (correctly rounded in practice)
  const _f64 = new Float64Array(1);
  const _u32 = new Uint32Array(_f64.buffer);
  const LE = (function () { _f64[0] = 1; return _u32[1] === 0x3ff00000; })();
  const HI = LE ? 1 : 0, LO = LE ? 0 : 1;
  function dlMulHi(x, y) { // Dekker product: returns [hi, lo]
    let t = x * 134217729.0;
    const xh = t - (t - x), xl = x - xh;
    t = y * 134217729.0;
    const yh = t - (t - y), yl = y - yh;
    const p = xh * yh;
    const q = xh * yl + xl * yh;
    const z = p + q;
    _dlLo = p - z + q + xl * yl;
    return z;
  }
  let _dlLo = 0;
  function hypot(a, b) {
    const x0 = Math.abs(a), y0 = Math.abs(b);
    if (x0 !== x0 || y0 !== y0) {
      if (x0 === Infinity || y0 === Infinity) return Infinity;
      return NaN;
    }
    const max = x0 > y0 ? x0 : y0;
    if (max === Infinity) return Infinity;
    if (max === 0) return 0;
    _f64[0] = max;
    const bexp = (_u32[HI] >>> 20) & 0x7ff;
    if (bexp === 0 || bexp >= 2045) return Math.hypot(a, b); // subnormal / huge: not reachable for PCB data
    const maxE = bexp - 1022; // frexp exponent: max = m * 2^maxE, m in [0.5, 1)
    _u32[HI] = (1023 - maxE) << 20; _u32[LO] = 0;
    const scale = _f64[0];
    let csum = 1.0, frac1 = 0.0, frac2 = 0.0;
    let x = x0 * scale;
    let hi = dlMulHi(x, x);
    frac1 += _dlLo;
    let s = csum + hi; frac2 += hi - (s - csum); csum = s;
    x = y0 * scale;
    hi = dlMulHi(x, x);
    frac1 += _dlLo;
    s = csum + hi; frac2 += hi - (s - csum); csum = s;
    let h = Math.sqrt(csum - 1.0 + (frac1 + frac2));
    hi = dlMulHi(-h, h);
    frac1 += _dlLo;
    s = csum + hi; frac2 += hi - (s - csum); csum = s;
    x = csum - 1.0 + (frac1 + frac2);
    h += x / (2.0 * h);
    return h / scale;
  }
  const DEG2RAD = Math.PI / 180.0;
  const RAD2DEG = 180.0 / Math.PI;

  // Python regex building blocks (str patterns are Unicode-aware)
  const PY_WS_CLASS = '\\t\\n\\v\\f\\r \\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
  const PY_WS_TRIM = new RegExp('^[' + PY_WS_CLASS + ']+|[' + PY_WS_CLASS + ']+$', 'g');
  function pyRe(src, flags) {
    // \w -> Unicode word, \d -> Unicode decimal, $ -> end or before a final newline
    const s = src.replace(/\\w/g, '[\\p{L}\\p{N}_]').replace(/\\d/g, '\\p{Nd}').replace(/\$(?![^[]*\])/g, '(?=\\n?$)');
    return new RegExp(s, (flags || '') + 'u');
  }
  const DIGITS_RE = /^\p{Nd}+$/u;

  // CPython 3.11 set of non-negative ints: reproduces iteration order (insert-only)
  class PySet {
    constructor(items) {
      this.mask = 7; this.table = new Array(8).fill(null); this.fill = 0; this.used = 0; this.set = new Set();
      if (items) for (const k of items) this.add(k);
    }
    has(k) { return this.set.has(k); }
    get size() { return this.used; }
    static _ins(table, mask, key) {
      let perturb = key;
      let i = key & mask;
      for (;;) {
        const probes = (i + 9 <= mask) ? 9 : 0;
        for (let k = 0; k <= probes; k++) {
          if (table[i + k] === null) { table[i + k] = key; return; }
        }
        perturb = Math.floor(perturb / 32);
        i = (i * 5 + 1 + perturb) & mask;
      }
    }
    add(k) {
      if (this.set.has(k)) return;
      this.set.add(k);
      PySet._ins(this.table, this.mask, k);
      this.fill++; this.used++;
      if (this.fill * 5 < this.mask * 3) return;
      const minused = this.used > 50000 ? this.used * 2 : this.used * 4;
      let size = 8;
      while (size <= minused) size *= 2;
      const old = this.table;
      this.table = new Array(size).fill(null);
      this.mask = size - 1;
      for (const key of old) if (key !== null) PySet._ins(this.table, this.mask, key);
      this.fill = this.used;
    }
    *[Symbol.iterator]() { for (const k of this.table) if (k !== null) yield k; }
    toArray() { return this.table.filter((k) => k !== null); }
  }

  // =====================================================================================
  // S-expression reader (sexpr.py)
  // =====================================================================================
  const WS = new Uint8Array(128);
  [9, 10, 11, 12, 13, 28, 29, 30, 31, 32].forEach((c) => { WS[c] = 1; });
  function wsHigh(c) {
    return c === 0x85 || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 ||
      c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000;
  }
  // quoted tokens that must stay distinguishable from bare flags (Python's Q class)
  const QFLAGS = new Set(['hide', 'dnp', 'exclude_from_bom', 'blind', 'micro']);

  // Index of the closing quote of the string starting at i, or -1 when Python's token regex would not
  // match it there (no closing quote before `end`, or a backslash followed by a newline).
  function scanString(text, i, end) {
    let j = i + 1;
    while (j < end) {
      const d = text.charCodeAt(j);
      if (d === 34) return j;
      if (d === 92) {
        if (j + 1 >= end) return -1;
        const e = text.charCodeAt(j + 1);
        if (e === 10 || e === 13) return -1; // Python's `\\.` does not match a newline
        j += 2;
        continue;
      }
      j++;
    }
    return -1;
  }
  function stringToken(text, i, j) {
    let s = text.slice(i + 1, j);
    if (s.indexOf('\r') >= 0) s = s.replace(/\r\n?/g, '\n'); // Python text mode: universal newlines
    if (s.indexOf('\\') >= 0) s = s.split('\\"').join('"').split('\\n').join('\n').split('\\\\').join('\\');
    return s;
  }

  // Parse text[start:end]; returns the first top-level list (auto-closes lists left open at `end`).
  function parseRange(text, start, end) {
    const top = [];
    const stack = [top];
    let cur = top;
    let i = start;
    while (i < end) {
      const c = text.charCodeAt(i);
      if (c === 40) { // (
        const l = [];
        cur.push(l); stack.push(l); cur = l; i++;
        continue;
      }
      if (c === 41) { // )
        if (stack.length > 1) { stack.pop(); cur = stack[stack.length - 1]; }
        i++;
        continue;
      }
      if (c < 128 ? WS[c] === 1 : wsHigh(c)) { i++; continue; }
      if (c === 34) { // "
        const j = scanString(text, i, end);
        if (j < 0) { i++; continue; } // unterminated: the regex skips the lone quote
        const s = stringToken(text, i, j);
        if (cur.length > 0 && (QFLAGS.has(s) || (cur[0] === 'net' && DIGITS_RE.test(s)))) (cur.q || (cur.q = [])).push(cur.length);
        cur.push(s);
        i = j + 1;
        continue;
      }
      let j = i + 1;
      while (j < end) {
        const d = text.charCodeAt(j);
        if (d === 40 || d === 41 || d === 34 || (d < 128 ? WS[d] === 1 : wsHigh(d))) break;
        j++;
      }
      cur.push(text.slice(i, j));
      i = j;
    }
    for (const t of top) if (Array.isArray(t)) return t;
    return [];
  }

  /** Parse KiCad s-expression text. Lists are arrays; tokens are strings. A list gets a `q`
   *  array of indices when it holds quoted strings that could be mistaken for bare flags. */
  function parseSexpr(text) { return parseRange(text, 0, text.length); }

  // ---- root adapters: the PCB builder only walks the root's direct children, so a large board can be
  // parsed one top-level child at a time (a pre-scan records child spans and head keywords).
  const HEAD_UNKNOWN = {};
  class ArrayRoot {
    constructor(arr) { this.a = arr; }
    find(key) { return find(this.a, key); }
    findall(key) { return findall(this.a, key); }
    val(key, idx, def) { return val(this.a, key, idx, def); }
    *each(heads) {
      const a = this.a;
      for (let i = 1; i < a.length; i++) {
        const c = a[i];
        if (Array.isArray(c) && c.length && heads.has(c[0])) yield c;
      }
    }
  }
  class LazyRoot {
    constructor(text) {
      this.text = text;
      const n = text.length;
      const starts = [], ends = [], heads = [];
      let i = 0, found = false;
      // the first top-level list is the root (as parseSexpr returns it)
      while (i < n) {
        const c = text.charCodeAt(i);
        if (c === 40) { found = true; i++; break; }
        if (c === 34) { const j = scanString(text, i, n); i = j < 0 ? i + 1 : j + 1; continue; }
        i++;
      }
      // root keyword (e.g. kicad_pcb)
      this.head = null;
      if (found) {
        let k = i;
        while (k < n) { const d = text.charCodeAt(k); if (d < 128 ? WS[d] === 1 : wsHigh(d)) k++; else break; }
        let j = k;
        while (j < n) {
          const e = text.charCodeAt(j);
          if (e === 40 || e === 41 || e === 34 || (e < 128 ? WS[e] === 1 : wsHigh(e))) break;
          j++;
        }
        this.head = text.slice(k, j);
      }
      while (found && i < n) {
        const c = text.charCodeAt(i);
        if (c === 41) break; // root closed
        if (c === 34) { const j = scanString(text, i, n); i = j < 0 ? i + 1 : j + 1; continue; }
        if (c !== 40) { i++; continue; }
        const s = i;
        // head token
        let k = i + 1;
        while (k < n) { const d = text.charCodeAt(k); if (d < 128 ? WS[d] === 1 : wsHigh(d)) k++; else break; }
        let head = null;
        if (k < n) {
          const d = text.charCodeAt(k);
          if (d === 34) {
            const j = scanString(text, k, n);
            head = j < 0 ? HEAD_UNKNOWN : stringToken(text, k, j);
          } else if (d !== 40 && d !== 41) {
            let j = k + 1;
            while (j < n) {
              const e = text.charCodeAt(j);
              if (e === 40 || e === 41 || e === 34 || (e < 128 ? WS[e] === 1 : wsHigh(e))) break;
              j++;
            }
            head = text.slice(k, j);
          }
        }
        // matching close paren
        let depth = 1;
        i++;
        while (i < n && depth > 0) {
          const d = text.charCodeAt(i);
          if (d === 40) depth++;
          else if (d === 41) depth--;
          else if (d === 34) { const j = scanString(text, i, n); i = j < 0 ? i + 1 : j + 1; continue; }
          i++;
        }
        starts.push(s); ends.push(i); heads.push(head);
      }
      this.starts = starts; this.ends = ends; this.heads = heads;
    }
    node(k) { return parseRange(this.text, this.starts[k], this.ends[k]); }
    match(k, key) {
      const h = this.heads[k];
      if (h === HEAD_UNKNOWN) { const n = this.node(k); return n.length > 0 && n[0] === key; }
      return h === key;
    }
    find(key) {
      for (let k = 0; k < this.heads.length; k++) if (this.match(k, key)) return this.node(k);
      return null;
    }
    findall(key) {
      const out = [];
      for (let k = 0; k < this.heads.length; k++) if (this.match(k, key)) out.push(this.node(k));
      return out;
    }
    val(key, idx, def) {
      if (idx === undefined) idx = 1;
      if (def === undefined) def = null;
      const c = this.find(key);
      if (c === null || c.length <= idx) return def;
      return c[idx];
    }
    *each(heads) {
      for (let k = 0; k < this.heads.length; k++) {
        const h = this.heads[k];
        if (h === HEAD_UNKNOWN) { const n = this.node(k); if (n.length && heads.has(n[0])) yield n; }
        else if (h !== null && heads.has(h)) yield this.node(k);
      }
    }
  }

  function isQ(n, i) { return !!(n.q && n.q.indexOf(i) >= 0); }
  function find(n, key) {
    if (!n) return null;
    for (let i = 1; i < n.length; i++) {
      const c = n[i];
      if (Array.isArray(c) && c.length && c[0] === key) return c;
    }
    return null;
  }
  function findall(n, key) {
    const out = [];
    if (!n) return out;
    for (let i = 1; i < n.length; i++) {
      const c = n[i];
      if (Array.isArray(c) && c.length && c[0] === key) out.push(c);
    }
    return out;
  }
  function val(n, key, idx, def) {
    if (idx === undefined) idx = 1;
    if (def === undefined) def = null;
    const c = find(n, key);
    if (c === null || c.length <= idx) return def;
    return c[idx];
  }
  function xy(n, key) {
    const c = find(n, key);
    if (c === null) return null;
    return [fnum(c[1], 0), fnum(c[2], 0)];
  }
  function at(n) {
    const c = find(n, 'at');
    if (c === null) return [0, 0, 0];
    return [fnum(c[1], 0), fnum(c[2], 0), c.length > 3 && !Array.isArray(c[3]) ? fnum(c[3], 0) : 0];
  }
  function hasFlag(n, flag) {
    for (let i = 1; i < n.length; i++) {
      const c = n[i];
      if (c === flag && !isQ(n, i)) return true;
      if (Array.isArray(c) && c.length && c[0] === flag) {
        if (c.length === 1 || c[1] === 'yes' || c[1] === 'true') return true;
      }
    }
    return false;
  }
  function pts(n) {
    const p = find(n, 'pts');
    const out = [];
    if (p === null) return out;
    for (let i = 1; i < p.length; i++) {
      const c = p[i];
      if (!Array.isArray(c) || !c.length) continue;
      if (c[0] === 'xy') out.push([fnum(c[1], 0), fnum(c[2], 0)]);
      else if (c[0] === 'arc') {
        const s = xy(c, 'start'), m = xy(c, 'mid'), e = xy(c, 'end');
        if (s && m && e) {
          const ap = arcPoints(s, m, e, 10);
          if (out.length) ap.pop();
          for (const q of ap) out.push(q);
        }
      }
    }
    return out;
  }
  const TWO_PI = 2 * Math.PI;
  function normAng(a) {
    while (a < 0) a += TWO_PI;
    while (a >= TWO_PI) a -= TWO_PI;
    return a;
  }
  function arcPoints(s, m, e, maxSeg) {
    if (maxSeg === undefined) maxSeg = 10;
    const x1 = s[0], y1 = s[1], x2 = m[0], y2 = m[1], x3 = e[0], y3 = e[1];
    const d = 2 * (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2));
    if (Math.abs(d) < 1e-12) return [s, e];
    const ux = ((x1 * x1 + y1 * y1) * (y2 - y3) + (x2 * x2 + y2 * y2) * (y3 - y1) + (x3 * x3 + y3 * y3) * (y1 - y2)) / d;
    const uy = ((x1 * x1 + y1 * y1) * (x3 - x2) + (x2 * x2 + y2 * y2) * (x1 - x3) + (x3 * x3 + y3 * y3) * (x2 - x1)) / d;
    const r = hypot(x1 - ux, y1 - uy);
    const a1 = Math.atan2(y1 - uy, x1 - ux);
    const a2 = Math.atan2(y2 - uy, x2 - ux);
    const a3 = Math.atan2(y3 - uy, x3 - ux);
    const ccw = normAng(a3 - a1);
    const sweep = normAng(a2 - a1) <= ccw ? ccw : ccw - 2 * Math.PI;
    const n = Math.max(2, Math.trunc(Math.abs(sweep * RAD2DEG) / maxSeg) + 1);
    const out = [];
    for (let i = 0; i <= n; i++) {
      const a = a1 + sweep * i / n;
      out.push([ux + r * Math.cos(a), uy + r * Math.sin(a)]);
    }
    return out;
  }

  // =====================================================================================
  // PCB (kicad_pcb.py)
  // =====================================================================================
  const KEEP_GFX = new Set(['F.SilkS', 'B.SilkS', 'Edge.Cuts', 'F.Fab', 'B.Fab', 'F.CrtYd', 'B.CrtYd', 'F.Mask', 'B.Mask']);
  const MASK_COLORS = {
    'green': '#1f6b3a', 'red': '#9c1c1c', 'blue': '#1f5fc2', 'black': '#141417', 'white': '#ecebe6',
    'purple': '#4b2a7a', 'yellow': '#c9a227', 'matte black': '#18181a', 'matte green': '#2a5a39', 'matte blue': '#1e4f9c',
  };
  const SILK_COLORS = { 'white': '#f4f4f0', 'black': '#111111', 'yellow': '#e8d24a' };
  const FP_SKIP_PROPS = new Set(['Reference', 'Value', 'Footprint', 'Sheetfile', 'Sheetname', 'ki_fp_filters', 'ki_description', 'ki_keywords', 'exclude_from_bom', 'dnp']);

  function rot(x, y, deg) {
    if (deg === 0) return [x, y];
    const a = deg * DEG2RAD;
    const c = Math.cos(a), s = Math.sin(a);
    return [x * c + y * s, -x * s + y * c];
  }

  function rdp(points, eps) {
    const n = points.length;
    if (n < 5) return points;
    const keep = new Uint8Array(n);
    keep[0] = 1; keep[n - 1] = 1;
    const stack = [0, n - 1];
    while (stack.length) {
      const j = stack.pop(), i = stack.pop();
      const x1 = points[i][0], y1 = points[i][1], x2 = points[j][0], y2 = points[j][1];
      const dx = x2 - x1, dy = y2 - y1;
      const L = hypot(dx, dy);
      let best = -1.0, bi = -1;
      for (let k = i + 1; k < j; k++) {
        const px = points[k][0], py = points[k][1];
        const d = L < 1e-9 ? hypot(px - x1, py - y1) : Math.abs(dy * px - dx * py + x2 * y1 - y2 * x1) / L;
        if (d > best) { best = d; bi = k; }
      }
      if (best > eps && bi > 0) {
        keep[bi] = 1;
        stack.push(i, bi, bi, j);
      }
    }
    const out = [];
    for (let k = 0; k < n; k++) if (keep[k]) out.push(points[k]);
    return out;
  }

  function widthOf(n, def) {
    const w = val(n, 'width');
    if (w !== null) return fnum(w, def);
    const st = find(n, 'stroke');
    if (st !== null) return fnum(val(st, 'width'), def);
    return def;
  }
  const FILL_YES = new Set(['solid', 'yes', 'true', 'color', 'background', 'outline_solid']);
  function fillOf(n, def) {
    let f = val(n, 'fill');
    if (f === null) {
      const fl = find(n, 'fill');
      if (fl !== null && fl.length > 1 && Array.isArray(fl[1])) f = val(fl, 'type');
    }
    if (f === null) return def;
    return typeof f === 'string' && FILL_YES.has(f);
  }

  function textEffects(n) {
    const eff = find(n, 'effects');
    let size = 1.0, thick = 0.15, just = '', mirror = false, hidden = false;
    if (eff !== null) {
      const font = find(eff, 'font');
      if (font !== null) {
        const s = find(font, 'size');
        if (s !== null) size = fnum(s.length > 2 ? s[2] : s[1], 1.0);
        thick = fnum(val(font, 'thickness'), size * 0.15);
      }
      const j = find(eff, 'justify');
      if (j !== null) {
        const js = [];
        for (let k = 1; k < j.length; k++) if (!Array.isArray(j[k])) js.push(S(j[k]));
        if (js.indexOf('mirror') >= 0) mirror = true;
        just = js.filter((t) => t === 'left' || t === 'right' || t === 'top' || t === 'bottom').map((t) => t[0]).join('');
      }
      if (hasFlag(eff, 'hide')) hidden = true;
    }
    if (hasFlag(n, 'hide')) hidden = true;
    return [size, thick, just, mirror, hidden];
  }

  function convexHull(points) {
    const seen = new Map();
    for (const p of points) {
      const x = pyRound(p[0], 4), y = pyRound(p[1], 4);
      const k = x + ',' + y;
      if (!seen.has(k)) seen.set(k, [x, y]);
    }
    const ps = Array.from(seen.values()).sort((a, b) => cmpNum(a[0], b[0]) || cmpNum(a[1], b[1]));
    if (ps.length <= 2) return ps;
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [], upper = [];
    for (const p of ps) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    }
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    return lower.slice(0, -1).concat(upper.slice(0, -1));
  }
  function polyArea(l) {
    let a = 0;
    const n = l.length;
    for (let i = 0; i < n; i++) {
      const p = l[i], q = l[(i + 1) % n];
      a += p[0] * q[1] - q[0] * p[1];
    }
    return a / 2;
  }
  function pointInPoly(p, poly) {
    const x = p[0], y = p[1];
    let inside = false;
    let j = poly.length - 1;
    for (let i = 0; i < poly.length; i++) {
      const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi) inside = !inside;
      j = i;
    }
    return inside;
  }
  function chainLoops(segs0, tol) {
    if (tol === undefined) tol = 0.02;
    const segs = [];
    for (const s of segs0) if (s.length >= 2) segs.push(s.slice());
    const loops = [];
    const used = new Uint8Array(segs.length);
    const idx = new Map();
    const kx = (p) => round0(p[0] / tol), ky = (p) => round0(p[1] / tol);
    const addIdx = (x, y, i) => { const k = x + ',' + y; let l = idx.get(k); if (!l) idx.set(k, l = []); l.push(i); };
    segs.forEach((s, i) => {
      addIdx(kx(s[0]), ky(s[0]), i);
      const e = s[s.length - 1];
      addIdx(kx(e), ky(e), i);
    });
    const near = (p) => {
      const a = kx(p), b = ky(p);
      const out = [];
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const l = idx.get((a + dx) + ',' + (b + dy));
          if (l) for (const v of l) out.push(v);
        }
      }
      return out;
    };
    for (let i = 0; i < segs.length; i++) {
      if (used[i]) continue;
      used[i] = 1;
      const chain = segs[i].slice();
      for (let it = 0; it < segs.length + 1; it++) {
        const end = chain[chain.length - 1];
        if (hypot(end[0] - chain[0][0], end[1] - chain[0][1]) < tol && chain.length > 2) break;
        let found = false;
        for (const j of near(end)) {
          if (used[j]) continue;
          const s = segs[j];
          const last = s[s.length - 1];
          if (hypot(s[0][0] - end[0], s[0][1] - end[1]) < tol) {
            for (let q = 1; q < s.length; q++) chain.push(s[q]);
          } else if (hypot(last[0] - end[0], last[1] - end[1]) < tol) {
            for (let q = s.length - 2; q >= 0; q--) chain.push(s[q]);
          } else continue;
          used[j] = 1;
          found = true;
          break;
        }
        if (!found) break;
      }
      if (chain.length > 2 && hypot(chain[chain.length - 1][0] - chain[0][0], chain[chain.length - 1][1] - chain[0][1]) < tol) chain.pop();
      loops.push(chain);
    }
    return loops;
  }

  function flatR(points) {
    const out = new Array(points.length * 2);
    for (let i = 0; i < points.length; i++) { out[2 * i] = R(points[i][0]); out[2 * i + 1] = R(points[i][1]); }
    return out;
  }

  /** Parse .kicad_pcb text into the viewer's compact board object (same as kicad_pcb.parse_pcb). */
  function parsePcb(text, boardCfg) { return drain(pcbGen(new LazyRoot(text), boardCfg)); }
  /** Same as parsePcb for an already parsed tree (parseSexpr output). */
  function pcbFromTree(tree, boardCfg) { return drain(pcbGen(new ArrayRoot(tree), boardCfg)); }
  function drain(gen) { for (;;) { const r = gen.next(); if (r.done) return r.value; } }
  const FP_HEADS = new Set(['footprint', 'module']);
  const GR_HEADS = new Set(['gr_line', 'gr_rect', 'gr_arc', 'gr_circle', 'gr_poly', 'gr_curve', 'gr_text']);
  const TRACK_HEADS = new Set(['segment', 'arc', 'via']);
  const ZONE_HEADS = new Set(['zone']);

  // Generator: yields now and then so importProject can keep the page responsive.
  function* pcbGen(root, boardCfg) {
    let ops = 0;
    const netIdx = new Map([['', 0]]);
    const nets = [''];
    const numNames = new Map();
    const nameToIdx = (name) => {
      let i = netIdx.get(name);
      if (i === undefined) { i = nets.length; netIdx.set(name, i); nets.push(name); }
      return i;
    };
    const netOf = (node) => {
      const n = find(node, 'net');
      if (n === null) return 0;
      let name;
      if (n.length >= 3) name = n[2];
      else if (n.length === 2) {
        const v = n[1];
        if (isQ(n, 1) || !DIGITS_RE.test(S(v))) name = v;
        else name = numNames.has(v) ? numNames.get(v) : '';
      } else return 0;
      return nameToIdx(S(name));
    };

    const version = root.val('version', 1, '?');
    const genVer = root.val('generator_version') || '';
    for (const n of root.findall('net')) {
      if (n.length >= 3) {
        numNames.set(S(n[1]), S(n[2]));
        nameToIdx(S(n[2]));
      }
    }
    const general = root.find('general');
    const thickness = general ? fnum(val(general, 'thickness'), 1.6) : 1.6;

    // layers
    const layersNode = root.find('layers');
    const cuLayers = [];
    if (layersNode) {
      for (let i = 1; i < layersNode.length; i++) {
        const l = layersNode[i];
        if (Array.isArray(l) && l.length >= 3) {
          const name = S(l[1]);
          if (name.endsWith('.Cu')) cuLayers.push(name);
        }
      }
    }
    const cuKey = (n) => {
      if (n === 'F.Cu') return 0;
      if (n === 'B.Cu') return 999;
      const m = /^In(\d+)\.Cu/.exec(n);
      return m ? parseInt(m[1], 10) : 500;
    };
    cuLayers.sort((a, b) => cuKey(a) - cuKey(b));

    // stackup colours
    let maskColor = null, silkColor = null, finish = null;
    const setup = root.find('setup');
    if (setup !== null) {
      const st = find(setup, 'stackup');
      if (st !== null) {
        finish = val(st, 'copper_finish');
        for (const l of findall(st, 'layer')) {
          const nm = S(l[1]);
          const c = val(l, 'color');
          if (c === null) continue;
          if (nm === 'F.Mask') maskColor = S(c);
          if (nm === 'F.SilkS') silkColor = S(c);
        }
      }
    }
    const cfg = boardCfg || {};
    if (own(cfg, 'mask')) maskColor = cfg.mask;
    if (own(cfg, 'silk')) silkColor = cfg.silk;
    const colorHex = (name, table, def) => {
      if (!name) return def;
      if (name.startsWith('#')) return name.slice(0, 7);
      return get(table, name.toLowerCase(), def);
    };

    const gfx = {};
    const G = (layer) => {
      let g = own(gfx, layer) ? gfx[layer] : undefined;
      if (g === undefined) { g = { lines: [], polys: [], circles: [], texts: [] }; put(gfx, layer, g); }
      return g;
    };
    const edgeSegments = [];
    const edgeCircles = [];

    const addGraphic = (n, tf) => {
      const kind = n[0];
      const layer = S(val(n, 'layer', 1, ''));
      const cu = layer.endsWith('.Cu');
      if (!KEEP_GFX.has(layer) && !cu) return;
      const w = widthOf(n, 0.1);
      const g = G(layer);
      const k = (kind.startsWith('fp_') || kind.startsWith('gr_')) ? kind.slice(3) : kind;
      if (k === 'line') {
        let s = xy(n, 'start'), e = xy(n, 'end');
        if (!s || !e) return;
        s = tf(s[0], s[1]); e = tf(e[0], e[1]);
        g.lines.push(R(s[0]), R(s[1]), R(e[0]), R(e[1]), R(w));
        if (layer === 'Edge.Cuts') edgeSegments.push([s, e]);
      } else if (k === 'rect') {
        const s = xy(n, 'start'), e = xy(n, 'end');
        if (!s || !e) return;
        const corners = [tf(s[0], s[1]), tf(e[0], s[1]), tf(e[0], e[1]), tf(s[0], e[1])];
        const filled = fillOf(n, false);
        g.polys.push({ p: flatR(corners), w: R(w), f: filled ? 1 : 0 });
        if (layer === 'Edge.Cuts') edgeSegments.push(corners.concat([corners[0]]));
      } else if (k === 'arc') {
        const s = xy(n, 'start'), m = xy(n, 'mid'), e = xy(n, 'end');
        if (!(s && m && e)) return;
        const ps = arcPoints(s, m, e, 10).map((p) => tf(p[0], p[1]));
        for (let i = 0; i + 1 < ps.length; i++) {
          const a = ps[i], b = ps[i + 1];
          g.lines.push(R(a[0]), R(a[1]), R(b[0]), R(b[1]), R(w));
        }
        if (layer === 'Edge.Cuts') edgeSegments.push(ps);
      } else if (k === 'circle') {
        const c = xy(n, 'center'), e = xy(n, 'end');
        if (!c || !e) return;
        const r = hypot(e[0] - c[0], e[1] - c[1]);
        const cc = tf(c[0], c[1]);
        const filled = fillOf(n, false);
        g.circles.push(R(cc[0]), R(cc[1]), R(r), R(w), filled ? 1 : 0);
        if (layer === 'Edge.Cuts') edgeCircles.push([cc[0], cc[1], r]);
      } else if (k === 'poly') {
        let p = pts(n);
        if (p.length < 2) return;
        p = p.map((q) => tf(q[0], q[1]));
        const filled = fillOf(n, true);
        g.polys.push({ p: flatR(p), w: R(w), f: filled ? 1 : 0 });
        if (layer === 'Edge.Cuts') edgeSegments.push(p.concat([p[0]]));
      } else if (k === 'curve') {
        const p = pts(n);
        if (p.length === 4) {
          let bez = [];
          for (let i = 0; i < 13; i++) {
            const t = i / 12;
            const mt = 1 - t;
            bez.push([mt ** 3 * p[0][0] + 3 * mt * mt * t * p[1][0] + 3 * mt * t * t * p[2][0] + t ** 3 * p[3][0],
              mt ** 3 * p[0][1] + 3 * mt * mt * t * p[1][1] + 3 * mt * t * t * p[2][1] + t ** 3 * p[3][1]]);
          }
          bez = bez.map((q) => tf(q[0], q[1]));
          for (let i = 0; i + 1 < bez.length; i++) {
            const a = bez[i], b = bez[i + 1];
            g.lines.push(R(a[0]), R(a[1]), R(b[0]), R(b[1]), R(w));
          }
          if (layer === 'Edge.Cuts') edgeSegments.push(bez);
        }
      }
    };
    const ident = (x, y) => [x, y];

    // ---------------- footprints
    const fps = [];
    const pads = [];
    for (const fp of root.each(FP_HEADS)) {
      if ((++ops & 63) === 0) yield;
      const fpname = S(fp[1]);
      const side = S(val(fp, 'layer', 1, 'F.Cu')) === 'B.Cu' ? 1 : 0;
      const [fx, fy, frot] = at(fp);
      const tf = (x, y) => { const r = rot(x, y, frot); return [fx + r[0], fy + r[1]]; };

      const props = new Map();
      let ref = '', value = '';
      for (const p of findall(fp, 'property')) {
        if (p.length >= 3) props.set(S(p[1]), S(p[2]));
      }
      for (const t of findall(fp, 'fp_text')) {
        if (t.length >= 3 && t[1] === 'reference') ref = S(t[2]);
        else if (t.length >= 3 && t[1] === 'value') value = S(t[2]);
      }
      if (props.has('Reference')) ref = props.get('Reference');
      if (props.has('Value')) value = props.get('Value');
      const attr = find(fp, 'attr');
      const attrs = attr !== null ? attr.slice(1).map(S) : [];
      const kind = attrs.indexOf('smd') >= 0 ? 'smd' : (attrs.indexOf('through_hole') >= 0 ? 'th' : '');
      const dnp = attrs.indexOf('dnp') >= 0 || hasFlag(fp, 'dnp');
      const nobom = attrs.indexOf('exclude_from_bom') >= 0 || hasFlag(fp, 'exclude_from_bom') || props.has('exclude_from_bom');
      const boardOnly = attrs.indexOf('board_only') >= 0;
      let model = null;
      const m = find(fp, 'model');
      if (m !== null) {
        const parts = replaceAll(S(m[1]), '\\', '/').split('/');
        model = parts[parts.length - 1];
        if (hasFlag(m, 'hide')) model = null;
      }
      const descr = S(val(fp, 'descr', 1, '') || '');

      const fabPts = [], crtPts = [], silkPts = [];
      for (let gi = 1; gi < fp.length; gi++) {
        const g = fp[gi];
        if (!Array.isArray(g) || !g.length) continue;
        const g0 = g[0];
        if (g0 === 'fp_line' || g0 === 'fp_rect' || g0 === 'fp_arc' || g0 === 'fp_circle' || g0 === 'fp_poly' || g0 === 'fp_curve') {
          const lay = S(val(g, 'layer', 1, ''));
          addGraphic(g, tf);
          let lp = [];
          for (const key of ['start', 'end', 'mid', 'center']) {
            const q = xy(g, key);
            if (q) lp.push(q);
          }
          if (g0 === 'fp_circle') {
            const c = xy(g, 'center'), e = xy(g, 'end');
            if (c && e) {
              const r = hypot(e[0] - c[0], e[1] - c[1]);
              lp = [[c[0] - r, c[1] - r], [c[0] + r, c[1] + r]];
            }
          }
          if (g0 === 'fp_poly' || g0 === 'fp_curve') lp = pts(g);
          if (lay.endsWith('.Fab')) { for (const q of lp) fabPts.push(q); }
          else if (lay.endsWith('.CrtYd')) { for (const q of lp) crtPts.push(q); }
          else if (lay.endsWith('.SilkS')) { for (const q of lp) silkPts.push(q); }
        } else if (g0 === 'fp_text' || g0 === 'property') {
          let txt;
          if (g0 === 'fp_text') {
            const kindt = S(g[1]);
            txt = g.length > 2 ? S(g[2]) : '';
            if (kindt === 'value') continue;
          } else {
            if (g.length < 3 || S(g[1]) !== 'Reference' || find(g, 'at') === null) continue;
            txt = S(g[2]);
          }
          const lay = S(val(g, 'layer', 1, ''));
          if (!lay.endsWith('.SilkS') && !lay.endsWith('.Fab')) continue;
          const [size, thick, just, mirror, hidden] = textEffects(g);
          if (hidden) continue;
          txt = replaceAll(replaceAll(txt, '${REFERENCE}', ref), '%R', ref);
          if (!txt || txt.indexOf('${') >= 0) continue;
          const [tx, ty, ta] = at(g);
          const pp = tf(tx, ty);
          G(lay).texts.push([txt, R(pp[0]), R(pp[1]), R(size), R(ta), just, mirror ? 1 : 0, R(thick)]);
        }
      }

      // pads
      const padIds = [];
      const pbox = [];
      for (const pd of findall(fp, 'pad')) {
        const num = S(pd[1]);
        const ptype = S(pd[2]);
        const shape = S(pd[3]);
        const [px, py, prot] = at(pd);
        const sz = find(pd, 'size');
        const w = sz ? fnum(sz[1], 0) : 0;
        const h = sz && sz.length > 2 ? fnum(sz[2], 0) : w;
        const bxy = tf(px, py);
        const layNode = find(pd, 'layers');
        const lays = layNode ? layNode.slice(1).map(S) : [];
        let mask = 0;
        for (const L of lays) {
          if (L === '*.Cu' || L === 'F&B.Cu') mask |= 1 | 2 | 4;
          else if (L === 'F.Cu') mask |= 1;
          else if (L === 'B.Cu') mask |= 2;
          else if (L.startsWith('In') && L.endsWith('.Cu')) mask |= 4;
          else if (L === '*.Mask') mask |= 8 | 16;
          else if (L === 'F.Mask') mask |= 8;
          else if (L === 'B.Mask') mask |= 16;
        }
        const dr = find(pd, 'drill');
        let dw = 0, dh = 0;
        if (dr !== null) {
          const vals = dr.slice(1).filter((x) => !Array.isArray(x));
          if (vals.length && vals[0] === 'oval') {
            dw = vals.length > 1 ? fnum(vals[1], 0) : 0;
            dh = vals.length > 2 ? fnum(vals[2], 0) : dw;
          } else if (vals.length) {
            dw = dh = fnum(vals[0], 0);
          }
        }
        const rr = fnum(val(pd, 'roundrect_rratio'), 0.25);
        const t = get({ thru_hole: 1, np_thru_hole: 2, smd: 0, connect: 3 }, ptype, 0);
        const sc = get({ circle: 0, rect: 1, oval: 2, roundrect: 3, trapezoid: 1, custom: 4 }, shape, 1);
        let poly = null;
        if (shape === 'custom') {
          const prims = find(pd, 'primitives');
          poly = [];
          if (prims !== null) {
            for (let k = 1; k < prims.length; k++) {
              const pr = prims[k];
              if (!Array.isArray(pr) || !pr.length) continue;
              if (pr[0] === 'gr_poly') {
                const q = pts(pr);
                if (q.length) poly.push(flatR(q));
              } else if (pr[0] === 'gr_rect') {
                const s = xy(pr, 'start'), e = xy(pr, 'end');
                if (s && e) poly.push([R(s[0]), R(s[1]), R(e[0]), R(s[1]), R(e[0]), R(e[1]), R(s[0]), R(e[1])]);
              } else if (pr[0] === 'gr_circle') {
                const c = xy(pr, 'center'), e = xy(pr, 'end');
                if (c && e) {
                  const r = hypot(e[0] - c[0], e[1] - c[1]);
                  const ring = [];
                  for (let i = 0; i < 16; i++) {
                    ring.push(R(c[0] + r * Math.cos(i * Math.PI / 8)), R(c[1] + r * Math.sin(i * Math.PI / 8)));
                  }
                  poly.push(ring);
                }
              }
            }
          }
        }
        const netid = netOf(pd);
        const pf = S(val(pd, 'pinfunction', 1, '') || '');
        const pt = S(val(pd, 'pintype', 1, '') || '');
        const entry = [fps.length, num, t, sc, R(bxy[0]), R(bxy[1]), R(w), R(h), R(prot), mask, netid, R(dw), R(dh), R(rr), pf, pt];
        if (poly && poly.length) entry.push(poly);
        padIds.push(pads.length);
        pads.push(entry);
        const rel = prot - frot;
        const hw = w / 2, hh = h / 2;
        for (const [cx, cy] of [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]) {
          const o = rot(cx, cy, rel);
          pbox.push([px + o[0], py + o[1]]);
        }
      }

      const bb = (ps) => {
        if (!ps.length) return null;
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const p of ps) {
          if (p[0] < x0) x0 = p[0];
          if (p[0] > x1) x1 = p[0];
          if (p[1] < y0) y0 = p[1];
          if (p[1] > y1) y1 = p[1];
        }
        return [R(x0), R(y0), R(x1), R(y1)];
      };
      let body = bb(fabPts);
      let srcBody = 'fab';
      const crt = bb(crtPts);
      if (body === null || (body[2] - body[0]) < 0.05 || (body[3] - body[1]) < 0.05) {
        if (crt !== null) {
          const inset = 0.2;
          body = [crt[0] + inset, crt[1] + inset, crt[2] - inset, crt[3] - inset];
          srcBody = 'crt';
        } else {
          body = bb(pbox);
          srcBody = 'pad';
        }
      }
      let crtBoard = null;
      if (crtPts.length) crtBoard = flatR(convexHull(crtPts.map((p) => tf(p[0], p[1]))));

      const ci = fpname.indexOf(':');
      const rec = {
        r: ref, v: value, fp: fpname.split(':').pop(), lib: ci >= 0 ? fpname.slice(0, ci) : '',
        s: side, x: R(fx), y: R(fy), a: R(frot), k: kind,
        b: body, bs: srcBody, pads: padIds,
      };
      if (crtBoard && crtBoard.length) rec.c = crtBoard;
      if (dnp) rec.dnp = 1;
      if (nobom) rec.nb = 1;
      if (boardOnly) rec.bo = 1;
      if (model) rec.m = model;
      if (descr) rec.d = pySlice(descr, 160);
      const extra = {};
      let nExtra = 0;
      for (const [k, v] of props) {
        if (!FP_SKIP_PROPS.has(k) && v && v !== '~') { put(extra, k, v); nExtra++; }
      }
      if (nExtra) rec.p = extra;
      fps.push(rec);
    }

    // ---------------- board-level graphics
    for (const g of root.each(GR_HEADS)) {
      if ((++ops & 255) === 0) yield;
      const g0 = g[0];
      if (g0 === 'gr_line' || g0 === 'gr_rect' || g0 === 'gr_arc' || g0 === 'gr_circle' || g0 === 'gr_poly' || g0 === 'gr_curve') {
        addGraphic(g, ident);
      } else if (g0 === 'gr_text') {
        const lay = S(val(g, 'layer', 1, ''));
        if (lay.endsWith('.SilkS') || lay.endsWith('.Cu')) {
          const [size, thick, just, mirror, hidden] = textEffects(g);
          if (hidden) continue;
          const [tx, ty, ta] = at(g);
          G(lay).texts.push([S(g[1]), R(tx), R(ty), R(size), R(ta), just, mirror ? 1 : 0, R(thick)]);
        }
      }
    }

    // ---------------- tracks & vias
    const tracks = {};
    const vias = [];
    const trackLen = new Map();
    let minW = 99;
    for (const t of root.each(TRACK_HEADS)) {
      if ((++ops & 1023) === 0) yield;
      if (t[0] === 'segment' || t[0] === 'arc') {
        const layer = S(val(t, 'layer', 1, 'F.Cu'));
        const w = fnum(val(t, 'width'), 0.2);
        const nid = netOf(t);
        const s = xy(t, 'start'), e = xy(t, 'end');
        if (!s || !e) continue;
        let ps;
        if (t[0] === 'arc') {
          const m = xy(t, 'mid');
          ps = m ? arcPoints(s, m, e, 15) : [s, e];
        } else ps = [s, e];
        let arr = own(tracks, layer) ? tracks[layer] : undefined;
        if (arr === undefined) { arr = []; put(tracks, layer, arr); }
        const rw = R(w);
        for (let i = 0; i + 1 < ps.length; i++) {
          const a = ps[i], b = ps[i + 1];
          arr.push(R(a[0]), R(a[1]), R(b[0]), R(b[1]), rw, nid);
          trackLen.set(nid, (trackLen.has(nid) ? trackLen.get(nid) : 0) + hypot(b[0] - a[0], b[1] - a[1]));
        }
        if (w > 0) minW = Math.min(minW, w);
      } else if (t[0] === 'via') {
        const [x, y] = at(t);
        const size = fnum(val(t, 'size'), 0.6);
        const drill = fnum(val(t, 'drill'), 0.3);
        const vt = hasFlag(t, 'blind') ? 1 : (hasFlag(t, 'micro') ? 2 : 0);
        const vl = find(t, 'layers');
        let l1 = 'F.Cu', l2 = 'B.Cu';
        if (vl !== null && vl.length >= 3) { l1 = S(vl[1]); l2 = S(vl[2]); }
        const rx = R(x), ry = R(y), rs = R(size), rd = R(drill);
        const nid = netOf(t);
        const i1 = cuLayers.indexOf(l1), i2 = cuLayers.indexOf(l2);
        vias.push([rx, ry, rs, rd, nid, vt, i1 >= 0 ? i1 : 0, i2 >= 0 ? i2 : cuLayers.length - 1]);
      }
    }

    // ---------------- zones
    const zones = [];
    const zoneOutlines = [];
    let nptsBefore = 0, nptsAfter = 0;
    for (const z of root.each(ZONE_HEADS)) {
      yield;
      let nid = netOf(z);
      if (nid === 0) {
        const nn = val(z, 'net_name');
        if (nn) nid = nameToIdx(S(nn));
      }
      const isKeepout = find(z, 'keepout') !== null;
      const zl = find(z, 'layers');
      const zlays = zl !== null ? zl.slice(1).map(S) : [S(val(z, 'layer', 1, ''))];
      const outline = find(z, 'polygon');
      const filled = findall(z, 'filled_polygon');
      if (outline !== null) {
        const op = pts(outline);
        zoneOutlines.push({ n: nid, l: zlays, k: isKeepout ? 1 : 0, p: flatR(op), f: filled.length });
      }
      for (const fpoly of filled) {
        yield;
        const lay = S(val(fpoly, 'layer', 1, zlays.length ? zlays[0] : 'F.Cu'));
        const p = pts(fpoly);
        nptsBefore += p.length;
        let p2;
        if (p.length > 8) { p2 = rdp(p.concat([p[0]]), 0.015); p2.pop(); } else p2 = p;
        nptsAfter += p2.length;
        zones.push({ n: nid, l: lay, p: flatR(p2) });
      }
    }

    // ---------------- outline
    let loops = chainLoops(edgeSegments);
    for (const [cx, cy, r] of edgeCircles) {
      const l = [];
      for (let i = 0; i < 48; i++) l.push([cx + r * Math.cos(i * Math.PI / 24), cy + r * Math.sin(i * Math.PI / 24)]);
      loops.push(l);
    }
    loops = loops.filter((l) => l.length >= 3);
    const areas = new Map(loops.map((l) => [l, -Math.abs(polyArea(l))]));
    loops.sort((a, b) => cmpNum(areas.get(a), areas.get(b)));
    let outer = [];
    const holes = [];
    for (const l of loops) {
      if (outer.some((o) => pointInPoly(l[0], o))) holes.push(l);
      else outer.push(l);
    }
    let allpts = [];
    for (const l of outer) for (const p of l) allpts.push(p);
    if (!allpts.length) {
      const xs = fps.length ? fps.map((f) => f.x) : [0];
      const ys = fps.length ? fps.map((f) => f.y) : [0];
      const mnx = minOf(xs), mny = minOf(ys), mxx = maxOf(xs), mxy = maxOf(ys);
      allpts = [[mnx - 5, mny - 5], [mxx + 5, mxy + 5]];
      outer = [[[mnx - 5, mny - 5], [mxx + 5, mny - 5], [mxx + 5, mxy + 5], [mnx - 5, mxy + 5]]];
    }
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (const p of allpts) {
      if (p[0] < bx0) bx0 = p[0];
      if (p[0] > bx1) bx1 = p[0];
      if (p[1] < by0) by0 = p[1];
      if (p[1] > by1) by1 = p[1];
    }

    const gfxOut = {};
    for (const k of Object.keys(gfx)) {
      const v = gfx[k];
      if (v.lines.length || v.polys.length || v.circles.length || v.texts.length) put(gfxOut, k, v);
    }
    const drills = [];
    for (const v of vias) drills.push(v[3]);
    for (const p of pads) if (p[11] > 0) drills.push(p[11]);
    const minDrill = drills.length ? minOf(drills) : 0;
    const tl = {};
    for (const [k, v] of trackLen) put(tl, String(k), R(v));
    const fin = finish || 'Not specified';
    return {
      meta: {
        kicad: S(version), gen: S(genVer), thickness: R(thickness), cu: cuLayers,
        bbox: [R(bx0), R(by0), R(bx1), R(by1)], w: R(bx1 - bx0), h: R(by1 - by0),
        mask: colorHex(maskColor, MASK_COLORS, '#1f6b3a'), maskName: maskColor || 'Green (default)',
        silk: colorHex(silkColor, SILK_COLORS, '#f4f4f0'), finish: S(fin),
        minTrack: R(minW < 99 ? minW : 0), minDrill: R(minDrill),
        zonePts: [nptsBefore, nptsAfter],
      },
      outline: { outer: outer.map(flatR), holes: holes.map(flatR) },
      nets: nets,
      fps: fps,
      pads: pads,
      tracks: tracks,
      vias: vias,
      zones: zones,
      zoneOutlines: zoneOutlines,
      gfx: gfxOut,
      trackLen: tl,
    };
  }
  function minOf(a) { let m = Infinity; for (const v of a) if (v < m) m = v; return m; }
  function maxOf(a) { let m = -Infinity; for (const v of a) if (v > m) m = v; return m; }

  // =====================================================================================
  // Schematic (kicad_sch.py)
  // =====================================================================================
  const PAPER = {
    A5: [210, 148], A4: [297, 210], A3: [420, 297], A2: [594, 420], A1: [841, 594], A0: [1189, 841],
    A: [279.4, 215.9], B: [431.8, 279.4], C: [558.8, 431.8], D: [863.6, 558.8], E: [1117.6, 863.6],
    USLetter: [279.4, 215.9], USLegal: [355.6, 215.9], USLedger: [431.8, 279.4],
  };

  function symXf(lx, ly, angle, mirror) {
    let x = lx, y = -ly;
    const a = angle * DEG2RAD;
    const c = round0(Math.cos(a)), s = round0(Math.sin(a));
    const nx = x * c + y * s, ny = -x * s + y * c;
    x = nx; y = ny;
    if (mirror === 'x') y = -y;
    else if (mirror === 'y') x = -x;
    return [x, y];
  }
  function strokeW(n) {
    const st = find(n, 'stroke');
    if (st !== null) return fnum(val(st, 'width'), 0);
    return fnum(val(n, 'width'), 0);
  }
  function fillT(n) {
    const f = find(n, 'fill');
    if (f === null) return 0;
    const t = S(val(f, 'type'));
    return t === 'outline' ? 1 : t === 'background' ? 2 : t === 'color' ? 1 : 0;
  }
  const JUST4 = new Set(['left', 'right', 'top', 'bottom']);
  function fontSize(n, def) {
    if (def === undefined) def = 1.27;
    const eff = find(n, 'effects');
    if (eff === null) return [def, '', false];
    const font = find(eff, 'font');
    let size = def;
    if (font !== null) {
      const s = find(font, 'size');
      if (s !== null) size = fnum(s[1], def);
    }
    const j = find(eff, 'justify');
    let just = '';
    if (j !== null) {
      const strs = j.slice(1).map(S);
      just = strs.filter((t) => JUST4.has(t)).map((t) => t[0]).join('');
      if (strs.indexOf('mirror') >= 0) just += 'm';
    }
    return [size, just, hasFlag(eff, 'hide')];
  }
  function rsplit2(s) {
    const a = s.lastIndexOf('_');
    if (a < 0) return [s];
    const b = a > 0 ? s.lastIndexOf('_', a - 1) : -1;
    if (b < 0) return [s.slice(0, a), s.slice(a + 1)];
    return [s.slice(0, b), s.slice(b + 1, a), s.slice(a + 1)];
  }
  function bezier(p, steps) {
    const bz = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const mt = 1 - t;
      bz.push([mt ** 3 * p[0][0] + 3 * mt * mt * t * p[1][0] + 3 * mt * t * t * p[2][0] + t ** 3 * p[3][0],
        mt ** 3 * p[0][1] + 3 * mt * mt * t * p[1][1] + 3 * mt * t * t * p[2][1] + t ** 3 * p[3][1]]);
    }
    return bz;
  }

  function parseLibSymbol(sym) {
    const out = { u: {}, n: 1 };
    if (find(sym, 'power') !== null) out.pw = 1;
    const pn = find(sym, 'pin_names');
    if (pn !== null) {
      out.po = R(fnum(val(pn, 'offset'), 0.508));
      if (hasFlag(pn, 'hide')) out.hpn = 1;
    } else out.po = 0.508;
    const pnum = find(sym, 'pin_numbers');
    if (pnum !== null && hasFlag(pnum, 'hide')) out.hpnum = 1;
    const props = new Map();
    for (const p of findall(sym, 'property')) if (p.length >= 3) props.set(S(p[1]), S(p[2]));
    out.desc = pySlice(props.has('ki_description') ? props.get('ki_description') : (props.has('Description') ? props.get('Description') : ''), 200);
    const units = new Set();
    for (const sub of findall(sym, 'symbol')) {
      const sname = S(sub[1]);
      const parts = rsplit2(sname);
      let u = 0, s = 1;
      if (parts.length >= 2) {
        const a = pyInt(parts[parts.length - 2]), b = pyInt(parts[parts.length - 1]);
        if (a !== null && b !== null) { u = a; s = b; }
      }
      units.add(u);
      const prims = [];
      for (let gi = 1; gi < sub.length; gi++) {
        const g = sub[gi];
        if (!Array.isArray(g) || !g.length) continue;
        const k = g[0];
        if (k === 'rectangle') {
          const a = xy(g, 'start'), b = xy(g, 'end');
          if (a && b) prims.push(['r', R(a[0]), R(a[1]), R(b[0]), R(b[1]), R(strokeW(g)), fillT(g)]);
        } else if (k === 'polyline') {
          prims.push(['p', flatR(pts(g)), R(strokeW(g)), fillT(g)]);
        } else if (k === 'circle') {
          const c = xy(g, 'center');
          if (c) prims.push(['c', R(c[0]), R(c[1]), R(fnum(val(g, 'radius'), 0)), R(strokeW(g)), fillT(g)]);
        } else if (k === 'arc') {
          const s_ = xy(g, 'start'), m_ = xy(g, 'mid'), e_ = xy(g, 'end');
          if (s_ && m_ && e_) prims.push(['p', flatR(arcPoints(s_, m_, e_, 12)), R(strokeW(g)), fillT(g)]);
        } else if (k === 'bezier') {
          const p = pts(g);
          if (p.length === 4) prims.push(['p', flatR(bezier(p, 10)), R(strokeW(g)), fillT(g)]);
        } else if (k === 'text') {
          const [tx, ty, ta] = at(g);
          const [size, just, hidden] = fontSize(g);
          if (!hidden) prims.push(['t', S(g[1]), R(tx), R(ty), R(size), R(ta > 360 ? ta / 10 : ta), just]);
        } else if (k === 'pin') {
          const etype = S(g[1]);
          const shape = S(g[2]);
          const [px, py, pa] = at(g);
          const ln = fnum(val(g, 'length'), 2.54);
          const nm = find(g, 'name');
          const nu = find(g, 'number');
          const pname = nm !== null ? S(nm[1]) : '';
          const pnumv = nu !== null ? S(nu[1]) : '';
          const nsize = nm !== null ? fontSize(nm)[0] : 1.27;
          const usize = nu !== null ? fontSize(nu)[0] : 1.27;
          const hidden = hasFlag(g, 'hide');
          prims.push(['P', R(px), R(py), R(pa), R(ln), pname, pnumv, etype, shape, hidden ? 1 : 0, R(nsize), R(usize)]);
        }
      }
      const key = String(u) + '_' + String(s);
      if (!own(out.u, key)) put(out.u, key, []);
      for (const p of prims) out.u[key].push(p);
    }
    let mx = 1;
    for (const u of units) if (u > mx) mx = u;
    out.n = mx;
    return out;
  }

  // os.path helpers (POSIX)
  function pathDirname(p) {
    const i = p.lastIndexOf('/');
    if (i < 0) return '';
    let head = p.slice(0, i + 1);
    if (head && head !== '/'.repeat(head.length)) head = head.replace(/\/+$/, '');
    return head;
  }
  function pathBasename(p) { return p.slice(p.lastIndexOf('/') + 1); }
  function pathJoin(a, b) {
    if (b.startsWith('/')) return b;
    if (!a || a.endsWith('/')) return a + b;
    return a + '/' + b;
  }
  function pathNorm(p) {
    const abs = p.startsWith('/');
    const out = [];
    for (const seg of p.split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') { if (out.length && out[out.length - 1] !== '..') out.pop(); else if (!abs) out.push('..'); continue; }
      out.push(seg);
    }
    return (abs ? '/' : '') + out.join('/');
  }

  function fileText(files, key) {
    if (!own(files, key)) return null;
    const v = files[key];
    if (v == null) return null;
    if (typeof v === 'string') return v;
    if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) return decodeText(v);
    if (typeof v.text === 'string') return v.text;
    return String(v);
  }
  function findFileKey(files, p) {
    if (own(files, p)) return p;
    const n = pathNorm(p);
    if (own(files, n)) return n;
    return null;
  }

  /** Parse a (hierarchical) schematic. `files`: {relativePath: text|Uint8Array}; `rootPath`: key of the root sheet. */
  function parseSchematic(files, rootPath, projectName) { return drain(schGen(files, rootPath, projectName)); }
  function* schGen(files, rootPath, projectName) {
    const dir = pathDirname(rootPath);
    const lib = {};
    const pages = [];
    const parts = [];
    const v6refs = new Map();
    const cache = new Map();
    const missing = [];
    let rootUuid = '';

    const load = (fname) => {
      const p = pathJoin(dir, fname);
      if (!cache.has(p)) {
        const key = fname ? findFileKey(files, p) : null;
        const txt = key === null ? null : fileText(files, key);
        cache.set(p, txt === null ? null : parseSexpr(txt));
      }
      return cache.get(p);
    };

    const symbol = (it, pathV7, pathV6, sheetName) => {
      let lid = S(val(it, 'lib_id', 1, ''));
      const lname = val(it, 'lib_name');
      if (lname) lid = own(lib, S(lname)) ? S(lname) : lid;
      const [x, y, a] = at(it);
      const mirror = S(val(it, 'mirror', 1, '') || '');
      let unit = Math.trunc(fnum(val(it, 'unit'), 1));
      const uuid = S(val(it, 'uuid', 1, ''));
      const props = new Map();
      const fields = [];
      for (const p of findall(it, 'property')) {
        if (p.length < 3) continue;
        const pname = S(p[1]), ptxt = S(p[2]);
        props.set(pname, ptxt);
        const [fx, fy, fa] = at(p);
        const [size, just, hidden] = fontSize(p);
        if (!hidden && ptxt && ptxt !== '~') fields.push([pname, R(fx), R(fy), R(fa), R(size), just]);
      }
      const pget = (k, d) => props.has(k) ? props.get(k) : d;
      let ref = pget('Reference', '?');
      let value = pget('Value', '');
      let fpv = pget('Footprint', '');
      const inst = find(it, 'instances');
      if (inst !== null) {
        let first = null;
        outer: for (const proj of findall(inst, 'project')) {
          for (const pth of findall(proj, 'path')) {
            const r_ = [S(val(pth, 'reference', 1, ref)), Math.trunc(fnum(val(pth, 'unit'), unit))];
            if (first === null) first = r_;
            if (S(pth[1]) === pathV7) {
              ref = r_[0]; unit = r_[1];
              first = null;
              break outer;
            }
          }
        }
        if (first !== null) { ref = first[0]; unit = first[1]; }
      } else if (v6refs.size) {
        const key = pathV6 + '/' + uuid;
        if (v6refs.has(key)) {
          const [r, u, v, f] = v6refs.get(key);
          ref = r; unit = u;
          value = v || value;
          fpv = f || fpv;
        }
      }
      const dnp = hasFlag(it, 'dnp');
      const inBom = !(find(it, 'in_bom') !== null && val(it, 'in_bom') === 'no');
      const L = own(lib, lid) ? lib[lid] : {};
      let dispRef = ref;
      if (get(L, 'n', 1) > 1) dispRef = (unit >= 1 && unit <= 26) ? ref + String.fromCharCode(65 + unit - 1) : ref;
      const outFields = [];
      for (const f of fields) {
        const nm = f[0];
        let txt = nm === 'Reference' ? dispRef : (nm === 'Value' ? value : pget(nm, ''));
        if (nm !== 'Reference' && nm !== 'Value') {
          txt = pget(nm, '');
          if (nm === 'Footprint' || nm === 'Datasheet' || nm === 'Description') continue;
        }
        outFields.push([txt, f[1], f[2], f[3], f[4], f[5], nm === 'Reference' ? 'r' : nm === 'Value' ? 'v' : 'o']);
      }
      const rec = { l: lid, x: R(x), y: R(y), a: R(a), m: mirror, u: unit, r: ref, v: value, f: outFields };
      if (dnp) rec.dnp = 1;
      if (!ref.startsWith('#') && !get(L, 'pw', 0)) {
        const extra = {};
        for (const [k, v] of props) {
          if (k !== 'Reference' && k !== 'Value' && k !== 'Footprint' && k !== 'Datasheet' && v && v !== '~' && !k.startsWith('ki_') && k !== 'Sim.Enable') put(extra, k, v);
        }
        const ds = pget('Datasheet', '~') !== '~' ? pget('Datasheet', '') : '';
        parts.push({
          r: ref, v: value, fp: fpv.split(':').pop(), lib: lid, sheet: sheetName,
          ds: ds, p: extra, dnp: dnp ? 1 : 0, bom: inBom ? 1 : 0, u: unit,
          desc: pget('Description', '') || get(L, 'desc', ''),
        });
      }
      return rec;
    };

    const page = (node, fname, name, chain) => {
      for (const ls of findall(node, 'lib_symbols')) {
        for (const s of findall(ls, 'symbol')) {
          const lid = S(s[1]);
          if (!own(lib, lid)) put(lib, lid, parseLibSymbol(s));
        }
      }
      const paper = find(node, 'paper');
      let pw = 297, ph = 210;
      if (paper !== null) {
        const pn = S(paper[1]);
        if (pn === 'User' && paper.length >= 4) { pw = fnum(paper[2], 0); ph = fnum(paper[3], 0); }
        else { const d = get(PAPER, pn, [297, 210]); pw = d[0]; ph = d[1]; }
        if (paper.slice(1).map(S).indexOf('portrait') >= 0) { const t = pw; pw = ph; ph = t; }
      }
      const tb = {};
      const tbn = find(node, 'title_block');
      if (tbn !== null) {
        for (const k of ['title', 'date', 'rev', 'company']) {
          const v = val(tbn, k);
          if (v && v.length) tb[k] = S(v);
        }
      }
      const pathV7 = '/' + rootUuid + chain.map((c) => '/' + c).join('');
      const pathV6 = chain.map((c) => '/' + c).join('');
      const wires = [], buses = [], juncs = [], ncs = [], labels = [], texts = [], gfx = [], sheets = [], syms = [], entries = [];
      for (let ii = 1; ii < node.length; ii++) {
        const it = node[ii];
        if (!Array.isArray(it) || !it.length) continue;
        const k = it[0];
        if (k === 'wire' || k === 'bus') {
          const p = pts(it);
          const arr = k === 'wire' ? wires : buses;
          for (let i = 0; i + 1 < p.length; i++) arr.push(R(p[i][0]), R(p[i][1]), R(p[i + 1][0]), R(p[i + 1][1]));
        } else if (k === 'junction') {
          const [x, y] = at(it);
          juncs.push(R(x), R(y));
        } else if (k === 'no_connect') {
          const [x, y] = at(it);
          ncs.push(R(x), R(y));
        } else if (k === 'bus_entry') {
          const [x, y] = at(it);
          const s = find(it, 'size');
          const dx = s !== null ? fnum(s[1], 0) : 2.54, dy = s !== null ? fnum(s[2], 0) : 2.54;
          entries.push(R(x), R(y), R(x + dx), R(y + dy));
        } else if (k === 'label' || k === 'global_label' || k === 'hierarchical_label' || k === 'directive_label' || k === 'netclass_flag') {
          const [x, y, a] = at(it);
          const [size, just] = fontSize(it);
          const shape = S(val(it, 'shape', 1, ''));
          const kind = k === 'label' ? 'l' : k === 'global_label' ? 'g' : k === 'hierarchical_label' ? 'h' : 'd';
          labels.push([S(it[1]), R(x), R(y), R(a), kind, shape, R(size), just]);
        } else if (k === 'text') {
          const [x, y, a] = at(it);
          const [size, just, hidden] = fontSize(it);
          if (!hidden) texts.push([S(it[1]), R(x), R(y), R(a), R(size), just]);
        } else if (k === 'text_box') {
          const [x, y] = at(it);
          const s = find(it, 'size');
          const [size] = fontSize(it);
          const w = s !== null ? fnum(s[1], 0) : 10, h = s !== null ? fnum(s[2], 0) : 5;
          gfx.push(['r', R(x), R(y), R(x + w), R(y + h), R(strokeW(it))]);
          texts.push([S(it[1]), R(x + 0.8), R(y + size), 0, R(size), 'lt']);
        } else if (k === 'polyline') {
          gfx.push(['p', flatR(pts(it)), R(strokeW(it))]);
        } else if (k === 'rectangle') {
          const a = xy(it, 'start'), b = xy(it, 'end');
          if (a && b) gfx.push(['r', R(a[0]), R(a[1]), R(b[0]), R(b[1]), R(strokeW(it))]);
        } else if (k === 'circle') {
          const c = xy(it, 'center');
          if (c) gfx.push(['c', R(c[0]), R(c[1]), R(fnum(val(it, 'radius'), 0)), R(strokeW(it))]);
        } else if (k === 'arc') {
          const s_ = xy(it, 'start'), m_ = xy(it, 'mid'), e_ = xy(it, 'end');
          if (s_ && m_ && e_) gfx.push(['p', flatR(arcPoints(s_, m_, e_, 12)), R(strokeW(it))]);
        } else if (k === 'sheet') {
          const [x, y] = at(it);
          const s = find(it, 'size');
          const w = s !== null ? fnum(s[1], 0) : 0, h = s !== null ? fnum(s[2], 0) : 0;
          const props = new Map();
          for (const p of findall(it, 'property')) if (p.length >= 3) props.set(S(p[1]), S(p[2]));
          const sname = props.has('Sheetname') ? props.get('Sheetname') : (props.has('Sheet name') ? props.get('Sheet name') : 'Sheet');
          const sfile = props.has('Sheetfile') ? props.get('Sheetfile') : (props.has('Sheet file') ? props.get('Sheet file') : '');
          const spins = [];
          for (const sp of findall(it, 'pin')) {
            const [px, py, pa] = at(sp);
            spins.push([S(sp[1]), R(px), R(py), R(pa), sp.length > 2 ? S(sp[2]) : '']);
          }
          sheets.push({ x: R(x), y: R(y), w: R(w), h: R(h), name: sname, file: sfile, pins: spins, uuid: S(val(it, 'uuid', 1, '')) });
        } else if (k === 'symbol') {
          syms.push(symbol(it, pathV7, pathV6, name));
        }
      }
      return {
        name: name, file: fname, path: pathV7, paper: [pw, ph], tb: tb,
        wires: wires, buses: buses, entries: entries, junctions: juncs, nc: ncs, labels: labels,
        texts: texts, gfx: gfx, sheets: sheets, syms: syms,
      };
    };

    const walk = function* (node, fname, name, chain, depth) {
      if (depth > 12) return null;
      const pageIndex = pages.length;
      const pg = page(node, fname, name, chain);
      pg.parent = null;
      pages.push(pg);
      yield;
      for (const sh of pg.sheets) {
        const child = load(sh.file);
        yield;
        if (child === null) {
          missing.push(sh.file);
          sh.missing = 1;
          continue;
        }
        sh.page = pages.length;
        yield* walk(child, sh.file, sh.name, chain.concat([sh.uuid]), depth + 1);
        if (pages[sh.page]) pages[sh.page].parent = pageIndex;
      }
      return pg;
    };

    const rootBase = pathBasename(rootPath);
    const rootNode = load(rootBase);
    if (rootNode === null) throw new Error('Schematic not found: ' + rootPath);
    rootUuid = S(val(rootNode, 'uuid', 1, ''));
    const si = find(rootNode, 'symbol_instances');
    if (si !== null) {
      for (const p of findall(si, 'path')) {
        v6refs.set(S(p[1]), [S(val(p, 'reference', 1, '?')), Math.trunc(fnum(val(p, 'unit'), 1)),
          S(val(p, 'value', 1, '')), S(val(p, 'footprint', 1, ''))]);
      }
    }
    yield* walk(rootNode, rootBase, 'Root', [], 0);
    return { lib: lib, pages: pages, parts: parts, missing: missing };
  }

  // =====================================================================================
  // Classification (classify.py)
  // =====================================================================================
  const CHIP_H = { '0201': 0.3, '0402': 0.4, '0603': 0.5, '0805': 0.6, '1206': 0.65, '1210': 0.7, '2010': 0.7, '2512': 0.7 };
  const CAP_H = { '0201': 0.3, '0402': 0.5, '0603': 0.8, '0805': 1.0, '1206': 1.2, '1210': 1.5, '2010': 1.5, '2512': 1.8 };
  const NONE_KW = ['mountinghole', 'mounting_hole', 'fiducial', 'logo', 'testpoint', 'test_point', 'tp_', 'nettie', 'net_tie',
    'solderjumper', 'solder_jumper', 'jumper_sm', 'hole', 'oshw', 'kibuzzard', 'symbol_', 'graphic', 'tag-connect',
    'tagconnect', 'tc2030', 'tc2050', 'pad_', 'mousebites', 'label', 'qr', 'jlc', 'version'];
  const NONE_PRE = new Set(['H', 'MH', 'FID', 'LOGO', 'TP', 'JP', 'NT', 'G', 'REF**', 'KB', 'MK']);
  // (?<!\d)code(?!\d) without lookbehind (older Safari): the leftmost match is the same
  const RE_SIZE = pyRe('(?:^|[^\\d])(0201|0402|0603|0805|1206|1210|2010|2512)(?!\\d)');
  const RE_MODULE = /cm3588|cm4|cm5|compute.?module|som|core.?board/u;
  const RE_ELEC = /cp_elec_([0-9]+(?:\.[0-9]+)?)x([0-9]+(?:\.[0-9]+)?)/;
  const RE_RADIAL = /cp_radial_d([0-9]+(?:\.[0-9]+)?)mm/;
  const RE_ICPKG = /qfn|qfp|bga|soic|ssop|tssop|msop|dfn|lga|wlcsp|csp|son|sop|qfp|plcc|lqfp|tqfp|vqfn|wson|uson|xson/;
  function inSet(x, arr) { return arr.indexOf(x) >= 0; }
  function has(s, sub) { return s.indexOf(sub) >= 0; }

  /** Guess a 3D body class, height and colour for a footprint: [cls, height, color|null]. */
  function classify(fp) {
    const ref = get(fp, 'r', '');
    const name = (get(fp, 'fp', '') + ' ' + (get(fp, 'm', null) || '')).toLowerCase();
    const val_ = (get(fp, 'v', null) || '').toLowerCase();
    const pre = /^[A-Za-z_#]*/.exec(ref)[0].toUpperCase();
    const b = get(fp, 'b', null) || [0, 0, 0, 0];
    const w = Math.abs(b[2] - b[0]), h = Math.abs(b[3] - b[1]);
    const small = (w && h) ? Math.min(w, h) : 1;
    const sizeCode = () => { const m = RE_SIZE.exec(name); return m ? m[1] : null; };
    const big = (w && h) ? Math.max(w, h) : 0;
    if (big > 30 && RE_MODULE.test(name + ' ' + val_)) return ['module', 2.9, '#1c3a52'];
    if (has(name, 'shield') || has(val_, 'shield') || has(name, 'rf-can')) return ['frame', 2.2, '#c3c7cc'];
    if (get(fp, 'bo', 0) || NONE_KW.some((k) => has(name, k)) || NONE_PRE.has(pre)) return ['none', 0, null];
    const sc = sizeCode();
    if (inSet(pre, ['R', 'RN', 'RA']) || name.startsWith('r_') || has(name, ' r_')) {
      if (has(name, 'array') || pre === 'RN' || pre === 'RA') return ['res', 0.5, '#1a1a1a'];
      return ['res', sc !== null ? CHIP_H[sc] : 0.55, '#1c1c1e'];
    }
    if (pre === 'C' || name.startsWith('c_') || has(name, 'cp_elec') || has(name, 'cp_radial')) {
      let m = RE_ELEC.exec(name);
      if (m) return ['elco', parseFloat(m[2]), '#b7bcc4'];
      m = RE_RADIAL.exec(name);
      if (m) return ['elco', 11.0, '#1d2a4a'];
      if (has(name, 'tantal') || has(name, 'cp_')) return ['tant', 1.6, '#c6962c'];
      return ['cap', sc !== null ? CAP_H[sc] : Math.min(1.2, Math.max(0.5, small * 0.6)), '#b88a5a'];
    }
    if (inSet(pre, ['L', 'FB', 'FL'])) {
      if (pre === 'FB' || has(name, 'ferrite') || has(name, 'bead')) return ['ind', sc !== null ? CHIP_H[sc] : 0.6, '#3a3a3c'];
      return ['ind', !sc ? Math.min(4.5, Math.max(0.8, small * 0.55)) : get(CAP_H, sc, 0.8), '#343436'];
    }
    if (inSet(pre, ['LED', 'D']) && (has(name, 'led') || pre === 'LED')) return ['led', sc ? 0.55 : 1.0, '#f2efe4'];
    if (inSet(pre, ['D', 'TVS', 'Z', 'ZD'])) return ['diode', (has(name, 'sod-323') || has(name, 'sod-523') || sc) ? 0.9 : 1.1, '#1b1b1d'];
    if (inSet(pre, ['Y', 'X', 'XTAL', 'OSC']) || has(name, 'crystal') || has(name, 'oscillator')) {
      if (has(name, 'hc49') || has(name, 'hc-49')) return ['xtal', 3.5, '#c9ccd1'];
      if (has(name, 'mc306') || has(name, 'fc-135') || has(name, '2012') || has(name, '3215')) return ['xtal', 0.8, '#2b2b2d'];
      return ['xtal', 0.9, '#c7cacf'];
    }
    if (inSet(pre, ['SW', 'S', 'BTN', 'KEY']) || has(name, 'button') || has(name, 'switch') || has(name, 'sw_')) {
      if (has(name, 'kailh') || has(name, 'mx') || has(name, 'choc') || has(name, 'hotswap')) return ['switch', 3.0, '#e8e3d6'];
      if (has(name, 'slide') || has(name, 'spdt')) return ['switch', 1.6, '#c9ccd1'];
      return ['switch', Math.min(3.5, Math.max(1.0, small * 0.5)), '#2a2a2c'];
    }
    if (inSet(pre, ['J', 'P', 'CN', 'CON', 'USB', 'X']) || has(name, 'connector') || has(name, 'conn') || has(name, 'usb') || has(name, 'header') || has(name, 'socket')) {
      if (has(name, 'usb_c') || has(name, 'usb-c') || has(name, 'type-c') || has(name, 'typec')) return ['metal', 3.2, '#c3c7cc'];
      if (has(name, 'usb_a') || has(name, 'usb-a')) return ['metal', 7.0, '#c3c7cc'];
      if (has(name, 'micro') && has(name, 'usb')) return ['metal', 2.6, '#c3c7cc'];
      if (has(name, 'rj45') || has(name, 'ethernet')) return ['metal', 13.0, '#c3c7cc'];
      if (has(name, 'sma') && !has(name, 'u.fl')) return ['gold', 6.0, '#d4a64a'];
      if ((has(name, 'u.fl') || has(name, 'ufl') || has(name, 'ipex') || has(name, 'mhf')) && big < 5) return ['gold', 1.2, '#d9b25c'];
      if (has(name, 'ipex') || has(name, '20455') || has(name, '20453')) return ['metal', 1.1, '#aeb3b9'];
      if (has(name, 'm.2') || has(name, 'm2_') || has(name, 'ngff')) return ['plastic', 4.2, '#1f1f22'];
      if (has(name, 'sodimm') || has(name, 'dimm')) return ['plastic', 5.2, '#1f1f22'];
      if (has(name, 'sd') && (has(name, 'card') || has(name, 'micro'))) return ['metal', 1.9, '#c3c7cc'];
      if (has(name, 'pinheader') || has(name, 'pin_header') || has(name, 'pinsocket') || has(name, 'pin_socket')) {
        if (has(name, 'socket')) return ['plastic', 8.5, '#1d1d20'];
        return ['header', 2.5, '#1d1d20'];
      }
      if (has(name, 'jst') || has(name, 'molex') || has(name, 'picoblade') || has(name, 'pico') || has(name, 'ph_') || has(name, 'sh_') || has(name, 'zh_')) {
        return ['plastic', !has(name, 'sh_') ? 4.0 : 2.9, '#efe7d4'];
      }
      if (has(name, 'fpc') || has(name, 'ffc') || has(name, 'hirose_fh') || has(name, 'fh12') || has(name, 'fh19')) return ['plastic', 1.2, '#2a2a2c'];
      if (has(name, 'audio') || has(name, 'jack') || has(name, 'pj-')) return ['plastic', 5.0, '#1d1d20'];
      if (has(name, 'b2b') || has(name, 'board_to_board') || has(name, 'df40') || has(name, 'bm')) return ['plastic', 1.5, '#e6dcc3'];
      if (has(name, 'barrel') || has(name, 'dc_')) return ['plastic', 11.0, '#1d1d20'];
      if (has(name, 'terminal')) return ['plastic', 10.0, '#2f6f3f'];
      return ['plastic', Math.min(6.0, Math.max(1.2, small * 0.5)), '#2a2a2c'];
    }
    if (inSet(pre, ['BT', 'BAT']) || has(name, 'battery') || has(name, 'cr2032')) return ['metal', 3.2, '#c3c7cc'];
    if (pre === 'F' || has(name, 'fuse') || has(name, 'polyfuse')) return ['ind', sc !== null ? CHIP_H[sc] : 0.8, '#6b6f75'];
    if (pre === 'Q' || has(name, 'sot') || has(name, 'to-252') || has(name, 'dpak')) {
      if (has(name, 'to-252') || has(name, 'dpak') || has(name, 'to-263')) return ['ic', 2.3, '#1b1b1d'];
      return ['ic', 1.0, '#1b1b1d'];
    }
    if (inSet(pre, ['BZ', 'LS', 'SP', 'BUZ']) || has(name, 'buzzer') || has(name, 'speaker')) return ['plastic', 3.0, '#1d1d20'];
    if (inSet(pre, ['ANT', 'AE']) || has(name, 'antenna')) return ['plastic', 0.8, '#e7e7e7'];
    if (has(name, 'shield') || inSet(pre, ['SH', 'SC'])) return ['metal', 1.8, '#c3c7cc'];
    if (has(name, 'module') || has(name, 'esp32-') || has(name, 'wroom') || has(name, 'wrover') || has(name, 'som') || has(name, 'core')) return ['module', 3.0, '#23272e'];
    if (inSet(pre, ['U', 'IC', 'M', 'MOD', 'Z', 'VR', 'REG', 'A', 'PS', 'N']) || RE_ICPKG.test(name)) {
      if (has(name, 'bga') || has(name, 'fbga')) return ['ic', 1.2, '#1b1b1d'];
      if (has(name, 'wlcsp') || has(name, 'csp')) return ['ic', 0.5, '#2a2c30'];
      if (has(name, 'qfp') || has(name, 'soic') || (has(name, 'sop') && !has(name, 'ssop') && !has(name, 'tssop'))) return ['ic', 1.5, '#1b1b1d'];
      if (has(name, 'tssop') || has(name, 'ssop') || has(name, 'msop')) return ['ic', 1.1, '#1b1b1d'];
      if (has(name, 'qfn') || has(name, 'dfn') || has(name, 'son') || has(name, 'lga')) return ['ic', 0.85, '#1b1b1d'];
      return ['ic', 1.0, '#1b1b1d'];
    }
    if (inSet(pre, ['T', 'TR'])) return ['ind', 3.0, '#343436'];
    if (inSet(pre, ['K', 'RL', 'RLY'])) return ['plastic', 10.0, '#1d1d20'];
    if (inSet(pre, ['RV', 'VR', 'POT'])) return ['plastic', 4.0, '#1d1d20'];
    if (pre === 'MIC') return ['metal', 1.1, '#c3c7cc'];
    return ['ic', Math.min(2.0, Math.max(0.6, small * 0.3)), '#232326'];
  }

  // =====================================================================================
  // Checks (checks.py)
  // =====================================================================================
  const GND_RE = pyRe('(^|[/_\\-])(A|D|P|S|CHASSIS|EARTH)?(GND|VSS|VEE|0V)([_\\-]?\\w*)?$', 'i');
  const PWR_NAME_RE = pyRe('^([+-]?\\d+V\\d*|\\d+V\\d+|[+-]?\\d+\\.\\d+V|(A|D|P|IO|CPU|SOC|MEM|DDR)?V(CC|DD|DDA|DDIO|DDQ|BUS|BAT|IN|SYS|IO|CORE|REF|MOT|PP|LED|CHG|OUT|USB|DC|S|PWR|MAIN)\\w*|PWR\\w*|VIN\\w*|\\+\\w+)$', 'i');
  const PWR_EXCL_RE = pyRe('(_EN|EN$|_DET|DET$|_SENSE|SENSE|_PG|PGOOD|_FB|FB$|_OK|_ADC|_SW|^SW|CTRL|_ALERT|_INT|_CTRL|_SEL|_MON|_STAT|_DIV|_N$|_P$)', 'i');
  const HI_I_RE = pyRe('(VBUS|VIN|VBAT|VSYS|DCIN|VCHG|VMOT|(^|[^0-9.])(5|9|12|15|19|20|24)V)', 'i');
  const ESD_RE = pyRe('(esd|tvs|usblc|pesd|tpd\\d|sp05|rclamp|prtr|srv05|ip42|esda|nup\\d|sp30|sp72|cdsot|tpd2e|tpd4e|lesd|esdalc|smf|smaj|sm712|pgb)', 'i');
  const USB_DATA_RE = pyRe('(^|[_\\-/])(USB\\d?_?)?(D_?[PMN+\\-]|DP|DM|DN)(\\d|_|$)');
  const SRC_KEYS = ['mpn', 'part number', 'partnumber', 'part_number', 'mfr', 'manufacturer', 'lcsc', 'digikey', 'digi-key', 'mouser', 'jlc', 'sku', 'order', 'pn', 'farnell', 'arrow', 'supplier'];
  const RE_C_NUM = pyRe('^C\\d');
  const RE_U_IC = pyRe('^(U|IC)\\d');
  const RE_RCL = pyRe('^(R|C|L)\\d');
  const RE_USB_REF = pyRe('^(J|USB|P|CN|CON)\\d');
  const RE_USB_PF = pyRe('^(D[+\\-]|DP|DN|DM|D_[PN])\\d?$');
  const RE_TP_NUM = pyRe('^TP\\d');
  const RE_REFDES = pyRe('^[A-Za-z_]+\\d+[A-Za-z]?$');
  const RE_MECH_REF = pyRe('^(H|MH|FID|G|LOGO|NT)\\d*$');
  const RE_BOM_SKIP = pyRe('^(FID|H|MH|LOGO|G|KB|MK)\\d*$');
  const RE_REFKEY = pyRe('^([A-Za-z_#]*)(\\d*)');
  const RE_IC_REF = pyRe('^(U|IC|M|MOD)\\d');
  const GND_NAMES = new Set(['GND', 'GNDA', 'GNDD', 'AGND', 'DGND', 'PGND', 'VSS']);

  function shortNet(net) {
    if (!net) return net;
    return net.slice(net.lastIndexOf('/') + 1);
  }
  function isGnd(net) {
    const s = shortNet(net);
    return GND_RE.test(s) || GND_NAMES.has(s.toUpperCase());
  }

  function powerNetsSet(pcb) {
    const nets = pcb.nets;
    const byType = new Map();
    for (const p of pcb.pads) {
      if (p[15] === 'power_in' || p[15] === 'power_out') {
        let s = byType.get(p[10]);
        if (!s) byType.set(p[10], s = new Set());
        s.add(p[15]);
      }
    }
    const out = new PySet();
    for (let i = 0; i < nets.length; i++) {
      const n = nets[i];
      if (i === 0 || !n || isGnd(n) || n.startsWith('unconnected')) continue;
      const s = shortNet(n);
      if (PWR_EXCL_RE.test(s)) {
        if (!byType.has(i)) continue;
      }
      const bt = byType.get(i);
      if (PWR_NAME_RE.test(s) || (bt && bt.has('power_out')) || (bt && bt.has('power_in') && !s.startsWith('Net-('))) out.add(i);
    }
    return out;
  }
  /** Indices of supply nets, sorted ascending (== sorted(power_nets(pcb))). */
  function powerNets(pcb) { return powerNetsSet(pcb).toArray().sort((a, b) => a - b); }

  // ------------------------------------------------------------------ geometry helpers
  function customExt(p) {
    let ex = p[6] / 2, ey = p[7] / 2;
    for (const poly of p[16]) {
      for (let i = 0; i < poly.length; i += 2) {
        const ax = Math.abs(poly[i]);
        if (ax > ex) ex = ax;
        if (i + 1 < poly.length) { const ay = Math.abs(poly[i + 1]); if (ay > ey) ey = ay; }
      }
    }
    return [ex, ey];
  }
  function isCustom(p) { return p.length > 16 && p[16] && p[16].length > 0; }
  function padContains(p, x, y, tol) {
    const r = rot(x - p[4], y - p[5], -p[8]);
    const lx = r[0], ly = r[1];
    if (isCustom(p)) {
      const e = customExt(p);
      return Math.abs(lx) <= e[0] + tol && Math.abs(ly) <= e[1] + tol;
    }
    if (p[3] === 0) return hypot(lx, ly) <= p[6] / 2 + tol;
    return Math.abs(lx) <= p[6] / 2 + tol && Math.abs(ly) <= p[7] / 2 + tol;
  }
  function padExt(p) {
    if (isCustom(p)) return customExt(p);
    return [p[6] / 2, p[7] / 2];
  }
  function padDist(p, x, y) {
    const r = rot(x - p[4], y - p[5], -p[8]);
    const lx = r[0], ly = r[1];
    if (p[3] === 0 && !isCustom(p)) return Math.max(0.0, hypot(lx, ly) - p[6] / 2);
    const e = padExt(p);
    const ox = Math.max(0.0, Math.abs(lx) - e[0]), oy = Math.max(0.0, Math.abs(ly) - e[1]);
    return hypot(ox, oy);
  }
  function segDist(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const L2 = dx * dx + dy * dy;
    if (L2 < 1e-12) return hypot(px - x1, py - y1);
    const t = Math.max(0.0, Math.min(1.0, ((px - x1) * dx + (py - y1) * dy) / L2));
    return hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }

  class Poly {
    constructor(flat, row) {
      this.row = row || 0.5;
      const n = flat.length >> 1;
      const xs = new Float64Array(n), ys = new Float64Array(n);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < n; i++) {
        const x = flat[2 * i], y = flat[2 * i + 1];
        xs[i] = x; ys[i] = y;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
      this.n = n; this.xs = xs; this.ys = ys;
      this.bb = [x0, y0, x1, y1];
      const rmin = Math.floor(y0 / this.row), rmax = Math.floor(y1 / this.row);
      this.rmin = rmin;
      const rows = new Array(Math.max(0, rmax - rmin + 1));
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const ya = ys[i], yb = ys[j];
        const lo = ya < yb ? ya : yb, hi = ya < yb ? yb : ya;
        const r1 = Math.floor(hi / this.row);
        for (let r = Math.floor(lo / this.row); r <= r1; r++) {
          const k = r - rmin;
          (rows[k] || (rows[k] = [])).push(i);
        }
      }
      this.rows = rows;
    }
    contains(x, y) {
      const b = this.bb;
      if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) return false;
      const lst = this.rows[Math.floor(y / this.row) - this.rmin];
      if (!lst) return false;
      const xs = this.xs, ys = this.ys, n = this.n;
      let inside = false;
      for (let q = 0; q < lst.length; q++) {
        const i = lst[q], j = (i + 1) % n;
        const xi = xs[i], yi = ys[i], xj = xs[j], yj = ys[j];
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    }
  }

  // Spatial hash with Python Grid semantics (cells visited x-major, items in insertion order, deduplicated)
  const GK = 4194304;
  class Grid {
    constructor(cell) { this.c = cell; this.g = new Map(); }
    add(item, x0, y0, x1, y1) {
      const c = this.c;
      const ax = Math.floor(x0 / c), bx = Math.floor(x1 / c), ay = Math.floor(y0 / c), by = Math.floor(y1 / c);
      for (let gx = ax; gx <= bx; gx++) {
        for (let gy = ay; gy <= by; gy++) {
          const k = gx * GK + gy;
          const l = this.g.get(k);
          if (l) l.push(item); else this.g.set(k, [item]);
        }
      }
    }
    query(x, y, r) {
      const c = this.c;
      const out = [];
      const seen = new Set();
      const ax = Math.floor((x - r) / c), bx = Math.floor((x + r) / c), ay = Math.floor((y - r) / c), by = Math.floor((y + r) / c);
      for (let gx = ax; gx <= bx; gx++) {
        for (let gy = ay; gy <= by; gy++) {
          const l = this.g.get(gx * GK + gy);
          if (!l) continue;
          for (const it of l) if (!seen.has(it)) { seen.add(it); out.push(it); }
        }
      }
      return out;
    }
  }
  // Integer-id grid for connectivity (order of candidates does not change the resulting partition)
  class IdGrid {
    constructor(cell, nIds) { this.c = cell; this.g = new Map(); this.mark = new Int32Array(nIds); this.stamp = 0; this.buf = []; }
    add(id, x0, y0, x1, y1) {
      const c = this.c;
      const ax = Math.floor(x0 / c), bx = Math.floor(x1 / c), ay = Math.floor(y0 / c), by = Math.floor(y1 / c);
      for (let gx = ax; gx <= bx; gx++) {
        for (let gy = ay; gy <= by; gy++) {
          const k = gx * GK + gy;
          const l = this.g.get(k);
          if (l) l.push(id); else this.g.set(k, [id]);
        }
      }
    }
    query(x, y, r) {
      const c = this.c;
      const out = this.buf;
      out.length = 0;
      const st = ++this.stamp;
      const mark = this.mark;
      const ax = Math.floor((x - r) / c), bx = Math.floor((x + r) / c), ay = Math.floor((y - r) / c), by = Math.floor((y + r) / c);
      for (let gx = ax; gx <= bx; gx++) {
        for (let gy = ay; gy <= by; gy++) {
          const l = this.g.get(gx * GK + gy);
          if (!l) continue;
          for (let q = 0; q < l.length; q++) {
            const id = l[q];
            if (mark[id] !== st) { mark[id] = st; out.push(id); }
          }
        }
      }
      return out;
    }
  }

  function* connectivity(pcb) {
    const cu = pcb.meta.cu;
    const nL = cu.length;
    const lidx = new Map();
    cu.forEach((n, i) => lidx.set(n, i));
    const padLayers = (p) => {
      const m = p[9];
      const s = new Set();
      if (m & 1) s.add(0);
      if (m & 2) s.add(nL - 1);
      if (m & 4) for (let l = 1; l < nL - 1; l++) s.add(l);
      return s;
    };
    const perNet = new Map();
    const net = (n) => {
      let d = perNet.get(n);
      if (!d) perNet.set(n, d = { pads: [], segs: [], vias: [], zones: [] });
      return d;
    };
    pcb.pads.forEach((p, i) => {
      if (p[10] && p[2] !== 2) net(p[10]).pads.push([i, p, padLayers(p)]);
    });
    for (const L of Object.keys(pcb.tracks)) {
      const li = lidx.get(L);
      if (li === undefined) continue;
      const arr = pcb.tracks[L];
      for (let k = 0; k + 5 < arr.length; k += 6) {
        const n = arr[k + 5];
        if (n) net(n).segs.push([li, arr[k], arr[k + 1], arr[k + 2], arr[k + 3], arr[k + 4]]);
      }
    }
    for (const v of pcb.vias) if (v[4]) net(v[4]).vias.push(v);
    for (const z of pcb.zones) {
      const li = lidx.get(z.l);
      if (li !== undefined && z.n && z.p.length >= 6) net(z.n).zones.push([li, z.p, null]);
    }
    let unfilled = 0;
    for (const zo of (pcb.zoneOutlines || [])) {
      if (zo.k || !zo.n || get(zo, 'f', 0) || zo.p.length < 6) continue;
      unfilled += 1;
      for (const L of zo.l) {
        let targets = (L === '*.Cu' || L === 'F&B.Cu') ? cu : (lidx.has(L) ? [L] : []);
        if (L === 'F&B.Cu') targets = nL ? [cu[0], cu[nL - 1]] : [];
        for (const t of targets) net(zo.n).zones.push([lidx.get(t), zo.p, null]);
      }
    }

    const results = new Map();
    let work = 0;
    for (const [netId, d] of perNet) {
      const pads = d.pads;
      if (pads.length < 2) continue;
      work += pads.length + d.segs.length + d.vias.length + 50 * d.zones.length;
      if (work > 2000) { work = 0; yield; }
      const P = pads.length, Sn = d.segs.length, V = d.vias.length, Z = d.zones.length;
      const SB = P, VB = P + Sn, ZB = P + Sn + V;
      const parent = new Int32Array(P + Sn + V + Z);
      for (let i = 0; i < parent.length; i++) parent[i] = i;
      const find_ = (a) => {
        let r = a;
        while (parent[r] !== r) r = parent[r];
        while (parent[a] !== r) { const nx = parent[a]; parent[a] = r; a = nx; }
        return r;
      };
      const union = (a, b) => { const ra = find_(a), rb = find_(b); if (ra !== rb) parent[ra] = rb; };

      const ext = pads.map((e) => padExt(e[1]));
      const grid = new IdGrid(1.0, P + Sn + V);
      for (let k = 0; k < P; k++) {
        const p = pads[k][1];
        const r = Math.max(ext[k][0], ext[k][1]);
        grid.add(k, p[4] - r, p[5] - r, p[4] + r, p[5] + r);
      }
      for (let si = 0; si < Sn; si++) {
        const s = d.segs[si];
        const x1 = s[1], y1 = s[2], x2 = s[3], y2 = s[4], w = s[5];
        grid.add(SB + si, Math.min(x1, x2) - w, Math.min(y1, y2) - w, Math.max(x1, x2) + w, Math.max(y1, y2) + w);
      }
      for (let vi = 0; vi < V; vi++) {
        const v = d.vias[vi];
        const r = v[2] / 2;
        grid.add(VB + vi, v[0] - r, v[1] - r, v[0] + r, v[1] + r);
      }
      // segment endpoints
      for (let si = 0; si < Sn; si++) {
        if ((si & 1023) === 1023) yield;
        const s = d.segs[si];
        const li = s[0], w = s[5];
        for (let e = 0; e < 2; e++) {
          const ex = e ? s[3] : s[1], ey = e ? s[4] : s[2];
          const cand = grid.query(ex, ey, w);
          for (let q = 0; q < cand.length; q++) {
            const id = cand[q];
            if (id >= VB) {
              const v = d.vias[id - VB];
              if (v[6] <= li && li <= v[7] && hypot(ex - v[0], ey - v[1]) <= v[2] / 2 + w / 2 - 0.002) union(SB + si, id);
            } else if (id >= SB) {
              if (id === SB + si) continue;
              const o = d.segs[id - SB];
              if (o[0] !== li) continue;
              if (segDist(ex, ey, o[1], o[2], o[3], o[4]) <= Math.max(0.01, (w + o[5]) / 2 - 0.002)) union(SB + si, id);
            } else {
              if (pads[id][2].has(li) && padDist(pads[id][1], ex, ey) <= w / 2 - 0.002) union(SB + si, id);
            }
          }
        }
      }
      // vias in pads / vias touching segments or vias
      for (let vi = 0; vi < V; vi++) {
        const v = d.vias[vi];
        const cand = grid.query(v[0], v[1], v[2] / 2);
        for (let q = 0; q < cand.length; q++) {
          const id = cand[q];
          if (id >= VB) {
            if (id === VB + vi) continue;
            const o = d.vias[id - VB];
            if (hypot(v[0] - o[0], v[1] - o[1]) < (v[2] + o[2]) / 2) {
              if (!(v[7] < o[6] || o[7] < v[6])) union(VB + vi, id);
            }
          } else if (id >= SB) {
            const o = d.segs[id - SB];
            if (v[6] <= o[0] && o[0] <= v[7] && segDist(v[0], v[1], o[1], o[2], o[3], o[4]) <= v[2] / 2 + o[5] / 2 - 0.002) union(VB + vi, id);
          } else {
            if (padDist(pads[id][1], v[0], v[1]) <= v[2] / 2 - 0.002) {
              let any = false;
              for (const l of pads[id][2]) if (v[6] <= l && l <= v[7]) { any = true; break; }
              if (any) union(VB + vi, id);
            }
          }
        }
      }
      // pads: tracks crossing the pad centre, pads overlapping pads
      for (let k = 0; k < P; k++) {
        const p = pads[k][1], ls = pads[k][2];
        const r = Math.min(p[6], p[7]) / 2;
        let cand = grid.query(p[4], p[5], Math.max(p[6], p[7]) / 2);
        for (let q = 0; q < cand.length; q++) {
          const id = cand[q];
          if (id >= SB && id < VB) {
            const o = d.segs[id - SB];
            if (ls.has(o[0]) && segDist(p[4], p[5], o[1], o[2], o[3], o[4]) <= r + o[5] / 2 - 0.01) union(k, id);
          }
        }
        cand = grid.query(p[4], p[5], 0.01);
        for (let q = 0; q < cand.length; q++) {
          const id = cand[q];
          if (id < SB && id !== k) {
            let common = false;
            for (const l of ls) if (pads[id][2].has(l)) { common = true; break; }
            if (common && padContains(pads[id][1], p[4], p[5], 0.01)) union(k, id);
          }
        }
      }
      // zones
      for (let zi = 0; zi < Z; zi++) {
        yield;
        const zrec = d.zones[zi];
        const li = zrec[0];
        const poly = zrec[2] || (zrec[2] = new Poly(zrec[1]));
        const zkey = ZB + zi;
        let vgrid = null;
        const getV = () => {
          if (vgrid) return vgrid;
          vgrid = new Map();
          for (let i = 0; i < poly.n; i++) {
            const k = Math.floor(poly.xs[i] / 0.5) * GK + Math.floor(poly.ys[i] / 0.5);
            const l = vgrid.get(k);
            if (l) l.push(i); else vgrid.set(k, [i]);
          }
          return vgrid;
        };
        const anyNear = (x, y, r, test) => {
          const g = getV();
          const ax = Math.floor((x - r) / 0.5), bx = Math.floor((x + r) / 0.5), ay = Math.floor((y - r) / 0.5), by = Math.floor((y + r) / 0.5);
          for (let gx = ax; gx <= bx; gx++) {
            for (let gy = ay; gy <= by; gy++) {
              const l = g.get(gx * GK + gy);
              if (!l) continue;
              for (const i of l) if (test(poly.xs[i], poly.ys[i])) return true;
            }
          }
          return false;
        };
        const b = poly.bb;
        for (let k = 0; k < P; k++) {
          const p = pads[k][1];
          if (!pads[k][2].has(li)) continue;
          if (p[4] < b[0] - 5 || p[4] > b[2] + 5 || p[5] < b[1] - 5 || p[5] > b[3] + 5) continue;
          let hit = poly.contains(p[4], p[5]);
          if (!hit) {
            const r = Math.max(ext[k][0], ext[k][1]) + 0.05;
            hit = anyNear(p[4], p[5], r, (qx, qy) => padContains(p, qx, qy, 0.03));
          }
          if (hit) union(zkey, k);
        }
        for (let vi = 0; vi < V; vi++) {
          const v = d.vias[vi];
          if (!(v[6] <= li && li <= v[7])) continue;
          let hit = poly.contains(v[0], v[1]);
          if (!hit) hit = anyNear(v[0], v[1], v[2] / 2 + 0.05, (qx, qy) => hypot(qx - v[0], qy - v[1]) <= v[2] / 2 + 0.03);
          if (hit) union(zkey, VB + vi);
        }
        for (let si = 0; si < Sn; si++) {
          const s = d.segs[si];
          if (s[0] !== li) continue;
          if (poly.contains(s[1], s[2]) || poly.contains(s[3], s[4])) union(zkey, SB + si);
        }
      }
      // pads sharing a pin number inside one footprint are the same physical pin
      const same = new Map();
      for (let k = 0; k < P; k++) {
        const p = pads[k][1];
        const key = p[0] + '\u0000' + p[1];
        if (same.has(key)) union(k, same.get(key));
        else same.set(key, k);
      }
      const groups = new Map();
      for (let k = 0; k < P; k++) {
        const r = find_(k);
        let g = groups.get(r);
        if (!g) groups.set(r, g = []);
        g.push(pads[k][0]);
      }
      if (groups.size > 1) results.set(netId, Array.from(groups.values()).sort((a, b) => b.length - a.length));
    }
    return [results, unfilled];
  }

  // ------------------------------------------------------------------ courtyard overlap (convex)
  function clip(subject, clipper) {
    const inside = (p, a, b) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= 0;
    const inter = (p1, p2, a, b) => {
      const x1 = p1[0], y1 = p1[1], x2 = p2[0], y2 = p2[1], x3 = a[0], y3 = a[1], x4 = b[0], y4 = b[1];
      const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
      if (Math.abs(den) < 1e-12) return p2;
      const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den;
      return [x1 + t * (x2 - x1), y1 + t * (y2 - y1)];
    };
    let out = subject;
    for (let i = 0; i < clipper.length; i++) {
      const a = clipper[i], b = clipper[(i + 1) % clipper.length];
      const inp = out;
      out = [];
      if (!inp.length) break;
      let s = inp[inp.length - 1];
      for (const e of inp) {
        if (inside(e, a, b)) {
          if (!inside(s, a, b)) out.push(inter(s, e, a, b));
          out.push(e);
        } else if (inside(s, a, b)) out.push(inter(s, e, a, b));
        s = e;
      }
    }
    return out;
  }
  function ccwPoly(poly) { return polyArea(poly) >= 0 ? poly : poly.slice().reverse(); }

  function symEnds(sch, pg) {
    const ends = new Set();
    for (const sy of pg.syms) {
      const lib = get(sch.lib, sy.l, null);
      if (!lib) continue;
      for (const key of Object.keys(lib.u)) {
        const kp = key.split('_');
        const u = pyInt(kp[0]), st = pyInt(kp[1]);
        if (!((u === 0 || u === sy.u) && (st === 0 || st === 1))) continue;
        for (const p of lib.u[key]) {
          if (p[0] === 'P') {
            const o = symXf(p[1], p[2], sy.a, sy.m);
            ends.add(pyRound(sy.x + o[0], 1) + ',' + pyRound(sy.y + o[1], 1));
          }
        }
      }
    }
    for (const sh of pg.sheets) for (const p of sh.pins) ends.add(pyRound(p[1], 1) + ',' + pyRound(p[2], 1));
    return ends;
  }

  /** Design checks (checks.run_checks). `classes` = fps.map(classify). */
  function runChecks(pcb, sch, classes) { return drain(checksGen(pcb, sch, classes)); }
  function* checksGen(pcb, sch, classes) {
    const nets = pcb.nets, fps = pcb.fps, pads = pcb.pads;
    if (!classes) classes = fps.map(classify);
    const out = [];
    const netPads = new Map();
    pads.forEach((p, i) => {
      if (p[10]) { let l = netPads.get(p[10]); if (!l) netPads.set(p[10], l = []); l.push(i); }
    });
    yield;
    const pwr = powerNetsSet(pcb);
    const fpref = (i) => fps[pads[i][0]].r;
    const padlabel = (i) => fpref(i) + '.' + pads[i][1];

    // 1 unrouted
    const [unrouted, unfilled] = yield* connectivity(pcb);
    yield;
    let items = [];
    const ur = Array.from(unrouted.entries());
    const strayCount = (groups) => { let s = 0; for (let i = 1; i < groups.length; i++) s += groups[i].length; return s; };
    ur.sort((a, b) => strayCount(b[1]) - strayCount(a[1]));
    for (const [n, groups] of ur) {
      const stray = [];
      for (let i = 1; i < groups.length; i++) for (const k of groups[i]) stray.push(k);
      const p0 = pads[stray[0]];
      const refs = Array.from(new Set(stray.map(fpref))).sort(cmpStr).slice(0, 8);
      items.push({
        t: `${nets[n]} splits into ${groups.length} islands. Not reached: ${stray.slice(0, 8).map(padlabel).join(', ')}${stray.length > 8 ? '\u2026' : ''}`,
        nets: [nets[n]], refs: refs, xy: [p0[4], p0[5]],
      });
    }
    let multi = 0;
    for (const l of netPads.values()) if (l.length >= 2) multi++;
    const note = unfilled ? ` ${unfilled} zone(s) were saved unfilled, so their outlines stood in for copper.` : '';
    out.push({
      id: 'unrouted', cat: 'Electrical', title: 'Unrouted connections',
      status: items.length ? 'fail' : 'pass',
      summary: (items.length ? `${items.length} of ${multi} multi-pad nets look split: no track, via or pour joins every pad. Confirm with KiCad DRC; zone fills saved in the file may be stale.` : `All ${multi} multi-pad nets are fully connected by tracks, vias and pours.`) + note,
      items: items.slice(0, 60),
    });
    yield;

    // 2 single-pin nets
    items = [];
    for (const [n, lst] of netPads) {
      const nm = nets[n];
      if (lst.length === 1 && !nm.startsWith('unconnected') && pads[lst[0]][15].indexOf('no_connect') < 0 && !nm.startsWith('Net-(')) {
        const i = lst[0];
        items.push({ t: `${nm} touches only ${padlabel(i)}`, nets: [nm], refs: [fpref(i)], xy: [pads[i][4], pads[i][5]] });
      }
    }
    items.sort((a, b) => cmpStr(a.t, b.t));
    out.push({
      id: 'single', cat: 'Electrical', title: 'Named nets with a single pin',
      status: items.length ? 'warn' : 'pass',
      summary: items.length ? `${items.length} named nets reach only one pad. Each is either a test hook or a missing connection.` : 'Every named net reaches at least two pads.',
      items: items.slice(0, 60),
    });
    yield;

    // 3 decoupling
    const capsByNet = new Map();
    pads.forEach((p, i) => {
      const f = fps[p[0]];
      if (f.r.slice(0, 1) === 'C' && RE_C_NUM.test(f.r)) {
        let l = capsByNet.get(p[10]);
        if (!l) capsByNet.set(p[10], l = []);
        l.push(i);
      }
    });
    yield;
    items = [];
    let icChecked = 0;
    for (const f of fps) {
      if (!RE_U_IC.test(f.r) || ESD_RE.test(f.v + ' ' + f.fp)) continue;
      const pinNets = new Map();
      for (const pi of f.pads) {
        const p = pads[pi];
        if (pwr.has(p[10]) && (p[15] === 'power_in' || p[15] === '' || p[15] === null)) {
          let l = pinNets.get(p[10]);
          if (!l) pinNets.set(p[10], l = []);
          l.push(pi);
        }
      }
      if (!pinNets.size) continue;
      icChecked += 1;
      const bad = [];
      for (const [n, pl] of pinNets) {
        let best = 1e9, bref = null;
        for (const ci of (capsByNet.get(n) || [])) {
          const c = pads[ci];
          for (const pi of pl) {
            const dd = hypot(c[4] - pads[pi][4], c[5] - pads[pi][5]);
            if (dd < best) { best = dd; bref = fps[c[0]].r; }
          }
        }
        if (best > 6.0) bad.push([nets[n], best, bref]);
      }
      if (bad.length) {
        const desc = bad.slice(0, 4).map(([n, dd, bref]) => `${shortNet(n)}: ` + (bref ? `nearest cap ${bref} at ${fmtF(dd, 1)} mm` : 'no capacitor on this rail')).join('; ');
        items.push({
          t: `${f.r} (${f.v}) \u2014 ${desc}`,
          refs: [f.r].concat(bad.filter((b) => b[2]).map((b) => b[2]).slice(0, 3)),
          nets: bad.map((b) => b[0]), xy: [f.x, f.y],
        });
      }
    }
    out.push({
      id: 'decoupling', cat: 'Power integrity', title: 'Decoupling capacitors near IC supply pins',
      status: items.length ? 'warn' : 'pass',
      summary: items.length ? `${items.length} of ${icChecked} ICs have a supply pin with no capacitor on that rail within 6 mm.` : `All ${icChecked} ICs with supply pins have a capacitor on each rail within 6 mm.`,
      items: items.slice(0, 60),
    });
    yield;

    // 4 power traces
    items = [];
    const segByNet = new Map();
    for (const L of Object.keys(pcb.tracks)) {
      const arr = pcb.tracks[L];
      for (let k = 0; k + 5 < arr.length; k += 6) {
        let l = segByNet.get(arr[k + 5]);
        if (!l) segByNet.set(arr[k + 5], l = []);
        l.push([arr[k + 4], hypot(arr[k + 2] - arr[k], arr[k + 3] - arr[k + 1]), arr[k], arr[k + 1]]);
      }
    }
    for (const n of pwr.toArray().sort((a, b) => cmpStr(nets[a], nets[b]))) {
      const segs = (segByNet.get(n) || []).filter((s) => s[1] > 1.0);
      if (!segs.length) continue;
      const hi = HI_I_RE.test(shortNet(nets[n]));
      const limit = hi ? 0.25 : 0.15;
      const narrow = segs.filter((s) => s[0] < limit - 1e-6);
      if (narrow.length) {
        let length = 0;
        for (const s of narrow) length += s[1];
        let wmin = Infinity;
        for (const s of narrow) if (s[0] < wmin) wmin = s[0];
        const amps = 0.048 * Math.pow(10, 0.44) * Math.pow((wmin / 0.0254) * 1.378, 0.725);
        items.push({
          t: `${nets[n]}: ${fmtF(length, 1)} mm at ${fmtF(wmin, 3)} mm wide, about ${fmtF(amps, 2)} A for a 10 \u00b0C rise on 1 oz outer copper (IPC-2221)`,
          nets: [nets[n]], xy: [narrow[0][2], narrow[0][3]],
        });
      }
    }
    out.push({
      id: 'pwrwidth', cat: 'Power integrity', title: 'Narrow traces on supply rails',
      status: items.length ? 'warn' : 'pass',
      summary: items.length ? `${items.length} supply rails have long thin sections that may drop voltage under load.` : 'Supply rails are routed at comfortable widths.',
      items: items.slice(0, 60),
    });
    yield;

    // 5 ESD on USB / external connectors
    items = [];
    const esdNets = new Set();
    for (const f of fps) {
      const txt = [f.v, f.fp, get(f, 'd', '')].concat(Object.values(get(f, 'p', null) || {})).join(' ');
      if (ESD_RE.test(txt) && !RE_RCL.test(f.r)) for (const pi of f.pads) esdNets.add(pads[pi][10]);
    }
    let usbCount = 0;
    for (const f of fps) {
      const name = (f.fp + ' ' + get(f, 'm', '')).toLowerCase();
      if (name.indexOf('usb') < 0 || !RE_USB_REF.test(f.r)) continue;
      usbCount += 1;
      const data = new PySet();
      for (const pi of f.pads) {
        const p = pads[pi];
        const nm = shortNet(nets[p[10]]).toUpperCase();
        const pf = (p[14] || '').toUpperCase();
        if (nets[p[10]].startsWith('unconnected')) continue;
        if (p[10] && (USB_DATA_RE.test(nm) || RE_USB_PF.test(pf)) && !isGnd(nets[p[10]]) && !pwr.has(p[10])) data.add(p[10]);
      }
      if (!data.size) continue;
      const unprot = data.toArray().filter((n) => !esdNets.has(n));
      if (unprot.length) {
        items.push({
          t: `${f.r} (${f.fp}): data lines ${unprot.slice().sort((a, b) => a - b).map((n) => shortNet(nets[n])).join(', ')} reach no ESD/TVS part`,
          refs: [f.r], nets: unprot.map((n) => nets[n]), xy: [f.x, f.y],
        });
      }
    }
    out.push({
      id: 'esd', cat: 'Robustness', title: 'ESD protection on USB data lines',
      status: items.length ? 'warn' : (usbCount ? 'pass' : 'info'),
      summary: items.length ? `${items.length} of ${usbCount} USB connectors have data lines without a directly attached ESD/TVS device.` : (usbCount ? `All ${usbCount} USB connectors have ESD protection on their data lines.` : 'No USB connectors on this board.'),
      items: items,
    });
    yield;

    // 6 test points on rails (debuggability)
    const tpNets = new Set();
    for (const f of fps) {
      const fl = f.fp.toLowerCase();
      if (RE_TP_NUM.test(f.r) || fl.indexOf('testpoint') >= 0 || fl.indexOf('test_point') >= 0) for (const pi of f.pads) tpNets.add(pads[pi][10]);
    }
    const npc = (n) => (netPads.get(n) || []).length;
    const rails = pwr.toArray().filter((n) => npc(n) >= 3);
    const covered = rails.filter((n) => tpNets.has(n));
    const missingR = rails.filter((n) => !tpNets.has(n));
    items = missingR.slice().sort((a, b) => npc(b) - npc(a)).map((n) => ({
      t: `${nets[n]} (${npc(n)} pads) has no test point`, nets: [nets[n]],
      xy: [pads[netPads.get(n)[0]][4], pads[netPads.get(n)[0]][5]],
    }));
    let pct = rails.length ? round0(100 * covered.length / rails.length) : 100;
    const tpCount = fps.filter((f) => f.r.startsWith('TP')).length;
    out.push({
      id: 'testpoints', cat: 'Debuggability', title: 'Test points on supply rails',
      status: pct >= 80 ? 'pass' : (rails.length ? 'warn' : 'info'), score: pct,
      summary: `${covered.length} of ${rails.length} supply rails (${pct}%) have a dedicated test point. ${tpCount} test points on the board.`,
      items: items.slice(0, 60),
    });
    yield;

    // 7 net naming (debuggability)
    const multiNets = [];
    for (const [n, l] of netPads) if (l.length >= 2) multiNets.push(n);
    const auto = multiNets.filter((n) => nets[n].startsWith('Net-(') || nets[n].indexOf('/Net-(') >= 0);
    pct = multiNets.length ? round0(100 * (multiNets.length - auto.length) / multiNets.length) : 100;
    out.push({
      id: 'naming', cat: 'Debuggability', title: 'Named nets',
      status: pct >= 60 ? 'pass' : 'info', score: pct,
      summary: `${pct}% of connected nets carry a human name; ${auto.length} use auto-generated names like Net-(R1-Pad2), which are harder to probe by name.`,
      items: auto.slice().sort((a, b) => cmpStr(nets[a], nets[b])).slice(0, 40).map((n) => ({
        t: nets[n], nets: [nets[n]], xy: [pads[netPads.get(n)[0]][4], pads[netPads.get(n)[0]][5]],
      })),
    });
    yield;

    // 8 courtyard overlaps
    items = [];
    for (const side of [0, 1]) {
      const polys = [];
      fps.forEach((f, fi) => {
        if (f.s !== side || !(f.c && f.c.length) || classes[fi][0] === 'none' || f.c.length < 6) return;
        const raw = [];
        for (let i = 0; i + 1 < f.c.length; i += 2) raw.push([f.c[i], f.c[i + 1]]);
        const pl = ccwPoly(raw);
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const p of pl) {
          if (p[0] < x0) x0 = p[0];
          if (p[0] > x1) x1 = p[0];
          if (p[1] < y0) y0 = p[1];
          if (p[1] > y1) y1 = p[1];
        }
        polys.push([fi, pl, [x0, y0, x1, y1], Math.abs(polyArea(pl))]);
      });
      const g = new Grid(5.0);
      for (const it of polys) g.add(it, it[2][0], it[2][1], it[2][2], it[2][3]);
      const seen = new Set();
      let nq = 0;
      for (const it of polys) {
        if ((++nq & 127) === 0) yield;
        const [fi, pl, bb, a1] = it;
        for (const o of g.query((bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2, Math.max(bb[2] - bb[0], bb[3] - bb[1]) / 2 + 5)) {
          const [fj, pl2, bb2, a2] = o;
          const key = fi + ',' + fj;
          if (fj <= fi || seen.has(key)) continue;
          if (bb2[0] > bb[2] || bb2[2] < bb[0] || bb2[1] > bb[3] || bb2[3] < bb[1]) continue;
          seen.add(key);
          const inter = clip(pl, pl2);
          const ia = inter.length >= 3 ? Math.abs(polyArea(inter)) : 0;
          if (ia > 0.05) {
            const small = Math.min(a1, a2);
            if (ia > 0.9 * small && Math.max(a1, a2) > 8 * small) continue;
            const f1 = fps[fi], f2 = fps[fj];
            items.push({
              t: `${f1.r} and ${f2.r} courtyards overlap by ${fmtF(ia, 2)} mm\u00b2 (${side ? 'bottom' : 'top'})`,
              refs: [f1.r, f2.r], xy: [(f1.x + f2.x) / 2, (f1.y + f2.y) / 2], a: ia,
            });
          }
        }
      }
    }
    items.sort((a, b) => cmpNum(-a.a, -b.a));
    for (const i of items) delete i.a;
    out.push({
      id: 'courtyard', cat: 'Assembly', title: 'Courtyard overlaps',
      status: items.length ? 'warn' : 'pass',
      summary: items.length ? `${items.length} component pairs have overlapping courtyards (placement or rework clearance may be tight).` : 'No overlapping courtyards.',
      items: items.slice(0, 60),
    });
    yield;

    // 9 parts outside board
    const outers = pcb.outline.outer.map((l) => { const r = []; for (let i = 0; i + 1 < l.length; i += 2) r.push([l[i], l[i + 1]]); return r; });
    items = [];
    fps.forEach((f, fi) => {
      if (get(f, 'bo', 0) || classes[fi][0] === 'none' || f.r.startsWith('REF') || !f.pads.length) return;
      const pinIn = f.pads.slice(0, 6).some((pi) => outers.some((o) => pointInPoly([pads[pi][4], pads[pi][5]], o)));
      if (outers.length && !pinIn && !outers.some((o) => pointInPoly([f.x, f.y], o))) {
        items.push({ t: `${f.r} (${f.v}) sits outside the board outline`, refs: [f.r], xy: [f.x, f.y] });
      }
    });
    yield;
    out.push({
      id: 'outside', cat: 'Assembly', title: 'Parts outside the board edge',
      status: items.length ? 'fail' : 'pass',
      summary: items.length ? `${items.length} parts are placed outside Edge.Cuts.` : 'All parts are inside the board outline.',
      items: items.slice(0, 40),
    });
    yield;

    // 10 reference designators
    const cnt = new Map();
    for (const f of fps) if (f.r && !f.r.startsWith('REF')) cnt.set(f.r, (cnt.get(f.r) || 0) + 1);
    const dups = [];
    for (const [r, c] of cnt) if (c > 1 && RE_REFDES.test(r) && !RE_MECH_REF.test(r)) dups.push(r);
    const unann = fps.filter((f) => f.r.indexOf('?') >= 0).map((f) => f.r);
    items = dups.sort(cmpStr).map((r) => ({ t: `${r} is used by ${cnt.get(r)} footprints`, refs: [r] }))
      .concat(unann.map((r) => ({ t: `${r} is not annotated`, refs: [r] })));
    out.push({
      id: 'refdes', cat: 'Schematic', title: 'Reference designators',
      status: items.length ? 'fail' : 'pass',
      summary: items.length ? `${items.length} duplicate or unannotated references.` : `All ${cnt.size} references are unique and annotated.`,
      items: items.slice(0, 40),
    });
    yield;

    // 11 schematic <-> PCB sync
    if (sch && sch.parts && sch.parts.length) {
      items = [];
      const schRefs = new Map();
      for (const p of sch.parts) if (!schRefs.has(p.r)) schRefs.set(p.r, p);
      const pcbRefs = new Map();
      const pcbIdx = new Map();
      fps.forEach((f, fi) => { pcbRefs.set(f.r, f); pcbIdx.set(f.r, fi); });
      for (const r of Array.from(schRefs.keys()).sort(cmpStr)) {
        const p = schRefs.get(r);
        if (!pcbRefs.has(r) && p.fp && r.indexOf('?') < 0) items.push({ t: `${r} (${p.v}) is in the schematic but not on the PCB`, refs: [r] });
      }
      const PFX = ['REF', 'G', 'H', 'MH', 'FID', 'LOGO', 'kibuzzard'];
      for (const r of Array.from(pcbRefs.keys()).sort(cmpStr)) {
        const f = pcbRefs.get(r);
        const fi = pcbIdx.get(r);
        if (r && !schRefs.has(r) && !get(f, 'bo', 0) && classes[fi][0] !== 'none' && !PFX.some((x) => r.startsWith(x))) {
          items.push({ t: `${r} (${f.v}) is on the PCB but not in the schematic`, refs: [r], xy: [f.x, f.y] });
        } else if (schRefs.has(r) && schRefs.get(r).v !== f.v && schRefs.get(r).v && f.v) {
          items.push({ t: `${r}: schematic says ${schRefs.get(r).v}, PCB says ${f.v}`, refs: [r], xy: [f.x, f.y] });
        }
      }
      out.push({
        id: 'sync', cat: 'Schematic', title: 'Schematic and PCB agree',
        status: items.length ? 'warn' : 'pass',
        summary: items.length ? `${items.length} differences between schematic and layout.` : 'Every schematic part is on the PCB with the same value.',
        items: items.slice(0, 60),
      });

      // 12 dangling labels
      items = [];
      const gcount = new Map();
      for (const pg of sch.pages) for (const l of pg.labels) if (l[4] === 'g') gcount.set(l[0], (gcount.get(l[0]) || 0) + 1);
      for (const pg of sch.pages) {
        yield;
        const wires = pg.wires.concat(pg.buses, get(pg, 'entries', []));
        const ends = symEnds(sch, pg);
        const attached = (x, y) => {
          if (ends.has(pyRound(x, 1) + ',' + pyRound(y, 1))) return true;
          for (let i = 0; i + 3 < wires.length; i += 4) if (segDist(x, y, wires[i], wires[i + 1], wires[i + 2], wires[i + 3]) < 0.02) return true;
          return false;
        };
        for (const l of pg.labels) {
          if ((l[4] === 'l' || l[4] === 'g' || l[4] === 'h') && !attached(l[1], l[2])) {
            const kind = l[4] === 'l' ? 'Label' : l[4] === 'g' ? 'Global label' : 'Hierarchical label';
            items.push({ t: `${kind} ${l[0]} on sheet ${pg.name} is not attached to a wire or pin`, nets: [l[0]], sheet: pg.name, sxy: [l[1], l[2]] });
          }
        }
      }
      for (const [name, c] of gcount) {
        if (c === 1) {
          const pg = sch.pages.find((p) => p.labels.some((l) => l[0] === name && l[4] === 'g'));
          const l = pg.labels.find((q) => q[0] === name && q[4] === 'g');
          items.push({ t: `Global label ${name} appears only once (sheet ${pg.name}), so it links to nothing`, nets: [name], sheet: pg.name, sxy: [l[1], l[2]] });
        }
      }
      out.push({
        id: 'labels', cat: 'Schematic', title: 'Labels that connect to nothing',
        status: items.length ? 'warn' : 'pass',
        summary: items.length ? `${items.length} net labels are floating or have no partner, so they join nothing.` : 'Every net label sits on a wire or pin and has a partner where needed.',
        items: items.slice(0, 60),
      });
    }

    // 13 BOM sourcing
    const lines = bomLines(pcb, sch);
    const noSrc = lines.filter((l) => !Object.keys(l.src).length && !l.dnp);
    pct = lines.length ? round0(100 * (lines.length - noSrc.length) / lines.length) : 100;
    out.push({
      id: 'sourcing', cat: 'BOM', title: 'Orderable part numbers',
      status: pct >= 90 ? 'pass' : (pct >= 30 ? 'warn' : 'info'), score: pct,
      summary: `${lines.length - noSrc.length} of ${lines.length} BOM lines (${pct}%) carry a manufacturer or supplier part number.`,
      items: noSrc.slice(0, 60).map((l) => ({
        t: `${l.v} \u00b7 ${l.fp} \u00d7 ${l.q} (${l.refs.slice(0, 6).join(', ')}${l.refs.length > 6 ? '\u2026' : ''})`, refs: l.refs.slice(0, 10),
      })),
    });
    yield;

    // 14 fab capability
    const m = pcb.meta;
    items = [];
    if (m.minTrack && m.minTrack < 0.1) items.push({ t: `Minimum track width ${numStr(m.minTrack)} mm is below 0.1 mm (4 mil): needs an advanced process.` });
    if (m.minDrill && m.minDrill < 0.2) items.push({ t: `Minimum drill ${numStr(m.minDrill)} mm is below 0.2 mm: laser or fine mechanical drilling.` });
    const bvias = pcb.vias.filter((v) => v[5]).length;
    if (bvias) items.push({ t: `${bvias} blind/buried or micro vias: HDI stackup required.` });
    out.push({
      id: 'fab', cat: 'Manufacturing', title: 'Standard fab capability',
      status: items.length ? 'info' : 'pass',
      summary: `${m.cu.length}-layer board, ${fmtF(m.w, 1)} \u00d7 ${fmtF(m.h, 1)} mm, min track ${numStr(m.minTrack)} mm, min drill ${numStr(m.minDrill)} mm, ${pcb.vias.length} vias.`,
      items: items,
    });
    yield;
    return out;
  }

  // ------------------------------------------------------------------ BOM
  const NO_VAL = new Set(['~', '-', 'N/A', 'n/a', 'DNP', 'NA']);
  function sourcing(props) {
    let mpn = '', mfr = '';
    const src = {};
    for (const [k, v] of props) {
      const kl = k.toLowerCase();
      if (!v || NO_VAL.has(v)) continue;
      const klS = kl.split('_').join(' ');
      if (SRC_KEYS.some((s) => s === kl || klS.indexOf(s) >= 0)) {
        put(src, k, v);
        if (!mpn && (kl.indexOf('mpn') >= 0 || kl.indexOf('part') >= 0 || kl === 'pn' || (kl.indexOf('mfr') >= 0 && kl.indexOf('part') >= 0))) mpn = v;
        if (!mfr && (kl.indexOf('manufacturer') >= 0 || kl === 'mfr' || kl === 'mfr.' || kl === 'mf') && kl.indexOf('part') < 0) mfr = v;
      }
    }
    return [mpn, mfr, src];
  }
  function refkey(r) {
    const m = RE_REFKEY.exec(r);
    return [m[1], m[2] ? parseInt(m[2], 10) : 0];
  }
  function sortLines(lines) {
    const cmpKey = (a, b) => cmpStr(a[0], b[0]) || cmpNum(a[1], b[1]);
    for (const l of lines) {
      const keyed = l.refs.map((r) => [refkey(r), r]);
      keyed.sort((a, b) => cmpKey(a[0], b[0]));
      l.refs = keyed.map((x) => x[1]);
    }
    const k0 = new Map(lines.map((l) => [l, refkey(l.refs[0])]));
    lines.sort((a, b) => cmpKey(k0.get(a), k0.get(b)));
    return lines;
  }
  /** BOM lines grouped by value/footprint/MPN (checks.bom_lines). */
  function bomLines(pcb, sch) {
    if (!pcb) return bomLinesSch(sch);
    const fields = new Map();
    if (sch) for (const p of (sch.parts || [])) if (!fields.has(p.r)) fields.set(p.r, p);
    const groups = new Map();
    for (const f of pcb.fps) {
      const r = f.r;
      if (!r || get(f, 'bo', 0) || get(f, 'nb', 0) || r.startsWith('REF') || (RE_BOM_SKIP.test(r) && (get(f, 'z', null) || ['none'])[0] === 'none')) continue;
      const sp = fields.has(r) ? fields.get(r) : {};
      if (Object.keys(sp).length && !get(sp, 'bom', 1)) continue;
      const props = new Map(Object.entries(get(f, 'p', null) || {}));
      for (const [k, v] of Object.entries(get(sp, 'p', null) || {})) props.set(k, v);
      const [mpn, mfr, src] = sourcing(props);
      const key = f.v + '\u0000' + f.fp + '\u0000' + mpn;
      let g = groups.get(key);
      const dnp = !!(get(f, 'dnp', 0) || get(sp, 'dnp', 0));
      if (g === undefined) {
        g = {
          v: f.v, fp: f.fp, mpn: mpn, mfr: mfr, refs: [], q: 0, src: src,
          desc: get(sp, 'desc', '') || get(f, 'd', ''), ds: get(sp, 'ds', ''), dnp: dnp, smd: f.k === 'smd',
        };
        groups.set(key, g);
      }
      g.refs.push(r);
      g.q += 1;
      if (Object.keys(src).length && !Object.keys(g.src).length) g.src = src;
    }
    return sortLines(Array.from(groups.values()));
  }
  /** Schematic-only BOM (no PCB): one line per value/footprint/MPN over unique schematic references. */
  function bomLinesSch(sch) {
    if (!sch) return [];
    const seen = new Set();
    const groups = new Map();
    for (const p of (sch.parts || [])) {
      const r = p.r;
      if (seen.has(r)) continue;
      seen.add(r);
      if (!r || r.startsWith('#') || r.startsWith('REF') || !get(p, 'bom', 1)) continue;
      if (classify({ r: r, v: p.v, fp: p.fp })[0] === 'none' && RE_BOM_SKIP.test(r)) continue;
      const [mpn, mfr, src] = sourcing(new Map(Object.entries(p.p || {})));
      const key = p.v + '\u0000' + p.fp + '\u0000' + mpn;
      let g = groups.get(key);
      if (g === undefined) {
        g = { v: p.v, fp: p.fp, mpn: mpn, mfr: mfr, refs: [], q: 0, src: src, desc: p.desc || '', ds: p.ds || '', dnp: !!p.dnp, smd: false };
        groups.set(key, g);
      }
      g.refs.push(r);
      g.q += 1;
      if (Object.keys(src).length && !Object.keys(g.src).length) g.src = src;
    }
    return sortLines(Array.from(groups.values()));
  }

  // =====================================================================================
  // build.py: text variables, stats, KiCad version
  // =====================================================================================
  /** Replace ${VAR} from the .kicad_pro text_variables in PCB texts and schematic title blocks/texts/fields (in place). */
  function substVars(pcb, sch, proText) {
    let tv = {};
    if (proText) {
      try {
        const j = JSON.parse(proText);
        const t = j && typeof j === 'object' && !Array.isArray(j) ? j.text_variables : null;
        tv = t && typeof t === 'object' && !Array.isArray(t) ? t : {};
      } catch (e) { tv = {}; }
    }
    const sub = (s) => {
      if (typeof s !== 'string' || s.indexOf('${') < 0) return s;
      return s.replace(/\$\{([A-Za-z0-9_]+)\}/g, (m0, g1) => own(tv, g1) ? String(tv[g1]) : m0);
    };
    if (pcb) {
      for (const L of Object.keys(pcb.gfx)) for (const t of pcb.gfx[L].texts) t[0] = sub(t[0]);
    }
    if (sch) {
      for (const pg of sch.pages) {
        const tb = {};
        for (const k of Object.keys(pg.tb)) put(tb, k, sub(pg.tb[k]));
        pg.tb = tb;
        if (get(pg.tb, 'title', '').indexOf('${') >= 0) pg.tb.title = '';
        for (const t of pg.texts) t[0] = sub(t[0]);
        for (const s of pg.syms) for (const f of s.f) f[0] = sub(f[0]);
      }
    }
  }

  function icsFrom(list, sch) {
    const ics = [];
    for (const f of list) {
      if (RE_IC_REF.test(f.r)) {
        let desc = '';
        if (sch) {
          for (const p of sch.parts) if (p.r === f.r) { desc = get(p, 'desc', ''); break; }
        }
        ics.push([f.r, f.v, f.fp, pySlice(desc, 90)]);
      }
    }
    return ics.slice(0, 80);
  }
  /** Summary numbers for a board (build.stats_for). */
  function stats(pcb, sch, lines, classes) {
    if (!pcb) return statsSch(sch, lines);
    const fps = pcb.fps, m = pcb.meta;
    if (!classes) classes = fps.map(classify);
    let trackLen = 0;
    for (const k of Object.keys(pcb.trackLen)) trackLen += pcb.trackLen[k];
    let segments = 0;
    for (const k of Object.keys(pcb.tracks)) segments += Math.floor(pcb.tracks[k].length / 6);
    const placed = (f, i) => !get(f, 'bo', 0) && classes[i][0] !== 'none';
    return {
      parts: fps.filter(placed).length,
      fps: fps.length, smd: fps.filter((f) => f.k === 'smd').length, tht: fps.filter((f) => f.k === 'th').length,
      top: fps.filter((f, i) => f.s === 0 && placed(f, i)).length,
      bottom: fps.filter((f, i) => f.s === 1 && placed(f, i)).length,
      lines: lines.length, nets: pcb.nets.filter((n) => n).length, pads: pcb.pads.length, vias: pcb.vias.length,
      segments: segments, trackLen: round0(trackLen), layers: m.cu.length,
      w: m.w, h: m.h, thickness: m.thickness, sheets: sch ? sch.pages.length : 0, ics: icsFrom(fps, sch),
    };
  }
  function statsSch(sch, lines) {
    const uniq = [];
    const seen = new Set();
    if (sch) {
      for (const p of sch.parts) {
        if (seen.has(p.r) || !p.r || p.r.startsWith('#')) continue;
        seen.add(p.r);
        uniq.push({ r: p.r, v: p.v, fp: p.fp });
      }
    }
    return {
      parts: uniq.length, fps: 0, smd: 0, tht: 0, top: 0, bottom: 0,
      lines: (lines || []).length, nets: 0, pads: 0, vias: 0, segments: 0, trackLen: 0, layers: 0,
      w: 0, h: 0, thickness: 0, sheets: sch ? sch.pages.length : 0, ics: icsFrom(uniq, sch),
    };
  }

  /** Major KiCad version from the file format date / generator_version (build.kicad_major). */
  function kicadMajor(version, gen) {
    if (gen) {
      const g = fnum(String(gen), NaN);
      if (g === g && isFinite(g)) return String(Math.trunc(g + 0.02));
    }
    const v8 = String(version).slice(0, 8);
    const v = /^[0-9]+$/.test(v8) ? parseInt(v8, 10) : 0;
    for (const [cut, major] of [[20260101, '10'], [20241201, '9'], [20231001, '8'], [20220601, '7'], [20210601, '6'], [20171130, '5']]) {
      if (v >= cut) return major;
    }
    return '?';
  }

  // =====================================================================================
  // Projects, upload helpers
  // =====================================================================================
  function isIgnoredPath(p) {
    const segs = p.split('/');
    const base = segs[segs.length - 1];
    if (!base) return true;
    for (let i = 0; i < segs.length - 1; i++) {
      if (segs[i] === '__MACOSX' || segs[i].endsWith('-backups')) return true;
    }
    if (base.startsWith('_autosave-') || (base.startsWith('~') && base.endsWith('.lck')) || base.endsWith('.bak') || base.startsWith('._')) return true;
    return false;
  }
  function stemExt(base) {
    const m = /^(.*)\.(kicad_pcb|kicad_sch|kicad_pro)$/.exec(base);
    return m ? [m[1], m[2]] : null;
  }

  /** Find KiCad projects in a list of relative paths (strings or [path, size]).
   *  Returns [{name, folder, pcb, sch, pro}] with PCB+schematic projects first, then larger files first. */
  function findProjects(paths) {
    const size = new Map();
    const folders = new Map();
    for (const it of paths || []) {
      const p0 = Array.isArray(it) ? it[0] : it;
      if (typeof p0 !== 'string') continue;
      const p = p0.replace(/\\/g, '/').replace(/^(\.\/)+/, ''); // normalised for grouping; results keep p0
      if (isIgnoredPath(p)) continue;
      if (Array.isArray(it) && typeof it[1] === 'number') size.set(p0, it[1]);
      const i = p.lastIndexOf('/');
      const folder = i < 0 ? '' : p.slice(0, i);
      const se = stemExt(p.slice(i + 1));
      if (!se) continue;
      let f = folders.get(folder);
      if (!f) folders.set(folder, f = { kicad_pcb: new Map(), kicad_sch: new Map(), kicad_pro: new Map() });
      f[se[1]].set(se[0], p0);
    }
    const projects = [];
    for (const [folder, f] of folders) {
      const usedSch = new Set(), usedPro = new Set();
      // a project file whose stem has a schematic but no board of its own can pair with a differently named board
      const orphan = Array.from(f.kicad_pro.keys()).filter((st) => !f.kicad_pcb.has(st));
      const orphanSch = orphan.filter((st) => f.kicad_sch.has(st));
      for (const [stem, pcb] of f.kicad_pcb) {
        let sch = f.kicad_sch.get(stem) || null;
        let pro = f.kicad_pro.get(stem) || null;
        let schStem = sch ? stem : null;
        if (!sch && orphanSch.length === 1 && !usedSch.has(orphanSch[0])) {
          schStem = orphanSch[0];
          sch = f.kicad_sch.get(schStem);
          if (!pro) pro = f.kicad_pro.get(schStem);
        }
        if (!pro && orphan.length === 1) pro = f.kicad_pro.get(orphan[0]);
        if (schStem !== null) usedSch.add(schStem);
        if (pro) usedPro.add(pro);
        projects.push({ name: stem, folder: folder, pcb: pcb, sch: sch, pro: pro });
      }
      for (const [stem, pro] of f.kicad_pro) {
        if (f.kicad_pcb.has(stem) || usedPro.has(pro)) continue;
        const sch = f.kicad_sch.get(stem) || null;
        if (!sch || usedSch.has(stem)) continue;
        usedSch.add(stem);
        projects.push({ name: stem, folder: folder, pcb: null, sch: sch, pro: pro });
      }
      if (!f.kicad_pcb.size && !f.kicad_pro.size && f.kicad_sch.size === 1) {
        const [stem, sch] = Array.from(f.kicad_sch.entries())[0];
        projects.push({ name: stem, folder: folder, pcb: null, sch: sch, pro: null });
      }
    }
    const sz = (pr) => (pr.pcb ? (size.get(pr.pcb) || 0) : 0) + (pr.sch ? (size.get(pr.sch) || 0) : 0);
    projects.sort((a, b) => {
      const ab = a.pcb && a.sch ? 0 : a.pcb ? 1 : 2, bb = b.pcb && b.sch ? 0 : b.pcb ? 1 : 2;
      return (ab - bb) || (sz(b) - sz(a)) || cmpStr(a.folder + '/' + a.name, b.folder + '/' + b.name);
    });
    return projects;
  }

  function utf8Length(s) {
    let n = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xFC00) === 0xDC00) { n += 4; i++; }
      else n += 3;
    }
    return n;
  }
  function byteSize(v) {
    if (v == null) return 0;
    if (typeof v === 'string') return utf8Length(v);
    if (v instanceof ArrayBuffer) return v.byteLength;
    if (ArrayBuffer.isView(v)) return v.byteLength;
    if (typeof v.size === 'number') return v.size;
    if (typeof v.text === 'string') return utf8Length(v.text);
    return 0;
  }

  const tick = () => new Promise((res) => { setTimeout(res, 0); });
  const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
  // run a generator, handing control back to the event loop whenever a slice exceeds budget ms
  async function drive(gen, budget) {
    let t = nowMs();
    for (;;) {
      const r = gen.next();
      if (r.done) return r.value;
      if (nowMs() - t > budget) { await tick(); t = nowMs(); }
    }
  }

  /** Import one project: same steps as build.py main(). Resolves to
   *  {pcb, sch, bom, checks, power, stats, kicad, files}. opts.onProgress(label, fraction). */
  async function importProject(files, proj, opts) {
    opts = opts || {};
    const progress = (label, frac) => { if (opts.onProgress) opts.onProgress(label, frac); };
    const budget = opts.sliceMs || 30;
    const origSizes = {};
    for (const k of Object.keys(files)) origSizes[k] = byteSize(files[k]);
    // decode once, and only what this project can use: its board, project file and the schematics at or
    // below the root sheet's folder (sub-sheets resolve relative to it). Accepts string, Uint8Array,
    // ArrayBuffer and browser File/Blob values.
    const need = new Set([proj.pcb, proj.sch, proj.pro].filter(Boolean));
    if (proj.sch) {
      const sd = pathDirname(proj.sch);
      for (const k of Object.keys(files)) if (/\.kicad_sch$/.test(k) && (!sd || k.startsWith(sd + '/'))) need.add(k);
    }
    const F = Object.assign({}, files);
    for (const k of need) {
      if (!own(files, k)) continue;
      const v = files[k];
      if (typeof v === 'string') continue;
      if (typeof Blob !== 'undefined' && v instanceof Blob) F[k] = decodeText(new Uint8Array(await v.arrayBuffer()));
      else F[k] = fileText(files, k);
    }
    files = F;
    let pcb = null, sch = null;
    if (proj.pcb) {
      progress('Reading PCB', 0.02);
      await tick();
      const txt = fileText(files, proj.pcb);
      if (txt === null) throw new Error('PCB file not found: ' + proj.pcb);
      const lazy = new LazyRoot(txt);
      if (lazy.head !== 'kicad_pcb') throw new Error(proj.pcb + ' is not a KiCad board file (expected a (kicad_pcb ...) s-expression).');
      progress('Parsing PCB', 0.1);
      await tick();
      pcb = await drive(pcbGen(lazy, opts.boardCfg), budget);
    }
    if (proj.sch && own(files, proj.sch)) {
      progress('Parsing schematic', 0.5);
      await tick();
      if (!/^\s*\(\s*kicad_sch[\s()]/.test((fileText(files, proj.sch) || '').slice(0, 200))) {
        throw new Error(proj.sch + ' is not a KiCad 6+ schematic (expected a (kicad_sch ...) s-expression).');
      }
      sch = await drive(schGen(files, proj.sch, proj.name), budget);
    }
    const proText = proj.pro ? fileText(files, proj.pro) : null;
    substVars(pcb, sch, proText);
    let classes = [];
    let checks = [];
    let lines;
    let power = [];
    let st;
    if (pcb) {
      progress('Classifying parts', 0.65);
      await tick();
      classes = pcb.fps.map(classify);
      pcb.fps.forEach((f, i) => { const c = classes[i]; f.z = [c[0], c[1], c[2]]; });
      progress('Running design checks', 0.72);
      await tick();
      checks = await drive(checksGen(pcb, sch, classes), budget);
      progress('Building BOM', 0.92);
      await tick();
      lines = bomLines(pcb, sch);
      power = powerNets(pcb);
      st = stats(pcb, sch, lines, classes);
    } else {
      progress('Building BOM', 0.9);
      await tick();
      lines = bomLinesSch(sch);
      st = statsSch(sch, lines);
    }
    let kicad = '?';
    if (pcb) kicad = kicadMajor(pcb.meta.kicad, pcb.meta.gen);
    else if (proj.sch) {
      const head = (fileText(files, proj.sch) || '').slice(0, 2000);
      const mv = /\(version\s+(\d+)\)/.exec(head), mg = /\(generator_version\s+"([^"]*)"\)/.exec(head);
      kicad = kicadMajor(mv ? mv[1] : '?', mg ? mg[1] : '');
    }
    const folder = proj.folder != null ? proj.folder : pathDirname(proj.pcb || proj.sch || '');
    const pre = folder ? folder + '/' : '';
    const allKeys = new Set(Object.keys(files));
    if (opts.sizes) for (const k of Object.keys(opts.sizes)) allKeys.add(k);
    const normKey = (k) => k.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
    const list = Array.from(allKeys).filter((k) => !pre || normKey(k).startsWith(pre)).sort(cmpStr).slice(0, 400)
      .map((k) => [k, opts.sizes && own(opts.sizes, k) ? opts.sizes[k] : (own(origSizes, k) ? origSizes[k] : 0)]);
    progress('Done', 1);
    return { pcb: pcb, sch: sch, bom: lines, checks: checks, power: power, stats: st, kicad: kicad, files: list };
  }

  // ---- ZIP reading
  const CP437 = '\u00c7\u00fc\u00e9\u00e2\u00e4\u00e0\u00e5\u00e7\u00ea\u00eb\u00e8\u00ef\u00ee\u00ec\u00c4\u00c5\u00c9\u00e6\u00c6\u00f4\u00f6\u00f2\u00fb\u00f9\u00ff\u00d6\u00dc\u00a2\u00a3\u00a5\u20a7\u0192' +
    '\u00e1\u00ed\u00f3\u00fa\u00f1\u00d1\u00aa\u00ba\u00bf\u2310\u00ac\u00bd\u00bc\u00a1\u00ab\u00bb\u2591\u2592\u2593\u2502\u2524\u2561\u2562\u2556\u2555\u2563\u2551\u2557\u255d\u255c\u255b\u2510' +
    '\u2514\u2534\u252c\u251c\u2500\u253c\u255e\u255f\u255a\u2554\u2569\u2566\u2560\u2550\u256c\u2567\u2568\u2564\u2565\u2559\u2558\u2552\u2553\u256b\u256a\u2518\u250c\u2588\u2584\u258c\u2590\u2580' +
    '\u03b1\u00df\u0393\u03c0\u03a3\u03c3\u00b5\u03c4\u03a6\u0398\u03a9\u03b4\u221e\u03c6\u03b5\u2229\u2261\u00b1\u2265\u2264\u2320\u2321\u00f7\u2248\u00b0\u2219\u00b7\u221a\u207f\u00b2\u25a0\u00a0';
  function decodeName(bytes, utf8Flag) {
    if (utf8Flag) return new TextDecoder('utf-8').decode(bytes);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (e) { /* not UTF-8 */ }
    let s = '';
    for (const b of bytes) s += b < 128 ? String.fromCharCode(b) : CP437[b - 128];
    return s;
  }
  async function inflateRaw(u8) {
    if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot unpack ZIP files (DecompressionStream is not available). Upload the project folder instead.');
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([u8]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  /** Minimal ZIP reader: resolves to {path: Uint8Array} (stored + deflate, ZIP64 sizes/offsets).
   *  opts.filter(path) -> false skips an entry without inflating it; opts.sizes (object) receives
   *  {path: uncompressedSize} for every file entry, including skipped ones. */
  async function unzip(data, opts) {
    opts = opts || {};
    const u8 = data instanceof Uint8Array ? data : (ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data));
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const len = u8.length;
    const u16 = (o) => dv.getUint16(o, true);
    const u32 = (o) => dv.getUint32(o, true);
    const u64 = (o) => {
      const lo = dv.getUint32(o, true), hi = dv.getUint32(o + 4, true);
      if (hi >= 0x200000) throw new Error('ZIP entry too large');
      return hi * 4294967296 + lo;
    };
    let eocd = -1;
    for (let i = len - 22; i >= Math.max(0, len - 22 - 65535); i--) {
      if (u32(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a ZIP file (no end-of-central-directory record).');
    let count = u16(eocd + 10);
    let cdSize = u32(eocd + 12);
    let cdOff = u32(eocd + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) {
      const loc = eocd - 20;
      if (loc < 0 || u32(loc) !== 0x07064b50) throw new Error('ZIP64 archive without a ZIP64 locator: unsupported.');
      const z64 = u64(loc + 8);
      if (z64 + 56 > len || u32(z64) !== 0x06064b50) throw new Error('Corrupt ZIP64 end-of-central-directory record.');
      count = u64(z64 + 32);
      cdSize = u64(z64 + 40);
      cdOff = u64(z64 + 48);
    }
    const out = {};
    let p = cdOff;
    for (let n = 0; n < count; n++) {
      if (p + 46 > len || u32(p) !== 0x02014b50) throw new Error('Corrupt ZIP central directory.');
      const flags = u16(p + 8);
      const method = u16(p + 10);
      let csize = u32(p + 20);
      let usize = u32(p + 24);
      const nlen = u16(p + 28), elen = u16(p + 30), clen = u16(p + 32);
      let lho = u32(p + 42);
      const name = decodeName(u8.subarray(p + 46, p + 46 + nlen), (flags & 0x800) !== 0).replace(/\\/g, '/');
      // ZIP64 extra field
      let e = p + 46 + nlen;
      const eEnd = e + elen;
      while (e + 4 <= eEnd) {
        const id = u16(e), sz = u16(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (usize === 0xffffffff) { usize = u64(q); q += 8; }
          if (csize === 0xffffffff) { csize = u64(q); q += 8; }
          if (lho === 0xffffffff) { lho = u64(q); q += 8; }
        }
        e += 4 + sz;
      }
      p = eEnd + clen;
      if (name.endsWith('/')) continue;
      if (opts.sizes) opts.sizes[name] = usize;
      if (opts.filter && !opts.filter(name)) continue;
      if (flags & 1) throw new Error('Encrypted ZIP entries are not supported: ' + name);
      if (csize === 0xffffffff || usize === 0xffffffff || lho === 0xffffffff) throw new Error('ZIP64 entry without size information: ' + name);
      if (lho + 30 > len || u32(lho) !== 0x04034b50) throw new Error('Corrupt ZIP local header: ' + name);
      const start = lho + 30 + u16(lho + 26) + u16(lho + 28);
      const raw = u8.subarray(start, start + csize);
      if (method === 0) out[name] = raw.slice();
      else if (method === 8) out[name] = await inflateRaw(raw);
      else throw new Error('Unsupported ZIP compression method ' + method + ' for ' + name + ' (use Deflate).');
    }
    return out;
  }
  /** UTF-8 decode (invalid bytes become U+FFFD) and strip a byte-order mark. */
  function decodeText(u8) {
    const b = u8 instanceof ArrayBuffer ? new Uint8Array(u8) : u8;
    let s = new TextDecoder('utf-8').decode(b);
    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
    return s;
  }

  const api = {
    version: 1,
    parseSexpr: parseSexpr,
    parsePcb: parsePcb,
    parseSchematic: parseSchematic,
    classify: classify,
    runChecks: runChecks,
    bomLines: bomLines,
    bomLinesSch: bomLinesSch,
    powerNets: powerNets,
    shortNet: shortNet,
    substVars: substVars,
    stats: stats,
    kicadMajor: kicadMajor,
    findProjects: findProjects,
    importProject: importProject,
    unzip: unzip,
    decodeText: decodeText,
    // exposed for tests
    _py: { pyRound: pyRound, round0: round0, fmtF: fmtF, floatRepr: floatRepr, hypot: hypot, fnum: fnum, PySet: PySet, symXf: symXf, pcbFromTree: pcbFromTree },
  };
  N.kicad = api;
})(typeof window !== 'undefined' ? window : globalThis);
