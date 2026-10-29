import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu','--enable-unsafe-swiftshader'])
        logs = []
        # desktop: KiLive setup, controls, rebuild on design edit, navigation stop
        pg = await b.new_page(viewport={'width': 1440, 'height': 1250})
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        await pg.goto(URL + '#rp2040-guide~rp2040-guide~pcb', wait_until='networkidle')
        for i in range(80):
            if await pg.evaluate("document.querySelector('#loading').hidden"): break
            await pg.wait_for_timeout(250)
        await pg.click('#live-btn'); await pg.wait_for_timeout(800)
        before = await pg.evaluate("Noeti.live.base.sim.sources.map(s=>s.net+'='+s.value).join(',')")
        await pg.click('.live-dock .ld-btn:has-text(\"Set up with KiLive\")'); await pg.wait_for_timeout(2000)
        after = await pg.evaluate("({src: Noeti.live.base.sim.sources.map(s=>s.net+'='+s.value).join(','), loads: Noeti.live.base.sim.standins.filter(s=>s.ref==='U3').map(s=>s.pin+':'+s.value+' '+s.note).slice(0,3), toast: [...document.querySelectorAll('.toast')].map(t=>t.innerText).join(' | '), t: Noeti.live.engine.t})")
        print('noeti setup', before, '->', json.dumps(after))
        # space pauses
        await pg.click('.pcb-canvas', position={'x':5,'y':5}); await pg.keyboard.press('Escape')
        await pg.keyboard.press(' '); await pg.wait_for_timeout(200)
        print('space paused', not await pg.evaluate("Noeti.live.running"))
        await pg.keyboard.press(' ')
        # navigate away stops live
        await pg.evaluate("location.hash='explore'"); await pg.wait_for_timeout(800)
        print('stopped on leave', not await pg.evaluate("Noeti.live.on"))
        # design edit rebuild: ldo template
        await pg.evaluate("Noeti.create.newDesignDraft('ldo')"); await pg.wait_for_timeout(1500)
        for i in range(40):
            if await pg.evaluate("!!document.querySelector('#loading') && document.querySelector('#loading').hidden"): break
            await pg.wait_for_timeout(250)
        await pg.click('#live-btn'); await pg.wait_for_timeout(1500)
        print('ldo', await pg.evaluate("({tab: location.hash, rails:[...document.querySelectorAll('.ld-rail')].map(x=>x.innerText.replace(/\\n/g,' ')).join(' | '), leds:Noeti.live.leds.map(d=>d.ref+':'+d.lvl.toFixed(2))})"))
        gen0 = await pg.evaluate("Noeti.live.gen")
        # change a value in the design through the app's rebuild path: edit R1 value via SchEditor doc
        await pg.click('#tab-design'); await pg.wait_for_timeout(800)
        ok = await pg.evaluate("""(()=>{ const ed=document.querySelector('.se-root, .scheditor, .se-wrap'); return !!ed; })()""")
        print('design editor present', ok)
        await pg.click('#tab-sch'); await pg.wait_for_timeout(1000)
        print('live still on after tab switch', await pg.evaluate("Noeti.live.on"))
        await pg.screenshot(path='/tmp/claude-0/shots/lm-ldo-sch.png')
        await pg.close()
        # mobile + dark
        ctx = await b.new_context(viewport={'width': 390, 'height': 844}, color_scheme='dark', device_scale_factor=2)
        pg = await ctx.new_page()
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR(m): {e}'))
        await pg.goto(URL + '#bus-pirate~bus-pirate~pcb', wait_until='networkidle')
        for i in range(80):
            if await pg.evaluate("document.querySelector('#loading').hidden"): break
            await pg.wait_for_timeout(250)
        await pg.click('#live-btn'); await pg.wait_for_timeout(2500)
        await pg.evaluate("document.querySelector('#viewer-card').scrollIntoView()")
        await pg.wait_for_timeout(500)
        await pg.screenshot(path='/tmp/claude-0/shots/lm-mobile-pcb.png')
        await pg.click('#tab-sch'); await pg.wait_for_timeout(1500)
        await pg.screenshot(path='/tmp/claude-0/shots/lm-mobile-sch.png')
        print('mobile dock h', await pg.evaluate("getComputedStyle(document.querySelector('#vc-body')).getPropertyValue('--dock-h')"), await pg.evaluate("document.querySelector('#vc-body').offsetHeight"))
        print('\n'.join(logs[-20:]))
        await b.close()
asyncio.run(main())
