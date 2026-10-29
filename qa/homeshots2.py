import asyncio, sys
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu'])
        logs = []
        pg = await b.new_page(viewport={'width': 1440, 'height': 900})
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        await pg.goto(URL + '#explore', wait_until='networkidle'); await pg.wait_for_timeout(2000)
        # FPGA category, cards
        await pg.click('.ex-cats .chip-btn:has-text("FPGA")'); await pg.wait_for_timeout(1200)
        await pg.evaluate("window.scrollTo(0, 380)"); await pg.wait_for_timeout(1500)
        await pg.screenshot(path='/tmp/claude-0/qa/ui/ex-fpga.png')
        # list view, sorted by parts
        await pg.click('.ex-vb[data-v="list"]'); await pg.select_option('.ex-tools select[aria-label="Sort boards"]', 'parts'); await pg.wait_for_timeout(1500)
        await pg.screenshot(path='/tmp/claude-0/qa/ui/ex-list.png')
        # search
        await pg.click('.ex-clear'); await pg.fill('.ex-search', 'rp2040 usb'); await pg.wait_for_timeout(1200)
        print('search count', await pg.inner_text('.ex-count'))
        await pg.click('.ex-vb[data-v="cards"]'); await pg.select_option('.ex-tools select[aria-label="Sort boards"]', 'featured'); await pg.wait_for_timeout(800)
        # chip filter
        await pg.fill('.ex-search', ''); await pg.wait_for_timeout(400)
        await pg.select_option('.ex-tools select[aria-label="Chip family"]', 'esp32'); await pg.wait_for_timeout(1200)
        print('esp32 count', await pg.inner_text('.ex-count'))
        await pg.screenshot(path='/tmp/claude-0/qa/ui/ex-esp32.png')
        # phone
        ph = await b.new_page(viewport={'width': 390, 'height': 844}, device_scale_factor=2)
        ph.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        await ph.goto(URL + '#explore', wait_until='networkidle'); await ph.wait_for_timeout(2000)
        await ph.screenshot(path='/tmp/claude-0/qa/ui/ex-phone-0.png')
        await ph.evaluate("window.scrollTo(0, 700)"); await ph.wait_for_timeout(1500)
        await ph.screenshot(path='/tmp/claude-0/qa/ui/ex-phone-1.png')
        sw = await ph.evaluate("document.documentElement.scrollWidth")
        print('phone scrollWidth', sw)
        print('\n'.join(logs[:10]) or 'NO ERRORS')
        await b.close()
asyncio.run(main())
