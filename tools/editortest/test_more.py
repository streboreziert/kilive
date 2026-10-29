"""More interaction tests: box select, shift-click, pan/zoom, IC pin table editing, connector pin count, label ports,
no-connects, read-only mode, highlight API, check popover, onChange debounce. Uses the 555 blinker saved by test_editor.py."""
import json, sys
from playwright.sync_api import sync_playwright
sys.path.insert(0, __file__.rsplit('/', 1)[0])
from test_editor import Ed, check, results, URL, SHOTS

def run():
    doc = json.load(open('/tmp/claude-0/shots/blinker-doc.json'))
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        page = b.new_page(viewport={'width': 1440, 'height': 900})
        logs = []
        page.on('pageerror', lambda e: logs.append(str(e)))
        page.goto(URL, wait_until='load'); page.wait_for_timeout(300)
        e = Ed(page)
        e.ev('(d) => ed.setDoc(d)', doc)
        n_changes = e.ev('() => window.changes.length')
        check('setDoc does not emit onChange', n_changes == 0, n_changes)

        # box select (left-to-right = fully inside) around R1 and R2
        a, c = e.xy(12, -12), e.xy(22, 12)
        page.mouse.move(*a); page.mouse.down(); page.mouse.move((a[0] + c[0]) / 2, (a[1] + c[1]) / 2); page.mouse.move(*c); page.mouse.up(); page.wait_for_timeout(60)
        sel = e.ev('() => ed.doc.parts.filter(p => ed.sel.parts.has(p.id)).map(p => p.ref).sort().join(" ")')
        check('box select (window) picks R1 and R2 only', sel == 'R1 R2', sel)
        page.keyboard.down('Shift'); e.click(-22, 8); page.keyboard.up('Shift')
        sel = e.ev('() => ed.doc.parts.filter(p => ed.sel.parts.has(p.id)).map(p => p.ref).sort().join(" ")')
        check('shift-click adds C1 to the selection', sel == 'C1 R1 R2', sel)
        check('inspector shows the multi-selection', '3 selected' in page.inner_text('.se-insp') or 'selected' in page.inner_text('.se-insp'), page.inner_text('.se-insp')[:200])
        nets0 = e.netset()
        e.key('ArrowRight'); e.key('ArrowRight')
        check('arrow keys nudge the selection and keep nets', e.netset() == nets0 and e.orthogonal(), e.netset())
        e.key('Control+z')
        e.key('Escape')
        check('Esc clears the selection', e.ev('() => ed._selCount()') == 0)

        # right-to-left crossing box touches D1 only
        a, c = e.xy(40, -4), e.xy(37, -6)
        page.mouse.move(*a); page.mouse.down(); page.mouse.move(*c); page.mouse.up(); page.wait_for_timeout(60)
        sel = e.ev('() => ed.doc.parts.filter(p => ed.sel.parts.has(p.id)).map(p => p.ref).join(" ")')
        check('crossing box (right-to-left) selects what it touches', 'D1' in sel, sel)
        e.key('Escape')

        # pan: middle drag, space + drag; zoom around pointer
        v0 = e.ev('() => ({ ...ed.view })')
        x, y = e.xy(0, 20)
        page.mouse.move(x, y); page.mouse.down(button='middle'); page.mouse.move(x + 60, y + 30); page.mouse.up(button='middle')
        v1 = e.ev('() => ({ ...ed.view })')
        check('middle-button drag pans', abs(v1['ox'] - v0['ox'] - 60) < 1 and abs(v1['oy'] - v0['oy'] - 30) < 1, (v0, v1))
        page.keyboard.down(' '); page.mouse.move(x, y); page.mouse.down(); page.mouse.move(x - 60, y - 30); page.mouse.up(); page.keyboard.up(' ')
        v2 = e.ev('() => ({ ...ed.view })')
        check('space + drag pans', abs(v2['ox'] - v0['ox']) < 1 and abs(v2['oy'] - v0['oy']) < 1, (v0, v2))
        before = e.ev('([x, y]) => ed._world([x - ed.canvas.getBoundingClientRect().left, y - ed.canvas.getBoundingClientRect().top])', [x, y])
        page.mouse.move(x, y); page.mouse.wheel(0, -300); page.wait_for_timeout(60)
        after = e.ev('([x, y]) => ed._world([x - ed.canvas.getBoundingClientRect().left, y - ed.canvas.getBoundingClientRect().top])', [x, y])
        check('wheel zooms in around the pointer', e.ev('() => ed.view.s') > v2['s'] * 1.3 and abs(before[0] - after[0]) < 0.01 and abs(before[1] - after[1]) < 0.01, (before, after))
        e.key('f')

        # IC pin table: add a pin; wires on existing pins stay connected
        e.click(0, 0)
        page.click('.se-insp .se-pt-h .btn')
        page.wait_for_timeout(80)
        page.keyboard.type('NC1'); page.keyboard.press('Tab'); page.wait_for_timeout(80)
        pins = e.ev("() => ed.doc.parts.find(p => p.ref === 'U1').pins.map(p => p.number + ':' + p.name).join(' ')")
        check('Add pin appends pin 9 and the name is editable', pins.endswith('9:NC1'), pins)
        nets = e.netset()
        check('IC pin table edit keeps all existing connections', all(x in nets for x in ['R1.2 R2.1 U1.7', 'C1.1 R2.2 U1.2 U1.6', 'R1.1 U1.4 U1.8']), nets)
        warn = [x['text'] for x in e.ev('() => ed.check()')]
        check('new unconnected IC pin is reported by check()', any('U1: pin 9' in t for t in warn), warn)
        # mark it no-connect with the tool
        e.key('q'); e.click_pin('U1', '9'); e.key('Escape')
        check('No-connect tool marks the pin; check() is clean again', not e.ev('() => ed.check()') and e.ev("() => ed.toCircuit().no_connects.some(n => n.ref === 'U1' && n.pin === '9')"), e.ev('() => ed.check()'))
        page.select_option('.se-insp [data-f="pin-side-8"]', 'right'); page.wait_for_timeout(80)
        check('changing a pin side moves the pin and its no-connect marker', e.pin('U1', '9')[0] > 0 and e.ev("() => ed.doc.nc.length === 1 && ed.geo.pts.get(ed.doc.nc[0].join(',')).pins.length === 1"), e.pin('U1', '9'))

        # connector pin count; label port shape; power rename
        e.ev('() => ed.setDoc({})')
        j = e.place('connector:', 0, 0)
        e.set_field('n', '4')
        check('connector pin count updates pins and value', e.ev("() => { const p = ed.doc.parts[0]; return p.n === 4 && p.value === 'Conn_01x04' && ed.geo.parts.get(p.id).pins.length === 4; }"))
        e.label_on(*e.pin('J1', '1'), 'SDA')
        page.select_option('.se-insp [data-f="port"]', 'bidirectional'); page.wait_for_timeout(80)
        c = e.ev('() => ed.toCircuit()')
        check('label port direction flows into the net', any(n['name'] == 'SDA' and n['port'] == 'bidirectional' for n in c['nets']), c['nets'])
        e.power_on(*e.pin('J1', '2'))
        page.fill('.se-insp [data-f="name"]', '+3V3'); page.press('.se-insp [data-f="name"]', 'Enter'); page.wait_for_timeout(80)
        e.power_on(*e.pin('J1', '4'), ground=True)
        c = e.ev('() => ed.toCircuit()')
        kinds = {n['name']: n['kind'] for n in c['nets']}
        check('power ports: +3V3 is a power net, GND a ground net', kinds.get('+3V3') == 'power' and kinds.get('GND') == 'ground', kinds)
        e.power_on(*e.pin('J1', '3'))
        check('Power tool remembers the last supply name', e.ev("() => ed.doc.power.slice(-1)[0].name") == '+3V3')
        e.ev("() => ed.fit()")
        page.screenshot(path=f'{SHOTS}/editor-ports.png')

        # check popover with problems; clicking a row focuses it
        e.ev('(d) => ed.setDoc(d)', doc)
        e.click(38, -5); e.key('Delete')          # remove the LED: R3.2 now dangles
        page.click('[data-t="check"]'); page.wait_for_timeout(120)
        rows = page.locator('.se-chk-item').count()
        check('Check lists problems', rows >= 1 and page.is_visible('.se-chk'), rows)
        page.screenshot(path=f'{SHOTS}/editor-check.png')
        page.locator('.se-chk-item').first.click(); page.wait_for_timeout(80)
        check('clicking a problem selects the part involved', e.ev('() => ed._selCount()') >= 1)
        badge = page.inner_text('.se-badge')
        check('Check button shows a live problem count', badge.strip().isdigit() and int(badge) >= 1, badge)
        page.wait_for_timeout(400)
        check('onChange fired after the edit with a compact doc', e.ev('() => window.changes.length') >= 1 and 'wires' in e.ev('() => window.lastDoc'))

        # highlight API used by the app for probes / debug results
        ok = e.ev("() => ed.highlightNet('TRIG')")
        e.ev("() => ed.highlightRefs(['R2', 'C1'])")
        check('highlightNet / highlightRefs', ok and e.ev("() => ed.hl.refs.size") == 2 and not e.ev("() => ed.highlightNet('NOPE')"))
        e.ev("() => ed.highlightNet('TRIG')")
        page.screenshot(path=f'{SHOTS}/editor-highlight.png')
        e.ev("() => { ed.highlightNet(null); ed.highlightRefs([]); }")

        # read-only
        e.ev('() => ed.setReadOnly(true)')
        page.wait_for_timeout(100)
        n0 = e.ev('() => ed.doc.wires.length')
        e.click_pin('U1', '2'); e.click(-30, -2); e.key('Delete'); e.key('w')
        check('read-only: palette hidden, no wiring, no deleting', not page.is_visible('.se-pal') and e.ev('() => ed.doc.wires.length') == n0 and e.ev('() => ed.mode') == 'select')
        e.click(12, 0)
        check('read-only: clicking a wire still traces the net', e.ev('() => !!ed.netSel'))
        e.ev('() => ed.setReadOnly(false)')
        check('setReadOnly(false) restores editing', page.is_visible('.se-pal'))

        # right-click leaves place mode; synthetic two-finger pinch zooms and one-finger drag on empty canvas pans
        e.palette('resistor:'); e.p.mouse.move(*e.xy(0, -18)); e.p.mouse.click(*e.xy(0, -18), button='right'); page.wait_for_timeout(60)
        st = e.ev('() => [ed.mode, ed.doc.parts.length, [...ed._ptrs.keys()], ed.drag && ed.drag.kind]')
        check('right-click leaves place mode', st[0] == 'select' and st[1] == 6, st)
        pinch = e.ev('''() => {
          const cv = ed.canvas, r = cv.getBoundingClientRect(), cx = r.left + 300, cy = r.top + 300;
          const ev = (type, id, x, y) => cv.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', isPrimary: id === 11, clientX: x, clientY: y, button: 0, buttons: 1, bubbles: true }));
          const o0 = ed.view.ox, empty = [r.left + 20, r.top + r.height - 60];
          ev('pointerdown', 13, empty[0], empty[1]); ev('pointermove', 13, empty[0] + 50, empty[1]); ev('pointerup', 13, empty[0] + 50, empty[1]);
          const pan = ed.view.ox - o0, s0 = ed.view.s;
          ev('pointerdown', 11, cx - 40, cy); ev('pointerdown', 12, cx + 40, cy);
          for (let i = 1; i <= 5; i++) { ev('pointermove', 11, cx - 40 - i * 10, cy); ev('pointermove', 12, cx + 40 + i * 10, cy); }
          ev('pointerup', 11, cx - 90, cy); ev('pointerup', 12, cx + 90, cy);
          const s1 = ed.view.s, o1 = ed.view.ox;
          return { zoom: s1 / s0, pan, parts: ed.doc.parts.length };
        }''')
        check('touch: pinch zooms, one-finger drag on empty canvas pans', pinch['zoom'] > 1.8 and abs(pinch['pan'] - 50) < 1 and pinch['parts'] == 6, pinch)

        # destroy
        e.ev('() => { ed.destroy(); }')
        check('destroy() removes the editor', page.locator('.se').count() == 0)
        check('no page errors', not logs, logs)
        b.close()
    failed = [n for n, ok in results if not ok]
    print(f'\n{len(results) - len(failed)}/{len(results)} passed')
    return 1 if failed else 0

if __name__ == '__main__':
    sys.exit(run())
