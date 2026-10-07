"""ניהול קניות לבית - רשימה משותפת, הצעות מההיסטוריה והערכת מחיר."""
from flask import Blueprint, request, jsonify, send_file
from contextlib import contextmanager
from datetime import datetime, timezone
import sqlite3
import os

shop = Blueprint('shop', __name__)

DATA_DIR = os.environ.get('DATA_DIR', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data'))
DB_PATH = os.path.join(DATA_DIR, 'shop.db')
HTML_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'shop.html')

URGENCIES = ('urgent', 'regular')  # urgent = לשבת הקרובה, regular = שוטף

SCHEMA = """
CREATE TABLE IF NOT EXISTS members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    price REAL,
    is_regular INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    qty REAL NOT NULL DEFAULT 1,
    note TEXT NOT NULL DEFAULT '',
    urgency TEXT NOT NULL DEFAULT 'regular',
    requested_by TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open',
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    bought_at TEXT,
    bought_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_items_status ON items(status, archived);
CREATE INDEX IF NOT EXISTS idx_items_product ON items(product_id);
"""


def now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


@contextmanager
def db():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA foreign_keys = ON')
    try:
        with conn:
            yield conn
    finally:
        conn.close()


def init_db():
    os.makedirs(DATA_DIR, exist_ok=True)
    with db() as conn:
        conn.execute('PRAGMA journal_mode = WAL')
        conn.executescript(SCHEMA)


init_db()


def clean_name(value):
    return ' '.join(str(value or '').split())[:80]


def parse_price(value):
    if value in (None, ''):
        return None
    price = float(value)
    if price < 0:
        raise ValueError('price must be >= 0')
    return round(price, 2)


def parse_qty(value):
    qty = float(value if value not in (None, '') else 1)
    if qty <= 0:
        raise ValueError('qty must be > 0')
    return qty


def get_or_create_product(conn, name):
    row = conn.execute('SELECT * FROM products WHERE name = ?', (name,)).fetchone()
    if row:
        return row
    cur = conn.execute('INSERT INTO products (name, created_at) VALUES (?, ?)', (name, now()))
    return conn.execute('SELECT * FROM products WHERE id = ?', (cur.lastrowid,)).fetchone()


def build_suggestions(conn, products):
    """מוצרים שנקנים קבוע ואינם ברשימה כרגע, מדורגים לפי תדירות ו'הגיע הזמן'."""
    on_list = {r['product_id'] for r in conn.execute(
        "SELECT DISTINCT product_id FROM items WHERE status = 'open'")}

    history = {}
    for r in conn.execute(
            "SELECT product_id, bought_at, created_at FROM items WHERE status = 'bought' ORDER BY product_id, bought_at"):
        history.setdefault(r['product_id'], []).append(r['bought_at'] or r['created_at'])

    today = datetime.now(timezone.utc)
    suggestions = []
    for p in products:
        if p['id'] in on_list:
            continue
        dates = [datetime.fromisoformat(d) for d in history.get(p['id'], [])]
        count = len(dates)
        if count < 2 and not p['is_regular']:
            continue
        days_since = (today - dates[-1]).days if dates else None
        avg_interval = None
        if count >= 2:
            avg_interval = max(1, round((dates[-1] - dates[0]).days / (count - 1)))
        due = bool(avg_interval and days_since is not None and days_since >= avg_interval)
        score = count + (10 if due else 0) + (5 if p['is_regular'] else 0)
        suggestions.append({
            'product_id': p['id'],
            'name': p['name'],
            'price': p['price'],
            'is_regular': bool(p['is_regular']),
            'times_bought': count,
            'days_since': days_since,
            'avg_interval': avg_interval,
            'due': due,
            'score': score,
        })
    suggestions.sort(key=lambda s: (-s['score'], s['name']))
    return suggestions[:24]


@shop.route('/shop')
def shop_page():
    return send_file(HTML_PATH)


@shop.route('/shop/api/state')
def state():
    with db() as conn:
        members = [dict(r) for r in conn.execute('SELECT * FROM members ORDER BY name')]
        products = conn.execute("""
            SELECT p.*, COUNT(i.id) AS times_bought, MAX(i.bought_at) AS last_bought
            FROM products p
            LEFT JOIN items i ON i.product_id = p.id AND i.status = 'bought'
            GROUP BY p.id ORDER BY p.is_regular DESC, times_bought DESC, p.name
        """).fetchall()
        items = [dict(r) for r in conn.execute("""
            SELECT i.*, p.name, p.price
            FROM items i JOIN products p ON p.id = i.product_id
            WHERE i.archived = 0
            ORDER BY i.status, CASE i.urgency WHEN 'urgent' THEN 0 ELSE 1 END, i.created_at
        """)]
        suggestions = build_suggestions(conn, products)
    return jsonify({
        'members': members,
        'products': [dict(r) for r in products],
        'items': items,
        'suggestions': suggestions,
    })


@shop.route('/shop/api/items', methods=['POST'])
def add_item():
    data = request.get_json(force=True) or {}
    name = clean_name(data.get('name'))
    if not name:
        return jsonify({'error': 'חסר שם מוצר'}), 400
    urgency = data.get('urgency') if data.get('urgency') in URGENCIES else 'regular'
    try:
        qty = parse_qty(data.get('qty'))
    except (TypeError, ValueError):
        return jsonify({'error': 'כמות לא תקינה'}), 400
    note = str(data.get('note') or '').strip()[:200]
    requested_by = clean_name(data.get('requested_by'))

    with db() as conn:
        product = get_or_create_product(conn, name)
        existing = conn.execute(
            "SELECT * FROM items WHERE product_id = ? AND status = 'open' AND archived = 0",
            (product['id'],)).fetchone()
        if existing:
            # כבר ברשימה - מעדכנים כמות, ודחוף גובר על שוטף
            new_urgency = 'urgent' if 'urgent' in (urgency, existing['urgency']) else 'regular'
            conn.execute('UPDATE items SET qty = ?, urgency = ?, note = ? WHERE id = ?',
                         (existing['qty'] + qty, new_urgency, note or existing['note'], existing['id']))
            return jsonify({'id': existing['id'], 'merged': True})
        cur = conn.execute(
            'INSERT INTO items (product_id, qty, note, urgency, requested_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
            (product['id'], qty, note, urgency, requested_by, now()))
        return jsonify({'id': cur.lastrowid, 'merged': False}), 201


@shop.route('/shop/api/items/<int:item_id>', methods=['PATCH'])
def update_item(item_id):
    data = request.get_json(force=True) or {}
    fields = {}
    if 'urgency' in data:
        if data['urgency'] not in URGENCIES:
            return jsonify({'error': 'דחיפות לא תקינה'}), 400
        fields['urgency'] = data['urgency']
    if 'qty' in data:
        try:
            fields['qty'] = parse_qty(data['qty'])
        except (TypeError, ValueError):
            return jsonify({'error': 'כמות לא תקינה'}), 400
    if 'note' in data:
        fields['note'] = str(data['note'] or '').strip()[:200]
    if 'status' in data:
        if data['status'] == 'bought':
            fields.update(status='bought', bought_at=now(), bought_by=clean_name(data.get('by')))
        elif data['status'] == 'open':
            fields.update(status='open', bought_at=None, bought_by=None)
        else:
            return jsonify({'error': 'סטטוס לא תקין'}), 400
    if not fields:
        return jsonify({'error': 'אין מה לעדכן'}), 400
    sets = ', '.join(f'{k} = ?' for k in fields)
    with db() as conn:
        cur = conn.execute(f'UPDATE items SET {sets} WHERE id = ?', (*fields.values(), item_id))
    if not cur.rowcount:
        return jsonify({'error': 'לא נמצא'}), 404
    return jsonify({'ok': True})


@shop.route('/shop/api/items/<int:item_id>', methods=['DELETE'])
def delete_item(item_id):
    with db() as conn:
        conn.execute('DELETE FROM items WHERE id = ?', (item_id,))
    return jsonify({'ok': True})


@shop.route('/shop/api/items/finish', methods=['POST'])
def finish_shopping():
    """מסיים קנייה: הפריטים שנקנו עוברים להיסטוריה ונעלמים מהרשימה."""
    with db() as conn:
        cur = conn.execute("UPDATE items SET archived = 1 WHERE status = 'bought' AND archived = 0")
    return jsonify({'archived': cur.rowcount})


@shop.route('/shop/api/products', methods=['POST'])
def add_product():
    data = request.get_json(force=True) or {}
    name = clean_name(data.get('name'))
    if not name:
        return jsonify({'error': 'חסר שם מוצר'}), 400
    try:
        price = parse_price(data.get('price'))
    except (TypeError, ValueError):
        return jsonify({'error': 'מחיר לא תקין'}), 400
    with db() as conn:
        product = get_or_create_product(conn, name)
        conn.execute('UPDATE products SET price = COALESCE(?, price), is_regular = ? WHERE id = ?',
                     (price, 1 if data.get('is_regular', True) else 0, product['id']))
    return jsonify({'id': product['id']}), 201


@shop.route('/shop/api/products/<int:product_id>', methods=['PATCH'])
def update_product(product_id):
    data = request.get_json(force=True) or {}
    fields = {}
    if 'price' in data:
        try:
            fields['price'] = parse_price(data['price'])
        except (TypeError, ValueError):
            return jsonify({'error': 'מחיר לא תקין'}), 400
    if 'is_regular' in data:
        fields['is_regular'] = 1 if data['is_regular'] else 0
    if 'name' in data:
        name = clean_name(data['name'])
        if not name:
            return jsonify({'error': 'חסר שם מוצר'}), 400
        fields['name'] = name
    if not fields:
        return jsonify({'error': 'אין מה לעדכן'}), 400
    sets = ', '.join(f'{k} = ?' for k in fields)
    try:
        with db() as conn:
            cur = conn.execute(f'UPDATE products SET {sets} WHERE id = ?', (*fields.values(), product_id))
    except sqlite3.IntegrityError:
        return jsonify({'error': 'מוצר בשם הזה כבר קיים'}), 409
    if not cur.rowcount:
        return jsonify({'error': 'לא נמצא'}), 404
    return jsonify({'ok': True})


@shop.route('/shop/api/products/<int:product_id>', methods=['DELETE'])
def delete_product(product_id):
    with db() as conn:
        conn.execute('DELETE FROM products WHERE id = ?', (product_id,))
    return jsonify({'ok': True})


@shop.route('/shop/api/members', methods=['POST'])
def add_member():
    name = clean_name((request.get_json(force=True) or {}).get('name'))
    if not name:
        return jsonify({'error': 'חסר שם'}), 400
    with db() as conn:
        conn.execute('INSERT OR IGNORE INTO members (name) VALUES (?)', (name,))
    return jsonify({'ok': True}), 201


@shop.route('/shop/api/members/<int:member_id>', methods=['DELETE'])
def delete_member(member_id):
    with db() as conn:
        conn.execute('DELETE FROM members WHERE id = ?', (member_id,))
    return jsonify({'ok': True})
