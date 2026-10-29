"""Minimal, fast S-expression reader for KiCad files."""
import re

_TOK = re.compile(r'\(|\)|"(?:[^"\\]|\\.)*"|[^\s()"]+')


class Q(str):
    """A quoted string token (so we can tell "hide" from hide)."""
    __slots__ = ()


def parse(text):
    stack = [[]]
    for m in _TOK.finditer(text):
        t = m.group(0)
        if t == '(':
            stack.append([])
        elif t == ')':
            node = stack.pop()
            stack[-1].append(node)
        elif t[0] == '"':
            s = t[1:-1]
            if '\\' in s:
                s = s.replace('\\"', '"').replace('\\n', '\n').replace('\\\\', '\\')
            stack[-1].append(Q(s))
        else:
            stack[-1].append(t)
    return stack[0][0]


def head(n):
    return n[0] if isinstance(n, list) and n else None


def find(n, key):
    for c in n[1:]:
        if isinstance(c, list) and c and c[0] == key:
            return c
    return None


def findall(n, key):
    return [c for c in n[1:] if isinstance(c, list) and c and c[0] == key]


def val(n, key, idx=1, default=None):
    c = find(n, key)
    if c is None or len(c) <= idx:
        return default
    return c[idx]


def fnum(x, default=0.0):
    try:
        return float(x)
    except (TypeError, ValueError):
        return default


def xy(n, key):
    c = find(n, key)
    if c is None:
        return None
    return (fnum(c[1]), fnum(c[2]))


def at(n):
    c = find(n, 'at')
    if c is None:
        return (0.0, 0.0, 0.0)
    return (fnum(c[1]), fnum(c[2]), fnum(c[3]) if len(c) > 3 and not isinstance(c[3], list) else 0.0)


def has_flag(n, flag):
    """True if bare token `flag` appears as a direct child, or (flag yes)."""
    for c in n[1:]:
        if c == flag and not isinstance(c, Q):
            return True
        if isinstance(c, list) and c and c[0] == flag:
            if len(c) == 1 or c[1] in ('yes', 'true'):
                return True
    return False


def pts(n):
    """Return list of (x,y) from a (pts ...) node; arcs inside are discretized."""
    p = find(n, 'pts')
    out = []
    if p is None:
        return out
    for c in p[1:]:
        if not isinstance(c, list):
            continue
        if c[0] == 'xy':
            out.append((fnum(c[1]), fnum(c[2])))
        elif c[0] == 'arc':
            s, m, e = xy(c, 'start'), xy(c, 'mid'), xy(c, 'end')
            if s and m and e:
                out.extend(arc_points(s, m, e)[:-1] if out else arc_points(s, m, e))
    return out


def arc_points(s, m, e, max_seg_deg=10):
    import math
    (x1, y1), (x2, y2), (x3, y3) = s, m, e
    d = 2 * (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2))
    if abs(d) < 1e-12:
        return [s, e]
    ux = ((x1 * x1 + y1 * y1) * (y2 - y3) + (x2 * x2 + y2 * y2) * (y3 - y1) + (x3 * x3 + y3 * y3) * (y1 - y2)) / d
    uy = ((x1 * x1 + y1 * y1) * (x3 - x2) + (x2 * x2 + y2 * y2) * (x1 - x3) + (x3 * x3 + y3 * y3) * (x2 - x1)) / d
    r = math.hypot(x1 - ux, y1 - uy)
    a1 = math.atan2(y1 - uy, x1 - ux)
    a2 = math.atan2(y2 - uy, x2 - ux)
    a3 = math.atan2(y3 - uy, x3 - ux)

    def norm(a):
        while a < 0:
            a += 2 * math.pi
        while a >= 2 * math.pi:
            a -= 2 * math.pi
        return a
    # sweep from a1 to a3 passing through a2
    ccw = norm(a3 - a1)
    if norm(a2 - a1) <= ccw:
        sweep = ccw
    else:
        sweep = ccw - 2 * math.pi
    n = max(2, int(abs(math.degrees(sweep)) / max_seg_deg) + 1)
    return [(ux + r * math.cos(a1 + sweep * i / n), uy + r * math.sin(a1 + sweep * i / n)) for i in range(n + 1)]


def arc_center_points(c, start, angle_deg, max_seg_deg=10):
    """KiCad5-style arc: center, start, angle."""
    import math
    cx, cy = c
    sx, sy = start
    r = math.hypot(sx - cx, sy - cy)
    a0 = math.atan2(sy - cy, sx - cx)
    sweep = math.radians(angle_deg)
    n = max(2, int(abs(angle_deg) / max_seg_deg) + 1)
    return [(cx + r * math.cos(a0 + sweep * i / n), cy + r * math.sin(a0 + sweep * i / n)) for i in range(n + 1)]
