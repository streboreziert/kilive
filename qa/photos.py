import asyncio, sys, json, base64, time, io, os, math
from playwright.async_api import async_playwright
from PIL import Image, ImageDraw, ImageFilter
URL = 'http://localhost:8765/preview-mock.html'
APP = '/home/claude/noeti/app'
def backdrop(w, h):
    # seamless light-grey studio sweep with a soft vignette
    small = Image.new('RGB', (256, 160))
    px = small.load()
    for y in range(160):
        for x in range(256):
            dx = (x / 255 - 0.5) * 1.6; dy = (y / 159 - 0.38) * 1.0
            r = min(1.0, math.hypot(dx, dy))
            t = r * r
            c = (244 * (1 - t) + 201 * t, 244 * (1 - t) + 201 * t, 241 * (1 - t) + 195 * t)
            g = y / 159
            c = tuple(v * (1.0 - 0.04 * g) for v in c)
            px[x, y] = tuple(int(v) for v in c)
    return small.resize((w, h), Image.BICUBIC).filter(ImageFilter.GaussianBlur(2))
async def main():
    only = sys.argv[1].split(',') if len(sys.argv) > 1 and sys.argv[1] else None
    force = len(sys.argv) > 2 and sys.argv[2] == 'force'
    idx = json.load(open(f'{APP}/data/index.json'))
    bg = backdrop(2048, 1280)
    todo = [r for r in idx if (not only or r['id'] in only) and (force or not os.path.exists(f"{APP}/photos/{r['id']}.webp"))]
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        pg = None; n = 0
        for r in todo:
            if pg is None or n % 12 == 0:
                if pg: await pg.close()
                pg = await b.new_page(viewport={'width': 1200, 'height': 800})
                await pg.goto(URL, wait_until='networkidle'); await pg.wait_for_timeout(800)
            n += 1
            bd = r['boards'][0]
            v = next((x for x in bd['versions'] if x['id'] == bd.get('default')), bd['versions'][0])
            t0 = time.time()
            try:
                res = await pg.evaluate("""async (f) => { const d = await Noeti.loadJSON(f); const B = new Noeti.Board(d);
                  const cv = await Noeti.renderPhoto(B, { width: 2048, height: 1280, ss: 1 }); return { url: cv.toDataURL('image/png'), meta: cv.meta, mask: B.meta.mask }; }""", v['file'])
            except Exception as e:
                print('FAIL', r['id'], str(e)[:300], flush=True); pg = None; n = 0; continue
            im = Image.open(io.BytesIO(base64.b64decode(res['url'].split(',')[1]))).convert('RGBA')
            photo = bg.copy().convert('RGBA'); photo.alpha_composite(im)
            photo.convert('RGB').save(f"{APP}/photos/{r['id']}.webp", 'WEBP', quality=86, method=6)
            th = im.resize((960, 600), Image.LANCZOS)
            th.save(f"{APP}/thumbs/{r['id']}.webp", 'WEBP', quality=86, method=6)
            m = res['meta']
            print('ok', r['id'], f"{time.time()-t0:.1f}s", m.get('parts'), int(m.get('triangles', 0)), res['mask'], 'under' if m.get('under') else '', os.path.getsize(f"{APP}/photos/{r['id']}.webp") // 1024, 'KB', flush=True)
        await b.close()
asyncio.run(main())
