"""End-to-end tests for the schematic editor (app/js/scheditor.js), driven by real mouse and keyboard input.
Run:  python3 tools/editortest/test_editor.py      (needs the static server on http://localhost:8765/)
Screenshots go to /tmp/claude-0/shots/editor-*.png"""
import json, sys, os
from playwright.sync_api import sync_playwright

URL = 'http://localhost:8765/test-editor.html'
SHOTS = '/tmp/claude-0/shots'
os.makedirs(SHOTS, exist_ok=True)
results = []

def check(name, ok, detail=''):
    results.append((name, bool(ok)))
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else '  -> ' + str(detail)[:600]))

NORM = """(c) => {
  const k = new DS2K.Circuit(JSON.parse(JSON.stringify(c))); k.normalize();
  return k.nets.map(n => ({ name: n.name, nodes: n.nodes.map(q => q.join('.')).sort() })).sort((a, b) => a.nodes.join() < b.nodes.join() ? -1 : 1);
}"""

class Ed:
    def __init__(self, page):
        self.p = page
    def ev(self, js, arg=None):
        return self.p.evaluate(js, arg) if arg is not None else self.p.evaluate(js)
    def xy(self, x, y):
        r = self.ev('([x, y]) => ed.toClient(x, y)', [x, y])
        return r['x'], r['y']
    def click(self, x, y, **kw):
        self.p.mouse.click(*self.xy(x, y), **kw)
        self.p.wait_for_timeout(60)
    def pin(self, ref, pin):
        r = self.ev('([r, p]) => ed.pinAt(r, p)', [ref, pin])
        assert r, f'no pin {ref}.{pin}'
        return r['x'], r['y']
    def click_pin(self, ref, pin):
        self.click(*self.pin(ref, pin))
    def palette(self, key):
        self.p.click(f'.se-pal-item[data-k="{key}"]')
        self.p.wait_for_timeout(50)
    def key(self, k):
        self.p.keyboard.press(k)
        self.p.wait_for_timeout(60)
    def place(self, key, x, y, rotate=0, mirror=False):
        self.palette(key)
        self.p.mouse.move(*self.xy(x, y))
        for _ in range(rotate): self.key('r')
        if mirror: self.key('x')
        self.click(x, y)
        self.key('Escape')
        return self.ev('() => { const id = [...ed.sel.parts][0]; return ed.doc.parts.find(p => p.id === id).ref; }')
    def set_field(self, f, value):
        self.p.fill(f'.se-insp [data-f="{f}"]', value)
        self.p.press(f'.se-insp [data-f="{f}"]', 'Enter')
        self.p.wait_for_timeout(60)
    def wire(self, *pts):
        """pts: ('pin', ref, pin) or (x, y); draws with the Wire tool; last point must be a pin / wire to auto-finish"""
        self.key('w')
        for q in pts:
            if q[0] == 'pin': self.click_pin(q[1], q[2])
            else: self.click(*q)
        if self.ev('() => !!ed.wire'): self.key('Escape')
        self.key('Escape')
    def label_on(self, x, y, name):
        self.key('l')
        self.click(x, y)
        self.p.keyboard.press('Control+A')
        self.p.keyboard.type(name)
        self.p.keyboard.press('Enter')
        self.p.wait_for_timeout(60)
        self.key('Escape')
    def power_on(self, x, y, ground=False):
        self.key('g' if ground else 'p')
        self.click(x, y)
        self.key('Escape')
    def nets(self):
        return self.ev(f'(() => {{ const n = ({NORM})(ed.toCircuit()); return n; }})()')
    def netset(self):
        return sorted(' '.join(n['nodes']) for n in self.nets())
    def orthogonal(self):
        return self.ev('() => ed.doc.wires.every(w => w[0] === w[2] || w[1] === w[3])')
    def errors(self):
        return [x['text'] for x in self.ev('() => ed.check()') if x['level'] == 'error']

def run():
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        page = b.new_page(viewport={'width': 1440, 'height': 900}, device_scale_factor=1)
        logs = []
        page.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        page.on('console', lambda m: logs.append(f'{m.type}: {m.text}') if m.type == 'error' and 'fonts.g' not in m.text and 'ERR_' not in m.text else None)
        page.goto(URL, wait_until='load')
        page.wait_for_timeout(500)
        e = Ed(page)

        # ------------------------------------------------ 1. LED + resistor + connector + power/ground, drawn by hand
        j1 = e.place('connector:', 10, 20, mirror=True)
        r1 = e.place('resistor:', 24, 20, rotate=1)
        d1 = e.place('led:', 32, 25, rotate=1)
        check('auto-numbered refs', (j1, r1, d1) == ('J1', 'R1', 'D1'), (j1, r1, d1))
        check('J1 mirrored so its pins face right', e.pin('J1', '1') == (14, 20), e.pin('J1', '1'))
        e.wire(('pin', 'J1', '1'), ('pin', 'R1', '1'))
        e.wire(('pin', 'R1', '2'), ('pin', 'D1', 'A'))
        # a wire started by clicking a pin in Select mode, bent with a corner and ended with a double click
        e.click_pin('J1', '2'); e.click(17, 24); e.click(17, 24)
        check('clicking a pin in Select mode draws a wire (L-shaped)', e.ev('() => ed.mode') == 'select' and e.ev('() => ed.doc.wires.length') >= 4, e.ev('() => ed.doc.wires'))
        e.power_on(17, 20)                     # +5V dropped on the middle of the J1-R1 wire
        e.power_on(17, 24, ground=True)        # GND on the end of the J1.2 wire
        e.power_on(*e.pin('D1', 'K'), ground=True)
        nets = e.nets()
        exp = sorted(['J1.1 R1.1', 'D1.A R1.2', 'D1.K J1.2'])
        check('LED circuit: toCircuit nets', e.netset() == exp, nets)
        named = {n['name']: n['nodes'] for n in nets}
        check('LED circuit: net names from power ports', named.get('+5V') == ['J1.1', 'R1.1'] and named.get('GND') == ['D1.K', 'J1.2'], named)
        c = e.ev('() => ed.toCircuit()')
        check('components carry DS2K fields', all(set(['ref', 'type', 'value', 'package', 'mpn', 'rating', 'tolerance', 'dnp']) <= set(x) for x in c['components'])
              and [x for x in c['components'] if x['ref'] == 'J1'][0]['pins'][1]['number'] == '2', c['components'])
        bld = e.ev("() => { const r = DS2K.build(ed.toCircuit(), 't', {}); return { ok: r.selfCheck.ok, self: r.selfCheck.errors, errors: r.errors, warnings: r.warnings }; }")
        check('LED circuit: DS2K.build selfCheck ok, no errors', bld['ok'] and not bld['errors'], bld)
        sim = e.ev("() => { const r = DS2K_SIM.run(ed.toCircuit(), { sources: [{ net: '+5V', kind: 'dc', value: 5 }], probes: ['+5V'] }, {}, {}); return { ok: r.ok, error: r.error, final: r.final }; }")
        check('LED circuit: DS2K_SIM.run ok', sim['ok'], sim)
        vled = [v for k, v in (sim.get('final') or {}).items() if k != 'P5V']
        check('LED circuit: unnamed net gets its own sim node; LED drop ~1.7 V', c['nets'][-1]['name'] == 'N1' and any(1.2 < v < 3.2 for v in vled), (sim.get('final'), c['nets']))
        blank = e.ev('() => ed.toCircuit({ blankUnnamed: true }).nets.filter(n => !n.name).length')
        check("toCircuit({blankUnnamed:true}) leaves unnamed nets as ''", blank == 1, blank)
        check('design check: no errors', not e.errors(), e.ev('() => ed.check()'))

        # ------------------------------------------------ T-junction
        tp = e.place('test_point:', 29, 14)
        e.wire(('pin', tp, '1'), (29, 20))
        check('T-junction: wire ending mid-wire joins the net', 'D1.A R1.2 TP1.1' in e.netset(), e.netset())
        check('T-junction: wire was split and a junction dot exists', e.ev("() => { const p = ed.geo.pts.get('29,20'); return !!p && p.ends.length === 3; }"))
        # clicking a wire highlights its net and shows the name
        e.click(30, 20)
        check('clicking a wire traces its net', e.ev("() => { const n = ed._conn().netOf(ed.netSel); return !!n && n.pins.length === 3; }") and 'pins' in page.inner_text('.se-status'), page.inner_text('.se-status'))
        # ------------------------------------------------ delete
        e.click(29, 11.4)                     # test point body (the circle sits above its pin)
        check('click selects the test point', e.ev('() => ed.sel.parts.size === 1 && ed.doc.parts.find(p => ed.sel.parts.has(p.id)).ref') == 'TP1')
        e.key('Delete')
        check('Delete removes the part', 'TP1' not in [x['ref'] for x in e.ev('() => ed.toCircuit()')['components']])
        dangling = [x for x in e.ev('() => ed.check()') if 'Dangling' in x['text']]
        check('check() reports the wire left dangling', len(dangling) == 1, e.ev('() => ed.check()'))
        e.click(29, 16); e.key('Backspace')
        check('Backspace deletes the selected wire; nothing dangles', not [x for x in e.ev('() => ed.check()') if 'Dangling' in x['text']] and e.netset() == exp, e.ev('() => ed.check()'))

        # ------------------------------------------------ rotate keeps connections
        before = e.netset()
        e.click(32, 25)
        e.key('r')
        check('R rotates the selected LED', e.ev("() => ed.doc.parts.find(p => p.ref === 'D1').rot") == 180)
        check('rotation keeps every connection (rubber-band)', e.netset() == before and e.orthogonal(), (e.netset(), e.ev('() => ed.doc.wires')))
        for k in range(3):
            e.key('r')
            check(f'rotation {k + 2}: connections kept, no shorts', e.netset() == before and e.orthogonal() and not e.errors(), (e.netset(), e.ev('() => ed.doc.wires'), e.errors()))
        # ------------------------------------------------ drag with rubber-banding
        x0, y0 = e.xy(24, 20)
        page.mouse.move(x0, y0); page.mouse.down()
        for i in range(1, 11):
            page.mouse.move(x0 + i * 2, y0 - i * 3.2); page.wait_for_timeout(16)
        tx, ty = e.xy(26, 15)
        page.mouse.move(tx, ty); page.mouse.up(); page.wait_for_timeout(80)
        rp = e.ev("() => { const p = ed.doc.parts.find(p => p.ref === 'R1'); return [p.x, p.y]; }")
        check('drag moves the part on the grid', rp == [26, 15], rp)
        check('drag keeps connections and wires stay orthogonal', e.netset() == exp and e.orthogonal(), (e.netset(), e.ev('() => ed.doc.wires')))
        check('drag leaves no dangling ends / errors', not e.errors() and not [x for x in e.ev('() => ed.check()') if 'Dangling' in x['text']], e.ev('() => ed.check()'))

        # ------------------------------------------------ undo / redo
        after_move = e.ev('() => JSON.stringify(ed.getDoc())')
        e.key('Control+z')
        check('Ctrl+Z undoes the move', e.ev("() => { const p = ed.doc.parts.find(p => p.ref === 'R1'); return [p.x, p.y]; }") == [24, 20])
        e.key('Control+Shift+Z')
        check('Ctrl+Shift+Z redoes it', e.ev('() => JSON.stringify(ed.getDoc())') == after_move)
        n_undo = e.ev('() => ed.undoStack.length')
        for _ in range(n_undo): e.key('Control+z')
        check('undo all the way back to an empty drawing', e.ev('() => ed.doc.parts.length + ed.doc.wires.length') == 0)
        for _ in range(n_undo): e.key('Control+y')
        check('Ctrl+Y redoes everything', e.ev('() => JSON.stringify(ed.getDoc())') == after_move)
        check('onChange fired (debounced) with the doc', page.wait_for_function('() => window.lastDoc && JSON.stringify(window.lastDoc) === JSON.stringify(ed.getDoc())', timeout=2000) is not None)

        # ------------------------------------------------ typing does not trigger shortcuts; double click focuses value
        page.dblclick(f'canvas', position=None) if False else None
        x, y = e.xy(26, 15); page.mouse.dblclick(x, y); page.wait_for_timeout(80)
        check('double-click a part focuses its value field', e.ev('() => document.activeElement && document.activeElement.dataset.f') == 'value')
        rot0 = e.ev("() => ed.doc.parts.find(p => p.ref === 'R1').rot")
        page.keyboard.press('Control+A'); page.keyboard.type('470r'); page.keyboard.press('Enter'); page.wait_for_timeout(80)
        check('typing "r" in a field does not rotate; value is set', e.ev("() => ed.doc.parts.find(p => p.ref === 'R1').rot") == rot0 and e.ev("() => ed.doc.parts.find(p => p.ref === 'R1').value") == '470r')
        page.screenshot(path=f'{SHOTS}/editor-led.png')

        # ------------------------------------------------ 2. 555 LED blinker from the NE555 template
        e.ev('() => ed.setDoc({ title: "555 LED blinker" })')
        u1 = e.place('ic:ne555', 0, 0)
        check('NE555 template placed as U1 with its pin table', u1 == 'U1' and e.ev("() => ed.doc.parts[0].pins.length") == 8 and e.pin('U1', '7') == (8, 0), e.pin('U1', '7'))
        vals = {}
        def part(key, x, y, value, rotate=0):
            ref = e.place(key, x, y, rotate)
            e.set_field('value', value); vals[ref] = value
            return ref
        part('resistor:', 16, -6, '1k'); part('resistor:', 16, 6, '10k'); part('capacitor:', -22, 8, '1uF'); part('capacitor:', -14, 7, '10nF')
        part('resistor:', 30, -10, '330', rotate=1); part('led:', 38, -5, 'Red', rotate=1)
        refs = e.ev('() => ed.doc.parts.map(p => p.ref).join(" ")')
        check('555: refs R1 R2 C1 C2 R3 D1', refs == 'U1 R1 R2 C1 C2 R3 D1', refs)
        e.wire(('pin', 'R1', '2'), ('pin', 'U1', '7'))
        e.wire(('pin', 'R2', '1'), (16, 0))
        e.wire(('pin', 'U1', '5'), ('pin', 'C2', '1'))
        e.wire(('pin', 'R3', '2'), ('pin', 'D1', 'A'))
        for ref, p in [('U1', '2'), ('U1', '6'), ('R2', '2'), ('C1', '1')]: e.label_on(*e.pin(ref, p), 'TRIG')
        e.label_on(*e.pin('U1', '3'), 'OUT'); e.label_on(*e.pin('R3', '1'), 'OUT')
        for ref, p in [('U1', '8'), ('U1', '4'), ('R1', '1')]: e.power_on(*e.pin(ref, p))
        for ref, p in [('U1', '1'), ('C1', '2'), ('C2', '2'), ('D1', 'K')]: e.power_on(*e.pin(ref, p), ground=True)
        e.key('Escape')
        got = {n['name'] if not n['name'].startswith('N$') else '': n['nodes'] for n in e.nets()}
        want = {'+5V': ['R1.1', 'U1.4', 'U1.8'], 'GND': ['C1.2', 'C2.2', 'D1.K', 'U1.1'], 'TRIG': ['C1.1', 'R2.2', 'U1.2', 'U1.6'],
                'OUT': ['R3.1', 'U1.3'], '': ['D1.A', 'R3.2']}
        dis = [n['nodes'] for n in e.nets() if 'U1.7' in n['nodes']]
        cv = [n['nodes'] for n in e.nets() if 'U1.5' in n['nodes']]
        check('555: named nets', all(got.get(k) == v for k, v in want.items() if k), got)
        check('555: DIS and CV nets', dis == [['R1.2', 'R2.1', 'U1.7']] and cv == [['C2.1', 'U1.5']], (dis, cv))
        check('555: design check clean (no errors or warnings)', not e.ev('() => ed.check()'), e.ev('() => ed.check()'))
        bld = e.ev("() => { const r = DS2K.build(ed.toCircuit(), 'blinker', {}); return { ok: r.selfCheck.ok, self: r.selfCheck.errors, errors: r.errors, warnings: r.warnings, files: Object.keys(r.files) }; }")
        check('555: DS2K.build selfCheck ok, no errors', bld['ok'] and not bld['errors'], bld)
        sim = e.ev("""() => { const r = DS2K_SIM.run(ed.toCircuit(), { sources: [{ net: '+5V', kind: 'dc', value: 5 }], chips: ed.simChips(), probes: ['OUT', 'TRIG'], tstop: 0.08 }, {}, {});
          if (!r.ok) return { ok: false, error: r.error };
          const out = r.traces[0].v, trig = r.traces[1].v;
          return { ok: true, chips: ed.simChips().length, outMax: Math.max(...out), outMin: Math.min(...out), trigMax: Math.max(...trig), trigMin: Math.min(...trig.slice(trig.length >> 1)) }; }""")
        check('555: DS2K_SIM.run ok', sim.get('ok'), sim)
        check('555: output oscillates (simulated with the template chip model)', sim.get('ok') and sim['outMax'] > 3 and sim['outMin'] < 0.5 and 1.3 < sim['trigMin'] < 2.2 and 3.0 < sim['trigMax'] < 3.7, sim)
        blinker_doc = e.ev('() => ed.getDoc()')
        json.dump(blinker_doc, open('/tmp/claude-0/shots/blinker-doc.json', 'w'))
        check('doc is compact JSON with integer grid coordinates', len(json.dumps(blinker_doc)) < 6000 and all(isinstance(v, int) for w in blinker_doc['wires'] for v in w), len(json.dumps(blinker_doc)))

        # select U1 so the inspector shows the pin table; screenshot light
        e.click(0, 0)
        page.mouse.move(*e.xy(-8, 0)); page.wait_for_timeout(120)
        e.ev('() => ed.fit()'); page.wait_for_timeout(120)
        page.mouse.move(*e.xy(-8, 0)); page.wait_for_timeout(120)
        page.screenshot(path=f'{SHOTS}/editor-light.png')

        # ------------------------------------------------ 3. fromCircuit(DS2K_EXAMPLE) round trip
        rt = e.ev(f"""() => {{ const norm = {NORM};
          const doc = Noeti.SchEditor.fromCircuit(DS2K_EXAMPLE); ed.setDoc(doc);
          const a = norm(DS2K_EXAMPLE).map(n => n.nodes.join(' ')).sort(), b = norm(ed.toCircuit()).map(n => n.nodes.join(' ')).sort();
          const names = norm(ed.toCircuit()).map(n => n.name);
          return {{ same: JSON.stringify(a) === JSON.stringify(b), a: a.length, b: b.length, parts: doc.parts.length, names, check: ed.check().length,
                    headless: JSON.stringify(norm(Noeti.SchEditor.docToCircuit(doc)).map(n => n.nodes.join(' ')).sort()) === JSON.stringify(a) }}; }}""")
        check('fromCircuit(DS2K_EXAMPLE) round-trips net membership', rt['same'] and rt['a'] == 10, rt)
        check('fromCircuit keeps net names (VIN, GND, VOUT, ...)', {'VIN', 'GND', 'VOUT', 'VSENSE', 'EN', 'SS', 'BOOT', 'PH', 'COMP'} <= set(rt['names']), rt['names'])
        check('static docToCircuit gives the same connectivity headless', rt['headless'])
        page.screenshot(path=f'{SHOTS}/editor-example.png')

        # ------------------------------------------------ 4. performance with ~150 parts
        perf = e.ev("""() => {
          const parts = [], nets = [];
          const types = ['resistor', 'capacitor', 'led', 'diode', 'bjt_npn', 'inductor'];
          for (let i = 0; i < 150; i++) parts.push({ ref: 'X' + i, type: types[i % types.length], value: '1k' });
          const comps = parts.map((p, i) => Object.assign(p, { ref: ({resistor:'R',capacitor:'C',led:'D',diode:'D',bjt_npn:'Q',inductor:'L'})[p.type] + (i + 1) }));
          for (let i = 0; i + 1 < comps.length; i++) { const a = comps[i], b = comps[i + 1]; const pa = a.type === 'led' || a.type === 'diode' ? 'K' : a.type === 'bjt_npn' ? 'C' : '2'; const pb = b.type === 'led' || b.type === 'diode' ? 'A' : b.type === 'bjt_npn' ? 'B' : '1'; nets.push({ name: i % 10 === 0 ? 'GND' : '', kind: i % 10 === 0 ? 'ground' : 'signal', nodes: [{ ref: a.ref, pin: pa }, { ref: b.ref, pin: pb }] }); }
          const t0 = performance.now(); const doc = Noeti.SchEditor.fromCircuit({ components: comps, nets }); const t1 = performance.now();
          ed.setDoc(doc); ed.fit();
          const t2 = performance.now(); for (let i = 0; i < 20; i++) ed._paint(); const t3 = performance.now();
          const id = ed.doc.parts[0].id; ed.sel = { parts: new Set([id]), power: new Set(), labels: new Set(), wires: new Set(), nc: new Set() };
          const d = { kind: 'press', w0: [0, 0], start: [0, 0], moved: 9 }; ed._beginMove(d);
          const t4 = performance.now(); for (let i = 1; i <= 20; i++) { ed.cursor = [i * 1.27, 0]; ed._updateMove(d); ed._paint(); } const t5 = performance.now();
          ed._cancelDrag();
          return { parts: ed.doc.parts.length, wires: ed.doc.wires.length, layoutMs: t1 - t0, paintMs: (t3 - t2) / 20, dragFrameMs: (t5 - t4) / 20 }; }""")
        check('150 parts: paint < 16 ms and drag frame < 40 ms', perf['parts'] == 150 and perf['paintMs'] < 16 and perf['dragFrameMs'] < 40, perf)
        print('   perf', perf)

        # ------------------------------------------------ 5. screenshots dark + mobile
        page.goto(URL + '?dark', wait_until='load'); page.wait_for_timeout(300)
        e.ev('(d) => ed.setDoc(d)', blinker_doc)
        e.click(12, 0)           # click a wire: traces the DIS net, inspector shows the net
        page.mouse.move(*e.xy(16, -3)); page.wait_for_timeout(150)
        check('dark: wire click traces the DIS net in the inspector', 'R1.2' in page.inner_text('.se-insp') and 'U1.7' in page.inner_text('.se-insp'), page.inner_text('.se-insp'))
        page.screenshot(path=f'{SHOTS}/editor-dark.png')
        e.ev("() => document.querySelector('[data-t=check]').click()"); page.wait_for_timeout(150)
        page.screenshot(path=f'{SHOTS}/editor-dark-check.png')

        mob = b.new_page(viewport={'width': 390, 'height': 844}, device_scale_factor=2, has_touch=True, is_mobile=True)
        mob.on('pageerror', lambda e_: logs.append(f'PAGEERROR (mobile): {e_}'))
        mob.goto(URL, wait_until='load'); mob.wait_for_timeout(300)
        mob.evaluate('(d) => { ed.setDoc(d); }', blinker_doc); mob.wait_for_timeout(200)
        m = Ed(mob)
        mob.tap('.se-pal-item[data-k="resistor:"]'); mob.wait_for_timeout(100)
        check('mobile: palette tap enters place mode with hint', mob.evaluate('() => ed.mode') == 'place' and mob.is_visible('.se-hint'))
        mob.touchscreen.tap(*m.xy(30, 6)); mob.wait_for_timeout(120)
        check('mobile: tap places a part', mob.evaluate('() => ed.doc.parts.length') == 8)
        mob.tap('.se-hint .btn'); mob.wait_for_timeout(100)
        mob.tap('.se-insp-head'); mob.wait_for_timeout(300)
        sw = mob.evaluate('() => [document.documentElement.scrollWidth, document.body.scrollWidth, innerWidth]')
        check('mobile: no horizontal page scroll', sw[0] <= sw[2] and sw[1] <= sw[2], sw)
        check('mobile: palette is a horizontal strip above the canvas', mob.evaluate("() => { const p = document.querySelector('.se-pal').getBoundingClientRect(), s = document.querySelector('.se-stage').getBoundingClientRect(); return p.bottom <= s.top + 1 && p.width > 300; }"))
        mob.screenshot(path=f'{SHOTS}/editor-mobile.png')
        mob.tap('.se-insp-head'); mob.wait_for_timeout(300)
        mob.screenshot(path=f'{SHOTS}/editor-mobile-closed.png')

        check('no page errors', not logs, logs)
        b.close()
    failed = [n for n, ok in results if not ok]
    print(f'\n{len(results) - len(failed)}/{len(results)} passed')
    return 1 if failed else 0

if __name__ == '__main__':
    sys.exit(run())
