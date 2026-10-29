import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    bd = sys.argv[1]
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 900})
        logs = []
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        pg.on('console', lambda m: logs.append(f'{m.type}: {m.text}') if m.type == 'error' and 'TUNNEL' not in m.text and 'fonts' not in m.text else None)
        await pg.goto(URL + '#' + bd + '~~pcb', wait_until='networkidle')
        await pg.wait_for_timeout(1200)
        await pg.evaluate("Noeti.live ? 0 : 0; Noeti.startLive()"); await pg.wait_for_timeout(1200)
        await pg.evaluate("Noeti.live.ui.open('code')"); await pg.wait_for_timeout(500)
        ed0 = await pg.eval_on_selector('.cd-ed', 'e=>e.value.slice(0,80)')
        print('editor starts:', ed0.replace('\n',' | '))
        await pg.fill('.cc-q', 'make the LED breathe')
        await pg.click('.cc-in button')
        await pg.wait_for_timeout(2500)
        msgs = await pg.eval_on_selector_all('.cc-m', 'els=>els.map(e=>e.className+": "+e.innerText.slice(0,160))')
        print('msgs:', json.dumps(msgs, indent=1))
        ed1 = await pg.eval_on_selector('.cd-ed', 'e=>e.value.slice(0,160)')
        print('editor now:', ed1.replace('\n',' | '))
        st = await pg.evaluate("(()=>{const pr=[...Noeti.live.fwm.procs.values()][0]; return pr ? pr.state+' '+pr.console.text.slice(-120) : 'none'})()")
        print('proc:', st)
        await pg.screenshot(path=f'/tmp/claude-0/qa/ui-{bd}-chat.png')
        undo = await pg.query_selector('.cc-m button')
        if undo:
            await undo.click(); await pg.wait_for_timeout(600)
            ed2 = await pg.eval_on_selector('.cd-ed', 'e=>e.value.slice(0,80)')
            print('after undo:', ed2.replace('\n',' | '), 'same as start:', ed2 == ed0[:80])
        await pg.click('text=Explain the code'); await pg.wait_for_timeout(1500)
        msgs = await pg.eval_on_selector_all('.cc-m', 'els=>els.map(e=>e.className+": "+e.innerText.slice(0,120))')
        print('after explain:', json.dumps(msgs[-2:], indent=1))
        # board tab
        await pg.evaluate("Noeti.live.ui.open('board')"); await pg.wait_for_timeout(500)
        await pg.click('text=Explain with KiLive'); await pg.wait_for_timeout(1500)
        ai = await pg.eval_on_selector('.bd-ai', 'e=>e.innerText.slice(0,200)')
        print('board ai:', ai)
        await pg.screenshot(path=f'/tmp/claude-0/qa/ui-{bd}-board.png')
        print('\n'.join(logs[:20]))
        await b.close()
asyncio.run(main())
