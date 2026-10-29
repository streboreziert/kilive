"""Design checks run at import time (approximate DRC / ERC / DFM / debuggability)."""
import math
import re
from collections import defaultdict, Counter
from kicad_pcb import rot

GND_RE = re.compile(r'(^|[/_\-])(A|D|P|S|CHASSIS|EARTH)?(GND|VSS|VEE|0V)([_\-]?\w*)?$', re.I)
PWR_NAME_RE = re.compile(r'^([+-]?\d+V\d*|\d+V\d+|[+-]?\d+\.\d+V|(A|D|P|IO|CPU|SOC|MEM|DDR)?V(CC|DD|DDA|DDIO|DDQ|BUS|BAT|IN|SYS|IO|CORE|REF|MOT|PP|LED|CHG|OUT|USB|DC|S|PWR|MAIN)\w*|PWR\w*|VIN\w*|\+\w+)$', re.I)
PWR_EXCL_RE = re.compile(r'(_EN|EN$|_DET|DET$|_SENSE|SENSE|_PG|PGOOD|_FB|FB$|_OK|_ADC|_SW|^SW|CTRL|_ALERT|_INT|_CTRL|_SEL|_MON|_STAT|_DIV|_N$|_P$)', re.I)
HI_I_RE = re.compile(r'(VBUS|VIN|VBAT|VSYS|DCIN|VCHG|VMOT|(^|[^0-9.])(5|9|12|15|19|20|24)V)', re.I)
ESD_RE = re.compile(r'(esd|tvs|usblc|pesd|tpd\d|sp05|rclamp|prtr|srv05|ip42|esda|nup\d|sp30|sp72|cdsot|tpd2e|tpd4e|lesd|esdalc|smf|smaj|sm712|pgb)', re.I)
USB_DATA_RE = re.compile(r'(^|[_\-/])(USB\d?_?)?(D_?[PMN+\-]|DP|DM|DN)(\d|_|$)')
SRC_KEYS = ('mpn', 'part number', 'partnumber', 'part_number', 'mfr', 'manufacturer', 'lcsc', 'digikey', 'digi-key', 'mouser', 'jlc', 'sku', 'order', 'pn', 'farnell', 'arrow', 'supplier')


def short(net):
    return net.rsplit('/', 1)[-1] if net else net


def is_gnd(net):
    return bool(GND_RE.search(short(net))) or short(net).upper() in ('GND', 'GNDA', 'GNDD', 'AGND', 'DGND', 'PGND', 'VSS')


def power_nets(pcb):
    nets = pcb['nets']
    by_type = defaultdict(set)
    for p in pcb['pads']:
        if p[15] in ('power_in', 'power_out'):
            by_type[p[10]].add(p[15])
    out = set()
    for i, n in enumerate(nets):
        if i == 0 or not n or is_gnd(n) or n.startswith('unconnected'):
            continue
        s = short(n)
        if PWR_EXCL_RE.search(s):
            if i not in by_type:
                continue
        if PWR_NAME_RE.match(s) or 'power_out' in by_type.get(i, ()) or ('power_in' in by_type.get(i, ()) and not s.startswith('Net-(')):
            out.add(i)
    return out


# ------------------------------------------------------------------ geometry helpers
def pad_contains(p, x, y, tol=0.0):
    dx, dy = x - p[4], y - p[5]
    lx, ly = rot(dx, dy, -p[8])
    if len(p) > 16 and p[16]:  # custom pad: use extents of its primitives
        ex = max([p[6] / 2] + [abs(v) for poly in p[16] for v in poly[0::2]])
        ey = max([p[7] / 2] + [abs(v) for poly in p[16] for v in poly[1::2]])
        return abs(lx) <= ex + tol and abs(ly) <= ey + tol
    if p[3] == 0:  # circle
        return math.hypot(lx, ly) <= p[6] / 2 + tol
    return abs(lx) <= p[6] / 2 + tol and abs(ly) <= p[7] / 2 + tol


def pad_ext(p):
    if len(p) > 16 and p[16]:
        ex = max([p[6] / 2] + [abs(v) for poly in p[16] for v in poly[0::2]])
        ey = max([p[7] / 2] + [abs(v) for poly in p[16] for v in poly[1::2]])
        return ex, ey
    return p[6] / 2, p[7] / 2


def pad_dist(p, x, y):
    """Distance from a point to the pad copper (0 inside)."""
    dx, dy = x - p[4], y - p[5]
    lx, ly = rot(dx, dy, -p[8])
    if p[3] == 0 and not (len(p) > 16 and p[16]):
        return max(0.0, math.hypot(lx, ly) - p[6] / 2)
    ex, ey = pad_ext(p)
    ox, oy = max(0.0, abs(lx) - ex), max(0.0, abs(ly) - ey)
    return math.hypot(ox, oy)


def seg_dist(px, py, x1, y1, x2, y2):
    dx, dy = x2 - x1, y2 - y1
    L2 = dx * dx + dy * dy
    if L2 < 1e-12:
        return math.hypot(px - x1, py - y1)
    t = max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / L2))
    return math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))


class Poly:
    """Polygon with a row index for fast point-in-polygon."""

    def __init__(self, flat, row=0.5):
        self.pts = [(flat[i], flat[i + 1]) for i in range(0, len(flat), 2)]
        xs = [p[0] for p in self.pts]
        ys = [p[1] for p in self.pts]
        self.bb = (min(xs), min(ys), max(xs), max(ys))
        self.row = row
        self.rows = defaultdict(list)
        n = len(self.pts)
        for i in range(n):
            a, b = self.pts[i], self.pts[(i + 1) % n]
            y0, y1 = min(a[1], b[1]), max(a[1], b[1])
            for r in range(int(math.floor(y0 / row)), int(math.floor(y1 / row)) + 1):
                self.rows[r].append((a, b))

    def contains(self, x, y):
        b = self.bb
        if x < b[0] or x > b[2] or y < b[1] or y > b[3]:
            return False
        inside = False
        for (xi, yi), (xj, yj) in self.rows.get(int(math.floor(y / self.row)), ()):
            if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
                inside = not inside
        return inside


class Grid:
    def __init__(self, cell=1.0):
        self.c = cell
        self.g = defaultdict(list)

    def add(self, item, x0, y0, x1, y1):
        c = self.c
        for gx in range(int(math.floor(x0 / c)), int(math.floor(x1 / c)) + 1):
            for gy in range(int(math.floor(y0 / c)), int(math.floor(y1 / c)) + 1):
                self.g[(gx, gy)].append(item)

    def query(self, x, y, r=0.0):
        c = self.c
        seen = set()
        for gx in range(int(math.floor((x - r) / c)), int(math.floor((x + r) / c)) + 1):
            for gy in range(int(math.floor((y - r) / c)), int(math.floor((y + r) / c)) + 1):
                for it in self.g.get((gx, gy), ()):
                    if id(it) not in seen:
                        seen.add(id(it))
                        yield it


class UF:
    def __init__(self):
        self.p = {}

    def find(self, a):
        p = self.p
        p.setdefault(a, a)
        root = a
        while p[root] != root:
            root = p[root]
        while p[a] != root:
            p[a], a = root, p[a]
        return root

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.p[ra] = rb


# ------------------------------------------------------------------ connectivity
def connectivity(pcb):
    cu = pcb['meta']['cu']
    nL = len(cu)
    lidx = {n: i for i, n in enumerate(cu)}

    def pad_layers(p):
        m = p[9]
        s = set()
        if m & 1:
            s.add(0)
        if m & 2:
            s.add(nL - 1)
        if m & 4:
            s.update(range(1, nL - 1))
        return s

    per_net = defaultdict(lambda: {'pads': [], 'segs': [], 'vias': [], 'zones': []})
    for i, p in enumerate(pcb['pads']):
        if p[10] and p[2] != 2:
            per_net[p[10]]['pads'].append((i, p, pad_layers(p)))
    for L, arr in pcb['tracks'].items():
        li = lidx.get(L)
        if li is None:
            continue
        for k in range(0, len(arr), 6):
            n = arr[k + 5]
            if n:
                per_net[n]['segs'].append((li, arr[k], arr[k + 1], arr[k + 2], arr[k + 3], arr[k + 4]))
    for v in pcb['vias']:
        if v[4]:
            per_net[v[4]]['vias'].append(v)
    filled_nets = set()
    for z in pcb['zones']:
        li = lidx.get(z['l'])
        if li is not None and z['n'] and len(z['p']) >= 6:
            per_net[z['n']]['zones'].append((li, Poly(z['p'])))
            filled_nets.add(z['n'])
    unfilled = 0
    for zo in pcb.get('zoneOutlines', []):
        if zo['k'] or not zo['n'] or zo.get('f', 0) or len(zo['p']) < 6:
            continue
        unfilled += 1
        for L in zo['l']:
            targets = cu if L in ('*.Cu', 'F&B.Cu') else ([L] if L in lidx else [])
            if L == 'F&B.Cu':
                targets = [cu[0], cu[-1]]
            for t in targets:
                per_net[zo['n']]['zones'].append((lidx[t], Poly(zo['p'])))

    results = {}
    for net, d in per_net.items():
        pads = d['pads']
        if len(pads) < 2:
            continue
        uf = UF()
        grid = Grid(1.0)
        for (i, p, ls) in pads:
            r = max(pad_ext(p))
            grid.add(('p', i, p, ls), p[4] - r, p[5] - r, p[4] + r, p[5] + r)
        for si, s in enumerate(d['segs']):
            li, x1, y1, x2, y2, w = s
            grid.add(('s', si, s), min(x1, x2) - w, min(y1, y2) - w, max(x1, x2) + w, max(y1, y2) + w)
        for vi, v in enumerate(d['vias']):
            r = v[2] / 2
            grid.add(('v', vi, v), v[0] - r, v[1] - r, v[0] + r, v[1] + r)
        # segments endpoints
        for si, s in enumerate(d['segs']):
            li, x1, y1, x2, y2, w = s
            for (ex, ey) in ((x1, y1), (x2, y2)):
                for it in grid.query(ex, ey, w):
                    if it[0] == 's':
                        if it[1] == si:
                            continue
                        o = it[2]
                        if o[0] != li:
                            continue
                        if seg_dist(ex, ey, o[1], o[2], o[3], o[4]) <= max(0.01, (w + o[5]) / 2 - 0.002):
                            uf.union(('s', si), ('s', it[1]))
                    elif it[0] == 'p':
                        if li in it[3] and pad_dist(it[2], ex, ey) <= w / 2 - 0.002:
                            uf.union(('s', si), ('p', it[1]))
                    elif it[0] == 'v':
                        v = it[2]
                        if v[6] <= li <= v[7] and math.hypot(ex - v[0], ey - v[1]) <= v[2] / 2 + w / 2 - 0.002:
                            uf.union(('s', si), ('v', it[1]))
        # vias in pads / pads overlapping pads
        for vi, v in enumerate(d['vias']):
            for it in grid.query(v[0], v[1], v[2] / 2):
                if it[0] == 's':
                    o = it[2]
                    if v[6] <= o[0] <= v[7] and seg_dist(v[0], v[1], o[1], o[2], o[3], o[4]) <= v[2] / 2 + o[5] / 2 - 0.002:
                        uf.union(('v', vi), ('s', it[1]))
                elif it[0] == 'p' and pad_dist(it[2], v[0], v[1]) <= v[2] / 2 - 0.002 and any(v[6] <= l <= v[7] for l in it[3]):
                    uf.union(('v', vi), ('p', it[1]))
                elif it[0] == 'v' and it[1] != vi and math.hypot(v[0] - it[2][0], v[1] - it[2][1]) < (v[2] + it[2][2]) / 2:
                    if not (v[7] < it[2][6] or it[2][7] < v[6]):
                        uf.union(('v', vi), ('v', it[1]))
        for (i, p, ls) in pads:
            r = min(p[6], p[7]) / 2
            for it in grid.query(p[4], p[5], max(p[6], p[7]) / 2):
                if it[0] == 's' and it[2][0] in ls:
                    o = it[2]
                    if seg_dist(p[4], p[5], o[1], o[2], o[3], o[4]) <= r + o[5] / 2 - 0.01:
                        uf.union(('p', i), ('s', it[1]))
            for it in grid.query(p[4], p[5], 0.01):
                if it[0] == 'p' and it[1] != i and (ls & it[3]) and pad_contains(it[2], p[4], p[5], 0.01):
                    uf.union(('p', i), ('p', it[1]))
        # zones
        for zi, (li, poly) in enumerate(d['zones']):
            zkey = ('z', zi)
            vgrid = Grid(0.5)
            for (x, y) in poly.pts:
                vgrid.g[(int(math.floor(x / 0.5)), int(math.floor(y / 0.5)))].append((x, y))
            b = poly.bb
            for (i, p, ls) in pads:
                if li not in ls:
                    continue
                if p[4] < b[0] - 5 or p[4] > b[2] + 5 or p[5] < b[1] - 5 or p[5] > b[3] + 5:
                    continue
                hit = poly.contains(p[4], p[5])
                if not hit:
                    r = max(pad_ext(p)) + 0.05
                    for q in vgrid.query(p[4], p[5], r):
                        if pad_contains(p, q[0], q[1], 0.03):
                            hit = True
                            break
                if hit:
                    uf.union(zkey, ('p', i))
            for vi, v in enumerate(d['vias']):
                if not (v[6] <= li <= v[7]):
                    continue
                hit = poly.contains(v[0], v[1])
                if not hit:
                    for q in vgrid.query(v[0], v[1], v[2] / 2 + 0.05):
                        if math.hypot(q[0] - v[0], q[1] - v[1]) <= v[2] / 2 + 0.03:
                            hit = True
                            break
                if hit:
                    uf.union(zkey, ('v', vi))
            for si, s in enumerate(d['segs']):
                if s[0] != li:
                    continue
                if poly.contains(s[1], s[2]) or poly.contains(s[3], s[4]):
                    uf.union(zkey, ('s', si))
        # pads sharing a pin number inside one footprint are the same physical pin
        same = {}
        for (i, p, ls) in pads:
            k = (p[0], p[1])
            if k in same:
                uf.union(('p', i), ('p', same[k]))
            else:
                same[k] = i
        groups = defaultdict(list)
        for (i, p, ls) in pads:
            groups[uf.find(('p', i))].append(i)
        if len(groups) > 1:
            results[net] = sorted(groups.values(), key=len, reverse=True)
    return results, unfilled


# ------------------------------------------------------------------ courtyard overlap (convex)
def clip(subject, clipper):
    def inside(p, a, b):
        return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= 0

    def inter(p1, p2, a, b):
        x1, y1 = p1
        x2, y2 = p2
        x3, y3 = a
        x4, y4 = b
        den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
        if abs(den) < 1e-12:
            return p2
        t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den
        return (x1 + t * (x2 - x1), y1 + t * (y2 - y1))
    out = subject
    # ensure CCW orientation for both
    for i in range(len(clipper)):
        a, b = clipper[i], clipper[(i + 1) % len(clipper)]
        inp = out
        out = []
        if not inp:
            break
        s = inp[-1]
        for e in inp:
            if inside(e, a, b):
                if not inside(s, a, b):
                    out.append(inter(s, e, a, b))
                out.append(e)
            elif inside(s, a, b):
                out.append(inter(s, e, a, b))
            s = e
    return out


def area(poly):
    a = 0
    for i in range(len(poly)):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % len(poly)]
        a += x1 * y2 - x2 * y1
    return a / 2


def ccw(poly):
    return poly if area(poly) >= 0 else list(reversed(poly))


# ------------------------------------------------------------------ main
def run_checks(pcb, sch, classes):
    nets = pcb['nets']
    fps = pcb['fps']
    pads = pcb['pads']
    out = []
    net_pads = defaultdict(list)
    for i, p in enumerate(pads):
        if p[10]:
            net_pads[p[10]].append(i)
    pwr = power_nets(pcb)

    def fpref(i):
        return fps[pads[i][0]]['r']

    def padlabel(i):
        return f"{fpref(i)}.{pads[i][1]}"

    # 1 unrouted
    unrouted, unfilled = connectivity(pcb)
    items = []
    for n, groups in sorted(unrouted.items(), key=lambda kv: -sum(len(g) for g in kv[1][1:])):
        stray = [i for g in groups[1:] for i in g]
        p0 = pads[stray[0]]
        items.append({'t': f"{nets[n]} splits into {len(groups)} islands. Not reached: {', '.join(padlabel(i) for i in stray[:8])}{'…' if len(stray) > 8 else ''}",
                      'nets': [nets[n]], 'refs': sorted({fpref(i) for i in stray})[:8], 'xy': [p0[4], p0[5]]})
    multi = sum(1 for n in net_pads if len(net_pads[n]) >= 2)
    note = f" {unfilled} zone(s) were saved unfilled, so their outlines stood in for copper." if unfilled else ''
    out.append({'id': 'unrouted', 'cat': 'Electrical', 'title': 'Unrouted connections',
                'status': 'fail' if items else 'pass',
                'summary': (f"{len(items)} of {multi} multi-pad nets look split: no track, via or pour joins every pad. Confirm with KiCad DRC; zone fills saved in the file may be stale." if items else f"All {multi} multi-pad nets are fully connected by tracks, vias and pours.") + note,
                'items': items[:60]})

    # 2 single-pin nets
    items = []
    for n, lst in net_pads.items():
        nm = nets[n]
        if len(lst) == 1 and not nm.startswith('unconnected') and 'no_connect' not in pads[lst[0]][15] and not nm.startswith('Net-(') :
            i = lst[0]
            items.append({'t': f"{nm} touches only {padlabel(i)}", 'nets': [nm], 'refs': [fpref(i)], 'xy': [pads[i][4], pads[i][5]]})
    items.sort(key=lambda it: it['t'])
    out.append({'id': 'single', 'cat': 'Electrical', 'title': 'Named nets with a single pin',
                'status': 'warn' if items else 'pass',
                'summary': f"{len(items)} named nets reach only one pad. Each is either a test hook or a missing connection." if items else 'Every named net reaches at least two pads.',
                'items': items[:60]})

    # 3 decoupling
    caps_by_net = defaultdict(list)
    for i, p in enumerate(pads):
        f = fps[p[0]]
        if f['r'][:1] == 'C' and re.match(r'^C\d', f['r']):
            caps_by_net[p[10]].append(i)
    items = []
    ic_checked = 0
    for fi, f in enumerate(fps):
        if not re.match(r'^(U|IC)\d', f['r']) or ESD_RE.search(f['v'] + ' ' + f['fp']):
            continue
        pin_nets = defaultdict(list)
        for pi in f['pads']:
            p = pads[pi]
            if p[10] in pwr and (p[15] in ('power_in', '') or p[15] is None):
                pin_nets[p[10]].append(pi)
        if not pin_nets:
            continue
        ic_checked += 1
        bad = []
        for n, pl in pin_nets.items():
            best, bref = 1e9, None
            for ci in caps_by_net.get(n, ()):
                c = pads[ci]
                for pi in pl:
                    d = math.hypot(c[4] - pads[pi][4], c[5] - pads[pi][5])
                    if d < best:
                        best, bref = d, fps[c[0]]['r']
            if best > 6.0:
                bad.append((nets[n], best, bref))
        if bad:
            desc = '; '.join(f"{short(n)}: " + (f"nearest cap {bref} at {d:.1f} mm" if bref else 'no capacitor on this rail') for n, d, bref in bad[:4])
            items.append({'t': f"{f['r']} ({f['v']}) — {desc}", 'refs': [f['r']] + [b[2] for b in bad if b[2]][:3], 'nets': [b[0] for b in bad], 'xy': [f['x'], f['y']]})
    out.append({'id': 'decoupling', 'cat': 'Power integrity', 'title': 'Decoupling capacitors near IC supply pins',
                'status': 'warn' if items else 'pass',
                'summary': (f"{len(items)} of {ic_checked} ICs have a supply pin with no capacitor on that rail within 6 mm." if items else f"All {ic_checked} ICs with supply pins have a capacitor on each rail within 6 mm."),
                'items': items[:60]})

    # 4 power traces
    items = []
    seg_by_net = defaultdict(list)
    for L, arr in pcb['tracks'].items():
        for k in range(0, len(arr), 6):
            seg_by_net[arr[k + 5]].append((arr[k + 4], math.hypot(arr[k + 2] - arr[k], arr[k + 3] - arr[k + 1]), arr[k], arr[k + 1]))
    for n in sorted(pwr, key=lambda n: nets[n]):
        segs = [s for s in seg_by_net.get(n, ()) if s[1] > 1.0]
        if not segs:
            continue
        hi = bool(HI_I_RE.search(short(nets[n])))
        limit = 0.25 if hi else 0.15
        narrow = [s for s in segs if s[0] < limit - 1e-6]
        if narrow:
            length = sum(s[1] for s in narrow)
            wmin = min(s[0] for s in narrow)
            amps = 0.048 * (10 ** 0.44) * ((wmin / 0.0254) * 1.378) ** 0.725
            items.append({'t': f"{nets[n]}: {length:.1f} mm at {wmin:.3f} mm wide, about {amps:.2f} A for a 10 °C rise on 1 oz outer copper (IPC-2221)",
                          'nets': [nets[n]], 'xy': [narrow[0][2], narrow[0][3]]})
    out.append({'id': 'pwrwidth', 'cat': 'Power integrity', 'title': 'Narrow traces on supply rails',
                'status': 'warn' if items else 'pass',
                'summary': f"{len(items)} supply rails have long thin sections that may drop voltage under load." if items else 'Supply rails are routed at comfortable widths.',
                'items': items[:60]})

    # 5 ESD on USB / external connectors
    items = []
    esd_nets = set()
    for fi, f in enumerate(fps):
        txt = ' '.join([f['v'], f['fp'], f.get('d', '')] + list((f.get('p') or {}).values()))
        if ESD_RE.search(txt) and not re.match(r'^(R|C|L)\d', f['r']):
            for pi in f['pads']:
                esd_nets.add(pads[pi][10])
    usb_count = 0
    for fi, f in enumerate(fps):
        name = (f['fp'] + ' ' + f.get('m', '')).lower()
        if 'usb' not in name or not re.match(r'^(J|USB|P|CN|CON)\d', f['r']):
            continue
        usb_count += 1
        data = set()
        for pi in f['pads']:
            p = pads[pi]
            nm = short(nets[p[10]]).upper()
            pf = (p[14] or '').upper()
            if nets[p[10]].startswith('unconnected'):
                continue
            if p[10] and (USB_DATA_RE.search(nm) or re.match(r'^(D[+\-]|DP|DN|DM|D_[PN])\d?$', pf)) and not is_gnd(nets[p[10]]) and p[10] not in pwr:
                data.add(p[10])
        if not data:
            continue
        unprot = [n for n in data if n not in esd_nets]
        if unprot:
            items.append({'t': f"{f['r']} ({f['fp']}): data lines {', '.join(short(nets[n]) for n in sorted(unprot))} reach no ESD/TVS part", 'refs': [f['r']], 'nets': [nets[n] for n in unprot], 'xy': [f['x'], f['y']]})
    out.append({'id': 'esd', 'cat': 'Robustness', 'title': 'ESD protection on USB data lines',
                'status': 'warn' if items else ('pass' if usb_count else 'info'),
                'summary': (f"{len(items)} of {usb_count} USB connectors have data lines without a directly attached ESD/TVS device." if items else (f"All {usb_count} USB connectors have ESD protection on their data lines." if usb_count else 'No USB connectors on this board.')),
                'items': items})

    # 6 test points on rails (debuggability)
    tp_nets = set()
    for f in fps:
        if re.match(r'^TP\d', f['r']) or 'testpoint' in f['fp'].lower() or 'test_point' in f['fp'].lower():
            for pi in f['pads']:
                tp_nets.add(pads[pi][10])
    rails = [n for n in pwr if len(net_pads.get(n, ())) >= 3]
    covered = [n for n in rails if n in tp_nets]
    missing = [n for n in rails if n not in tp_nets]
    items = [{'t': f"{nets[n]} ({len(net_pads[n])} pads) has no test point", 'nets': [nets[n]],
              'xy': [pads[net_pads[n][0]][4], pads[net_pads[n][0]][5]]} for n in sorted(missing, key=lambda n: -len(net_pads[n]))]
    pct = round(100 * len(covered) / len(rails)) if rails else 100
    out.append({'id': 'testpoints', 'cat': 'Debuggability', 'title': 'Test points on supply rails',
                'status': 'pass' if pct >= 80 else ('warn' if rails else 'info'), 'score': pct,
                'summary': f"{len(covered)} of {len(rails)} supply rails ({pct}%) have a dedicated test point. {len([f for f in fps if re.match(r'^TP', f['r'])])} test points on the board.",
                'items': items[:60]})

    # 7 net naming (debuggability)
    multi_nets = [n for n, l in net_pads.items() if len(l) >= 2]
    auto = [n for n in multi_nets if nets[n].startswith('Net-(') or '/Net-(' in nets[n]]
    pct = round(100 * (len(multi_nets) - len(auto)) / len(multi_nets)) if multi_nets else 100
    out.append({'id': 'naming', 'cat': 'Debuggability', 'title': 'Named nets',
                'status': 'pass' if pct >= 60 else 'info', 'score': pct,
                'summary': f"{pct}% of connected nets carry a human name; {len(auto)} use auto-generated names like Net-(R1-Pad2), which are harder to probe by name.",
                'items': [{'t': nets[n], 'nets': [nets[n]], 'xy': [pads[net_pads[n][0]][4], pads[net_pads[n][0]][5]]} for n in sorted(auto, key=lambda n: nets[n])[:40]]})

    # 8 courtyard overlaps
    items = []
    for side in (0, 1):
        polys = []
        for fi, f in enumerate(fps):
            if f['s'] != side or not f.get('c') or classes[fi][0] == 'none' or len(f['c']) < 6:
                continue
            pl = ccw([(f['c'][i], f['c'][i + 1]) for i in range(0, len(f['c']), 2)])
            xs = [p[0] for p in pl]
            ys = [p[1] for p in pl]
            polys.append((fi, pl, (min(xs), min(ys), max(xs), max(ys)), abs(area(pl))))
        g = Grid(5.0)
        for it in polys:
            g.add(it, *it[2])
        seen = set()
        for it in polys:
            fi, pl, bb, a1 = it
            for o in g.query((bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2, max(bb[2] - bb[0], bb[3] - bb[1]) / 2 + 5):
                fj, pl2, bb2, a2 = o
                if fj <= fi or (fi, fj) in seen:
                    continue
                if bb2[0] > bb[2] or bb2[2] < bb[0] or bb2[1] > bb[3] or bb2[3] < bb[1]:
                    continue
                seen.add((fi, fj))
                inter = clip(pl, pl2)
                ia = abs(area(inter)) if len(inter) >= 3 else 0
                if ia > 0.05:
                    small = min(a1, a2)
                    if ia > 0.9 * small and max(a1, a2) > 8 * small:
                        continue  # nested by design (part under a module/shield)
                    f1, f2 = fps[fi], fps[fj]
                    items.append({'t': f"{f1['r']} and {f2['r']} courtyards overlap by {ia:.2f} mm² ({'bottom' if side else 'top'})",
                                  'refs': [f1['r'], f2['r']], 'xy': [(f1['x'] + f2['x']) / 2, (f1['y'] + f2['y']) / 2], 'a': ia})
    items.sort(key=lambda i: -i['a'])
    for i in items:
        i.pop('a')
    out.append({'id': 'courtyard', 'cat': 'Assembly', 'title': 'Courtyard overlaps',
                'status': 'warn' if items else 'pass',
                'summary': f"{len(items)} component pairs have overlapping courtyards (placement or rework clearance may be tight)." if items else 'No overlapping courtyards.',
                'items': items[:60]})

    # 9 parts outside board
    from kicad_pcb import point_in_poly
    outers = [[(l[i], l[i + 1]) for i in range(0, len(l), 2)] for l in pcb['outline']['outer']]
    items = []
    for fi, f in enumerate(fps):
        if f.get('bo') or classes[fi][0] == 'none' or f['r'].startswith('REF') or not f['pads']:
            continue
        pin_in = any(any(point_in_poly((pads[pi][4], pads[pi][5]), o) for o in outers) for pi in f['pads'][:6])
        if outers and not pin_in and not any(point_in_poly((f['x'], f['y']), o) for o in outers):
            items.append({'t': f"{f['r']} ({f['v']}) sits outside the board outline", 'refs': [f['r']], 'xy': [f['x'], f['y']]})
    out.append({'id': 'outside', 'cat': 'Assembly', 'title': 'Parts outside the board edge',
                'status': 'fail' if items else 'pass',
                'summary': f"{len(items)} parts are placed outside Edge.Cuts." if items else 'All parts are inside the board outline.',
                'items': items[:40]})

    # 10 reference designators
    cnt = Counter(f['r'] for f in fps if f['r'] and not f['r'].startswith('REF'))
    dups = [r for r, c in cnt.items() if c > 1 and re.match(r'^[A-Za-z_]+\d+[A-Za-z]?$', r) and not re.match(r'^(H|MH|FID|G|LOGO|NT)\d*$', r)]
    unann = [f['r'] for f in fps if '?' in f['r']]
    items = [{'t': f"{r} is used by {cnt[r]} footprints", 'refs': [r]} for r in sorted(dups)] + [{'t': f"{r} is not annotated", 'refs': [r]} for r in unann]
    out.append({'id': 'refdes', 'cat': 'Schematic', 'title': 'Reference designators',
                'status': 'fail' if items else 'pass',
                'summary': f"{len(items)} duplicate or unannotated references." if items else f"All {len(cnt)} references are unique and annotated.",
                'items': items[:40]})

    # 11 schematic <-> PCB sync
    items = []
    if sch and sch.get('parts'):
        sch_refs = {}
        for p in sch['parts']:
            sch_refs.setdefault(p['r'], p)
        pcb_refs = {f['r']: f for f in fps}
        for r, p in sorted(sch_refs.items()):
            if r not in pcb_refs and p['fp'] and '?' not in r:
                items.append({'t': f"{r} ({p['v']}) is in the schematic but not on the PCB", 'refs': [r]})
        for r, f in sorted(pcb_refs.items()):
            fi = fps.index(f)
            if r and r not in sch_refs and not f.get('bo') and classes[fi][0] != 'none' and not r.startswith(('REF', 'G', 'H', 'MH', 'FID', 'LOGO', 'kibuzzard')):
                items.append({'t': f"{r} ({f['v']}) is on the PCB but not in the schematic", 'refs': [r], 'xy': [f['x'], f['y']]})
            elif r in sch_refs and sch_refs[r]['v'] != f['v'] and sch_refs[r]['v'] and f['v']:
                items.append({'t': f"{r}: schematic says {sch_refs[r]['v']}, PCB says {f['v']}", 'refs': [r], 'xy': [f['x'], f['y']]})
        out.append({'id': 'sync', 'cat': 'Schematic', 'title': 'Schematic and PCB agree',
                    'status': 'warn' if items else 'pass',
                    'summary': f"{len(items)} differences between schematic and layout." if items else 'Every schematic part is on the PCB with the same value.',
                    'items': items[:60]})

        # 12 dangling labels: anchor not on a wire, bus, pin end or sheet pin
        from kicad_sch import sym_xf
        items = []
        gcount = Counter()
        for pg in sch['pages']:
            for l in pg['labels']:
                if l[4] == 'g':
                    gcount[l[0]] += 1
        for pg in sch['pages']:
            wires = pg['wires'] + pg['buses'] + pg.get('entries', [])
            ends = set()
            for sy in pg['syms']:
                lib = sch['lib'].get(sy['l'])
                if not lib:
                    continue
                for key, prims in lib['u'].items():
                    u, st = key.split('_')
                    if int(u) not in (0, sy['u']) or int(st) not in (0, 1):
                        continue
                    for p in prims:
                        if p[0] == 'P':
                            ox, oy = sym_xf(p[1], p[2], sy['a'], sy['m'])
                            ends.add((round(sy['x'] + ox, 1), round(sy['y'] + oy, 1)))
            for sh in pg['sheets']:
                for p in sh['pins']:
                    ends.add((round(p[1], 1), round(p[2], 1)))

            def attached(x, y):
                if (round(x, 1), round(y, 1)) in ends:
                    return True
                for i in range(0, len(wires), 4):
                    if seg_dist(x, y, wires[i], wires[i + 1], wires[i + 2], wires[i + 3]) < 0.02:
                        return True
                return False
            for l in pg['labels']:
                if l[4] in ('l', 'g', 'h') and not attached(l[1], l[2]):
                    kind = {'l': 'Label', 'g': 'Global label', 'h': 'Hierarchical label'}[l[4]]
                    items.append({'t': f"{kind} {l[0]} on sheet {pg['name']} is not attached to a wire or pin", 'nets': [l[0]], 'sheet': pg['name'], 'sxy': [l[1], l[2]]})
        for name, c in gcount.items():
            if c == 1:
                pg = next(p for p in sch['pages'] if any(l[0] == name and l[4] == 'g' for l in p['labels']))
                l = next(l for l in pg['labels'] if l[0] == name and l[4] == 'g')
                items.append({'t': f"Global label {name} appears only once (sheet {pg['name']}), so it links to nothing", 'nets': [name], 'sheet': pg['name'], 'sxy': [l[1], l[2]]})
        out.append({'id': 'labels', 'cat': 'Schematic', 'title': 'Labels that connect to nothing',
                    'status': 'warn' if items else 'pass',
                    'summary': f"{len(items)} net labels are floating or have no partner, so they join nothing." if items else 'Every net label sits on a wire or pin and has a partner where needed.',
                    'items': items[:60]})

    # 13 BOM sourcing
    lines = bom_lines(pcb, sch)
    no_src = [l for l in lines if not l['src'] and not l['dnp']]
    pct = round(100 * (len(lines) - len(no_src)) / len(lines)) if lines else 100
    out.append({'id': 'sourcing', 'cat': 'BOM', 'title': 'Orderable part numbers',
                'status': 'pass' if pct >= 90 else ('warn' if pct >= 30 else 'info'), 'score': pct,
                'summary': f"{len(lines) - len(no_src)} of {len(lines)} BOM lines ({pct}%) carry a manufacturer or supplier part number.",
                'items': [{'t': f"{l['v']} · {l['fp']} × {l['q']} ({', '.join(l['refs'][:6])}{'…' if len(l['refs']) > 6 else ''})", 'refs': l['refs'][:10]} for l in no_src[:60]]})

    # 14 fab capability
    m = pcb['meta']
    items = []
    if m['minTrack'] and m['minTrack'] < 0.1:
        items.append({'t': f"Minimum track width {m['minTrack']} mm is below 0.1 mm (4 mil): needs an advanced process."})
    if m['minDrill'] and m['minDrill'] < 0.2:
        items.append({'t': f"Minimum drill {m['minDrill']} mm is below 0.2 mm: laser or fine mechanical drilling."})
    bvias = sum(1 for v in pcb['vias'] if v[5])
    if bvias:
        items.append({'t': f"{bvias} blind/buried or micro vias: HDI stackup required."})
    out.append({'id': 'fab', 'cat': 'Manufacturing', 'title': 'Standard fab capability',
                'status': 'info' if items else 'pass',
                'summary': f"{len(m['cu'])}-layer board, {m['w']:.1f} × {m['h']:.1f} mm, min track {m['minTrack']} mm, min drill {m['minDrill']} mm, {len(pcb['vias'])} vias.",
                'items': items})
    return out


def bom_lines(pcb, sch):
    fields = {}
    if sch:
        for p in sch.get('parts', []):
            fields.setdefault(p['r'], p)
    groups = {}
    for f in pcb['fps']:
        r = f['r']
        if not r or f.get('bo') or f.get('nb') or r.startswith('REF') or re.match(r'^(FID|H|MH|LOGO|G|KB|MK)\d*$', r) and f.get('z', ['none'])[0] == 'none':
            continue
        sp = fields.get(r, {})
        if sp and not sp.get('bom', 1):
            continue
        props = dict(f.get('p') or {})
        props.update(sp.get('p') or {})
        mpn = ''
        mfr = ''
        src = {}
        for k, v in props.items():
            kl = k.lower()
            if not v or v in ('~', '-', 'N/A', 'n/a', 'DNP', 'NA'):
                continue
            if any(s == kl or s in kl.replace('_', ' ') for s in SRC_KEYS):
                src[k] = v
                if not mpn and ('mpn' in kl or 'part' in kl or kl == 'pn' or 'mfr' in kl and 'part' in kl):
                    mpn = v
                if not mfr and ('manufacturer' in kl or kl in ('mfr', 'mfr.', 'mf')) and 'part' not in kl:
                    mfr = v
        if not re.match(r'^[A-Za-z]+\d', r) and not r.startswith('#'):
            pass
        key = (f['v'], f['fp'], mpn)
        g = groups.get(key)
        dnp = bool(f.get('dnp') or sp.get('dnp'))
        if g is None:
            g = groups[key] = {'v': f['v'], 'fp': f['fp'], 'mpn': mpn, 'mfr': mfr, 'refs': [], 'q': 0, 'src': src,
                               'desc': sp.get('desc', '') or f.get('d', ''), 'ds': sp.get('ds', ''), 'dnp': dnp, 'smd': f['k'] == 'smd'}
        g['refs'].append(r)
        g['q'] += 1
        if src and not g['src']:
            g['src'] = src
    def refkey(r):
        m = re.match(r'([A-Za-z_#]*)(\d*)', r)
        return (m.group(1), int(m.group(2)) if m.group(2) else 0)
    lines = list(groups.values())
    for l in lines:
        l['refs'].sort(key=refkey)
    lines.sort(key=lambda l: (refkey(l['refs'][0])[0], refkey(l['refs'][0])[1]))
    return lines
