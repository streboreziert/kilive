import json, math, random
random.seed(7)
out = {}
# round(x, n) incl. exact binary ties and near-ties
vals = []
for _ in range(20000):
    vals.append(random.uniform(-300, 300))
for k in range(-4000, 4000):
    vals.append(k / 16); vals.append(k / 32 + 1e-12); vals.append(k / 2000)
vals += [2.675, 0.0625, -0.0625, 0.1875, 1.0005, 1.2345, -2.5, 2.5, 0.5, 1.5, -0.0004, 1e-9, 123456.0005, 0.15, 0.25, 0.35]
out['round'] = [[v, round(v, 1), round(v, 2), round(v, 3), round(v, 4), round(v)] for v in vals]
# format .nf
out['fmt'] = [[v, format(v, '.1f'), format(v, '.2f'), format(v, '.3f')] for v in vals[::7]]
# repr
rv = [0.09, 0.1, 0.15, 1.0, 12.5, 1e-5, 0.0001, 1e16, 1.5e16, 123456789012345678.0, 0.2, 0.127, 3.0000000000000004, 5e-324, -0.0, 0.0]
rv += [random.uniform(0, 1) ** 5 for _ in range(300)]
out['repr'] = [[v, repr(v)] for v in rv]
# hypot
hv = []
for _ in range(50000):
    hv.append([random.uniform(-200, 200), random.uniform(-200, 200)])
for _ in range(20000):
    a = round(random.uniform(-100, 100), 3); b = round(random.uniform(-100, 100), 3)
    hv.append([a - round(a + random.choice([0.001, 0.01, 0.1, 1.27, 2.54]), 3), b - round(b + 0.254, 3)])
for _ in range(5000):
    hv.append([random.uniform(-1e-3, 1e-3), random.uniform(-1e-3, 1e-3)])
hv += [[3, 4], [0, 5], [0, 0], [1e-310, 1e-310], [1e300, 1e300]]
out['hypot'] = [[a, b, math.hypot(a, b)] for a, b in hv]
# set iteration order
sets = []
for _ in range(3000):
    n = random.randint(1, 60)
    mx = random.choice([10, 100, 1000, 5000, 100000])
    seq = [random.randint(0, mx) for _ in range(n)]
    if random.random() < 0.3:
        seq.sort()
    s = set()
    for x in seq:
        s.add(x)
    sets.append([seq, list(s)])
# a big ascending one like power_nets
seq = sorted(random.sample(range(1, 20000), 3000)); s = set()
for x in seq: s.add(x)
sets.append([seq, list(s)])
out['sets'] = sets
# float()
fs = ['1', '-1.5', '1e3', '1E-3', '.5', '5.', '+.5', ' 1.5', '1.5 ', '1_000.25', '1__0', '_1', '1_', '0x10', '0b1', '0o7', 'inf', '-Infinity', 'nan', 'NaN', '', ' ', 'abc', '1e', 'e5', '--1', '1-2', '1.2.3', '\t2\n', '1e1000', '00012', '1_0e1_0', '1.5e+3', '.', '+', '-', '0.000']
res = []
for s in fs:
    try:
        v = float(s)
        res.append([s, 'nan' if v != v else v])
    except ValueError:
        res.append([s, None])
out['float'] = res
json.dump(out, open('helpers_expected.json', 'w'), allow_nan=True)
print('ok', len(out['round']), len(out['hypot']), len(out['sets']))
