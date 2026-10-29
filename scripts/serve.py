#!/usr/bin/env python3
"""KiLive as a desktop app: a local web server for app/ with everything the published page gets from claude.ai
done locally instead - the library and the stars/comments live as JSON files under local-data/, downloads are real
downloads, and you are the one user.

    python3 scripts/serve.py            serve and open the app in a browser window
    python3 scripts/serve.py --no-open  serve only (prints the address)
    python3 scripts/serve.py --port 8800

No dependencies beyond Python 3.8+. The server stops on its own a minute and a half after the last app window closed.
"""
import argparse, json, mimetypes, os, re, shutil, socket, subprocess, sys, threading, time, urllib.parse, webbrowser
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..'))
APP = os.path.join(ROOT, 'app')
DATA = os.path.join(ROOT, 'local-data')
DB = os.path.join(DATA, 'db')
SKELETON = ('<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover">'
            '<style>:root{padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)}body{margin:0;font:14px system-ui;background:#fafaf7}'
            'img{max-width:100%}[hidden]{display:none!important}</style><link rel="icon" href="/_local/icon.png"></head><body>')
SAFE = re.compile(r'^[A-Za-z0-9_~.\-]+$')
mimetypes.add_type('text/javascript', '.mjs')
mimetypes.add_type('image/webp', '.webp')
mimetypes.add_type('application/json', '.json')

state = {'rev': 0, 'last_ping': None, 'started': time.time()}
lock = threading.Lock()


# ---------------------------------------------------------------- the document store (one JSON file per document)
def doc_file(path):
    parts = path.strip('/').split('/')
    if len(parts) < 2 or len(parts) % 2 or not all(SAFE.match(p) for p in parts):
        raise ValueError('bad document path ' + path)
    return os.path.join(DB, *parts) + '.json'


def col_dir(col):
    parts = col.strip('/').split('/')
    if not parts or len(parts) % 2 == 0 or not all(SAFE.match(p) for p in parts):
        raise ValueError('bad collection path ' + col)
    return os.path.join(DB, *parts)


def db_get(path):
    f = doc_file(path)
    if not os.path.isfile(f):
        return None
    with open(f, encoding='utf-8') as h:
        return json.load(h)


def db_set(path, data, merge=False):
    f = doc_file(path)
    os.makedirs(os.path.dirname(f), exist_ok=True)
    if merge:
        cur = db_get(path)
        if cur is None:
            raise FileNotFoundError(path)
        cur.update(data)
        data = cur
    tmp = f + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as h:
        json.dump(data, h)
    os.replace(tmp, f)
    with lock:
        state['rev'] += 1


def db_delete(path):
    f = doc_file(path)
    if os.path.isfile(f):
        os.remove(f)
        with lock:
            state['rev'] += 1


def db_list(col):
    d = col_dir(col)
    out = []
    if os.path.isdir(d):
        for name in sorted(os.listdir(d)):
            if name.endswith('.json'):
                with open(os.path.join(d, name), encoding='utf-8') as h:
                    try:
                        out.append({'id': name[:-5], 'data': json.load(h)})
                    except ValueError:
                        pass
    return out


def profile():
    f = os.path.join(DATA, 'profile.json')
    if os.path.isfile(f):
        try:
            with open(f, encoding='utf-8') as h:
                return json.load(h)
        except ValueError:
            pass
    name = os.environ.get('USER') or os.environ.get('USERNAME') or 'You'
    return {'id': 'local', 'name': name.replace('.', ' ').title() if name.islower() else name}


# ---------------------------------------------------------------- the server
class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=APP, **k)

    def log_message(self, fmt, *args):
        if os.environ.get('NOETI_VERBOSE'):
            super().log_message(fmt, *args)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def send_json(self, obj, code=200):
        body = json.dumps(obj).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_bytes(self, body, ctype, code=200):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        n = int(self.headers.get('Content-Length') or 0)
        return json.loads(self.rfile.read(n).decode('utf-8') or '{}')

    def do_GET(self):
        u = urllib.parse.urlsplit(self.path)
        q = urllib.parse.parse_qs(u.query)
        p = u.path
        try:
            if p in ('/', '/app', '/app/', '/desktop.html'):
                with open(os.path.join(APP, 'index.html'), encoding='utf-8') as h:
                    page = h.read()
                body = SKELETON + '<script src="/_local/runtime.js"></script>' + page + '</body></html>'
                return self.send_bytes(body.encode('utf-8'), 'text/html; charset=utf-8')
            if p == '/_local/runtime.js':
                with open(os.path.join(HERE, 'local-runtime.js'), 'rb') as h:
                    return self.send_bytes(h.read(), 'text/javascript')
            if p == '/_local/icon.png':
                f = os.path.join(HERE, 'app-icon.png')
                if os.path.isfile(f):
                    with open(f, 'rb') as h:
                        return self.send_bytes(h.read(), 'image/png')
                return self.send_json({'error': 'no icon'}, 404)
            if p == '/_local/ping':
                with lock:
                    state['last_ping'] = time.time()
                return self.send_json({'ok': True, 'app': 'kilive', 'rev': state['rev']})
            if p == '/_local/profile':
                return self.send_json(profile())
            if p == '/_db/rev':
                return self.send_json({'rev': state['rev']})
            if p == '/_db/get':
                data = db_get(q['path'][0])
                return self.send_json({'exists': data is not None, 'data': data})
            if p == '/_db/list':
                return self.send_json({'docs': db_list(q['col'][0])})
        except (ValueError, KeyError) as e:
            return self.send_json({'error': str(e)}, 400)
        return super().do_GET()

    def do_POST(self):
        u = urllib.parse.urlsplit(self.path)
        p = u.path
        try:
            if p == '/_local/ping':
                with lock:
                    state['last_ping'] = time.time()
                return self.send_json({'ok': True})
            body = self.read_json()
            if p == '/_db/set':
                db_set(body['path'], body.get('data') or {}, merge=bool(body.get('merge')))
                return self.send_json({'ok': True, 'rev': state['rev']})
            if p == '/_db/delete':
                db_delete(body['path'])
                return self.send_json({'ok': True, 'rev': state['rev']})
            if p == '/_local/profile':
                os.makedirs(DATA, exist_ok=True)
                with open(os.path.join(DATA, 'profile.json'), 'w', encoding='utf-8') as h:
                    json.dump({'id': 'local', 'name': str(body.get('name') or 'You')[:60]}, h)
                return self.send_json({'ok': True})
        except FileNotFoundError as e:
            return self.send_json({'error': 'not found', 'path': str(e)}, 404)
        except (ValueError, KeyError) as e:
            return self.send_json({'error': str(e)}, 400)
        return self.send_json({'error': 'unknown'}, 404)


def free_port(start):
    for port in range(start, start + 50):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            if s.connect_ex(('127.0.0.1', port)) != 0:
                return port
    raise SystemExit('no free port')


def already_running(port):
    try:
        import urllib.request
        with urllib.request.urlopen('http://127.0.0.1:%d/_local/ping' % port, timeout=1) as r:
            return json.load(r).get('app') == 'kilive'
    except Exception:
        return False


def open_window(url):
    """A window of its own in Chrome / Edge / Brave / Chromium (app mode), else the default browser."""
    if sys.platform == 'darwin':
        for name in ('Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Chromium', 'Arc'):
            if os.path.isdir('/Applications/%s.app' % name) or os.path.isdir(os.path.expanduser('~/Applications/%s.app' % name)):
                subprocess.Popen(['open', '-na', name, '--args', '--app=' + url, '--window-size=1440,900', '--user-data-dir=' + os.path.join(DATA, 'browser')])
                return name
        subprocess.Popen(['open', url])
        return 'browser'
    if sys.platform.startswith('win'):
        for exe in (r'C:\Program Files\Google\Chrome\Application\chrome.exe', r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
                    r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'):
            if os.path.isfile(exe):
                subprocess.Popen([exe, '--app=' + url, '--window-size=1440,900', '--user-data-dir=' + os.path.join(DATA, 'browser')])
                return exe
    else:
        for exe in ('google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser'):
            if shutil.which(exe):
                subprocess.Popen([exe, '--app=' + url, '--window-size=1440,900', '--user-data-dir=' + os.path.join(DATA, 'browser')])
                return exe
    webbrowser.open(url)
    return 'browser'


def watchdog(server, idle):
    while True:
        time.sleep(10)
        with lock:
            last = state['last_ping']
        if last is None and time.time() - state['started'] > 600:
            break   # nobody ever opened it
        if last is not None and time.time() - last > idle:
            break
    server.shutdown()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--port', type=int, default=8765)
    ap.add_argument('--no-open', action='store_true', help='do not open a browser window')
    ap.add_argument('--keep', action='store_true', help='keep serving after the last window closes')
    a = ap.parse_args()
    os.makedirs(DB, exist_ok=True)
    if already_running(a.port):
        url = 'http://127.0.0.1:%d/' % a.port
        if not a.no_open:
            open_window(url)
        print('KiLive is already running at', url)
        return
    port = free_port(a.port)
    url = 'http://127.0.0.1:%d/' % port
    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    server.daemon_threads = True
    print('KiLive at', url, '- boards you save go to', DATA)
    if not a.no_open:
        threading.Thread(target=lambda: (time.sleep(0.4), open_window(url)), daemon=True).start()
    if not a.keep:
        threading.Thread(target=watchdog, args=(server, 90), daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
