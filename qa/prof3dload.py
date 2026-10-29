import asyncio, sys, json, collections
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    bd = sys.argv[1]; view = sys.argv[2] if len(sys.argv) > 2 else '3d'
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 900})
        await pg.goto(URL + '#' + bd + '~~pcb', wait_until='networkidle'); await pg.wait_for_timeout(2500)
        cdp = await pg.context.new_cdp_session(pg)
        await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', {'interval': 1000}); await cdp.send('Profiler.start')
        await pg.evaluate(f"location.hash = location.hash.replace('~pcb', '~{view}')")
        await pg.wait_for_timeout(int(sys.argv[3]) if len(sys.argv) > 3 else 8000)
        prof = (await cdp.send('Profiler.stop'))['profile']
        nodes = {n['id']: n for n in prof['nodes']}
        dt = prof['timeDeltas']; cnt = collections.Counter()
        for sid, d in zip(prof['samples'], dt): cnt[sid] += d
        self_t = collections.Counter()
        for nid, t in cnt.items():
            cf = nodes[nid]['callFrame']; self_t[(cf['functionName'] or '(anon)', cf['url'].split('/')[-1], cf['lineNumber'])] += t
        for k, t in self_t.most_common(25): print(round(t/1000), 'ms', k)
        await b.close()
asyncio.run(main())
