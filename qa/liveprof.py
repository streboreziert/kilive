import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    bd, tab = sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else '3d'
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        pg = await b.new_page(viewport={'width': 1200, 'height': 800})
        await pg.goto(URL + '#' + bd + '~~' + tab, wait_until='networkidle'); await pg.wait_for_timeout(3000)
        await pg.evaluate("Noeti.startLive()"); await pg.wait_for_timeout(2000)
        cdp = await pg.context.new_cdp_session(pg)
        await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', {'interval': 500}); await cdp.send('Profiler.start')
        f0 = await pg.evaluate("Noeti.live.frameId")
        await pg.wait_for_timeout(5000)
        f1 = await pg.evaluate("Noeti.live.frameId")
        prof = (await cdp.send('Profiler.stop'))['profile']
        print('frames in 5 s:', f1 - f0)
        nodes = {n['id']: n for n in prof['nodes']}
        self_t = {}
        for s, d in zip(prof['samples'], prof['timeDeltas']):
            n = nodes[s]; k = n['callFrame']['functionName'] + ':' + str(n['callFrame']['lineNumber'] + 1) + ' ' + n['callFrame']['url'].split('/')[-1]
            self_t[k] = self_t.get(k, 0) + d
        for k, v in sorted(self_t.items(), key=lambda x: -x[1])[:22]: print(f'{v/1000:8.1f} ms  {k}')
        await b.close()
asyncio.run(main())
