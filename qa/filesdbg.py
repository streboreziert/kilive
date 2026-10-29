import asyncio, json
from playwright.async_api import async_playwright
URL = 'http://localhost:8765/preview-mock.html'
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--disable-gpu'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 900})
        await pg.goto(URL + '#smartknob~~files', wait_until='networkidle'); await pg.wait_for_timeout(2500)
        r = await pg.evaluate("""(() => { const q = s => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.width), getComputedStyle(e).overflow]; };
          return { pane: q('#pane-files'), grid: q('.files-grid'), col: q('.files-col'), readme: q('.readme'), tree: q('.files-col > *'), li: q('.file-list li'), cols: getComputedStyle(document.querySelector('.files-grid')).gridTemplateColumns }; })()""")
        print(json.dumps(r))
        await b.close()
asyncio.run(main())
