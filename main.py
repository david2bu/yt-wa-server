from flask import Flask, request, jsonify, send_file
import yt_dlp
import os
import tempfile
import re

app = Flask(__name__)

COOKIES_FILE = os.path.join(os.path.dirname(__file__), 'youtube.com_cookies.txt')

def sanitize(name):
    return re.sub(r'[^\w\s-]', '', name).strip()[:50]

BASE_OPTS = {
    'quiet': True,
    'no_warnings': True,
    'cookiefile': COOKIES_FILE,
}

@app.route('/check')
def check():
    exists = os.path.exists(COOKIES_FILE)
    size = os.path.getsize(COOKIES_FILE) if exists else 0
    return jsonify({'cookies_file': COOKIES_FILE, 'exists': exists, 'size': size})def index():
    return open('index.html', encoding='utf-8').read()

@app.route('/search')
def search():
    q = request.args.get('q', '')
    ydl_opts = {**BASE_OPTS, 'extract_flat': True}
    try:
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
    except Exception as ex:
        return jsonify({'error': str(ex)}), 500

@app.route('/download')
def download():
    vid = request.args.get('id', '')
    fmt = request.args.get('fmt', 'mp3')
    if not vid:
        return jsonify({'error': 'missing id'}), 400

    tmpdir = tempfile.mkdtemp()
    url = f"https://www.youtube.com/watch?v={vid}"

    try:
        if fmt == 'mp3':
            ydl_opts = {
                **BASE_OPTS,
                'format': 'bestaudio',
                'outtmpl': f'{tmpdir}/%(title)s.%(ext)s',
                'postprocessors': [{
                    'key': 'FFmpegExtractAudio',
                    'preferredcodec': 'mp3',
                    'preferredquality': '128',
                }],
            }
        else:
            ydl_opts = {
                **BASE_OPTS,
                'format': 'best',
                'outtmpl': f'{tmpdir}/%(title)s.%(ext)s',
            }

        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            title = sanitize(info.get('title', 'audio'))

        files = os.listdir(tmpdir)
        if not files:
            return jsonify({'error': 'הורדה נכשלה'}), 500

        filepath = os.path.join(tmpdir, files[0])
        size = os.path.getsize(filepath)

        if size > 20 * 1024 * 1024:
            os.remove(filepath)
            return jsonify({'error': 'הקובץ גדול מ-20MB'}), 400

        ext = files[0].split('.')[-1]
        mime = 'audio/mpeg' if ext == 'mp3' else 'video/mp4'

        return send_file(
            filepath,
            mimetype=mime,
            as_attachment=True,
            download_name=f"{title}.{ext}"
        )

    except Exception as ex:
        return jsonify({'error': str(ex)}), 500

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8080))
    app.run(host='0.0.0.0', port=port)
