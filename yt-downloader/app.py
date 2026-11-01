"""YouTube downloader: video, MP3 and whole playlists, with a Hebrew UI.

Runs on the user's own computer (home IP addresses are blocked by YouTube far
less than servers). The download engine is the official standalone yt-dlp
binary, kept in the user's app-data folder together with deno (the JavaScript
runtime YouTube now requires) and ffmpeg. All three are fetched on first run,
so the packaged EXE needs nothing installed. The update button swaps in the
newest nightly yt-dlp, which is where fixes for YouTube changes land first.

    python app.py              open the app (native window if pywebview is installed)
    python app.py --browser    serve the UI and open it in the default browser
    python app.py --selftest   start, check the UI is served, exit (used by CI)
"""

import json
import os
import queue
import re
import shutil
import subprocess
import sys
import tarfile
import threading
import time
import urllib.request
import uuid
import webbrowser
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

APP_NAME = "מוריד יוטיוב"
FROZEN = getattr(sys, "frozen", False)
RES = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
IS_WIN = os.name == "nt"
IS_MAC = sys.platform == "darwin"


def app_home():
    if os.environ.get("YTD_HOME"):
        return Path(os.environ["YTD_HOME"])
    if IS_WIN:
        return Path(os.environ.get("LOCALAPPDATA", Path.home())) / "YTDownloader"
    if IS_MAC:
        return Path.home() / "Library" / "Application Support" / "YTDownloader"
    return Path.home() / ".local" / "share" / "yt-downloader"


HOME = app_home()
TOOLS = HOME / "tools"
SETTINGS_FILE = HOME / "settings.json"

NIGHTLY = "https://github.com/yt-dlp/yt-dlp-nightly-builds/releases"
if IS_WIN:
    YTDLP_ASSET, YTDLP_BIN = "yt-dlp.exe", "yt-dlp.exe"
    DENO_ZIP, DENO_BIN = "deno-x86_64-pc-windows-msvc.zip", "deno.exe"
    FFMPEG_PKG = "ffmpeg-master-latest-win64-gpl.zip"
elif IS_MAC:
    YTDLP_ASSET, YTDLP_BIN = "yt-dlp_macos", "yt-dlp"
    DENO_ZIP, DENO_BIN = "deno-aarch64-apple-darwin.zip", "deno"
    FFMPEG_PKG = None  # use Homebrew's ffmpeg
else:
    YTDLP_ASSET, YTDLP_BIN = "yt-dlp_linux", "yt-dlp"
    DENO_ZIP, DENO_BIN = "deno-x86_64-unknown-linux-gnu.zip", "deno"
    FFMPEG_PKG = "ffmpeg-master-latest-linux64-gpl.tar.xz"
YTDLP_URL = f"{NIGHTLY}/latest/download/{YTDLP_ASSET}"
DENO_URL = f"https://github.com/denoland/deno/releases/latest/download/{DENO_ZIP}"
FFMPEG_URL = (f"https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/{FFMPEG_PKG}"
              if FFMPEG_PKG else None)

# Errors that usually mean YouTube changed something and yt-dlp must be updated.
BREAKAGE = re.compile(
    r"HTTP Error 403|Sign in to confirm|nsig|signature|Precondition check failed|"
    r"Requested format is not available|Unable to extract|confirm you.re not a bot|"
    r"n challenge|JavaScript runtime|player response", re.I)

DEFAULT_SETTINGS = {
    "out_dir": str(Path.home() / "Downloads" / "YouTube"),
    "cookies_browser": "",      # "", "firefox", "edge", "chrome", "brave"
    "auto_update": True,        # update once a day and when a download breaks
    "last_update": 0,
    "ytdlp_version": None,
}

lock = threading.Lock()
WINDOW = None  # pywebview window, when running as a desktop app


# ---------------------------------------------------------------- settings ---

def load_settings():
    s = dict(DEFAULT_SETTINGS)
    try:
        s.update(json.loads(SETTINGS_FILE.read_text(encoding="utf-8")))
    except (OSError, ValueError):
        pass
    return s


def save_settings():
    HOME.mkdir(parents=True, exist_ok=True)
    SETTINGS_FILE.write_text(json.dumps(settings, ensure_ascii=False, indent=2), encoding="utf-8")


settings = load_settings()


# ------------------------------------------------------------------ tools ---

def no_window():
    return {"creationflags": subprocess.CREATE_NO_WINDOW} if IS_WIN else {}


def ytdlp_path():
    p = TOOLS / YTDLP_BIN
    return str(p) if p.exists() else None


def deno_path():
    p = TOOLS / DENO_BIN
    return str(p) if p.exists() else shutil.which("deno")


def ffmpeg_dir():
    if (TOOLS / ("ffmpeg.exe" if IS_WIN else "ffmpeg")).exists():
        return str(TOOLS)
    found = shutil.which("ffmpeg")
    return str(Path(found).parent) if found else None


def version_key(v):
    return tuple(int(x) for x in re.findall(r"\d+", v or ""))


def read_ytdlp_version():
    exe = ytdlp_path()
    if not exe:
        return None
    try:
        out = subprocess.run([exe, "--version"], capture_output=True, text=True,
                             timeout=120, **no_window())
        return out.stdout.strip() or None
    except Exception:
        return None


def latest_ytdlp():
    """Newest nightly tag, read from GitHub's /releases/latest redirect."""
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k):
            return None
    opener = urllib.request.build_opener(NoRedirect)
    try:
        opener.open(urllib.request.Request(f"{NIGHTLY}/latest", method="HEAD"), timeout=15)
    except urllib.error.HTTPError as e:
        m = re.search(r"/tag/([^/?#]+)", e.headers.get("Location") or "")
        if m:
            return m.group(1)
    with urllib.request.urlopen(
            "https://api.github.com/repos/yt-dlp/yt-dlp-nightly-builds/releases/latest",
            timeout=15) as r:
        return json.load(r)["tag_name"]


setup_state = {"running": False, "step": "", "percent": 0, "error": None}


def fetch(url, label):
    """Download url into memory-backed temp file with progress in setup_state."""
    with lock:
        setup_state.update(step=label, percent=0)
    tmp = TOOLS / (".dl-" + uuid.uuid4().hex)
    with urllib.request.urlopen(url, timeout=60) as r, open(tmp, "wb") as f:
        total = int(r.headers.get("Content-Length") or 0)
        got = 0
        while True:
            chunk = r.read(256 * 1024)
            if not chunk:
                break
            f.write(chunk)
            got += len(chunk)
            if total:
                with lock:
                    setup_state["percent"] = round(100 * got / total)
    return tmp


def install_file(tmp, dest):
    """Put a downloaded binary in place. On Windows a running exe cannot be
    replaced, so it is parked as <name>.new and swapped in before the next run."""
    if not IS_WIN:
        os.chmod(tmp, 0o755)
    try:
        os.replace(tmp, dest)
    except PermissionError:
        os.replace(tmp, str(dest) + ".new")


def swap_pending():
    for p in TOOLS.glob("*.new"):
        try:
            os.replace(p, p.with_suffix(""))
        except OSError:
            pass


def get_ytdlp():
    install_file(fetch(YTDLP_URL, "מנוע ההורדה (yt-dlp)"), TOOLS / YTDLP_BIN)


def get_deno():
    tmp = fetch(DENO_URL, "רכיב JavaScript (deno)")
    with zipfile.ZipFile(tmp) as z, open(TOOLS / (DENO_BIN + ".part"), "wb") as out:
        out.write(z.read(DENO_BIN))
    tmp.unlink()
    install_file(TOOLS / (DENO_BIN + ".part"), TOOLS / DENO_BIN)


def get_ffmpeg():
    tmp = fetch(FFMPEG_URL, "ffmpeg (המרה ל-MP3 ואיחוד וידאו)")
    wanted = {"ffmpeg", "ffprobe", "ffmpeg.exe", "ffprobe.exe"}
    if FFMPEG_PKG.endswith(".zip"):
        with zipfile.ZipFile(tmp) as z:
            for name in z.namelist():
                if "/bin/" in name and Path(name).name in wanted:
                    (TOOLS / (Path(name).name + ".part")).write_bytes(z.read(name))
                    install_file(TOOLS / (Path(name).name + ".part"), TOOLS / Path(name).name)
    else:
        with tarfile.open(tmp) as t:
            for m in t.getmembers():
                if "/bin/" in m.name and Path(m.name).name in wanted:
                    data = t.extractfile(m).read()
                    (TOOLS / (Path(m.name).name + ".part")).write_bytes(data)
                    install_file(TOOLS / (Path(m.name).name + ".part"), TOOLS / Path(m.name).name)
    tmp.unlink()


def ensure_tools():
    """First run: fetch whatever is missing. Safe to call again after a failure."""
    with lock:
        if setup_state["running"]:
            return
        setup_state.update(running=True, error=None)
    try:
        TOOLS.mkdir(parents=True, exist_ok=True)
        swap_pending()
        if not ytdlp_path():
            get_ytdlp()
            settings["last_update"] = time.time()
        if not deno_path():
            get_deno()
        if not ffmpeg_dir() and FFMPEG_URL:
            get_ffmpeg()
        settings["ytdlp_version"] = read_ytdlp_version()
        save_settings()
    except Exception as ex:
        with lock:
            setup_state["error"] = f"{setup_state['step']}: {ex}"
    finally:
        with lock:
            setup_state.update(running=False, step="", percent=0)


def tools_ready():
    return bool(ytdlp_path()) and bool(ffmpeg_dir())


# ---------------------------------------------------------------- updates ---

update_state = {"running": False, "latest": None, "message": "", "checked_at": 0}


def run_update(reason="ידני"):
    """Swap in the newest nightly yt-dlp (and refresh deno once a month)."""
    with lock:
        if update_state["running"] or setup_state["running"]:
            return False
        update_state.update(running=True, message="")
    ok = False
    try:
        before = settings.get("ytdlp_version") or read_ytdlp_version()
        try:
            latest = latest_ytdlp()
        except Exception:
            latest = None
        if latest and before and version_key(latest) <= version_key(before):
            msg = f"המנוע כבר מעודכן ({before})"
        else:
            get_ytdlp()
            after = read_ytdlp_version() or latest
            settings["ytdlp_version"] = after
            msg = f"עודכן לגרסה {after}" if after != before else f"המנוע כבר מעודכן ({after})"
        d = TOOLS / DENO_BIN
        if not deno_path() or (d.exists() and time.time() - d.stat().st_mtime > 30 * 86400):
            get_deno()
        settings["last_update"] = time.time()
        save_settings()
        ok = True
        with lock:
            update_state.update(latest=latest or settings["ytdlp_version"], message=msg)
        print(f"[update/{reason}] {msg}")
    except Exception as ex:
        with lock:
            update_state["message"] = f"העדכון נכשל: {ex}"
    finally:
        with lock:
            update_state["running"] = False
            setup_state.update(step="", percent=0)
    return ok


def check_latest():
    try:
        latest = latest_ytdlp()
    except Exception:
        return
    with lock:
        update_state.update(latest=latest, checked_at=time.time())


def startup():
    ensure_tools()
    if not settings.get("auto_update", True) or not ytdlp_path():
        return check_latest()
    check_latest()
    stale = time.time() - settings.get("last_update", 0) > 24 * 3600
    inst, latest = settings.get("ytdlp_version"), update_state["latest"]
    newer = latest and inst and version_key(latest) > version_key(inst)
    if stale or newer:
        run_update("אוטומטי")


# ------------------------------------------------------------------- jobs ---

jobs = {}
job_order = []
job_queue = queue.Queue()
SEP = "\t"


def is_playlist_url(url):
    return bool(re.search(r"[?&]list=", url)) or "/playlist" in url or \
        bool(re.search(r"youtube\.com/(@|c/|channel/|user/)", url))


def build_cmd(job):
    if job["playlist"]:
        tmpl = "%(playlist_title,playlist_id|playlist)s/%(playlist_index)03d - %(title)s.%(ext)s"
    else:
        tmpl = "%(title)s.%(ext)s"
    cmd = [ytdlp_path(), job["url"], "-P", job["out_dir"], "-o", tmpl,
           "--newline", "--no-colors", "--progress", "--no-simulate",
           "--ignore-errors", "--no-overwrites", "--continue", "--no-update",
           "--windows-filenames", "--trim-filenames", "160",
           "--retries", "10", "--fragment-retries", "10", "--extractor-retries", "3",
           "--embed-metadata",
           "--progress-template",
           f"download:[P]%(info.playlist_index)s{SEP}%(progress._percent_str)s{SEP}"
           f"%(progress._speed_str)s{SEP}%(progress._eta_str)s",
           "--print", f"before_dl:[T]%(playlist_index)s{SEP}%(n_entries)s{SEP}%(thumbnail)s{SEP}"
                      f"%(duration_string)s{SEP}%(playlist_title)s{SEP}%(title)s",
           "--print", f"after_move:[D]%(playlist_index)s{SEP}%(filepath)s"]
    cmd += ["--yes-playlist"] if job["playlist"] else ["--no-playlist"]
    if job["playlist"]:
        # A short pause between videos keeps long playlists from being throttled.
        cmd += ["--sleep-interval", "2", "--max-sleep-interval", "6"]
    if job["mode"] == "mp3":
        cmd += ["-f", "bestaudio/best", "-x", "--audio-format", "mp3",
                "--audio-quality", f"{job['quality']}K", "--embed-thumbnail"]
    else:
        sort = "vcodec:h264,acodec:m4a,ext:mp4:m4a"
        if job["quality"] != "best":
            sort = f"res:{job['quality']}," + sort
        cmd += ["-f", "bv*+ba/b", "-S", sort, "--merge-output-format", "mp4"]
    if ffmpeg_dir():
        cmd += ["--ffmpeg-location", ffmpeg_dir()]
    if deno_path():
        cmd += ["--js-runtimes", f"deno:{deno_path()}"]
    if settings.get("cookies_browser"):
        cmd += ["--cookies-from-browser", settings["cookies_browser"]]
    return cmd


def new_job(url, mode, quality, playlist):
    jid = uuid.uuid4().hex[:10]
    job = {"id": jid, "url": url, "mode": mode, "quality": quality, "playlist": playlist,
           "out_dir": settings["out_dir"], "status": "בתור", "state": "queued",
           "title": url, "thumb": None, "total": 0 if playlist else 1,
           "items": {}, "current": None, "errors": [], "log": [], "retried": False,
           "created": time.time(), "proc": None, "cancel": False}
    with lock:
        jobs[jid] = job
        job_order.insert(0, jid)
    job_queue.put(jid)
    return job


def item(job, idx):
    key = idx if idx not in ("NA", "None", "") else "1"
    return job["items"].setdefault(key, {"index": key, "title": "", "percent": 0, "thumb": None,
                                         "duration": "", "state": "downloading", "file": None})


def fields(line, n):
    return (line[3:].split(SEP, n - 1) + [""] * n)[:n]


def handle_line(job, line):
    if line.startswith("[T]"):
        idx, n, thumb, dur, pl_title, title = fields(line, 6)
        with lock:
            it = item(job, idx)
            it.update(title=title, state="downloading", percent=0,
                      thumb=None if thumb == "NA" else thumb, duration="" if dur == "NA" else dur)
            job["current"] = it["index"]
            if n.isdigit():
                job["total"] = int(n)
            if job["playlist"] and pl_title not in ("NA", ""):
                job["title"] = pl_title
            elif not job["playlist"]:
                job["title"] = title
            job["thumb"] = job["thumb"] or it["thumb"]
            job["status"] = "מוריד"
    elif line.startswith("[P]"):
        idx, pct, speed, eta = fields(line, 4)
        with lock:
            it = item(job, idx)
            try:
                it["percent"] = float(pct.strip().rstrip("%"))
            except ValueError:
                pass
            it["speed"], it["eta"] = speed.strip(), eta.strip()
            if job["status"] != "מוריד" and not job["status"].startswith("יוטיוב"):
                job["status"] = "מוריד"
    elif line.startswith("[D]"):
        idx, path = fields(line, 2)
        with lock:
            item(job, idx).update(state="done", percent=100, file=path)
    else:
        with lock:
            job["log"] = (job["log"] + [line])[-40:]
            if line.startswith("ERROR:"):
                job["errors"] = (job["errors"] + [line[6:].strip()])[-20:]
            if "[ExtractAudio]" in line:
                job["status"] = "ממיר ל-MP3"
            elif "[Merger]" in line:
                job["status"] = "מאחד וידאו ואודיו"
            elif job["state"] == "running" and job["status"] == "מתחיל":
                job["status"] = "טוען פרטים"


def run_job(job):
    swap_pending()
    Path(job["out_dir"]).mkdir(parents=True, exist_ok=True)
    with lock:
        job.update(state="running", status="מתחיל", errors=[])
    proc = subprocess.Popen(build_cmd(job), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, encoding="utf-8", errors="replace",
                            env=dict(os.environ, PYTHONIOENCODING="utf-8"), **no_window())
    job["proc"] = proc
    for raw in proc.stdout:
        line = raw.rstrip("\r\n")
        if line:
            handle_line(job, line)
    proc.wait()
    job["proc"] = None
    return proc.returncode


def finish(job, code):
    with lock:
        done = sum(1 for it in job["items"].values() if it["state"] == "done")
        if job["cancel"]:
            job.update(state="cancelled", status="בוטל")
        elif code == 0:
            job.update(state="done", status="הושלם")
        elif done > 0:
            job.update(state="partial", status=f"הושלם חלקית · {done} ירדו")
        else:
            job.update(state="error", status="נכשל")


def worker():
    while True:
        job = jobs.get(job_queue.get())
        if not job or job["cancel"]:
            continue
        try:
            while setup_state["running"] or update_state["running"]:
                with lock:
                    job["status"] = "ממתין לסיום ההכנה"
                time.sleep(1)
            if not ytdlp_path():
                raise RuntimeError("מנוע ההורדה לא מותקן - לחץ על 'עדכון'")
            code = run_job(job)
            broken = code != 0 and any(BREAKAGE.search(e) for e in job["errors"])
            if broken and not job["cancel"] and not job["retried"] and settings.get("auto_update", True):
                job["retried"] = True  # YouTube changed something: update, then try once more
                with lock:
                    job["status"] = "יוטיוב השתנה · מעדכן ומנסה שוב"
                run_update("אחרי תקלה")
                code = run_job(job)
            finish(job, code)
        except Exception as ex:
            with lock:
                job["errors"].append(str(ex))
                job.update(state="error", status="נכשל")


def public_job(job):
    items = sorted(job["items"].values(), key=lambda it: version_key(str(it["index"])) or (0,))
    cur = job["items"].get(job["current"]) if job["current"] else None
    keys = ("id", "url", "mode", "quality", "playlist", "status", "state", "title", "thumb",
            "total", "errors", "out_dir")
    return {k: job[k] for k in keys} | {
        "done": sum(1 for it in items if it["state"] == "done"),
        "current": cur, "items": items[-500:]}


# -------------------------------------------------------------------- web ---

def pick_folder(initial):
    if WINDOW is not None:
        import webview
        kind = getattr(getattr(webview, "FileDialog", None), "FOLDER", None) or webview.FOLDER_DIALOG
        res = WINDOW.create_file_dialog(kind, directory=initial)
        return res[0] if res else None
    try:
        import tkinter
        from tkinter import filedialog
        root = tkinter.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        p = filedialog.askdirectory(initialdir=initial, title="בחר תיקייה להורדות")
        root.destroy()
        return p or None
    except Exception:
        return None


def open_path(path):
    path = str(path)
    if IS_WIN:
        os.startfile(path)  # noqa
    else:
        subprocess.Popen(["open" if IS_MAC else "xdg-open", path])


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send_body(self, body, ctype, code=200):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, obj, code=200):
        self.send_body(json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                       "application/json; charset=utf-8", code)

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            self.send_body((RES / "static" / "index.html").read_bytes(), "text/html; charset=utf-8")
        elif self.path == "/icon.png":
            self.send_body((RES / "static" / "icon.png").read_bytes(), "image/png")
        elif self.path == "/api/state":
            with lock:
                data = {"jobs": [public_job(jobs[j]) for j in job_order[:40]],
                        "update": dict(update_state), "setup": dict(setup_state),
                        "version": settings.get("ytdlp_version"),
                        "settings": {k: settings[k] for k in ("out_dir", "cookies_browser", "auto_update")},
                        "ready": tools_ready(), "deno": bool(deno_path())}
            self.send_json(data)
        else:
            self.send_error(404)

    def do_POST(self):
        # Only the page served by this app may call the API.
        origin = self.headers.get("Origin")
        port = self.server.server_address[1]
        if origin and origin not in (f"http://127.0.0.1:{port}", f"http://localhost:{port}"):
            return self.send_json({"error": "forbidden"}, 403)
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        except ValueError:
            return self.send_json({"error": "bad json"}, 400)
        route = getattr(self, "api_" + self.path.strip("/").replace("api/", ""), None)
        if not route:
            return self.send_json({"error": "not found"}, 404)
        res = route(body)
        if isinstance(res, tuple):
            return self.send_json(*res)
        self.send_json(res or {"ok": True})

    def api_download(self, body):
        urls = [u.strip() for u in re.split(r"[\s,]+", body.get("urls", "")) if u.strip()]
        urls = [u for u in urls if re.match(r"^https?://", u)]
        if not urls:
            return {"error": "לא נמצא קישור תקין"}, 400
        mode = "mp3" if body.get("mode") == "mp3" else "video"
        quality = str(body.get("quality") or ("192" if mode == "mp3" else "1080"))
        allowed = {"mp3": {"128", "192", "320"},
                   "video": {"best", "2160", "1440", "1080", "720", "480", "360"}}[mode]
        if quality not in allowed:
            return {"error": "איכות לא חוקית"}, 400
        whole = body.get("playlist", True)
        return {"ok": True, "jobs": [new_job(u, mode, quality, whole and is_playlist_url(u))["id"]
                                     for u in urls]}

    def api_cancel(self, body):
        job = jobs.get(body.get("id"))
        if job:
            job["cancel"] = True
            if job.get("proc"):
                job["proc"].terminate()
            elif job["state"] == "queued":
                finish(job, 1)

    def api_retry(self, body):
        job = jobs.get(body.get("id"))
        if job and job["state"] in ("error", "partial", "cancelled"):
            job.update(cancel=False, retried=False, state="queued", status="בתור", errors=[])
            job_queue.put(job["id"])

    def api_clear(self, body):
        with lock:
            for jid in list(job_order):
                if jobs[jid]["state"] in ("done", "error", "partial", "cancelled"):
                    job_order.remove(jid)
                    jobs.pop(jid, None)

    def api_update(self, body):
        target = run_update if ytdlp_path() else ensure_tools
        threading.Thread(target=target, daemon=True).start()

    def api_setup(self, body):
        threading.Thread(target=ensure_tools, daemon=True).start()

    def api_settings(self, body):
        if body.get("cookies_browser") in ("", "firefox", "edge", "chrome", "brave"):
            settings["cookies_browser"] = body["cookies_browser"]
        if isinstance(body.get("auto_update"), bool):
            settings["auto_update"] = body["auto_update"]
        if body.get("pick_folder"):
            p = pick_folder(settings["out_dir"])
            if p:
                settings["out_dir"] = str(Path(p))
        save_settings()

    def api_open(self, body):
        job = jobs.get(body.get("id")) if body.get("id") else None
        target = Path(settings["out_dir"])
        if job:
            files = [it["file"] for it in job["items"].values() if it.get("file")]
            target = Path(files[0]).parent if files else Path(job["out_dir"])
        target.mkdir(parents=True, exist_ok=True)
        open_path(target)


def start_server():
    port = int(os.environ.get("YTD_PORT", "8770"))
    try:
        server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    except OSError:  # another copy is running: take any free port
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"


def shutdown():
    for job in jobs.values():
        if job.get("proc"):
            job["cancel"] = True
            job["proc"].terminate()


def main():
    server, url = start_server()
    if "--selftest" in sys.argv:
        with urllib.request.urlopen(url + "/") as r:
            assert "מוריד יוטיוב" in r.read().decode("utf-8")
        with urllib.request.urlopen(url + "/api/state") as r:
            json.load(r)
        print("selftest ok", url)
        return

    threading.Thread(target=worker, daemon=True).start()
    threading.Thread(target=startup, daemon=True).start()
    print(f"{APP_NAME}: {url}")

    if "--browser" not in sys.argv:
        try:
            import webview
            global WINDOW
            WINDOW = webview.create_window(APP_NAME, url, width=1120, height=860,
                                           min_size=(420, 600), background_color="#07070d")
            webview.start()
            shutdown()
            return
        except Exception as ex:  # no pywebview / no WebView2: fall back to the browser
            print("native window unavailable:", ex)

    webbrowser.open(url)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        shutdown()


if __name__ == "__main__":
    main()
