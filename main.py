from flask import Flask, request, jsonify, send_file
import yt_dlp
import os
import tempfile
import re

app = Flask(__name__)

def sanitize(name):
    return re.sub(r'[^\w\s-]', '', name).strip()[:50]

@app.route('/')
def index():
    return open('index.html').read()

@app.route('/search')
def search():
    q = request.args.get('q', '')
    ydl_opts = {'quiet': True, 'extract_flat': True, 'default_search': 'ytsearch6'}
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(f"ytsearch6:{q}", download=False)
    results = []
    for e in info.get('entries', []):
        results.append({
            'id': e.get('id'),
            'title': e.get('title'),
            'duration': e.get('duration'),
            'thumbnail': f"https://i.ytimg.com/vi/{e.get('id')}/mqdefault.jpg"
        })
    return jsonify(results)

@app.route('/download')
def download():
    vid = request.args.get('id', '')
    fmt = request.args.get('fmt', 'mp3')
    if not vid:
        return jsonify({'error': 'missing id'}), 400

    tmpdir = tempfile.mkdtemp()
    url = f"https://www.youtube.com/watch?v={vid}"

    if fmt == 'mp3':
        ydl_opts = {
            'format': 'bestaudio/best',
            'outtmpl': f'{tmpdir}/%(title)s.%(ext)s',
            'postprocessors': [{'key': 'FFmpegExtractAudio', 'preferredcodec': 'mp3', 'preferredquality': '128'}],
            'quiet': True,
        }
    else:
        ydl_opts = {
            'format': 'best[filesize<20M]/best[height<=480]',
            'outtmpl': f'{tmpdir}/%(title)s.%(ext)s',
            'quiet': True,
        }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=True)
        title = sanitize(info.get('title', 'video'))

    files = os.listdir(tmpdir)
    if not files:
        return jsonify({'error': 'download failed'}), 500

    filepath = os.path.join(tmpdir, files[0])
    size = os.path.getsize(filepath)
    if size > 20 * 1024 * 1024:
        os.remove(filepath)
        return jsonify({'error': 'file too large (>20MB)'}), 400

    ext = files[0].split('.')[-1]
    return send_file(filepath, as_attachment=True, download_name=f"{title}.{ext}")

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8080))
    app.run(host='0.0.0.0', port=port)
