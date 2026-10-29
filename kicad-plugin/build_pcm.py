#!/usr/bin/env python3
"""Build the "KiLive for KiCad" package for the Plugin and Content Manager.

    python3 kicad-plugin/build_pcm.py            -> dist/kilive-kicad-<version>.zip
    python3 kicad-plugin/build_pcm.py --dir out  -> also leaves the unpacked package in out/ (for tests)

Install: KiCad -> Plugin and Content Manager -> Install from File... -> the zip.
Layout: metadata.json, plugins/ (action plugin, local server, web/ = the app), resources/icon.png.
"""
import argparse, json, os, shutil, subprocess, sys, tempfile, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..'))
VERSION = '1.0.0'
IDENT = 'com.noeticompute.kilive'

META = {
    '$schema': 'https://go.kicad.org/pcm/schemas/v1',
    'name': 'KiLive',
    'description': 'PCB, schematic, 3D and live circuit simulation of the open board, in your browser, offline',
    'description_full': (
        'Adds a KiLive button to the PCB Editor. It opens the board as it is in the editor (unsaved edits included, '
        'KiCad 7+) together with its schematics in KiLive, served from this computer: cross-probed PCB, schematic '
        'and 3D views, BOM, design checks and a live transient simulation with probes, scope and supply-rail monitor. '
        'Microcontrollers (RP2040, AVR, ARM Cortex-M, RISC-V) run real firmware. Saving in KiCad or pressing the '
        'button again updates the open tab. Runs locally; nothing is uploaded.'),
    'identifier': IDENT,
    'type': 'plugin',
    'author': {'name': 'Roberts Treize', 'contact': {'web': 'https://github.com/streboreziert/kilive'}},
    'license': 'MIT',
    'resources': {'homepage': 'https://github.com/streboreziert/kilive'},
    'tags': ['simulation', 'viewer', 'bom', 'firmware'],
    'versions': [{'version': VERSION, 'status': 'stable', 'kicad_version': '7.0'}],
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dir', help='also write the unpacked package here')
    ap.add_argument('--out', default=os.path.join(ROOT, 'dist'))
    a = ap.parse_args()
    import re
    bad = [t for t in META['tags'] if not re.match(r'^[a-z][-a-z0-9]{0,48}[a-z0-9]$', t)]
    if bad: sys.exit('tags rejected by the KiCad PCM schema: %s' % bad)
    tmp = tempfile.mkdtemp(prefix='noeti-pcm-')
    try:
        pkg = os.path.join(tmp, 'pkg')
        plug = os.path.join(pkg, 'plugins')
        os.makedirs(os.path.join(pkg, 'resources'))
        subprocess.run([sys.executable, os.path.join(ROOT, 'scripts', 'build_site.py'), '--out', os.path.join(plug, 'web')], check=True, stdout=subprocess.DEVNULL)
        os.remove(os.path.join(plug, 'web', '.nojekyll'))
        for f in ('__init__.py', 'kilive.py', 'noeti_server.py', 'noeti.png', 'noeti_dark.png'):
            shutil.copy(os.path.join(HERE, 'boards', f), plug)
        shutil.copy(os.path.join(HERE, 'swig', 'noeti_common.py'), plug)
        shutil.copy(os.path.join(HERE, 'boards', 'icon64.png'), os.path.join(pkg, 'resources', 'icon.png'))
        with open(os.path.join(pkg, 'metadata.json'), 'w', encoding='utf-8') as h:
            json.dump(META, h, indent=2)
        os.makedirs(a.out, exist_ok=True)
        zpath = os.path.join(a.out, 'kilive-kicad-%s.zip' % VERSION)
        with zipfile.ZipFile(zpath, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
            for d, _, files in os.walk(pkg):
                for f in sorted(files):
                    full = os.path.join(d, f)
                    z.write(full, os.path.relpath(full, pkg).replace(os.sep, '/'))
        if a.dir:
            if os.path.isdir(a.dir): shutil.rmtree(a.dir)
            shutil.copytree(pkg, a.dir)
        print('wrote %s (%.1f MB)' % (zpath, os.path.getsize(zpath) / 1e6))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    main()
