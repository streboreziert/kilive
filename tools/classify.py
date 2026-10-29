"""Guess a 3D body class, height and color for a footprint (for the stylized 3D view)."""
import re

IMP = {'0201': '0603', '0402': '1005', '0603': '1608', '0805': '2012', '1206': '3216', '1210': '3225', '2010': '5025', '2512': '6332'}
CHIP_H = {'0201': 0.3, '0402': 0.4, '0603': 0.5, '0805': 0.6, '1206': 0.65, '1210': 0.7, '2010': 0.7, '2512': 0.7}
CAP_H = {'0201': 0.3, '0402': 0.5, '0603': 0.8, '0805': 1.0, '1206': 1.2, '1210': 1.5, '2010': 1.5, '2512': 1.8}


def classify(fp):
    ref = fp.get('r', '')
    name = (fp.get('fp', '') + ' ' + (fp.get('m') or '')).lower()
    val = (fp.get('v') or '').lower()
    pre = re.match(r'[A-Za-z_#]*', ref).group(0).upper()
    b = fp.get('b') or [0, 0, 0, 0]
    w, h = abs(b[2] - b[0]), abs(b[3] - b[1])
    small = min(w, h) if w and h else 1

    def size_code():
        m = re.search(r'(?<!\d)(0201|0402|0603|0805|1206|1210|2010|2512)(?!\d)', name)
        return m.group(1) if m else None

    big = max(w, h) if w and h else 0
    if big > 30 and re.search(r'cm3588|cm4|cm5|compute.?module|som|core.?board', name + ' ' + val):
        return 'module', 2.9, '#1c3a52'
    if 'shield' in name or 'shield' in val or 'rf-can' in name:
        return 'frame', 2.2, '#c3c7cc'
    none_kw = ('mountinghole', 'mounting_hole', 'fiducial', 'logo', 'testpoint', 'test_point', 'tp_', 'nettie', 'net_tie',
               'solderjumper', 'solder_jumper', 'jumper_sm', 'hole', 'oshw', 'kibuzzard', 'symbol_', 'graphic', 'tag-connect',
               'tagconnect', 'tc2030', 'tc2050', 'pad_', 'mousebites', 'label', 'qr', 'jlc', 'version')
    if fp.get('bo') or any(k in name for k in none_kw) or pre in ('H', 'MH', 'FID', 'LOGO', 'TP', 'JP', 'NT', 'G', 'REF**', 'KB', 'MK'):
        if 'jumper' in name or pre == 'JP':
            return 'none', 0, None
        return 'none', 0, None
    sc = size_code()
    if pre in ('R', 'RN', 'RA') or name.startswith('r_') or ' r_' in name:
        if 'array' in name or pre in ('RN', 'RA'):
            return 'res', 0.5, '#1a1a1a'
        return 'res', CHIP_H.get(sc, 0.55), '#1c1c1e'
    if pre in ('C',) or name.startswith('c_') or 'cp_elec' in name or 'cp_radial' in name:
        m = re.search(r'cp_elec_(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)', name)
        if m:
            return 'elco', float(m.group(2)), '#b7bcc4'
        m = re.search(r'cp_radial_d(\d+(?:\.\d+)?)mm', name)
        if m:
            return 'elco', 11.0, '#1d2a4a'
        if 'tantal' in name or 'cp_' in name:
            return 'tant', 1.6, '#c6962c'
        return 'cap', CAP_H.get(sc, min(1.2, max(0.5, small * 0.6))), '#b88a5a'
    if pre in ('L', 'FB', 'FL'):
        if pre == 'FB' or 'ferrite' in name or 'bead' in name:
            return 'ind', CHIP_H.get(sc, 0.6), '#3a3a3c'
        return 'ind', min(4.5, max(0.8, small * 0.55)) if not sc else CAP_H.get(sc, 0.8), '#343436'
    if pre in ('LED', 'D') and ('led' in name or pre == 'LED'):
        return 'led', 0.55 if sc else 1.0, '#f2efe4'
    if pre in ('D', 'TVS', 'Z', 'ZD'):
        return 'diode', 0.9 if 'sod-323' in name or 'sod-523' in name or sc else 1.1, '#1b1b1d'
    if pre in ('Y', 'X', 'XTAL', 'OSC') or 'crystal' in name or 'oscillator' in name:
        if 'hc49' in name or 'hc-49' in name:
            return 'xtal', 3.5, '#c9ccd1'
        if 'mc306' in name or 'fc-135' in name or '2012' in name or '3215' in name:
            return 'xtal', 0.8, '#2b2b2d'
        return 'xtal', 0.9, '#c7cacf'
    if pre in ('SW', 'S', 'BTN', 'KEY') or 'button' in name or 'switch' in name or 'sw_' in name:
        if 'kailh' in name or 'mx' in name or 'choc' in name or 'hotswap' in name:
            return 'switch', 3.0, '#e8e3d6'
        if 'slide' in name or 'spdt' in name:
            return 'switch', 1.6, '#c9ccd1'
        return 'switch', min(3.5, max(1.0, small * 0.5)), '#2a2a2c'
    if pre in ('J', 'P', 'CN', 'CON', 'USB', 'X') or 'connector' in name or 'conn' in name or 'usb' in name or 'header' in name or 'socket' in name:
        if 'usb_c' in name or 'usb-c' in name or 'type-c' in name or 'typec' in name:
            return 'metal', 3.2, '#c3c7cc'
        if 'usb_a' in name or 'usb-a' in name:
            return 'metal', 7.0, '#c3c7cc'
        if 'micro' in name and 'usb' in name:
            return 'metal', 2.6, '#c3c7cc'
        if 'rj45' in name or 'ethernet' in name:
            return 'metal', 13.0, '#c3c7cc'
        if 'sma' in name and 'u.fl' not in name:
            return 'gold', 6.0, '#d4a64a'
        if ('u.fl' in name or 'ufl' in name or 'ipex' in name or 'mhf' in name) and big < 5:
            return 'gold', 1.2, '#d9b25c'
        if 'ipex' in name or '20455' in name or '20453' in name:
            return 'metal', 1.1, '#aeb3b9'
        if 'm.2' in name or 'm2_' in name or 'ngff' in name:
            return 'plastic', 4.2, '#1f1f22'
        if 'sodimm' in name or 'dimm' in name:
            return 'plastic', 5.2, '#1f1f22'
        if 'sd' in name and ('card' in name or 'micro' in name):
            return 'metal', 1.9, '#c3c7cc'
        if 'pinheader' in name or 'pin_header' in name or 'pinsocket' in name or 'pin_socket' in name:
            if 'socket' in name:
                return 'plastic', 8.5, '#1d1d20'
            return 'header', 2.5, '#1d1d20'
        if 'jst' in name or 'molex' in name or 'picoblade' in name or 'pico' in name or 'ph_' in name or 'sh_' in name or 'zh_' in name:
            return 'plastic', 4.0 if 'sh_' not in name else 2.9, '#efe7d4'
        if 'fpc' in name or 'ffc' in name or 'hirose_fh' in name or 'fh12' in name or 'fh19' in name:
            return 'plastic', 1.2, '#2a2a2c'
        if 'audio' in name or 'jack' in name or 'pj-' in name:
            return 'plastic', 5.0, '#1d1d20'
        if 'b2b' in name or 'board_to_board' in name or 'df40' in name or 'bm' in name:
            return 'plastic', 1.5, '#e6dcc3'
        if 'barrel' in name or 'dc_' in name:
            return 'plastic', 11.0, '#1d1d20'
        if 'terminal' in name:
            return 'plastic', 10.0, '#2f6f3f'
        return 'plastic', min(6.0, max(1.2, small * 0.5)), '#2a2a2c'
    if pre in ('BT', 'BAT') or 'battery' in name or 'cr2032' in name:
        return 'metal', 3.2, '#c3c7cc'
    if pre in ('F',) or 'fuse' in name or 'polyfuse' in name:
        return 'ind', CHIP_H.get(sc, 0.8), '#6b6f75'
    if pre in ('Q',) or 'sot' in name or 'to-252' in name or 'dpak' in name:
        if 'to-252' in name or 'dpak' in name or 'to-263' in name:
            return 'ic', 2.3, '#1b1b1d'
        return 'ic', 1.0, '#1b1b1d'
    if pre in ('BZ', 'LS', 'SP', 'BUZ') or 'buzzer' in name or 'speaker' in name:
        return 'plastic', 3.0, '#1d1d20'
    if pre in ('ANT', 'AE') or 'antenna' in name:
        return 'plastic', 0.8, '#e7e7e7'
    if 'shield' in name or pre in ('SH', 'SC'):
        return 'metal', 1.8, '#c3c7cc'
    if 'module' in name or 'esp32-' in name or 'wroom' in name or 'wrover' in name or 'som' in name or 'core' in name:
        return 'module', 3.0, '#23272e'
    if pre in ('U', 'IC', 'M', 'MOD', 'Z', 'VR', 'REG', 'A', 'PS', 'N') or re.search(r'qfn|qfp|bga|soic|ssop|tssop|msop|dfn|lga|wlcsp|csp|son|sop|qfp|plcc|lqfp|tqfp|vqfn|wson|uson|xson', name):
        if 'bga' in name or 'fbga' in name:
            return 'ic', 1.2, '#1b1b1d'
        if 'wlcsp' in name or 'csp' in name:
            return 'ic', 0.5, '#2a2c30'
        if 'qfp' in name or 'soic' in name or 'sop' in name and 'ssop' not in name and 'tssop' not in name:
            return 'ic', 1.5, '#1b1b1d'
        if 'tssop' in name or 'ssop' in name or 'msop' in name:
            return 'ic', 1.1, '#1b1b1d'
        if 'qfn' in name or 'dfn' in name or 'son' in name or 'lga' in name:
            return 'ic', 0.85, '#1b1b1d'
        return 'ic', 1.0, '#1b1b1d'
    if pre in ('T', 'TR'):
        return 'ind', 3.0, '#343436'
    if pre in ('K', 'RL', 'RLY'):
        return 'plastic', 10.0, '#1d1d20'
    if pre in ('RV', 'VR', 'POT'):
        return 'plastic', 4.0, '#1d1d20'
    if pre in ('MIC',):
        return 'metal', 1.1, '#c3c7cc'
    return 'ic', min(2.0, max(0.6, small * 0.3)), '#232326'
