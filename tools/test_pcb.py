import sys, json, time, math
from kicad_pcb import parse_pcb, rot
t=time.time()
d=parse_pcb(sys.argv[1])
print('parse s', round(time.time()-t,2))
m=d['meta']; print(m)
print('fps',len(d['fps']),'pads',len(d['pads']),'nets',len(d['nets']),'vias',len(d['vias']),'zones',len(d['zones']), 'tracks', {k:len(v)//6 for k,v in d['tracks'].items()})
print('outline outer',len(d['outline']['outer']),[len(l)//2 for l in d['outline']['outer']],'holes',len(d['outline']['holes']))
s=json.dumps(d,separators=(',',':'))
print('json MB',round(len(s)/1e6,2))
import gzip; print('gz MB', round(len(gzip.compress(s.encode()))/1e6,2))
for k in ['tracks','zones','pads','fps','gfx','zoneOutlines']:
    print(' ',k, round(len(json.dumps(d[k],separators=(',',':')))/1e6,2))
# verify: track endpoints inside some pad (same net)
from collections import defaultdict
pn=defaultdict(list)
for p in d['pads']:
    pn[p[10]].append(p)
hit=tot=0
for L,arr in d['tracks'].items():
    for i in range(0,len(arr),6):
        for (x,y) in ((arr[i],arr[i+1]),(arr[i+2],arr[i+3])):
            for p in pn[arr[i+5]]:
                dx,dy=x-p[4],y-p[5]
                lx,ly=rot(dx,dy,-p[8])
                if abs(lx)<=p[6]/2+0.01 and abs(ly)<=p[7]/2+0.01:
                    hit+=1;break
            tot+=1
print('track endpoints on pads',hit,'/',tot)
