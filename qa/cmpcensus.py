import json, sys
a = {r['board']: r for r in json.load(open(sys.argv[1]))}
b = {r['board']: r for r in json.load(open(sys.argv[2]))}
for k in a:
    if k not in b: print('MISSING', k); continue
    x, y = a[k]['pm'], b[k]['pm']
    d = []
    if set(x['sup']) != set(y['sup']): d.append('  sup  ' + ' '.join(sorted(x['sup'])) + '\n    -> ' + ' '.join(sorted(y['sup'])))
    if sorted(x['regs']) != sorted(y['regs']): d.append('  regs ' + ' '.join(x['regs']) + '\n    -> ' + ' '.join(y['regs']))
    if x['ok'] != y['ok']: d.append(f"  ok {x['ok']} -> {y['ok']}")
    if abs(x['floating'] - y['floating']) > 3: d.append(f"  floating {x['floating']} -> {y['floating']}")
    if d: print(k); print('\n'.join(d))
