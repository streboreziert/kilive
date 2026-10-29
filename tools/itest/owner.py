import asyncio
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu','--enable-unsafe-swiftshader'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 1000})
        logs = []
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        pg.on('console', lambda m: logs.append(f'{m.type}: {m.text}') if m.type in ('error',) and 'TUNNEL' not in m.text else None)
        await pg.goto(URL + '#new', wait_until='networkidle'); await pg.wait_for_timeout(1500)
        await pg.click('.cc-tpls .tpl >> nth=0'); await pg.wait_for_timeout(1500)
        await pg.click('#save-btn'); await pg.wait_for_timeout(400)
        await pg.click('.modal-foot .btn.primary'); await pg.wait_for_timeout(4000)
        h = await pg.evaluate('location.hash'); print('saved', h)
        await pg.click('#tab-design'); await pg.wait_for_timeout(800)
        print('save hidden before edit:', await pg.evaluate("document.querySelector('#save-btn').hidden"))
        # place a resistor with real clicks
        await pg.click('.se-pal-item >> nth=0'); await pg.wait_for_timeout(200)
        box = await pg.evaluate("(()=>{const r=document.querySelector('.dz-editor .se-canvas').getBoundingClientRect();return [r.left,r.top,r.width,r.height]})()")
        await pg.mouse.click(box[0]+box[2]*0.8, box[1]+box[3]*0.25); await pg.wait_for_timeout(200)
        await pg.keyboard.press('Escape'); await pg.wait_for_timeout(2000)
        print('status:', await pg.evaluate("document.querySelector('.dz-status').textContent"))
        print('save hidden after edit:', await pg.evaluate("document.querySelector('#save-btn').hidden"))
        await pg.click('#save-btn'); await pg.wait_for_timeout(3500)
        bid = h.split('~')[0][3:]
        print('rev after save:', await pg.evaluate(f"window.__store.get('catalog/u_test').boards['{bid}'].rev"), 'parts', await pg.evaluate(f"window.__store.get('catalog/u_test').boards['{bid}'].stats.parts"))
        await pg.screenshot(path='/tmp/claude-0/shots/o-edited.png')
        # become another viewer: move the board to u_other
        await pg.evaluate(f"""(()=>{{const st=window.__store; for (const k of [...st.keys()]) if (k.startsWith('library/u_test/')) {{ st.set(k.replace('u_test','u_other'), st.get(k)); st.delete(k); }}
          st.set('catalog/u_other', st.get('catalog/u_test')); st.delete('catalog/u_test'); location.hash='explore'; }})()""")
        await pg.wait_for_timeout(1500)
        await pg.evaluate("Noeti.lib.catalog.delete('u_test'); Noeti.lib.catalog.set('u_other', window.__store.get('catalog/u_other')); location.hash='explore'")
        await pg.wait_for_timeout(800)
        await pg.click('.user-card'); await pg.wait_for_timeout(3000)
        await pg.click('#tab-design'); await pg.wait_for_timeout(1000)
        print('author:', await pg.evaluate("document.querySelector('#bp-author').textContent"), '| actions:', await pg.evaluate("[...document.querySelectorAll('#bp-actions > *')].filter(x=>!x.hidden).map(x=>x.innerText.trim()).join(' / ')"))
        print('design bar:', await pg.evaluate("document.querySelector('.dz-bar').innerText.replace(/\\n/g,' ')"))
        await pg.screenshot(path='/tmp/claude-0/shots/o-other.png')
        await pg.click('.dz-bar .btn'); await pg.wait_for_timeout(2000)
        print('remix:', await pg.evaluate("location.hash + ' ' + document.querySelector('#bp-h1').textContent"))
        print('\n'.join(logs[-20:]))
        await b.close()
asyncio.run(main())
