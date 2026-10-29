import asyncio, time
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        pg = await b.new_page()
        await pg.goto('http://localhost:8765/preview-mock.html', wait_until='networkidle'); await pg.wait_for_timeout(500)
        r = await pg.evaluate("""async () => { const t0 = performance.now(); await document.fonts.ready; const t1 = performance.now();
          const cv = document.createElement('canvas'); cv.width = 2048; cv.height = 1280; const gl = cv.getContext('webgl2', {antialias: true}); const t2 = performance.now();
          return [t1 - t0, t2 - t1, document.fonts.status, gl.getParameter(gl.MAX_SAMPLES), gl.getParameter(gl.RENDERER)]; }""")
        print(r)
        await b.close()
asyncio.run(main())
