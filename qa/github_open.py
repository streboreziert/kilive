import asyncio, os, json, re, urllib.parse
from playwright.async_api import async_playwright
"""Open-from-GitHub test with GitHub stubbed by a local clone (no network, no rate limit).

    git clone --depth 1 https://github.com/Jana-Marie/OtterPill /tmp/otter
    python3 qa/github_open.py http://localhost:8766/ /tmp/otter
Exit code 1 on failure.
"""
import sys
URL=sys.argv[1] if len(sys.argv)>1 else 'http://localhost:8766/'
ROOT=sys.argv[2] if len(sys.argv)>2 else '/tmp/otter'
fails=[]
tree=[]
for d,_,fs in os.walk(ROOT):
    if '/.git' in d: continue
    for f in fs:
        p=os.path.relpath(os.path.join(d,f),ROOT); tree.append({'path':p,'type':'blob','size':os.path.getsize(os.path.join(d,f))})
calls={'api':0,'raw':0}; ext=[]
async def route(r):
    u=r.request.url
    if u.startswith(URL) or u.startswith('data:') or u.startswith('blob:'): return await r.continue_()
    if u.startswith('https://api.github.com/repos/Jana-Marie/OtterPill/git/trees/'):
        calls['api']+=1; return await r.fulfill(status=200, content_type='application/json', headers={'access-control-allow-origin':'*'}, body=json.dumps({'sha':'abc123','tree':tree,'truncated':False}))
    m=re.match(r'https://raw\.githubusercontent\.com/Jana-Marie/OtterPill/[^/]+/(.*)$',u)
    if m:
        calls['raw']+=1; p=urllib.parse.unquote(m.group(1))
        return await r.fulfill(status=200, content_type='text/plain', headers={'access-control-allow-origin':'*'}, body=open(os.path.join(ROOT,p),encoding='utf-8').read())
    if u.startswith('https://api.github.com/'):
        return await r.fulfill(status=404, body='{}', headers={'access-control-allow-origin':'*'})
    ext.append(u); await r.abort()
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(args=['--disable-gpu','--enable-unsafe-swiftshader'])
        ctx=await b.new_context(viewport={'width':1400,'height':900}); await ctx.route('**/*',route)
        pg=await ctx.new_page(); logs=[]
        pg.on('pageerror',lambda e: logs.append(f'PAGEERROR: {e}'))
        pg.on('console',lambda m: logs.append(m.text[:200]) if m.type=='error' else None)
        await pg.goto(URL+'#explore',wait_until='networkidle'); await pg.wait_for_timeout(1500)
                # 1: paste a repo link into the home form -> project picker
        await pg.fill('.gh-input','https://github.com/Jana-Marie/OtterPill'); await pg.click('.gh-form .btn'); await pg.wait_for_timeout(2000)
        print('picker:', (await pg.evaluate("(document.querySelector('.proj-list')||{}).innerText||''")).replace('\n',' | ')[:300])
        btns=await pg.query_selector_all('.proj-list .proj')
        for bt in btns:
            if 'HW v1.4' in (await bt.inner_text()): await bt.click(); break
        await pg.wait_for_timeout(7000)
        n1 = await pg.evaluate("Noeti.app.cur && Noeti.app.cur.B && Noeti.app.cur.B.fps.length")
        print('hash:', await pg.evaluate('location.hash'), 'parts:', n1)
        if not n1: fails.append('picker import produced no board')
        print('about:', (await pg.evaluate("(document.querySelector('.about, aside')||{}).innerText||''"))[:250].replace('\n',' | '))
        # 2: a shared link to a folder opens directly
        await pg.goto(URL+'#gh/Jana-Marie/OtterPill/HW%20v1.4',wait_until='networkidle'); await pg.wait_for_timeout(7000)
        n2 = await pg.evaluate("Noeti.app.cur && Noeti.app.cur.B && Noeti.app.cur.B.fps.length")
        print('direct link hash:', await pg.evaluate('location.hash'), 'parts:', n2)
        if not n2: fails.append('direct link produced no board')
        await pg.evaluate("location.hash=location.hash.replace(/~3d$/,'~pcb')"); await pg.wait_for_timeout(1500)
        await pg.click('button:has-text("Live")'); await pg.wait_for_timeout(5000)
        print('rails:', (await pg.evaluate("document.body.innerText.match(/SUPPLY RAILS[\\s\\S]{0,160}/)?.[0]||''")).replace('\n',' | '))
        # 3: bad link and not-found
        await pg.goto(URL+'#gh/nobody/nothing',wait_until='networkidle'); await pg.wait_for_timeout(1500)
        if not await pg.evaluate("!!document.querySelector('#create-work .err')"): fails.append('no error for missing repo')
        print('404 msg:', (await pg.evaluate("(document.querySelector('#create-work .err')||{}).innerText||''"))[:120])
        print('calls', calls, 'other external', ext[:5]); errs=[l for l in logs if 'PAGEERROR' in l]
        print('\n'.join(errs) or 'NO PAGE ERRORS'); print('FAIL: '+'; '.join(fails) if fails else 'PASS'); await b.close()
        sys.exit(1 if fails or errs else 0)
asyncio.run(main())
