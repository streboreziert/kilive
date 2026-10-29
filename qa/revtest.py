import asyncio, sys, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def paste(pg, text):
    await pg.evaluate("""(t) => { const dt = new DataTransfer(); dt.setData('text/plain', t); document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true })); }""", text)
async def main():
    p1 = open('/tmp/claude-0/plugtest/payload1.txt').read(); p2 = open('/tmp/claude-0/plugtest/payload2.txt').read()
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 900})
        logs = []
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        await pg.goto(URL + '#new', wait_until='networkidle'); await pg.wait_for_timeout(1500)
        await paste(pg, p1); await pg.wait_for_timeout(500)
        await pg.click('.modal-foot .btn.primary'); await pg.wait_for_timeout(4000)
        await pg.click('#save-btn'); await pg.wait_for_timeout(500)
        await pg.click('.modal-foot .btn.primary'); await pg.wait_for_timeout(5000)
        print('saved:', await pg.evaluate("[location.hash, Noeti.app.cur.repo.id, Noeti.lib.live]"))
        await paste(pg, p2); await pg.wait_for_timeout(500)
        print('modal:', await pg.evaluate("document.querySelector('.modal') && document.querySelector('.modal').innerText.replace(/\\n+/g, ' | ')"))
        await pg.click('.modal-foot .btn.primary'); await pg.wait_for_timeout(4000)
        print('save btn:', await pg.evaluate("[document.querySelector('#save-btn').hidden, document.querySelector('#save-btn').innerText]"))
        await pg.click('#save-btn'); await pg.wait_for_timeout(5000)
        print('versions:', await pg.evaluate("Noeti.app.cur.board.versions.map(v => v.id + ':' + v.label)"))
        await pg.click('#ver-btn'); await pg.wait_for_timeout(400)
        print('menu:', await pg.evaluate("document.querySelector('.menu-pop').innerText.replace(/\\n+/g, ' | ')"))
        await pg.screenshot(path='/tmp/claude-0/qa/ui/k-7-vermenu.png')
        # compare
        items = await pg.query_selector_all('.menu-pop button')
        for it in items:
            t = await it.inner_text()
            if 'with' in t and 'rev' in t: await it.click(); break
        await pg.wait_for_timeout(2500)
        print('compare:', await pg.evaluate("document.querySelector('.modal') && document.querySelector('.modal').innerText.replace(/\\n+/g, ' | ')"))
        await pg.keyboard.press('Escape'); await pg.wait_for_timeout(300)
        # open the old revision
        await pg.click('#ver-btn'); await pg.wait_for_timeout(300)
        items = await pg.query_selector_all('.menu-pop button')
        for it in items:
            t = await it.inner_text()
            if t.strip().startswith('rev 1'): await it.click(); break
        await pg.wait_for_timeout(3000)
        print('old rev:', await pg.evaluate("[location.hash, Noeti.app.cur.version.id, Noeti.app.cur.B && Noeti.app.cur.B.fps.find(f => f.r === 'R2').v, Noeti.app.cur.user.readonly]"))
        await pg.click('#kicad-btn'); await pg.wait_for_timeout(300)
        print('kicad menu on old rev:', await pg.evaluate("document.querySelector('.menu-pop').innerText.replace(/\\n+/g, ' | ')"))
        print('\n'.join(logs[:20]) or 'NO ERRORS')
        await b.close()
asyncio.run(main())
