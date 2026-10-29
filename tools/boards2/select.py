import json, os
SEL = """0xCB-dev/0xCB-Helios 21km43/CH32V203-DevBoard Breadstick-Innovations/22008-RP2040-Dev-Board Jana-Marie/OtterPill Michael-Manning/E-Paper-Climate-Logger
OLIMEX/ESP32-C3-DevKit-Lipo OLIMEX/ESP32-C6-DevKit-Lipo OLIMEX/ESP32-EVB OLIMEX/ESP32-P4-DevKit OLIMEX/ESP32-POE OLIMEX/Neo6502pc OLIMEX/RP2350pc OpenJBOD/rp2040 Wren6991/PicoDVI
and3rson/lilka bitaxeorg/bitaxeGamma codetiger/GameTiger-Console esp-rs/esp-rust-board hackclub/sprig haydenkz/rak4630-solar-pcb joeycastillo/Sensor-Watch joeycastillo/The-Open-Book
joshajohnson/sea-picro next-hack/TheGamepadDesignFiles piit79/Frood scottbez1/smartknob shilga/rp2040-gameboy-cartridge solderparty/rp2040_stamp_hw wntrblm/Hubble zhiayang/mikoto
ICE-V-Wireless/ICE-V-Wireless antmicro/kria-k26-devboard cheyao/icepi-zero gregdavill/ButterStick machdyne/bonbon machdyne/keks tinyvision-ai-inc/UPduino-v3.0 tinyvision-ai-inc/pico-ice tinyvision-ai-inc/pico2-ice
ElectronicCats/BomberCat ElectronicCats/CatSniffer ElectronicCats/faultycat antmicro/programmable-led-panel fossasia/pslab-hardware gusmanb/logicanalyzer hydrabus/hydrabus jankae/LibreVNA machdyne/werkzeug
0xCB-dev/0xCB-1337 GEIGEIGEIST/TOTEM beekeeb/piantor foostan/crkbd kata0510/Lily58 system76/launch josefadamcik/SofleKeyboard
ClemensElflein/xESC ClemensElflein/xESC2040 Duet3D/Duet3-Mini5plus Smoothieware/Smoothieboard2 Twisted-Fields/rp2040-motor-controller mjbots/moteus opulo-inc/lumenpnp sparkfun/SparkFun_XRP_Controller ukmars/ukmarsbot
RetiaLLC/DefconBadge2026 Somerset-Recon/bsides-badge-2024 badgeteam/mch2022-badge-hardware bornhack/badge2023 bornhack/badge2024 ranzbak/why2025-hardware thestumbler/vectorscope-kicad
greatscottgadgets/cynthion-hardware usbarmory/usbarmory jfedor2/hid-remapper ElectronicCats/CatWAN_USB_Stick FrameworkComputer/InputModules machdyne/blaustahl
emeb/RP2040_Audio polpo/picogus rheslip/2HPico-Eurorack-Module-Hardware wntrblm/Castor_and_Pollux wntrblm/Helium
LibreSolar/bms-c1 centydev/PicoPD theohg/PD240W
Polprzewodnikowy/SummerCart64 TinyTapeout/tt-demo-pcb antmicro/jetson-nano-baseboard oresat/oresat-c3-hardware rusefi/rusefi-hardware""".split()
res = {}
for l in open(os.path.join(os.path.dirname(__file__), 'import_results.jsonl')):
    r = json.loads(l); res[r['repo'].lower()] = r
OUT = '/home/claude/noeti/app/data'
idx = json.load(open(os.path.join(OUT, 'index.json')))
old = [r for r in idx if r['id'] in ('anyon-e', 'glasgow', 'hackrf', 'bus-pirate', 'rp2040-guide')]
ids = {r['id'] for r in old}
new = []
for s in SEL:
    r = res[s.lower()]
    rec = r['rec']
    if rec['id'] in ids: rec['id'] = (rec['owner'][:12] + '-' + rec['id']).lower()
    ids.add(rec['id'])
    new.append(rec)
keep = set()
for r in old + new:
    for b in r['boards']:
        for v in b['versions']:
            keep.add(os.path.basename(v['file']))
# the board files carry the repo id in their key; rename if the id changed
for r in new:
    for b in r['boards']:
        for v in b['versions']:
            f = os.path.basename(v['file'])
            key = f[:-5]
            want = f"{r['id']}__{b['id']}__{v['id']}"
            if key != want:
                d = json.load(open(os.path.join(OUT, f)))
                d['key'] = want
                json.dump(d, open(os.path.join(OUT, want + '.json'), 'w'), separators=(',', ':'), ensure_ascii=False)
                v['file'] = f'data/{want}.json'
                keep.add(want + '.json')
json.dump(old + new, open(os.path.join(OUT, 'index.json'), 'w'), separators=(',', ':'))
removed = 0
for f in os.listdir(OUT):
    if f.endswith('.json') and not f.endswith('.meta.json') and f != 'index.json' and f not in keep:
        os.rename(os.path.join(OUT, f), os.path.join('/home/claude/boards2_unused_' + f)) if False else os.remove(os.path.join(OUT, f)); removed += 1
    if f.endswith('.meta.json') and f[:-10] + '.json' not in keep:
        os.remove(os.path.join(OUT, f))
tot = sum(os.path.getsize(os.path.join(OUT, f)) for f in keep)
print('repos', len(old + new), 'boards', sum(len(r['boards']) for r in old + new), 'versions', len(keep), 'removed', removed, 'data MB', round(tot / 1e6, 1), 'index KB', os.path.getsize(os.path.join(OUT, 'index.json')) // 1000)
