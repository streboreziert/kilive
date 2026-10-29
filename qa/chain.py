import asyncio, json, sys
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    idx = json.load(open('/home/claude/noeti/app/data/index.json'))
    r = [x for x in idx if x['id']==sys.argv[1]][0]; v = r['boards'][0]['versions'][int(sys.argv[2]) if len(sys.argv)>2 else 0]
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu']); pg = await b.new_page()
        await pg.goto(URL, wait_until='networkidle')
        res = await pg.evaluate("""async (f)=>{ const d = await Noeti.loadJSON(f); const B = new Noeti.Board(d); const c = Noeti.simtab.boardCircuit(B);
          const ch = Noeti.devices.ledChains(c); const ix = Noeti.analysis.index(c);
          const leds = c.components.filter(x=>/SK68|WS28|APA1|LED/i.test([x.value,x.mpn,x.description].join(' '))).slice(0,6).map(x=>x.ref+' '+x.value+' '+x.mpn+' '+(x.pins||[]).map(p=>p.number+':'+p.name+'='+((ix.at(x.ref,p.number)||{}).name)).join(','));
          const dn = ch[0] && ix.net.get(ch[0].dataNet);
          return {chains: ch.map(x=>({dataNet:x.dataNet, n:x.leds.length, part:x.part})), leds, dnNodes: dn? dn.nodes.map(x=>{const cc=ix.comp.get(x.ref); return x.ref+'.'+x.pin+' '+(cc&&cc.value)+' '+(cc&&cc.type)+' pins='+(cc&&(cc.pins||[]).length)}):null,
            hop: dn ? [...ix.hop(dn,1000)].map(n=>n.name+': '+n.nodes.map(x=>x.ref+'.'+x.pin).join(' ')) : null } }""", v['file'])
        print(json.dumps(res, indent=1)[:4000])
        await b.close()
asyncio.run(main())
