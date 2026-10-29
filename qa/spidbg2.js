(()=>{const L=Noeti.live; const p=[...L.fwm.procs.values()][0]; const hw=p.hw; const d=hw.devs[0]; const e=L.engine;
const comp=L.base.circuit.components.find(c=>c.ref==='U1');
return {lv:{rst:d.lvl('rst'),dc:d.lvl('dc'),cs:d.lvl('cs')}, status:d.status(),
 u1pins: comp.pins.map(pn=>pn.number+':'+pn.name).join(' '),
 nets: ['TFT_CS','D{slash}C','TFT_RST','RESET','RST'].map(n=>{const nd=e.nodeOf(n); return n+'='+(nd?e.V(nd).toFixed(2):'-')}),
 modes:[...(p.pinModes||new Map())].map(x=>x.join('=')).join(' ')}})()
