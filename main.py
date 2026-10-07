from flask import Flask, request, jsonify, send_file, Response
import requests
import os
import re
import tempfile

app = Flask(__name__)

RAPIDAPI_KEY = '1b10b50a2dmsh9a40f1f8b87f4dbp1c46b2jsn4b4f81f4b604'
RAPIDAPI_HOST = 'youtube-mp3-audio-video-downloader.p.rapidapi.com'

def sanitize(name):
    return re.sub(r'[^\w\s-]', '', name).strip()[:50]

@app.route('/')
def index():
    return open('index.html', encoding='utf-8').read()

@app.route('/search')
def search():
    q = request.args.get('q', '')
    try:
        r = requests.get(
            'https://youtube-mp3-audio-video-downloader.p.rapidapi.com/search',
            headers={'X-RapidAPI-Key': RAPIDAPI_KEY, 'X-RapidAPI-Host': RAPIDAPI_HOST},
            params={'q': q, 'hl': 'he', 'gl': 'IL'},
            timeout=10
        )
        data = r.json()
        results = []
        for v in data.get('data', {}).get('videos', [])[:6]:
            results.append({
                'id': v.get('videoId'),
                'title': v.get('title'),
                'duration': v.get('lengthSeconds'),
                'thumbnail': v.get('thumbnail', {}).get('thumbnails', [{}])[-1].get('url', f"https://i.ytimg.com/vi/{v.get('videoId')}/mqdefault.jpg")
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
            r = requests.get(
                'https://youtube-mp3-audio-video-downloader.p.rapidapi.com/mp3',
                headers={'X-RapidAPI-Key': RAPIDAPI_KEY, 'X-RapidAPI-Host': RAPIDAPI_HOST},
                params={'id': vid, 'quality': '128'},
                timeout=30
            )
        else:
            r = requests.get(
                'https://youtube-mp3-audio-video-downloader.p.rapidapi.com/mp4',
                headers={'X-RapidAPI-Key': RAPIDAPI_KEY, 'X-RapidAPI-Host': RAPIDAPI_HOST},
                params={'id': vid, 'quality': '360'},
                timeout=30
            )

        data = r.json()
        dl_url = data.get('link') or data.get('url') or data.get('downloadUrl')

        if not dl_url:
            return jsonify({'error': 'לא נמצא קישור להורדה', 'raw': data}), 500

        # Stream הקובץ
        file_r = requests.get(dl_url, stream=True, timeout=60)
        content_length = file_r.headers.get('Content-Length')

        if content_length and int(content_length) > 20 * 1024 * 1024:
            return jsonify({'error': 'הקובץ גדול מ-20MB'}), 400

        ext = 'mp3' if fmt == 'mp3' else 'mp4'
        mime = 'audio/mpeg' if ext == 'mp3' else 'video/mp4'
        title = sanitize(data.get('title', 'audio'))

        def generate():
            for chunk in file_r.iter_content(chunk_size=8192):
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
