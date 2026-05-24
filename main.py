from flask import Flask, request, jsonify, send_file, Response
import os
import re
import tempfile
import requests

app = Flask(__name__)

INVIDIOUS_INSTANCES = [
    'https://inv.nadeko.net',
    'https://invidious.nerdvpn.de',
    'https://yt.drgnz.club',
    'https://invidious.privacydev.net',
]

def sanitize(name):
    return re.sub(r'[^\w\s-]', '', name).strip()[:50]

def get_invidious(path, params=None):
    for inst in INVIDIOUS_INSTANCES:
        try:
            r = requests.get(f"{inst}/api/v1/{path}", params=params, timeout=10)
            if r.status_code == 200:
                return r.json()
        except:
            continue
    return None

def get_audio_url(video_id):
    data = get_invidious(f"videos/{video_id}")
    if not data:
        return None, None, None
    
    # מחפש audio format
    formats = data.get('adaptiveFormats', [])
    audio = [f for f in formats if f.get('type','').startswith('audio/')]
    if not audio:
        # fallback לformatStreams
        streams = data.get('formatStreams', [])
        if streams:
            best = streams[0]
            return best.get('url'), data.get('title','audio'), 'mp4'
        return None, None, None
    
    # בוחר הכי טוב
    best = sorted(audio, key=lambda x: x.get('bitrate', 0), reverse=True)[0]
    return best.get('url'), data.get('title','audio'), 'webm'

def get_video_url(video_id):
    data = get_invidious(f"videos/{video_id}")
    if not data:
        return None, None
    
    streams = data.get('formatStreams', [])
    # בוחר 480p או פחות
    for q in ['480p', '360p', '240p', '144p']:
        for s in streams:
            if s.get('qualityLabel') == q:
                return s.get('url'), data.get('title','video')
    
    if streams:
        return streams[-1].get('url'), data.get('title','video')
    return None, None

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

@app.route('/download')
def download():
    vid = request.args.get('id', '')
    fmt = request.args.get('fmt', 'mp3')
    if not vid:
        return jsonify({'error': 'missing id'}), 400

    try:
        if fmt == 'mp3':
            url, title, ext = get_audio_url(vid)
        else:
            url, title = get_video_url(vid)
            ext = 'mp4'

        if not url:
            return jsonify({'error': 'לא נמצא קובץ להורדה'}), 500

        title = sanitize(title or 'audio')

        # Stream מ-Invidious לclient
        headers = {'User-Agent': 'Mozilla/5.0', 'Range': 'bytes=0-'}
        r = requests.get(url, headers=headers, stream=True, timeout=30)

        if not r.ok:
            return jsonify({'error': f'שגיאה בהורדה: {r.status_code}'}), 500

        # בדיקת גודל
        content_length = r.headers.get('Content-Length')
        if content_length and int(content_length) > 20 * 1024 * 1024:
            return jsonify({'error': 'הקובץ גדול מ-20MB'}), 400

        mime = 'audio/webm' if ext == 'webm' else ('video/mp4' if ext == 'mp4' else 'audio/mpeg')

        def generate():
            for chunk in r.iter_content(chunk_size=8192):
                if chunk:
                    yield chunk

        response = Response(
            generate(),
            mimetype=mime,
            headers={
                'Content-Disposition': f'attachment; filename="{title}.{ext}"',
                'Content-Length': content_length or '',
            }
        )
        return response

    except Exception as ex:
        return jsonify({'error': str(ex)}), 500

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8080))
    app.run(host='0.0.0.0', port=port)
