from flask import Flask, request, jsonify, Response
import os
import re
import requests

app = Flask(__name__)

INVIDIOUS_INSTANCES = [
    'https://invidious.io.lol',
    'https://invidious.fdn.fr',
    'https://invidious.slipfox.xyz',
    'https://inv.tux.pizza',
    'https://invidious.privacyredirect.com',
    'https://yt.drgnz.club',
    'https://vid.puffyan.us',
    'https://invidious.lunar.icu',
]

def sanitize(name):
    return re.sub(r'[^\w\s-]', '', name).strip()[:50]

def get_invidious(path, params=None):
    for inst in INVIDIOUS_INSTANCES:
        try:
            r = requests.get(f"{inst}/api/v1/{path}", params=params, timeout=8)
            if r.status_code == 200:
                return r.json()
        except:
            continue
    return None

@app.route('/')
def index():
    return open('index.html', encoding='utf-8').read()

@app.route('/search')
def search():
    q = request.args.get('q', '')
    try:
        data = get_invidious('search', {'q': q, 'type': 'video'})
        if not data:
            return jsonify([])
        results = []
        for v in data[:6]:
            results.append({
                'id': v.get('videoId'),
                'title': v.get('title'),
                'duration': v.get('lengthSeconds'),
                'thumbnail': f"https://i.ytimg.com/vi/{v.get('videoId')}/mqdefault.jpg"
            })
        return jsonify(results)
    except Exception as ex:
        return jsonify({'error': str(ex)}), 500

@app.route('/ping')
def ping():
    results = []
    for inst in INVIDIOUS_INSTANCES:
        try:
            r = requests.get(f"{inst}/api/v1/search?q=test&type=video", timeout=5)
            results.append({'instance': inst, 'status': r.status_code, 'ok': r.status_code==200})
        except Exception as e:
            results.append({'instance': inst, 'status': 'error', 'ok': False, 'error': str(e)})
    return jsonify(results)

@app.route('/download')
def download():
    vid = request.args.get('id', '')
    fmt = request.args.get('fmt', 'mp3')
    if not vid:
        return jsonify({'error': 'missing id'}), 400

    try:
        data = get_invidious(f"videos/{vid}")
        if not data:
            return jsonify({'error': 'לא נמצא סרטון'}), 500

        title = sanitize(data.get('title', 'audio'))
        url = None
        ext = 'mp4'

        if fmt == 'mp3':
            formats = data.get('adaptiveFormats', [])
            audio = [f for f in formats if 'audio' in f.get('type', '')]
            if audio:
                best = sorted(audio, key=lambda x: x.get('bitrate', 0), reverse=True)[0]
                url = best.get('url')
                ext = 'webm'

        if not url:
            streams = data.get('formatStreams', [])
            for q in ['360p', '480p', '240p', '144p']:
                for s in streams:
                    if s.get('qualityLabel') == q:
                        url = s.get('url')
                        ext = 'mp4'
                        break
                if url:
                    break
            if not url and streams:
                url = streams[-1].get('url')
                ext = 'mp4'

        if not url:
            return jsonify({'error': 'לא נמצא קובץ להורדה'}), 500

        headers = {'User-Agent': 'Mozilla/5.0', 'Range': 'bytes=0-'}
        r = requests.get(url, headers=headers, stream=True, timeout=30)

        if not r.ok:
            return jsonify({'error': f'שגיאה: {r.status_code}'}), 500

        content_length = r.headers.get('Content-Length')
        if content_length and int(content_length) > 20 * 1024 * 1024:
            return jsonify({'error': 'הקובץ גדול מ-20MB'}), 400

        mime = 'audio/webm' if ext == 'webm' else 'video/mp4'

        def generate():
            for chunk in r.iter_content(chunk_size=8192):
                if chunk:
                    yield chunk

        return Response(
            generate(),
            mimetype=mime,
            headers={
                'Content-Disposition': f'attachment; filename="{title}.{ext}"',
                'Content-Length': content_length or '',
            }
        )

    except Exception as ex:
        return jsonify({'error': str(ex)}), 500

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8080))
    app.run(host='0.0.0.0', port=port)
