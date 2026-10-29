import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    bd = sys.argv[1]
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 900})
        await pg.goto(URL + '#' + bd + '~~pcb', wait_until='networkidle')
        await pg.wait_for_timeout(1500)
        await pg.evaluate("Noeti.startLive()"); await pg.wait_for_timeout(2500)
        r = await pg.evaluate("""(()=>{const L=Noeti.live; const p=L.procs[0]; const e=L.engine; const out={t0:e.t, ref:p.ref, vnom:p.vnom, vdd:p.vdd, io0:p.io[0]&&p.io[0].number};
          const pr = L.fwm.runScript(p, 'void setup(){ Serial.println("hi"); } void loop(){ delay(100); }');
          out.after = {t:L.engine.t, vdd: pr.vdd(), powered: pr.powered(), eng: L.engine===e, sup: L.engine.supplyV(pr.ref, pr.info.io[0].number)};
          return out; })()""")
        print(json.dumps(r))
        await pg.wait_for_timeout(1500)
        r = await pg.evaluate("""(()=>{const L=Noeti.live; const pr=[...L.fwm.procs.values()][0]; return {t:L.engine.t, c: pr.console.text.slice(0,200), vdd: pr.vdd(), powered: pr.powered()} })()""")
        print(json.dumps(r))
        await b.close()
asyncio.run(main())
