"""YouTube downloader: video, MP3 and whole playlists, with a local Hebrew web UI.

Runs on the user's own computer (home IP addresses are blocked by YouTube far
less than servers). Downloads go through yt-dlp, run as a separate process each
time, so an update of yt-dlp takes effect on the next download without a restart.

    python app.py           start the UI on http://127.0.0.1:8770
    python app.py --setup   one-time setup: fetch ffmpeg on Windows if missing
"""

import json
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
import uuid
import webbrowser
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

BASE = Path(__file__).resolve().parent
STATIC = BASE / "static"
TOOLS = BASE / "tools"
DATA = BASE / "data"
SETTINGS_FILE = DATA / "settings.json"
PORT = int(os.environ.get("YTD_PORT", "8770"))
IS_WIN = os.name == "nt"
PY = sys.executable

# Packages kept up to date by the update button. --pre gives yt-dlp's nightly
# builds, which carry fixes for YouTube changes days before a stable release.
UPDATE_CMD = [PY, "-m", "pip", "install", "-U", "--pre", "--disable-pip-version-check",
              "yt-dlp[default]", "deno"]
FFMPEG_ZIP = ("https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/"
              "ffmpeg-master-latest-win64-gpl.zip")

# Messages that usually mean YouTube changed something and yt-dlp must be updated.
BREAKAGE = re.compile(
    r"HTTP Error 403|Sign in to confirm|nsig|signature|Precondition check failed|"
    r"Requested format is not available|Unable to extract|confirm you.re not a bot|"
    r"n challenge|JavaScript runtime|player response", re.I)

DEFAULT_SETTINGS = {
    "out_dir": str(Path.home() / "Downloads" / "YouTube"),
    "cookies_browser": "",      # "", "firefox", "edge", "chrome", "brave"
    "auto_update": True,        # update yt-dlp once a day and when a download breaks
    "last_update": 0,
}

lock = threading.Lock()


# ---------------------------------------------------------------- settings ---

def load_settings():
    s = dict(DEFAULT_SETTINGS)
    try:
        s.update(json.loads(SETTINGS_FILE.read_text(encoding="utf-8")))
    except (OSError, ValueError):
        pass
    return s


def save_settings(s):
    DATA.mkdir(parents=True, exist_ok=True)
    SETTINGS_FILE.write_text(json.dumps(s, ensure_ascii=False, indent=2), encoding="utf-8")


settings = load_settings()


# ------------------------------------------------------------------ tools ---

def no_window():
    return {"creationflags": subprocess.CREATE_NO_WINDOW} if IS_WIN else {}


def ffmpeg_dir():
    exe = "ffmpeg.exe" if IS_WIN else "ffmpeg"
    if (TOOLS / exe).exists():
        return str(TOOLS)
    found = shutil.which("ffmpeg")
    return str(Path(found).parent) if found else None


def deno_path():
    try:
        import deno  # installed by pip; ships the deno binary
        p = deno.find_deno_bin()
        if p and Path(p).exists():
            return str(p)
    except Exception:
        pass
    return shutil.which("deno")


def ytdlp_version():
    try:
        out = subprocess.run([PY, "-m", "yt_dlp", "--version"], capture_output=True,
                             text=True, timeout=60, **no_window())
        return out.stdout.strip() or None
    except Exception:
        return None


def version_key(v):
    return tuple(int(x) for x in re.findall(r"\d+", v or ""))


def latest_ytdlp():
    """Newest yt-dlp on PyPI, nightly builds included."""
    with urllib.request.urlopen("https://pypi.org/pypi/yt-dlp/json", timeout=15) as r:
        data = json.load(r)
    versions = [v for v, files in data.get("releases", {}).items() if files]
    return max(versions, key=version_key) if versions else data["info"]["version"]


def setup_ffmpeg(log=print):
    if ffmpeg_dir():
        log("ffmpeg: נמצא")
        return True
    if not IS_WIN:
        log("ffmpeg לא נמצא. התקן אותו (למשל: sudo apt install ffmpeg)")
        return False
    TOOLS.mkdir(parents=True, exist_ok=True)
    zpath = TOOLS / "ffmpeg.zip"
    log("מוריד ffmpeg (פעם אחת בלבד, כ-100MB)...")

    def hook(blocks, bs, total):
        if total > 0 and blocks % 200 == 0:
            log(f"  {min(100, blocks * bs * 100 // total)}%")
    urllib.request.urlretrieve(FFMPEG_ZIP, zpath, hook)
    with zipfile.ZipFile(zpath) as z:
        for name in z.namelist():
            if name.endswith(("/bin/ffmpeg.exe", "/bin/ffprobe.exe")):
                with z.open(name) as src, open(TOOLS / Path(name).name, "wb") as dst:
                    shutil.copyfileobj(src, dst)
    zpath.unlink(missing_ok=True)
    log("ffmpeg: הותקן")
    return bool(ffmpeg_dir())


# ---------------------------------------------------------------- updates ---

update_state = {"running": False, "installed": None, "latest": None,
                "message": "", "checked_at": 0}


def run_update(reason="ידני"):
    """pip-upgrade yt-dlp (nightly) and deno. Returns True if it finished OK."""
    with lock:
        if update_state["running"]:
            return False
        update_state.update(running=True, message="מעדכן את מנוע ההורדה...")
    ok = False
    try:
        before = ytdlp_version()
        out = subprocess.run(UPDATE_CMD, capture_output=True, text=True, timeout=600,
                             **no_window())
        after = ytdlp_version()
        ok = out.returncode == 0
        if not ok:
            msg = "העדכון נכשל: " + (out.stderr or out.stdout).strip().splitlines()[-1][:200]
        elif before != after:
            msg = f"עודכן לגרסה {after}"
        else:
            msg = f"כבר מעודכן ({after})"
        with lock:
            update_state.update(installed=after, message=msg)
            if ok:
                update_state["latest"] = after
                settings["last_update"] = time.time()
                save_settings(settings)
        print(f"[update/{reason}] {msg}")
    except Exception as ex:
        with lock:
            update_state["message"] = f"העדכון נכשל: {ex}"
    finally:
        with lock:
            update_state["running"] = False
    return ok


def check_versions():
    installed = ytdlp_version()
    try:
        latest = latest_ytdlp()
    except Exception:
        latest = None
    with lock:
        update_state.update(installed=installed, latest=latest or update_state["latest"],
                            checked_at=time.time())


def startup_update():
    check_versions()
    stale = time.time() - settings.get("last_update", 0) > 24 * 3600
    with lock:
        newer = (update_state["latest"] and update_state["installed"]
                 and version_key(update_state["latest"]) > version_key(update_state["installed"]))
    if settings.get("auto_update", True) and (stale or newer):
        run_update("אוטומטי")


# ------------------------------------------------------------------- jobs ---

jobs = {}           # id -> job dict
job_order = []      # newest first
job_queue = queue.Queue()


def is_playlist_url(url):
    return bool(re.search(r"[?&]list=", url)) or "/playlist" in url or \
        bool(re.search(r"youtube\.com/(@|c/|channel/|user/)", url))


def build_cmd(job):
    out_dir = job["out_dir"]
    if job["playlist"]:
        tmpl = "%(playlist_title,playlist_id|playlist)s/%(playlist_index)03d - %(title)s.%(ext)s"
    else:
        tmpl = "%(title)s.%(ext)s"
    cmd = [PY, "-m", "yt_dlp", job["url"],
           "-P", out_dir, "-o", tmpl,
           "--newline", "--no-colors", "--progress", "--no-simulate",
           "--ignore-errors", "--no-overwrites", "--continue",
           "--windows-filenames", "--trim-filenames", "160",
           "--retries", "10", "--fragment-retries", "10", "--extractor-retries", "3",
           "--embed-metadata",
           "--progress-template",
           "download:[P]%(info.playlist_index)s|%(progress._percent_str)s|"
           "%(progress._speed_str)s|%(progress._eta_str)s",
           "--print", "before_dl:[T]%(playlist_index)s|%(n_entries)s|%(playlist_title)s|%(title)s",
           "--print", "after_move:[D]%(playlist_index)s|%(filepath)s"]
    cmd += ["--yes-playlist"] if job["playlist"] else ["--no-playlist"]
    if job["playlist"]:
        # A short pause between videos keeps long playlists from being throttled.
        cmd += ["--sleep-interval", "2", "--max-sleep-interval", "6"]
    if job["mode"] == "mp3":
        cmd += ["-f", "bestaudio/best", "-x", "--audio-format", "mp3",
                "--audio-quality", f"{job['quality']}K", "--embed-thumbnail"]
    else:
        h = job["quality"]
        sort = "vcodec:h264,acodec:m4a,ext:mp4:m4a"
        if h != "best":
            sort = f"res:{h}," + sort
        cmd += ["-f", "bv*+ba/b", "-S", sort, "--merge-output-format", "mp4"]
    ff = ffmpeg_dir()
    if ff:
        cmd += ["--ffmpeg-location", ff]
    dn = deno_path()
    if dn:
        cmd += ["--js-runtimes", f"deno:{dn}"]
    if settings.get("cookies_browser"):
        cmd += ["--cookies-from-browser", settings["cookies_browser"]]
    return cmd


def new_job(url, mode, quality, playlist):
    jid = uuid.uuid4().hex[:10]
    job = {"id": jid, "url": url, "mode": mode, "quality": quality, "playlist": playlist,
           "out_dir": settings["out_dir"], "status": "ממתין", "state": "queued",
           "title": url, "playlist_title": None, "total": 0 if playlist else 1,
           "items": {}, "current": None, "errors": [], "log": [], "retried": False,
           "created": time.time(), "proc": None, "cancel": False}
    with lock:
        jobs[jid] = job
        job_order.insert(0, jid)
    job_queue.put(jid)
    return job


def item(job, idx):
    key = idx if idx not in ("NA", "None", "") else "1"
    return job["items"].setdefault(key, {"index": key, "title": "", "percent": 0,
                                         "state": "downloading", "file": None})


def handle_line(job, line):
    if line.startswith("[T]"):
        idx, n, pl_title, title = (line[3:].split("|", 3) + ["", "", "", ""])[:4]
        with lock:
            it = item(job, idx)
            it["title"] = title
            it["state"] = "downloading"
            job["current"] = it["index"]
            if n.isdigit():
                job["total"] = int(n)
            if job["playlist"] and pl_title not in ("NA", ""):
                job["playlist_title"] = pl_title
                job["title"] = pl_title
            elif not job["playlist"]:
                job["title"] = title
            job["status"] = "מוריד"
    elif line.startswith("[P]"):
        idx, pct, speed, eta = (line[3:].split("|", 3) + ["", "", "", ""])[:4]
        with lock:
            it = item(job, idx)
            try:
                it["percent"] = float(pct.strip().rstrip("%"))
            except ValueError:
                pass
            it["speed"] = speed.strip()
            it["eta"] = eta.strip()
    elif line.startswith("[D]"):
        idx, path = (line[3:].split("|", 1) + [""])[:2]
        with lock:
            it = item(job, idx)
            it.update(state="done", percent=100, file=path)
    else:
        with lock:
            job["log"] = (job["log"] + [line])[-40:]
            if line.startswith("ERROR:"):
                job["errors"] = (job["errors"] + [line[6:].strip()])[-20:]
            if "[ExtractAudio]" in line or "[Merger]" in line:
                job["status"] = "ממיר..." if "[ExtractAudio]" in line else "מאחד וידאו ואודיו..."
            elif "Downloading playlist" in line or "Downloading webpage" in line:
                if job["status"] == "ממתין" or job["status"].startswith("טוען"):
                    job["status"] = "טוען רשימה..."


def run_job(job):
    Path(job["out_dir"]).mkdir(parents=True, exist_ok=True)
    with lock:
        job.update(state="running", status="מתחיל...", errors=[])
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")
    proc = subprocess.Popen(build_cmd(job), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, encoding="utf-8", errors="replace", env=env,
                            **no_window())
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
        job["done"] = done
        if job["cancel"]:
            job.update(state="cancelled", status="בוטל")
        elif code == 0:
            job.update(state="done", status="הסתיים ✓")
        elif done > 0:
            job.update(state="partial", status=f"הסתיים עם שגיאות ({done} ירדו)")
        else:
            job.update(state="error", status="נכשל")


def worker():
    while True:
        jid = job_queue.get()
        job = jobs.get(jid)
        if not job or job["cancel"]:
            continue
        try:
            code = run_job(job)
            broken = code != 0 and any(BREAKAGE.search(e) for e in job["errors"])
            if broken and not job["cancel"] and not job["retried"] and settings.get("auto_update", True):
                # YouTube changed something: update yt-dlp and try once more.
                job["retried"] = True
                with lock:
                    job["status"] = "יוטיוב השתנה - מעדכן ומנסה שוב..."
                run_update("אחרי תקלה")
                code = run_job(job)
            finish(job, code)
        except Exception as ex:
            with lock:
                job["errors"].append(str(ex))
                job.update(state="error", status="נכשל")


def public_job(job):
    items = sorted(job["items"].values(), key=lambda it: version_key(str(it["index"])) or (0,))
    done = sum(1 for it in items if it["state"] == "done")
    cur = job["items"].get(job["current"]) if job["current"] else None
    return {k: job[k] for k in ("id", "url", "mode", "quality", "playlist", "status", "state",
                                "title", "playlist_title", "total", "errors", "out_dir")} | {
        "done": done, "current": cur, "items": items[-300:],
        "log": job["log"][-6:]}


# -------------------------------------------------------------------- web ---

def pick_folder(initial):
    code = ("import tkinter as t,tkinter.filedialog as f,sys;r=t.Tk();r.withdraw();"
            "r.attributes('-topmost',True);"
            "p=f.askdirectory(initialdir=sys.argv[1],title='בחר תיקייה להורדות');"
            "sys.stdout.write(p or '')")
    try:
        out = subprocess.run([PY, "-c", code, initial], capture_output=True, text=True,
                             encoding="utf-8", timeout=600)
        return out.stdout.strip() or None
    except Exception:
        return None


def open_folder(path):
    path = str(path)
    Path(path).mkdir(parents=True, exist_ok=True)
    if IS_WIN:
        os.startfile(path)  # noqa
    elif sys.platform == "darwin":
        subprocess.Popen(["open", path])
    else:
        subprocess.Popen(["xdg-open", path])


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send_json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            body = (STATIC / "index.html").read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif self.path == "/api/state":
            with lock:
                data = {"jobs": [public_job(jobs[j]) for j in job_order[:30]],
                        "update": dict(update_state),
                        "settings": {k: settings[k] for k in ("out_dir", "cookies_browser", "auto_update")},
                        "ffmpeg": bool(ffmpeg_dir()), "deno": bool(deno_path())}
            self.send_json(data)
        else:
            self.send_error(404)

    def do_POST(self):
        # Only the page served from this machine may call the API.
        origin = self.headers.get("Origin")
        if origin and not re.match(r"^http://(127\.0\.0\.1|localhost):%d$" % PORT, origin):
            return self.send_json({"error": "forbidden"}, 403)
        try:
            n = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(n) or b"{}")
        except ValueError:
            return self.send_json({"error": "bad json"}, 400)

        if self.path == "/api/download":
            urls = [u.strip() for u in re.split(r"[\s,]+", body.get("urls", "")) if u.strip()]
            urls = [u for u in urls if re.match(r"^https?://", u)]
            if not urls:
                return self.send_json({"error": "לא נמצא קישור תקין"}, 400)
            mode = "mp3" if body.get("mode") == "mp3" else "video"
            quality = str(body.get("quality") or ("192" if mode == "mp3" else "1080"))
            allowed = {"mp3": {"128", "192", "320"},
                       "video": {"best", "2160", "1440", "1080", "720", "480", "360"}}[mode]
            if quality not in allowed:
                return self.send_json({"error": "איכות לא חוקית"}, 400)
            whole = body.get("playlist", True)
            created = [new_job(u, mode, quality, whole and is_playlist_url(u))["id"] for u in urls]
            return self.send_json({"ok": True, "jobs": created})

        if self.path == "/api/cancel":
            job = jobs.get(body.get("id"))
            if job:
                job["cancel"] = True
                p = job.get("proc")
                if p:
                    p.terminate()
                elif job["state"] == "queued":
                    finish(job, 1)
            return self.send_json({"ok": True})

        if self.path == "/api/clear":
            with lock:
                for jid in list(job_order):
                    if jobs[jid]["state"] in ("done", "error", "partial", "cancelled"):
                        job_order.remove(jid)
                        jobs.pop(jid, None)
            return self.send_json({"ok": True})

        if self.path == "/api/update":
            threading.Thread(target=lambda: (run_update("ידני"), check_versions()),
                             daemon=True).start()
            return self.send_json({"ok": True})

        if self.path == "/api/check":
            check_versions()
            return self.send_json({"ok": True, "update": update_state})

        if self.path == "/api/settings":
            if body.get("cookies_browser") in ("", "firefox", "edge", "chrome", "brave"):
                settings["cookies_browser"] = body["cookies_browser"]
            if isinstance(body.get("auto_update"), bool):
                settings["auto_update"] = body["auto_update"]
            if body.get("pick_folder"):
                p = pick_folder(settings["out_dir"])
                if p:
                    settings["out_dir"] = str(Path(p))
            save_settings(settings)
            return self.send_json({"ok": True})

        if self.path == "/api/open":
            job = jobs.get(body.get("id")) if body.get("id") else None
            target = Path(settings["out_dir"])
            if job:
                files = [it["file"] for it in job["items"].values() if it.get("file")]
                target = Path(files[0]).parent if files else Path(job["out_dir"])
            open_folder(target)
            return self.send_json({"ok": True})

        self.send_json({"error": "not found"}, 404)


def main():
    if "--setup" in sys.argv:
        ok = setup_ffmpeg()
        sys.exit(0 if ok else 1)
    if "--update" in sys.argv:
        sys.exit(0 if run_update("שורת פקודה") else 1)

    threading.Thread(target=worker, daemon=True).start()
    threading.Thread(target=startup_update, daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    url = f"http://127.0.0.1:{PORT}"
    print(f"מוריד יוטיוב פועל: {url}   (לסגירה: סגור את החלון הזה)")
    if "--no-browser" not in sys.argv:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
