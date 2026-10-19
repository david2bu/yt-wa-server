"""שליחת הודעת וואטסאפ דרך בוט הוואטסאפ שרץ על אותו שרת. בלי WA_URL - לא שולח כלום."""
import json
import os
import urllib.error
import urllib.request

WA_URL = os.environ.get('WA_URL', '')              # למשל http://127.0.0.1:3099/send
WA_TOKEN = os.environ.get('WA_TOKEN', '')
WA_TOKEN_HEADER = os.environ.get('WA_TOKEN_HEADER', 'Authorization')
WA_PHONE_FIELD = os.environ.get('WA_PHONE_FIELD', 'phone')
WA_TEXT_FIELD = os.environ.get('WA_TEXT_FIELD', 'message')


def send(phone, text):
    if not WA_URL:
        return None
    headers = {'Content-Type': 'application/json'}
    if WA_TOKEN:
        headers[WA_TOKEN_HEADER] = WA_TOKEN
    body = json.dumps({WA_PHONE_FIELD: phone, WA_TEXT_FIELD: text}, ensure_ascii=False).encode()
    req = urllib.request.Request(WA_URL, data=body, method='POST', headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status
    except urllib.error.HTTPError as e:
        return e.code
