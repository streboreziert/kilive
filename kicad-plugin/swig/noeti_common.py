# Send to KiLive - shared helpers (no KiCad imports here, so both plugin flavours and the tests can use them)
#
# The payload is plain text, so it travels through the clipboard:
#   NOETI-KICAD/1 <base64 of gzip(JSON)>
# JSON: {"format": "noeti-kicad", "version": 1, "project": name, "sent": ISO time, "kicad": version,
#        "tool": "...", "unsaved": bool, "files": {"relative/path": "file text", ...}}
import base64
import datetime
import gzip
import json
import os
import re
import subprocess
import sys
import tempfile

MARK = "NOETI-KICAD/1 "
TOOL = "send-to-kilive 1.0"
SHEET_RX = re.compile(r'\(property\s+"Sheet\s?[Ff]ile"\s+"((?:[^"\\]|\\.)*)"')
MAX_BYTES = 80 * 1024 * 1024


def _read(path):
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        return f.read()


def schematic_tree(root_dir, root_sch):
    """The root schematic and every sheet it uses, as {relative path: text}."""
    out = {}
    todo = [root_sch]
    while todo and len(out) < 400:
        rel = todo.pop()
        rel = rel.replace("\\", "/")
        if rel in out:
            continue
        path = os.path.normpath(os.path.join(root_dir, rel))
        if not os.path.isfile(path):
            continue
        text = _read(path)
        out[rel] = text
        base = os.path.dirname(rel)
        for m in SHEET_RX.finditer(text):
            sub = m.group(1).replace('\\"', '"').replace("\\", "/")
            if not sub.lower().endswith(".kicad_sch"):
                continue
            # sheet paths are relative to the project folder in KiCad 6+, but older files sometimes hold them relative to the parent sheet
            cand = sub if os.path.isfile(os.path.join(root_dir, sub)) else (base + "/" + sub if base else sub)
            todo.append(os.path.normpath(cand).replace("\\", "/"))
    return out


def collect(board_path, pcb_text=None):
    """{project name, files} for the project the board belongs to."""
    root = os.path.dirname(os.path.abspath(board_path))
    stem = os.path.splitext(os.path.basename(board_path))[0]
    files = {}
    pro = os.path.join(root, stem + ".kicad_pro")
    if os.path.isfile(pro):
        files[stem + ".kicad_pro"] = _read(pro)
    if os.path.isfile(os.path.join(root, stem + ".kicad_sch")):
        files.update(schematic_tree(root, stem + ".kicad_sch"))
    else:
        # a board without a schematic of the same name: any top-level schematic in the folder
        for fn in sorted(os.listdir(root)):
            if fn.lower().endswith(".kicad_sch"):
                files.update(schematic_tree(root, fn))
    files[os.path.basename(board_path)] = pcb_text if pcb_text is not None else _read(board_path)
    return stem, files


def encode(project, files, kicad_version="", unsaved=False):
    total = sum(len(t) for t in files.values())
    if total > MAX_BYTES:
        raise ValueError("This project is %.0f MB of KiCad files - more than KiLive reads in a browser (80 MB)." % (total / 1e6))
    doc = {
        "format": "noeti-kicad", "version": 1, "project": project,
        "sent": datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat(),
        "kicad": str(kicad_version or ""), "tool": TOOL, "unsaved": bool(unsaved), "files": files,
    }
    raw = gzip.compress(json.dumps(doc, ensure_ascii=False).encode("utf-8"), 6)
    return MARK + base64.b64encode(raw).decode("ascii")


def decode(text):
    """For tests: the inverse of encode."""
    body = text.strip()[len(MARK.strip()):].strip()
    return json.loads(gzip.decompress(base64.b64decode(body)).decode("utf-8"))


def save_copy(project, payload):
    """The payload as a .noeti file in the temp folder (drag it onto KiLive if the clipboard is not an option)."""
    folder = os.path.join(tempfile.gettempdir(), "noeti")
    os.makedirs(folder, exist_ok=True)
    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", project) or "board"
    path = os.path.join(folder, safe + ".noeti")
    with open(path, "w", encoding="ascii") as f:
        f.write(payload)
    return path


def os_clipboard(text):
    """Copy without a GUI toolkit: clip / pbcopy / wl-copy / xclip / xsel."""
    data = text.encode("utf-8")
    if sys.platform.startswith("win"):
        cmds = [["clip"]]
    elif sys.platform == "darwin":
        cmds = [["pbcopy"]]
    else:
        cmds = [["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]]
    for cmd in cmds:
        try:
            p = subprocess.run(cmd, input=data, timeout=20, check=False)
            if p.returncode == 0:
                return True
        except Exception:
            continue
    return False


def size_text(n):
    return "%.1f MB" % (n / 1e6) if n >= 1e6 else "%d kB" % max(1, round(n / 1e3))
