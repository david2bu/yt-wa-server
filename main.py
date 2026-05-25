from flask import Flask, request, jsonify, send_file
import yt_dlp
import os
import tempfile
import re

app = Flask(__name__)

COOKIES_FILE = 'youtube.com_cookies.txt'

VISITOR_DATA = 'Cgt6bnR1Ml82UlFoQSisq9HQBjIKCgJJTBIEGgAgVWLfAgrcAjE4LllUPXpZcURvVnBxQVV0VFAwQTZfei0xV0lJU3dhc0lMaU5ibUxzRHdPRjQxdXBxdVdSMjRRUUZHT3hZSUx6SXFISnFJRHNsMGJPUkM1WDhNeHd3azVmZGUtRmEyZUwyY1NEUUlhZ2FGYVd5T1YwQ0lvZEprZUhTS2J5QjJVVk45Wk5XWTN6dVZzckVKQ3lCMV9rdFo0X2g1a21RT3Q2dlcyQnFsel96UnQ3TzBabUV1UFhSc0VQcGE2ZkdkVVBabk0zSVBlRWNOWS10eURFM0hJeklCYjd3eGlSbEtac1JUSTQwZl9nMlJ2V0lCT3BKdEVKNEtHZkVjR0tHUXpWNlZpY0cza3FESjFsZGdlZDBBNG1xWHZCbnhYLUhDMDExU1lKcVQxalF4U3hrY1BjaTNLcVBHdUczcXhCU3NTMXJCaExoQUJocjZBOS03V2FuQ21neGdJelVZUQ%3D%3D'

PO_TOKEN = 'QUFFLUhqbXZwZG90VHVnYXZUdHpSLVVrUUc0WkdxZXlOUXw='

def sanitize(name):
    return re.sub(r'[^\w\s-]', '', name).strip()[:50]

def base_opts():
    return {
        'quiet': True,
        'no_warnings': True,
        'cookiefile': COOKIES_FILE,
        'extractor_args': {
            'youtube': {
                'visitor_data': VISITOR_DATA,
                'po_token': [f'web+{PO_TOKEN}'],
            }
        },
    }

@app.route('/check')
def check():
    exists = os.path.exists(COOKIES_FILE)
    return jsonify({'exists': exists, 'files': os.listdir('.')})

@app.route('/formats')
def formats():
    vid = request.args.get('id', '')
    url = f"https://www.youtube.com/watch?v={vid}"
    try:
        opts = base_opts()
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
        fmts = []
        for f in info.get('formats', []):
            fmts.append({
                'id': f.get('format_id'),
                'ext': f.get('ext'),
                'note': f.get('format_note'),
                'acodec': f.get('acodec'),
                'vcodec': f.get('vcodec'),
                'filesize': f.get('filesize'),
            })
        return jsonify(fmts)
    except Exception as ex:
        return jsonify({'error': str(ex)}), 500

@app.route('/')
def index():
    return open('index.html', encoding='utf-8').read()

@app.route('/search')
def search():
    q = request.args.get('q', '')
    try:
        opts = base_opts()
        opts['extract_flat'] = True
        with yt_dlp.YoutubeDL(opts) as ydl:
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
        opts = base_opts()
        opts['outtmpl'] = f'{tmpdir}/%(title)s.%(ext)s'

        if fmt == 'mp3':
            opts['format'] = '140/139/bestaudio'
            opts['postprocessors'] = [{
                'key': 'FFmpegExtractAudio',
                'preferredcodec': 'mp3',
                'preferredquality': '128',
            }]
        else:
            opts['format'] = '18/best'

        with yt_dlp.YoutubeDL(opts) as ydl:
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
