"""Parse a KiCad 6+ hierarchical schematic into a compact JSON-able dict."""
import math
import os
from sexpr import parse, find, findall, val, fnum, xy, at, has_flag, pts, arc_points, Q

R = lambda v: round(v, 3)

PAPER = {'A5': (210, 148), 'A4': (297, 210), 'A3': (420, 297), 'A2': (594, 420), 'A1': (841, 594), 'A0': (1189, 841),
         'A': (279.4, 215.9), 'B': (431.8, 279.4), 'C': (558.8, 431.8), 'D': (863.6, 558.8), 'E': (1117.6, 863.6),
         'USLetter': (279.4, 215.9), 'USLegal': (355.6, 215.9), 'USLedger': (431.8, 279.4)}

# symbol transform variant (validated empirically in selftest): rotate, then mirror
VARIANT = {'rot_sign': 1, 'mirror_first': False}


def sym_xf(lx, ly, angle, mirror):
    """lib coords (Y up) -> offset in sheet coords (Y down)."""
    x, y = lx, -ly
    def do_mirror(x, y):
        if mirror == 'x':
            return x, -y
        if mirror == 'y':
            return -x, y
        return x, y
    if VARIANT['mirror_first']:
        x, y = do_mirror(x, y)
    a = math.radians(angle) * VARIANT['rot_sign']
    c, s = round(math.cos(a)), round(math.sin(a))
    x, y = x * c + y * s, -x * s + y * c
    if not VARIANT['mirror_first']:
        x, y = do_mirror(x, y)
    return x, y


def stroke_w(n):
    st = find(n, 'stroke')
    if st is not None:
        return fnum(val(st, 'width'), 0)
    return fnum(val(n, 'width'), 0)


def fill_t(n):
    f = find(n, 'fill')
    if f is None:
        return 0
    t = val(f, 'type')
    return {'outline': 1, 'background': 2, 'color': 1}.get(str(t), 0)


def font_size(n, default=1.27):
    eff = find(n, 'effects')
    if eff is None:
        return default, '', False
    font = find(eff, 'font')
    size = default
    if font is not None:
        s = find(font, 'size')
        if s is not None:
            size = fnum(s[1], default)
    j = find(eff, 'justify')
    just = ''
    if j is not None:
        just = ''.join(str(t)[0] for t in j[1:] if str(t) in ('left', 'right', 'top', 'bottom'))
        if 'mirror' in [str(t) for t in j[1:]]:
            just += 'm'
    hidden = has_flag(eff, 'hide')
    return size, just, hidden


def parse_lib_symbol(sym):
    """Return dict with graphics per (unit, style) in lib coordinates."""
    out = {'u': {}, 'n': 1}
    if find(sym, 'power') is not None:
        out['pw'] = 1
    pn = find(sym, 'pin_names')
    if pn is not None:
        out['po'] = R(fnum(val(pn, 'offset'), 0.508))
        if has_flag(pn, 'hide'):
            out['hpn'] = 1
    else:
        out['po'] = 0.508
    pnum = find(sym, 'pin_numbers')
    if pnum is not None and has_flag(pnum, 'hide'):
        out['hpnum'] = 1
    props = {}
    for p in findall(sym, 'property'):
        props[str(p[1])] = str(p[2])
    out['desc'] = props.get('ki_description', props.get('Description', ''))[:200]
    name = str(sym[1]).split(':')[-1]
    units = set()
    for sub in findall(sym, 'symbol'):
        sname = str(sub[1])
        # NAME_U_S
        parts = sname.rsplit('_', 2)
        try:
            u, s = int(parts[-2]), int(parts[-1])
        except (ValueError, IndexError):
            u, s = 0, 1
        units.add(u)
        prims = []
        for g in sub[1:]:
            if not isinstance(g, list):
                continue
            k = g[0]
            if k == 'rectangle':
                a, b = xy(g, 'start'), xy(g, 'end')
                prims.append(['r', R(a[0]), R(a[1]), R(b[0]), R(b[1]), R(stroke_w(g)), fill_t(g)])
            elif k == 'polyline':
                p = pts(g)
                prims.append(['p', [R(c) for q in p for c in q], R(stroke_w(g)), fill_t(g)])
            elif k == 'circle':
                c = xy(g, 'center')
                prims.append(['c', R(c[0]), R(c[1]), R(fnum(val(g, 'radius'))), R(stroke_w(g)), fill_t(g)])
            elif k == 'arc':
                s_, m_, e_ = xy(g, 'start'), xy(g, 'mid'), xy(g, 'end')
                if s_ and m_ and e_:
                    p = arc_points(s_, m_, e_, 12)
                    prims.append(['p', [R(c) for q in p for c in q], R(stroke_w(g)), fill_t(g)])
            elif k == 'bezier':
                p = pts(g)
                if len(p) == 4:
                    bz = []
                    for i in range(11):
                        t = i / 10
                        mt = 1 - t
                        bz.append((mt ** 3 * p[0][0] + 3 * mt * mt * t * p[1][0] + 3 * mt * t * t * p[2][0] + t ** 3 * p[3][0],
                                   mt ** 3 * p[0][1] + 3 * mt * mt * t * p[1][1] + 3 * mt * t * t * p[2][1] + t ** 3 * p[3][1]))
                    prims.append(['p', [R(c) for q in bz for c in q], R(stroke_w(g)), fill_t(g)])
            elif k == 'text':
                tx, ty, ta = at(g)
                size, just, hidden = font_size(g)
                if not hidden:
                    prims.append(['t', str(g[1]), R(tx), R(ty), R(size), R(ta / 10 if ta > 360 else ta), just])
            elif k == 'pin':
                etype = str(g[1])
                shape = str(g[2])
                px, py, pa = at(g)
                ln = fnum(val(g, 'length'), 2.54)
                nm = find(g, 'name')
                nu = find(g, 'number')
                pname = str(nm[1]) if nm is not None else ''
                pnumv = str(nu[1]) if nu is not None else ''
                nsize = font_size(nm)[0] if nm is not None else 1.27
                usize = font_size(nu)[0] if nu is not None else 1.27
                hidden = has_flag(g, 'hide')
                prims.append(['P', R(px), R(py), R(pa), R(ln), pname, pnumv, etype, shape, 1 if hidden else 0, R(nsize), R(usize)])
        key = f'{u}_{s}'
        out['u'].setdefault(key, []).extend(prims)
    out['n'] = max([u for u in units] + [1])
    return out


class SchParser:
    def __init__(self, root_file, project):
        self.root_file = root_file
        self.dir = os.path.dirname(root_file)
        self.project = project
        self.lib = {}
        self.pages = []
        self.parts = []
        self.v6_refs = {}
        self.cache = {}
        self.missing = []

    def load(self, fname):
        p = os.path.join(self.dir, fname)
        if p not in self.cache:
            if not os.path.exists(p):
                self.cache[p] = None
            else:
                self.cache[p] = parse(open(p, encoding='utf-8', errors='replace').read())
        return self.cache[p]

    def run(self):
        root = self.load(os.path.basename(self.root_file))
        self.root_uuid = str(val(root, 'uuid', default=''))
        si = find(root, 'symbol_instances')
        if si is not None:
            for p in findall(si, 'path'):
                self.v6_refs[str(p[1])] = (str(val(p, 'reference', default='?')), int(fnum(val(p, 'unit'), 1)),
                                           str(val(p, 'value', default='')), str(val(p, 'footprint', default='')))
        self.walk(root, os.path.basename(self.root_file), 'Root', [], 0)
        return {'lib': self.lib, 'pages': self.pages, 'parts': self.parts, 'missing': self.missing}

    def walk(self, node, fname, name, chain, depth):
        if depth > 12:
            return
        page_index = len(self.pages)
        page = self.page(node, fname, name, chain)
        page['parent'] = None
        self.pages.append(page)
        for sh in page.pop('_sheets'):
            child = self.load(sh['file'])
            if child is None:
                self.missing.append(sh['file'])
                sh['missing'] = 1
                continue
            sh['page'] = len(self.pages)
            self.walk(child, sh['file'], sh['name'], chain + [sh['uuid']], depth + 1)
            self.pages[sh['page']]['parent'] = page_index
        return page

    def page(self, node, fname, name, chain):
        for ls in findall(node, 'lib_symbols'):
            for s in findall(ls, 'symbol'):
                lid = str(s[1])
                if lid not in self.lib:
                    self.lib[lid] = parse_lib_symbol(s)
        paper = find(node, 'paper')
        pw, ph = 297, 210
        if paper is not None:
            pn = str(paper[1])
            if pn == 'User' and len(paper) >= 4:
                pw, ph = fnum(paper[2]), fnum(paper[3])
            else:
                pw, ph = PAPER.get(pn, (297, 210))
            if 'portrait' in [str(x) for x in paper[1:]]:
                pw, ph = ph, pw
        tb = {}
        tbn = find(node, 'title_block')
        if tbn is not None:
            for k in ('title', 'date', 'rev', 'company'):
                v = val(tbn, k)
                if v:
                    tb[k] = str(v)
        path_v7 = '/' + self.root_uuid + ''.join('/' + c for c in chain)
        path_v6 = ''.join('/' + c for c in chain)
        wires, buses, juncs, ncs, labels, texts, gfx, sheets, syms, entries = [], [], [], [], [], [], [], [], [], []
        for it in node[1:]:
            if not isinstance(it, list):
                continue
            k = it[0]
            if k == 'wire' or k == 'bus':
                p = pts(it)
                arr = wires if k == 'wire' else buses
                for a, b in zip(p, p[1:]):
                    arr.extend([R(a[0]), R(a[1]), R(b[0]), R(b[1])])
            elif k == 'junction':
                x, y, _ = at(it)
                juncs.extend([R(x), R(y)])
            elif k == 'no_connect':
                x, y, _ = at(it)
                ncs.extend([R(x), R(y)])
            elif k == 'bus_entry':
                x, y, _ = at(it)
                s = find(it, 'size')
                dx, dy = (fnum(s[1]), fnum(s[2])) if s is not None else (2.54, 2.54)
                entries.extend([R(x), R(y), R(x + dx), R(y + dy)])
            elif k in ('label', 'global_label', 'hierarchical_label', 'directive_label', 'netclass_flag'):
                x, y, a = at(it)
                size, just, hidden = font_size(it)
                shape = str(val(it, 'shape', default=''))
                kind = {'label': 'l', 'global_label': 'g', 'hierarchical_label': 'h'}.get(k, 'd')
                labels.append([str(it[1]), R(x), R(y), R(a), kind, shape, R(size), just])
            elif k == 'text':
                x, y, a = at(it)
                size, just, hidden = font_size(it)
                if not hidden:
                    texts.append([str(it[1]), R(x), R(y), R(a), R(size), just])
            elif k == 'text_box':
                x, y, a = at(it)
                s = find(it, 'size')
                size, just, hidden = font_size(it)
                w, h = (fnum(s[1]), fnum(s[2])) if s is not None else (10, 5)
                gfx.append(['r', R(x), R(y), R(x + w), R(y + h), R(stroke_w(it))])
                texts.append([str(it[1]), R(x + 0.8), R(y + size), 0, R(size), 'lt'])
            elif k == 'polyline':
                p = pts(it)
                gfx.append(['p', [R(c) for q in p for c in q], R(stroke_w(it))])
            elif k == 'rectangle':
                a, b = xy(it, 'start'), xy(it, 'end')
                if a and b:
                    gfx.append(['r', R(a[0]), R(a[1]), R(b[0]), R(b[1]), R(stroke_w(it))])
            elif k == 'circle':
                c = xy(it, 'center')
                if c:
                    gfx.append(['c', R(c[0]), R(c[1]), R(fnum(val(it, 'radius'))), R(stroke_w(it))])
            elif k == 'arc':
                s_, m_, e_ = xy(it, 'start'), xy(it, 'mid'), xy(it, 'end')
                if s_ and m_ and e_:
                    p = arc_points(s_, m_, e_, 12)
                    gfx.append(['p', [R(c) for q in p for c in q], R(stroke_w(it))])
            elif k == 'sheet':
                x, y, _ = at(it)
                s = find(it, 'size')
                w, h = fnum(s[1]), fnum(s[2])
                props = {str(p[1]): str(p[2]) for p in findall(it, 'property') if len(p) >= 3}
                sname = props.get('Sheetname', props.get('Sheet name', 'Sheet'))
                sfile = props.get('Sheetfile', props.get('Sheet file', ''))
                spins = []
                for sp in findall(it, 'pin'):
                    px, py, pa = at(sp)
                    spins.append([str(sp[1]), R(px), R(py), R(pa), str(sp[2]) if len(sp) > 2 else ''])
                sheets.append({'x': R(x), 'y': R(y), 'w': R(w), 'h': R(h), 'name': sname, 'file': sfile,
                               'pins': spins, 'uuid': str(val(it, 'uuid', default=''))})
            elif k == 'symbol':
                sym = self.symbol(it, path_v7, path_v6, name)
                if sym:
                    syms.append(sym)
        return {'name': name, 'file': fname, 'path': path_v7, 'paper': [pw, ph], 'tb': tb,
                'wires': wires, 'buses': buses, 'entries': entries, 'junctions': juncs, 'nc': ncs, 'labels': labels,
                'texts': texts, 'gfx': gfx, 'sheets': sheets, 'syms': syms, '_sheets': sheets}

    def symbol(self, it, path_v7, path_v6, sheet_name):
        lid = str(val(it, 'lib_id', default=''))
        lname = val(it, 'lib_name')
        if lname:
            lid = str(lname) if str(lname) in self.lib else lid
        x, y, a = at(it)
        mirror = str(val(it, 'mirror', default='') or '')
        unit = int(fnum(val(it, 'unit'), 1))
        uuid = str(val(it, 'uuid', default=''))
        props = {}
        fields = []
        for p in findall(it, 'property'):
            if len(p) < 3:
                continue
            pname, ptxt = str(p[1]), str(p[2])
            props[pname] = ptxt
            fx, fy, fa = at(p)
            size, just, hidden = font_size(p)
            if not hidden and ptxt and ptxt != '~':
                fields.append([pname, R(fx), R(fy), R(fa), R(size), just])
        ref = props.get('Reference', '?')
        value = props.get('Value', '')
        fpv = props.get('Footprint', '')
        inst = find(it, 'instances')
        if inst is not None:
            first = None
            for proj in findall(inst, 'project'):
                for pth in findall(proj, 'path'):
                    r_ = (str(val(pth, 'reference', default=ref)), int(fnum(val(pth, 'unit'), unit)))
                    if first is None:
                        first = r_
                    if str(pth[1]) == path_v7:
                        ref, unit = r_
                        first = None
                        break
                else:
                    continue
                break
            if first is not None:
                ref, unit = first
        elif self.v6_refs:
            key = path_v6 + '/' + uuid
            if key in self.v6_refs:
                ref, unit, v, f = self.v6_refs[key]
                value = v or value
                fpv = f or fpv
        dnp = has_flag(it, 'dnp')
        in_bom = not (find(it, 'in_bom') is not None and val(it, 'in_bom') == 'no')
        # resolve text for Reference/Value fields
        lib = self.lib.get(lid, {})
        disp_ref = ref
        if lib.get('n', 1) > 1:
            disp_ref = ref + chr(ord('A') + unit - 1) if 1 <= unit <= 26 else ref
        out_fields = []
        for f in fields:
            nm = f[0]
            txt = disp_ref if nm == 'Reference' else (value if nm == 'Value' else props.get(nm, ''))
            if nm not in ('Reference', 'Value'):
                txt = props.get(nm, '')
                if nm in ('Footprint', 'Datasheet', 'Description'):
                    continue
            out_fields.append([txt, f[1], f[2], f[3], f[4], f[5], {'Reference': 'r', 'Value': 'v'}.get(nm, 'o')])
        rec = {'l': lid, 'x': R(x), 'y': R(y), 'a': R(a), 'm': mirror, 'u': unit, 'r': ref, 'v': value, 'f': out_fields}
        if dnp:
            rec['dnp'] = 1
        if not ref.startswith('#') and not lib.get('pw'):
            extra = {k: v for k, v in props.items() if k not in ('Reference', 'Value', 'Footprint', 'Datasheet') and v and v != '~' and not k.startswith('ki_') and k not in ('Sim.Enable',)}
            self.parts.append({'r': ref, 'v': value, 'fp': fpv.split(':')[-1], 'lib': lid, 'sheet': sheet_name,
                               'ds': props.get('Datasheet', '') if props.get('Datasheet', '~') != '~' else '',
                               'p': extra, 'dnp': 1 if dnp else 0, 'bom': 1 if in_bom else 0, 'u': unit,
                               'desc': props.get('Description', '') or lib.get('desc', '')})
        return rec


def parse_schematic(root_file, project):
    return SchParser(root_file, project).run()


def pin_endpoints(data):
    """For self-test: compute every pin connection point per page."""
    res = []
    for pg in data['pages']:
        pts_ = []
        for s in pg['syms']:
            lib = data['lib'].get(s['l'])
            if not lib:
                continue
            for key, prims in lib['u'].items():
                u, st = key.split('_')
                if int(u) not in (0, s['u']) or int(st) not in (0, 1):
                    continue
                for p in prims:
                    if p[0] == 'P':
                        ox, oy = sym_xf(p[1], p[2], s['a'], s['m'])
                        pts_.append((round(s['x'] + ox, 2), round(s['y'] + oy, 2)))
        res.append(pts_)
    return res
