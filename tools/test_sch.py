import sys, json, time
import kicad_sch
from kicad_sch import parse_schematic, pin_endpoints
t=time.time()
d=parse_schematic(sys.argv[1], 'x')
print('parse', round(time.time()-t,2), 'pages', len(d['pages']), [ (p['name'], len(p['syms'])) for p in d['pages']], 'lib', len(d['lib']), 'parts', len(d['parts']), 'missing', d['missing'])
s=json.dumps(d,separators=(',',':')); print('MB', round(len(s)/1e6,2))
for rs in (1,-1):
  for mf in (False, True):
    kicad_sch.VARIANT.update(rot_sign=rs, mirror_first=mf)
    eps=pin_endpoints(d)
    hit=tot=0
    for pg,pp in zip(d['pages'],eps):
        targets=set()
        w=pg['wires']
        for i in range(0,len(w),2): targets.add((round(w[i],2),round(w[i+1],2)))
        for l in pg['labels']: targets.add((round(l[1],2),round(l[2],2)))
        for i in range(0,len(pg['nc']),2): targets.add((round(pg['nc'][i],2),round(pg['nc'][i+1],2)))
        from collections import Counter
        c=Counter(pp)
        for p in pp:
            tot+=1
            if p in targets or c[p]>1: hit+=1
    print('rot_sign',rs,'mirror_first',mf,'pins connected',hit,'/',tot)
