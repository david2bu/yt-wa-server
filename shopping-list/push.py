"""Web Push בלי ספריות חיצוניות מלבד cryptography: הצפנה לפי RFC 8291 וחתימת VAPID (RFC 8292)."""
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from urllib.parse import urlsplit
import urllib.error
import urllib.request
import base64
import json
import os
import time

VAPID_SUBJECT = 'mailto:shop@judit.live'


def b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode()


def unb64url(text):
    return base64.urlsafe_b64decode(text + '=' * (-len(text) % 4))


def public_bytes(key):
    return key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)


def load_vapid_key(data_dir):
    """המפתח הפרטי נשמר בתיקיית הנתונים (לא בקוד) ונוצר בפעם הראשונה."""
    path = os.path.join(data_dir, 'vapid_private.pem')
    if os.path.exists(path):
        with open(path, 'rb') as f:
            return serialization.load_pem_private_key(f.read(), password=None)
    key = ec.generate_private_key(ec.SECP256R1())
    pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                            serialization.NoEncryption())
    tmp = f'{path}.{os.getpid()}'
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as f:
        f.write(pem)
    try:
        os.link(tmp, path)  # כמה תהליכי gunicorn עולים יחד - רק הראשון קובע את המפתח
    except FileExistsError:
        pass
    finally:
        os.unlink(tmp)
    with open(path, 'rb') as f:
        return serialization.load_pem_private_key(f.read(), password=None)


def vapid_auth(key, endpoint):
    parts = urlsplit(endpoint)
    header = b64url(json.dumps({'typ': 'JWT', 'alg': 'ES256'}).encode())
    claims = b64url(json.dumps({'aud': f'{parts.scheme}://{parts.netloc}',
                                'exp': int(time.time()) + 12 * 3600,
                                'sub': VAPID_SUBJECT}).encode())
    signing_input = f'{header}.{claims}'.encode()
    r, s = decode_dss_signature(key.sign(signing_input, ec.ECDSA(hashes.SHA256())))
    token = f'{header}.{claims}.{b64url(r.to_bytes(32, "big") + s.to_bytes(32, "big"))}'
    return f'vapid t={token}, k={b64url(public_bytes(key))}'


def _hkdf(salt, info, length, ikm):
    return HKDF(algorithm=hashes.SHA256(), length=length, salt=salt, info=info).derive(ikm)


def encrypt(payload, p256dh, auth):
    """הצפנת aes128gcm לפי RFC 8291 - רשומה אחת."""
    ua_public = unb64url(p256dh)
    auth_secret = unb64url(auth)
    ua_key = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), ua_public)
    as_key = ec.generate_private_key(ec.SECP256R1())
    as_public = public_bytes(as_key)
    ecdh_secret = as_key.exchange(ec.ECDH(), ua_key)
    ikm = _hkdf(auth_secret, b'WebPush: info\x00' + ua_public + as_public, 32, ecdh_secret)
    salt = os.urandom(16)
    cek = _hkdf(salt, b'Content-Encoding: aes128gcm\x00', 16, ikm)
    nonce = _hkdf(salt, b'Content-Encoding: nonce\x00', 12, ikm)
    ciphertext = AESGCM(cek).encrypt(nonce, payload + b'\x02', None)
    return salt + (4096).to_bytes(4, 'big') + bytes([len(as_public)]) + as_public + ciphertext


def send(key, sub, message):
    """שולח התראה. מחזיר את קוד התשובה של שירות הפוש (404/410 = המנוי כבר לא קיים)."""
    body = encrypt(json.dumps(message, ensure_ascii=False).encode(), sub['p256dh'], sub['auth'])
    req = urllib.request.Request(sub['endpoint'], data=body, method='POST', headers={
        'Authorization': vapid_auth(key, sub['endpoint']),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        'TTL': '86400',
        'Urgency': 'normal',
    })
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status
    except urllib.error.HTTPError as e:
        return e.code
