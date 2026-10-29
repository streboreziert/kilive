# KiLive for KiCad - the local web server (no KiCad imports, so it can be tested on its own)
#
# Serves the bundled app from web/ on 127.0.0.1 and the open project at:
#   GET /_kicad/rev      {"rev": "...", "name": "..."}     cheap; the page polls it
#   GET /_kicad/project  {"rev", "name", "files": {relative path: text}}
# The project is either the snapshot the toolbar button pushed (board as in the editor, unsaved edits included)
# or, once any project file changes on disk after that, the files as saved.
import hashlib
import json
import mimetypes
import os
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

try:
    from . import noeti_common as nc
except ImportError:  # run as a plain module (tests, or straight from the repository)
    import sys as _sys
    _here = os.path.dirname(os.path.abspath(__file__))
    _sys.path[:0] = [_here, os.path.join(_here, "..", "swig")]
    import noeti_common as nc

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, "web")
PORTS = list(range(8771, 8791))
KICAD_EXT = (".kicad_pcb", ".kicad_sch", ".kicad_pro")
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("image/webp", ".webp")


class State:
    def __init__(self):
        self.lock = threading.Lock()
        self.board_path = ""
        self.name = ""
        self.files = None      # {relative path: text}
        self.push = 0          # incremented by every button press
        self.disk = ""         # disk signature when files were taken
        self.last_poll = 0.0


STATE = State()


def disk_signature(board_path):
    """mtime and size of every KiCad file in the project folder (three levels deep)."""
    root = os.path.dirname(os.path.abspath(board_path))
    h = hashlib.sha1()
    base_depth = root.rstrip(os.sep).count(os.sep)
    for d, dirs, files in os.walk(root):
        if d.count(os.sep) - base_depth >= 3:
            dirs[:] = []
        dirs[:] = sorted(x for x in dirs if not x.startswith(".") and not x.endswith("-backups") and x != "__pycache__")
        for f in sorted(files):
            if f.lower().endswith(KICAD_EXT):
                try:
                    st = os.stat(os.path.join(d, f))
                except OSError:
                    continue
                h.update(("%s|%d|%d;" % (os.path.join(d, f), st.st_mtime_ns, st.st_size)).encode())
    return h.hexdigest()[:16]


def set_project(board_path, name, files):
    """Called from the toolbar button (KiCad's main thread) with the board as it is in the editor."""
    with STATE.lock:
        STATE.board_path = board_path
        STATE.name = name
        STATE.files = files
        STATE.push += 1
        STATE.disk = disk_signature(board_path)


def current():
    """(rev, name, files); re-reads the project from disk when it changed there since the last snapshot."""
    with STATE.lock:
        if not STATE.board_path:
            return None
        sig = disk_signature(STATE.board_path)
        if sig != STATE.disk:
            try:
                name, files = nc.collect(STATE.board_path)
                STATE.name, STATE.files, STATE.disk = name, files, sig
            except Exception:
                pass
        return "%d-%s" % (STATE.push, STATE.disk), STATE.name, STATE.files


class Handler(SimpleHTTPRequestHandler):
    server_version = "KiLive"

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=WEB, **kw)

    def log_message(self, *a):
        pass

    def _host_ok(self):
        # only pages served from this machine by this address (guards the project endpoints against DNS rebinding)
        host = (self.headers.get("Host") or "").split(":")[0]
        return host in ("127.0.0.1", "localhost")

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        if not self.path.startswith("/_kicad/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_GET(self):
        if not self._host_ok():
            self.send_error(403)
            return
        path = self.path.split("?")[0]
        if path in ("/_kicad/rev", "/_kicad/project"):
            STATE.last_poll = time.time()
            cur = current()
            if not cur:
                self._json({"error": "no project yet: press KiLive in the PCB Editor"}, 404)
                return
            rev, name, files = cur
            if path == "/_kicad/rev":
                self._json({"rev": rev, "name": name})
            else:
                self._json({"rev": rev, "name": name, "files": files})
            return
        super().do_GET()


_server = None


def start():
    """Start the server once per KiCad session; returns its base URL."""
    global _server
    if _server is not None:
        return "http://127.0.0.1:%d/" % _server.server_address[1]
    last = None
    for port in PORTS:
        try:
            srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
            break
        except OSError as e:
            last = e
    else:
        raise RuntimeError("no free port in 8771-8790 (%s)" % last)
    srv.daemon_threads = True
    t = threading.Thread(target=srv.serve_forever, name="kilive-server", daemon=True)
    t.start()
    _server = srv
    return "http://127.0.0.1:%d/" % port


def page_open(within=4.0):
    """True when a KiLive tab polled recently, so it will pick up a new push by itself."""
    return time.time() - STATE.last_poll < within


if __name__ == "__main__":
    # stand-alone: python3 noeti_server.py path/to/board.kicad_pcb
    import sys
    import webbrowser
    bp = os.path.abspath(sys.argv[1])
    n, f = nc.collect(bp)
    set_project(bp, n, f)
    url = start() + "#kicad"
    print("KiLive at " + url)
    if "--no-open" not in sys.argv:
        webbrowser.open(url)
    while True:
        time.sleep(3600)
