"""Parse a KiCad 6+ .kicad_pcb into a compact JSON-able dict for the web viewer."""
import math
import re
from sexpr import parse, find, findall, val, fnum, xy, at, has_flag, pts, arc_points, Q

R = lambda v: round(v, 3)
SIGN = 1

KEEP_GFX = {'F.SilkS', 'B.SilkS', 'Edge.Cuts', 'F.Fab', 'B.Fab', 'F.CrtYd', 'B.CrtYd', 'F.Mask', 'B.Mask'}

MASK_COLORS = {
    'green': '#1f6b3a', 'red': '#9c1c1c', 'blue': '#1f5fc2', 'black': '#141417', 'white': '#ecebe6',
    'purple': '#4b2a7a', 'yellow': '#c9a227', 'matte black': '#18181a', 'matte green': '#2a5a39', 'matte blue': '#1e4f9c',
}
SILK_COLORS = {'white': '#f4f4f0', 'black': '#111111', 'yellow': '#e8d24a'}


def rot(x, y, deg):
    if not deg:
        return x, y
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    return (x * c + y * s, -x * s + y * c) if SIGN > 0 else (x * c - y * s, x * s + y * c)


def rdp(points, eps):
    """Ramer-Douglas-Peucker for a closed ring (list of (x,y))."""
    if len(points) < 5:
        return points
    # iterative RDP
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        i, j = stack.pop()
        x1, y1 = points[i]
        x2, y2 = points[j]
        dx, dy = x2 - x1, y2 - y1
        L = math.hypot(dx, dy)
        best, bi = -1.0, -1
        for k in range(i + 1, j):
            px, py = points[k]
            if L < 1e-9:
                d = math.hypot(px - x1, py - y1)
            else:
                d = abs(dy * px - dx * py + x2 * y1 - y2 * x1) / L
            if d > best:
                best, bi = d, k
        if best > eps and bi > 0:
            keep[bi] = True
            stack.append((i, bi))
            stack.append((bi, j))
    return [p for p, k in zip(points, keep) if k]


def width_of(n, default=0.1):
    w = val(n, 'width')
    if w is not None:
        return fnum(w, default)
    st = find(n, 'stroke')
    if st is not None:
        return fnum(val(st, 'width'), default)
    return default


def fill_of(n, default):
    f = val(n, 'fill')
    if f is None:
        fl = find(n, 'fill')
        if fl is not None and len(fl) > 1 and isinstance(fl[1], list):
            f = val(fl, 'type')
    if f is None:
        return default
    return f in ('solid', 'yes', 'true', 'color', 'background', 'outline_solid')


class Board:
    def __init__(self):
        self.net_idx = {'': 0}
        self.nets = ['']

    def net(self, node):
        """Resolve a (net N "name") or (net "name") child to our index."""
        n = find(node, 'net')
        if n is None:
            return 0
        if len(n) >= 3:
            name = n[2]
        elif len(n) == 2:
            name = n[1] if isinstance(n[1], Q) or not re.fullmatch(r'\d+', str(n[1])) else self.num_names.get(n[1], '')
        else:
            return 0
        return self.name_to_idx(str(name))

    def name_to_idx(self, name):
        if name not in self.net_idx:
            self.net_idx[name] = len(self.nets)
            self.nets.append(name)
        return self.net_idx[name]


def text_of(node):
    return str(node[1]) if len(node) > 1 else ''


def text_effects(n):
    eff = find(n, 'effects')
    size, thick, just, mirror = 1.0, 0.15, '', False
    hidden = False
    if eff is not None:
        font = find(eff, 'font')
        if font is not None:
            s = find(font, 'size')
            if s is not None:
                size = fnum(s[2] if len(s) > 2 else s[1], 1.0)
            thick = fnum(val(font, 'thickness'), size * 0.15)
        j = find(eff, 'justify')
        if j is not None:
            js = [str(t) for t in j[1:] if not isinstance(t, list)]
            if 'mirror' in js:
                mirror = True
            just = ''.join(t[0] for t in js if t in ('left', 'right', 'top', 'bottom'))
        if has_flag(eff, 'hide'):
            hidden = True
    if has_flag(n, 'hide'):
        hidden = True
    return size, thick, just, mirror, hidden


def parse_pcb(path, board_cfg=None):
    src = open(path, encoding='utf-8', errors='replace').read()
    root = parse(src)
    B = Board()
    version = val(root, 'version', default='?')
    gen_ver = val(root, 'generator_version') or ''
    # net declarations (<= KiCad 9)
    B.num_names = {}
    for n in findall(root, 'net'):
        if len(n) >= 3:
            B.num_names[n[1]] = str(n[2])
            B.name_to_idx(str(n[2]))

    general = find(root, 'general')
    thickness = fnum(val(general, 'thickness'), 1.6) if general else 1.6

    # layers
    layers_node = find(root, 'layers')
    cu_layers = []
    for l in layers_node[1:]:
        if isinstance(l, list) and len(l) >= 3:
            name = str(l[1])
            if name.endswith('.Cu'):
                cu_layers.append(name)
    # order: F.Cu, In1..InN, B.Cu
    def cu_key(n):
        if n == 'F.Cu':
            return 0
        if n == 'B.Cu':
            return 999
        m = re.match(r'In(\d+)\.Cu', n)
        return int(m.group(1)) if m else 500
    cu_layers.sort(key=cu_key)

    # stackup colors
    mask_color, silk_color, finish = None, None, None
    setup = find(root, 'setup')
    if setup is not None:
        st = find(setup, 'stackup')
        if st is not None:
            finish = val(st, 'copper_finish')
            for l in findall(st, 'layer'):
                nm = str(l[1])
                c = val(l, 'color')
                if c is None:
                    continue
                if nm == 'F.Mask':
                    mask_color = str(c)
                if nm == 'F.SilkS':
                    silk_color = str(c)
    cfg = board_cfg or {}
    mask_color = cfg.get('mask', mask_color)
    silk_color = cfg.get('silk', silk_color)

    def color_hex(name, table, default):
        if not name:
            return default
        if name.startswith('#'):
            return name[:7]
        return table.get(name.lower(), default)

    gfx = {}  # layer -> dict(lines=[], polys=[], circles=[], texts=[])

    def G(layer):
        g = gfx.get(layer)
        if g is None:
            g = gfx[layer] = {'lines': [], 'polys': [], 'circles': [], 'texts': []}
        return g

    edge_segments = []  # list of point lists (open polylines) for outline chaining
    edge_circles = []

    def add_graphic(n, tf, layer_override=None):
        kind = n[0]
        layer = str(val(n, 'layer', default=''))
        if layer_override:
            layer = layer_override
        cu = layer.endswith('.Cu')
        if layer not in KEEP_GFX and not cu:
            return
        w = width_of(n, 0.1)
        g = G(layer)
        k = kind[3:] if kind.startswith(('fp_', 'gr_')) else kind
        if k == 'line':
            s, e = xy(n, 'start'), xy(n, 'end')
            if not s or not e:
                return
            s, e = tf(*s), tf(*e)
            g['lines'].extend([R(s[0]), R(s[1]), R(e[0]), R(e[1]), R(w)])
            if layer == 'Edge.Cuts':
                edge_segments.append([s, e])
        elif k == 'rect':
            s, e = xy(n, 'start'), xy(n, 'end')
            if not s or not e:
                return
            corners = [tf(s[0], s[1]), tf(e[0], s[1]), tf(e[0], e[1]), tf(s[0], e[1])]
            filled = fill_of(n, False)
            g['polys'].append({'p': [R(c) for p in corners for c in p], 'w': R(w), 'f': 1 if filled else 0})
            if layer == 'Edge.Cuts':
                edge_segments.append(corners + [corners[0]])
        elif k == 'arc':
            s, m, e = xy(n, 'start'), xy(n, 'mid'), xy(n, 'end')
            if s and m and e:
                ps = arc_points(s, m, e)
            else:
                return
            ps = [tf(*p) for p in ps]
            for a, b in zip(ps, ps[1:]):
                g['lines'].extend([R(a[0]), R(a[1]), R(b[0]), R(b[1]), R(w)])
            if layer == 'Edge.Cuts':
                edge_segments.append(ps)
        elif k == 'circle':
            c, e = xy(n, 'center'), xy(n, 'end')
            if not c or not e:
                return
            r = math.hypot(e[0] - c[0], e[1] - c[1])
            cc = tf(*c)
            filled = fill_of(n, False)
            g['circles'].extend([R(cc[0]), R(cc[1]), R(r), R(w), 1 if filled else 0])
            if layer == 'Edge.Cuts':
                edge_circles.append((cc[0], cc[1], r))
        elif k == 'poly':
            p = pts(n)
            if len(p) < 2:
                return
            p = [tf(*q) for q in p]
            filled = fill_of(n, True)
            g['polys'].append({'p': [R(c) for q in p for c in q], 'w': R(w), 'f': 1 if filled else 0})
            if layer == 'Edge.Cuts':
                edge_segments.append(p + [p[0]])
        elif k == 'curve':
            p = pts(n)
            if len(p) == 4:
                bez = []
                for i in range(13):
                    t = i / 12
                    mt = 1 - t
                    bez.append((mt ** 3 * p[0][0] + 3 * mt * mt * t * p[1][0] + 3 * mt * t * t * p[2][0] + t ** 3 * p[3][0],
                                mt ** 3 * p[0][1] + 3 * mt * mt * t * p[1][1] + 3 * mt * t * t * p[2][1] + t ** 3 * p[3][1]))
                bez = [tf(*q) for q in bez]
                for a, b in zip(bez, bez[1:]):
                    g['lines'].extend([R(a[0]), R(a[1]), R(b[0]), R(b[1]), R(w)])
                if layer == 'Edge.Cuts':
                    edge_segments.append(bez)

    ident = lambda x, y: (x, y)

    # ---------------- footprints
    fps = []
    pads = []
    for fp in [c for c in root[1:] if isinstance(c, list) and c and c[0] in ('footprint', 'module')]:
        fpname = str(fp[1])
        side = 1 if str(val(fp, 'layer', default='F.Cu')) == 'B.Cu' else 0
        fx, fy, frot = at(fp)

        def tf(x, y, fx=fx, fy=fy, frot=frot):
            rx, ry = rot(x, y, frot)
            return fx + rx, fy + ry

        props = {}
        ref, value = '', ''
        ref_txt = None
        for p in findall(fp, 'property'):
            if len(p) >= 3:
                props[str(p[1])] = str(p[2])
                if str(p[1]) == 'Reference':
                    ref_txt = p
        for t in findall(fp, 'fp_text'):
            if len(t) >= 3 and t[1] == 'reference':
                ref = str(t[2])
                ref_txt = t
            elif len(t) >= 3 and t[1] == 'value':
                value = str(t[2])
        ref = props.get('Reference', ref)
        value = props.get('Value', value)
        attr = find(fp, 'attr')
        attrs = [str(a) for a in attr[1:]] if attr is not None else []
        kind = 'smd' if 'smd' in attrs else ('th' if 'through_hole' in attrs else '')
        dnp = 'dnp' in attrs or has_flag(fp, 'dnp')
        nobom = 'exclude_from_bom' in attrs or has_flag(fp, 'exclude_from_bom') or 'exclude_from_bom' in props
        board_only = 'board_only' in attrs
        model = None
        m = find(fp, 'model')
        if m is not None:
            model = str(m[1]).replace('\\', '/').split('/')[-1]
            if has_flag(m, 'hide'):
                model = None
        descr = str(val(fp, 'descr', default='') or '')

        # graphics + body bbox in local coords
        fab_pts, crt_pts, silk_pts = [], [], []
        for g in fp[1:]:
            if not isinstance(g, list) or not g:
                continue
            if g[0] in ('fp_line', 'fp_rect', 'fp_arc', 'fp_circle', 'fp_poly', 'fp_curve'):
                lay = str(val(g, 'layer', default=''))
                add_graphic(g, tf)
                # local points for bbox
                lp = []
                for key in ('start', 'end', 'mid', 'center'):
                    q = xy(g, key)
                    if q:
                        lp.append(q)
                if g[0] == 'fp_circle':
                    c, e = xy(g, 'center'), xy(g, 'end')
                    if c and e:
                        r = math.hypot(e[0] - c[0], e[1] - c[1])
                        lp = [(c[0] - r, c[1] - r), (c[0] + r, c[1] + r)]
                if g[0] in ('fp_poly', 'fp_curve'):
                    lp = pts(g)
                if lay.endswith('.Fab'):
                    fab_pts.extend(lp)
                elif lay.endswith('.CrtYd'):
                    crt_pts.extend(lp)
                elif lay.endswith('.SilkS'):
                    silk_pts.extend(lp)
            elif g[0] in ('fp_text', 'property'):
                if g[0] == 'fp_text':
                    kindt = str(g[1])
                    txt = str(g[2]) if len(g) > 2 else ''
                    if kindt == 'value':
                        continue
                else:
                    if len(g) < 3 or str(g[1]) != 'Reference' or find(g, 'at') is None:
                        continue
                    txt = str(g[2])
                    kindt = 'reference'
                lay = str(val(g, 'layer', default=''))
                if not lay.endswith('.SilkS') and not lay.endswith('.Fab'):
                    continue
                size, thick, just, mirror, hidden = text_effects(g)
                if hidden:
                    continue
                txt = txt.replace('${REFERENCE}', ref).replace('%R', ref)
                if not txt or '${' in txt:
                    continue
                tx, ty, ta = at(g)
                px, py = tf(tx, ty)
                G(lay)['texts'].append([txt, R(px), R(py), R(size), R(ta), just, 1 if mirror else 0, R(thick)])

        # pads
        pad_ids = []
        pbox = []
        for pd in findall(fp, 'pad'):
            num = str(pd[1])
            ptype = str(pd[2])
            shape = str(pd[3])
            px, py, prot = at(pd)
            sz = find(pd, 'size')
            w = fnum(sz[1]) if sz else 0
            h = fnum(sz[2]) if sz and len(sz) > 2 else w
            bx, by = tf(px, py)
            lay_node = find(pd, 'layers')
            lays = [str(x) for x in lay_node[1:]] if lay_node else []
            mask = 0
            for L in lays:
                if L in ('*.Cu', 'F&B.Cu'):
                    mask |= 1 | 2 | 4
                elif L == 'F.Cu':
                    mask |= 1
                elif L == 'B.Cu':
                    mask |= 2
                elif L.startswith('In') and L.endswith('.Cu'):
                    mask |= 4
                elif L in ('*.Mask',):
                    mask |= 8 | 16
                elif L == 'F.Mask':
                    mask |= 8
                elif L == 'B.Mask':
                    mask |= 16
            dr = find(pd, 'drill')
            dw = dh = 0.0
            if dr is not None:
                vals = [x for x in dr[1:] if not isinstance(x, list)]
                if vals and vals[0] == 'oval':
                    dw = fnum(vals[1]) if len(vals) > 1 else 0
                    dh = fnum(vals[2]) if len(vals) > 2 else dw
                elif vals:
                    dw = dh = fnum(vals[0])
            rr = fnum(val(pd, 'roundrect_rratio'), 0.25)
            t = {'thru_hole': 1, 'np_thru_hole': 2, 'smd': 0, 'connect': 3}.get(ptype, 0)
            sc = {'circle': 0, 'rect': 1, 'oval': 2, 'roundrect': 3, 'trapezoid': 1, 'custom': 4}.get(shape, 1)
            if shape == 'custom':
                # anchor + primitives polygon(s)
                prims = find(pd, 'primitives')
                poly = []
                if prims is not None:
                    for pr in prims[1:]:
                        if isinstance(pr, list) and pr[0] in ('gr_poly',):
                            q = pts(pr)
                            if q:
                                poly.append([R(c) for p in q for c in p])
                        elif isinstance(pr, list) and pr[0] in ('gr_rect',):
                            s, e = xy(pr, 'start'), xy(pr, 'end')
                            if s and e:
                                poly.append([R(s[0]), R(s[1]), R(e[0]), R(s[1]), R(e[0]), R(e[1]), R(s[0]), R(e[1])])
                        elif isinstance(pr, list) and pr[0] in ('gr_circle',):
                            c, e = xy(pr, 'center'), xy(pr, 'end')
                            if c and e:
                                r = math.hypot(e[0] - c[0], e[1] - c[1])
                                poly.append([R(v) for i in range(16) for v in (c[0] + r * math.cos(i * math.pi / 8), c[1] + r * math.sin(i * math.pi / 8))])
            else:
                poly = None
            netid = B.net(pd)
            pf = str(val(pd, 'pinfunction', default='') or '')
            pt = str(val(pd, 'pintype', default='') or '')
            entry = [len(fps), num, t, sc, R(bx), R(by), R(w), R(h), R(prot), mask, netid, R(dw), R(dh), R(rr), pf, pt]
            if poly:
                entry.append(poly)
            pad_ids.append(len(pads))
            pads.append(entry)
            # local pad bbox (rotated by pad-local angle relative to footprint)
            rel = prot - frot
            hw, hh = w / 2, h / 2
            for cx_, cy_ in ((-hw, -hh), (hw, -hh), (hw, hh), (-hw, hh)):
                ox, oy = rot(cx_, cy_, rel)
                pbox.append((px + ox, py + oy))

        def bb(ps):
            if not ps:
                return None
            xs = [p[0] for p in ps]
            ys = [p[1] for p in ps]
            return [R(min(xs)), R(min(ys)), R(max(xs)), R(max(ys))]

        body = bb(fab_pts)
        src_body = 'fab'
        crt = bb(crt_pts)
        if body is None or (body[2] - body[0]) < 0.05 or (body[3] - body[1]) < 0.05:
            if crt is not None:
                inset = 0.2
                body = [crt[0] + inset, crt[1] + inset, crt[2] - inset, crt[3] - inset]
                src_body = 'crt'
            else:
                body = bb(pbox)
                src_body = 'pad'
        # courtyard polygon in board coords (convex hull of transformed points)
        crt_board = None
        if crt_pts:
            hull = convex_hull([tf(*p) for p in crt_pts])
            crt_board = [R(c) for p in hull for c in p]

        rec = {
            'r': ref, 'v': value, 'fp': fpname.split(':')[-1], 'lib': fpname.split(':')[0] if ':' in fpname else '',
            's': side, 'x': R(fx), 'y': R(fy), 'a': R(frot), 'k': kind,
            'b': body, 'bs': src_body, 'pads': pad_ids,
        }
        if crt_board:
            rec['c'] = crt_board
        if dnp:
            rec['dnp'] = 1
        if nobom:
            rec['nb'] = 1
        if board_only:
            rec['bo'] = 1
        if model:
            rec['m'] = model
        if descr:
            rec['d'] = descr[:160]
        extra = {k: v for k, v in props.items() if k not in ('Reference', 'Value', 'Footprint', 'Sheetfile', 'Sheetname', 'ki_fp_filters', 'ki_description', 'ki_keywords', 'exclude_from_bom', 'dnp') and v and v != '~'}
        if extra:
            rec['p'] = extra
        fps.append(rec)

    # ---------------- board-level graphics
    for g in root[1:]:
        if isinstance(g, list) and g and g[0] in ('gr_line', 'gr_rect', 'gr_arc', 'gr_circle', 'gr_poly', 'gr_curve'):
            add_graphic(g, ident)
        elif isinstance(g, list) and g and g[0] == 'gr_text':
            lay = str(val(g, 'layer', default=''))
            if lay.endswith('.SilkS') or lay.endswith('.Cu'):
                size, thick, just, mirror, hidden = text_effects(g)
                if hidden:
                    continue
                tx, ty, ta = at(g)
                G(lay)['texts'].append([str(g[1]), R(tx), R(ty), R(size), R(ta), just, 1 if mirror else 0, R(thick)])

    # ---------------- tracks & vias
    tracks = {}
    vias = []
    track_len = {}
    min_w = 99
    for t in root[1:]:
        if not isinstance(t, list) or not t:
            continue
        if t[0] == 'segment' or t[0] == 'arc':
            layer = str(val(t, 'layer', default='F.Cu'))
            w = fnum(val(t, 'width'), 0.2)
            nid = B.net(t)
            s, e = xy(t, 'start'), xy(t, 'end')
            if not s or not e:
                continue
            if t[0] == 'arc':
                m = xy(t, 'mid')
                ps = arc_points(s, m, e, 15) if m else [s, e]
            else:
                ps = [s, e]
            arr = tracks.setdefault(layer, [])
            for a, b in zip(ps, ps[1:]):
                arr.extend([R(a[0]), R(a[1]), R(b[0]), R(b[1]), R(w), nid])
                track_len[nid] = track_len.get(nid, 0) + math.hypot(b[0] - a[0], b[1] - a[1])
            if w > 0:
                min_w = min(min_w, w)
        elif t[0] == 'via':
            x, y, _ = at(t)
            size = fnum(val(t, 'size'), 0.6)
            drill = fnum(val(t, 'drill'), 0.3)
            vt = 1 if has_flag(t, 'blind') else (2 if has_flag(t, 'micro') else 0)
            vl = find(t, 'layers')
            l1, l2 = (str(vl[1]), str(vl[2])) if vl is not None and len(vl) >= 3 else ('F.Cu', 'B.Cu')
            vias.append([R(x), R(y), R(size), R(drill), B.net(t), vt, cu_layers.index(l1) if l1 in cu_layers else 0,
                         cu_layers.index(l2) if l2 in cu_layers else len(cu_layers) - 1])

    # ---------------- zones
    zones = []
    zone_outlines = []
    npts_before = npts_after = 0
    for z in findall(root, 'zone'):
        nid = B.net(z)
        if nid == 0:
            nn = val(z, 'net_name')
            if nn:
                nid = B.name_to_idx(str(nn))
        is_keepout = find(z, 'keepout') is not None
        zl = find(z, 'layers')
        zlays = [str(x) for x in zl[1:]] if zl is not None else [str(val(z, 'layer', default=''))]
        outline = find(z, 'polygon')
        if outline is not None:
            op = pts(outline)
            zone_outlines.append({'n': nid, 'l': zlays, 'k': 1 if is_keepout else 0, 'p': [R(c) for p in op for c in p],
                                  'f': len(findall(z, 'filled_polygon'))})
        for fpoly in findall(z, 'filled_polygon'):
            lay = str(val(fpoly, 'layer', default=zlays[0] if zlays else 'F.Cu'))
            p = pts(fpoly)
            npts_before += len(p)
            p2 = rdp(p + [p[0]], 0.015)[:-1] if len(p) > 8 else p
            npts_after += len(p2)
            zones.append({'n': nid, 'l': lay, 'p': [R(c) for q in p2 for c in q]})

    # ---------------- outline
    loops = chain_loops(edge_segments)
    for (cx, cy, r) in edge_circles:
        loops.append([(cx + r * math.cos(i * math.pi / 24), cy + r * math.sin(i * math.pi / 24)) for i in range(48)])
    loops = [l for l in loops if len(l) >= 3]
    loops.sort(key=lambda l: -abs(poly_area(l)))
    outer, holes = [], []
    for l in loops:
        if any(point_in_poly(l[0], o) for o in outer):
            holes.append(l)
        else:
            outer.append(l)
    allpts = [p for l in outer for p in l]
    if not allpts:  # fallback: bbox of everything
        xs = [f['x'] for f in fps] or [0]
        ys = [f['y'] for f in fps] or [0]
        allpts = [(min(xs) - 5, min(ys) - 5), (max(xs) + 5, max(ys) + 5)]
        outer = [[(min(xs) - 5, min(ys) - 5), (max(xs) + 5, min(ys) - 5), (max(xs) + 5, max(ys) + 5), (min(xs) - 5, max(ys) + 5)]]
    bx0 = min(p[0] for p in allpts)
    by0 = min(p[1] for p in allpts)
    bx1 = max(p[0] for p in allpts)
    by1 = max(p[1] for p in allpts)

    # drop graphics dicts that are empty; convert
    gfx_out = {k: v for k, v in gfx.items() if any(v.values())}

    min_drill = min([v[3] for v in vias] + [p[11] for p in pads if p[11] > 0] or [0])
    return {
        'meta': {
            'kicad': str(version), 'gen': str(gen_ver), 'thickness': R(thickness), 'cu': cu_layers,
            'bbox': [R(bx0), R(by0), R(bx1), R(by1)], 'w': R(bx1 - bx0), 'h': R(by1 - by0),
            'mask': color_hex(mask_color, MASK_COLORS, '#1f6b3a'), 'maskName': mask_color or 'Green (default)',
            'silk': color_hex(silk_color, SILK_COLORS, '#f4f4f0'), 'finish': str(finish or 'Not specified'),
            'minTrack': R(min_w if min_w < 99 else 0), 'minDrill': R(min_drill),
            'zonePts': [npts_before, npts_after],
        },
        'outline': {'outer': [[R(c) for p in l for c in p] for l in outer], 'holes': [[R(c) for p in l for c in p] for l in holes]},
        'nets': B.nets,
        'fps': fps,
        'pads': pads,
        'tracks': tracks,
        'vias': vias,
        'zones': zones,
        'zoneOutlines': zone_outlines,
        'gfx': gfx_out,
        'trackLen': {str(k): R(v) for k, v in track_len.items()},
    }


def convex_hull(points):
    pts_ = sorted(set((round(x, 4), round(y, 4)) for x, y in points))
    if len(pts_) <= 2:
        return pts_

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lower, upper = [], []
    for p in pts_:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    for p in reversed(pts_):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return lower[:-1] + upper[:-1]


def poly_area(l):
    a = 0
    for i in range(len(l)):
        x1, y1 = l[i]
        x2, y2 = l[(i + 1) % len(l)]
        a += x1 * y2 - x2 * y1
    return a / 2


def point_in_poly(p, poly):
    x, y = p
    inside = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi:
            inside = not inside
        j = i
    return inside


def chain_loops(segs, tol=0.02):
    """Join open polylines into closed loops by matching endpoints."""
    segs = [list(s) for s in segs if len(s) >= 2]
    loops = []
    used = [False] * len(segs)

    def key(p):
        return (round(p[0] / tol), round(p[1] / tol))
    # endpoint index
    from collections import defaultdict
    idx = defaultdict(list)
    for i, s in enumerate(segs):
        idx[key(s[0])].append(i)
        idx[key(s[-1])].append(i)

    def near(p):
        k = key(p)
        out = []
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                out.extend(idx.get((k[0] + dx, k[1] + dy), []))
        return out
    for i in range(len(segs)):
        if used[i]:
            continue
        used[i] = True
        chain = list(segs[i])
        # closed already?
        for _ in range(len(segs) + 1):
            end = chain[-1]
            if math.hypot(end[0] - chain[0][0], end[1] - chain[0][1]) < tol and len(chain) > 2:
                break
            found = False
            for j in near(end):
                if used[j]:
                    continue
                s = segs[j]
                if math.hypot(s[0][0] - end[0], s[0][1] - end[1]) < tol:
                    chain.extend(s[1:])
                elif math.hypot(s[-1][0] - end[0], s[-1][1] - end[1]) < tol:
                    chain.extend(list(reversed(s))[1:])
                else:
                    continue
                used[j] = True
                found = True
                break
            if not found:
                break
        if len(chain) > 2 and math.hypot(chain[-1][0] - chain[0][0], chain[-1][1] - chain[0][1]) < tol:
            chain = chain[:-1]
        loops.append(chain)
    return loops
