// Admin website. Plain DOM, no build step. All user content goes in via textContent (no innerHTML).

const WEEKDAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת']
const STATUS = {
  collecting: 'מתקבל…',
  unscheduled: 'ממתין לתזמון',
  scheduled: 'מתוזמן',
  sent: 'נשלח',
  failed: 'נכשל',
  pending: 'מתוזמן',
  cancelled: 'בוטל',
}
const CONN = {
  starting: 'מתחיל…', connecting: 'מתחבר…', qr: 'ממתין לסריקת QR', open: 'מחובר',
  closed: 'מתחבר מחדש…', logged_out: 'נותק מהטלפון', banned: 'חסום זמנית ע״י וואטסאפ',
}

const $ = (s) => document.querySelector(s)
const view = $('#view')
let state = { tab: 'home', groups: [], customers: [], status: null, inboxFilter: 'unscheduled' }

// ---------------- DOM helper ----------------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v === null || v === undefined) continue
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else if (k === 'class') el.className = v
    else if (k === 'value') el.value = v
    else if (k === 'checked' || k === 'selected' || k === 'disabled') el[k] = !!v
    else el.setAttribute(k, v === true ? '' : v)
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue
    el.append(c instanceof Node ? c : document.createTextNode(String(c)))
  }
  return el
}

// ---------------- API ----------------

async function api(method, url, body) {
  const opts = { method, headers: {} }
  if (body instanceof FormData) opts.body = body
  else if (body !== undefined) {
    opts.headers['content-type'] = 'application/json'
    opts.body = JSON.stringify(body)
  }
  const res = await fetch(url, opts)
  if (res.status === 401 && url !== '/api/login') {
    showLogin()
    throw new Error('צריך להתחבר')
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `שגיאה ${res.status}`)
  return data
}

function toast(msg, isErr = false) {
  const t = $('#toast')
  t.textContent = msg
  t.className = 'toast' + (isErr ? ' err' : '')
  t.hidden = false
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => (t.hidden = true), isErr ? 6000 : 3000)
}

// wraps an action: disables the button while running, shows errors, re-renders on success
function action(fn, { rerender = true } = {}) {
  return async (e) => {
    const btn = e?.currentTarget
    if (btn) btn.disabled = true
    try {
      const msg = await fn(e)
      if (msg) toast(msg)
      if (rerender) await render()
    } catch (err) {
      toast(err.message, true)
    } finally {
      if (btn) btn.disabled = false
    }
  }
}

// ---------------- formatting ----------------

// All times are shown and entered in the server's time zone (Israel), whatever the viewing device is set to.
const pad = (n) => String(n).padStart(2, '0')
let tz = 'Asia/Jerusalem'
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
function parts(ts) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short',
  }).formatToParts(new Date(ts)).map((x) => [x.type, x.value]))
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute, wd: WD[p.weekday] }
}
// wall-clock time in the server's zone -> timestamp
function fromZoned(y, m, d, h, min) {
  const want = Date.UTC(y, m - 1, d, h, min)
  let ts = want
  for (let i = 0; i < 2; i++) {
    const p = parts(ts)
    ts += want - Date.UTC(p.y, p.m - 1, p.d, p.h, p.min)
  }
  return ts
}
const startOfDay = (ts) => { const p = parts(ts); return fromZoned(p.y, p.m, p.d, 0, 0) }
const fromInput = (v) => { const [date, time] = v.split('T'); const [y, m, d] = date.split('-').map(Number); const [h, min] = time.split(':').map(Number); return fromZoned(y, m, d, h, min) }
const fmtTime = (ts) => { const p = parts(ts); return `${pad(p.h)}:${pad(p.min)}` }
const fmtDate = (ts) => { const p = parts(ts); return `יום ${WEEKDAYS[p.wd]} ${p.d}/${p.m}` }
const fmtWhen = (ts) => `${fmtDate(ts)}, ${fmtTime(ts)}`
function fmtAgo(ts) {
  const m = Math.round((Date.now() - ts) / 60000)
  if (m < 1) return 'עכשיו'
  if (m < 60) return `לפני ${m} דק׳`
  if (m < 60 * 24) return `לפני ${Math.round(m / 60)} שע׳`
  return fmtWhen(ts)
}
const toLocalInput = (ts) => { const p = parts(ts); return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.h)}:${pad(p.min)}` }
const phoneLabel = (p) => (p?.startsWith('972') ? '0' + p.slice(3) : p)
const customerName = (phone, name) => name || phoneLabel(phone)
const badge = (status) => h('span', { class: `badge b-${status}` }, STATUS[status] || status)
const groupName = (jid) => state.groups.find((g) => g.jid === jid)?.subject || jid

// ---------------- login ----------------

let setupMode = false

async function showLogin() {
  $('#app').hidden = true
  $('#login').hidden = false
  setupMode = (await api('GET', '/api/setup').catch(() => ({}))).needsSetup
  $('#login-form').classList.toggle('setup', !!setupMode)
  $('#login-form').querySelector('button').textContent = setupMode ? 'שמירה וכניסה' : 'כניסה'
  $('#login-form').password.autocomplete = setupMode ? 'new-password' : 'current-password'
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  $('#login-error').textContent = ''
  try {
    if (setupMode) await api('POST', '/api/setup', { password: e.target.password.value, phone: e.target.phone.value })
    else await api('POST', '/api/login', { password: e.target.password.value })
    e.target.reset()
    start()
  } catch (err) {
    $('#login-error').textContent = err.message
  }
})

$('#logout').addEventListener('click', async () => {
  await api('POST', '/api/logout').catch(() => {})
  showLogin()
})

// ---------------- tabs ----------------

$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]')
  if (b) go(b.dataset.tab)
})

function go(tab, extra = {}) {
  state = { ...state, ...extra, tab }
  history.replaceState(null, '', '#' + tab)
  render()
}

async function render() {
  for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('active', b.dataset.tab === state.tab)
  const fn = { home: renderHome, inbox: renderInbox, calendar: renderCalendar, customers: renderCustomers, new: renderNew, connection: renderConnection }[state.tab]
  try {
    const content = await fn()
    view.replaceChildren(content)
  } catch (err) {
    if (err.message !== 'צריך להתחבר') view.replaceChildren(h('div', { class: 'card error' }, err.message))
  }
}

async function refreshStatus() {
  try {
    state.status = await api('GET', '/api/status')
  } catch {
    return
  }
  const s = state.status
  tz = s.timeZone || tz
  $('#conn-dot').className = 'dot ' + (s.state === 'open' ? 'on' : 'off')
  $('#count-inbox').textContent = s.unscheduled + s.failed || ''
  $('#count-customers').textContent = s.strangers || ''
}

async function loadBasics() {
  ;[state.groups, state.customers] = await Promise.all([api('GET', '/api/groups'), api('GET', '/api/customers')])
}

// ---------------- home ----------------

function storageBanner() {
  if (!state.status?.missingStorage) return null
  return h('div', { class: 'card banner' },
    h('strong', {}, '⚠️ חסר אחסון קבוע בשרת. '),
    'בלי זה, בכל עדכון נמחקים החיבור לוואטסאפ והנתונים. ב-Railway: השירות ← Settings ← Volumes ← Add Volume (כל נתיב). זו הפעולה היחידה שצריך לעשות שם.')
}

async function renderHome() {
  await Promise.all([refreshStatus(), loadBasics()])
  const s = state.status
  const now = Date.now()
  const upcoming = await api('GET', `/api/calendar?from=${now}&to=${now + 2 * 86400_000}`)
  const pending = upcoming.filter((d) => d.status === 'pending')

  const stat = (n, l, tab, alert) => h('button', { class: 'card stat' + (alert && n ? ' alert' : ''), style: 'text-align:start;cursor:pointer;font:inherit;color:inherit', onclick: () => go(tab.split(':')[0], tab.includes(':') ? { inboxFilter: tab.split(':')[1] } : {}) },
    h('div', { class: 'n' }, n), h('div', { class: 'l' }, l))

  return h('div', {},
    storageBanner(),
    s.state !== 'open' && h('div', { class: 'card', style: 'border-color:var(--danger);margin-bottom:16px' },
      h('div', { class: 'row spread' }, h('strong', {}, `⚠️ וואטסאפ: ${CONN[s.state] || s.state}`), h('button', { class: 'btn primary small', onclick: () => go('connection') }, 'לחיבור'))),
    h('div', { class: 'stats' },
      stat(s.unscheduled, 'ממתינים לתזמון', 'inbox:unscheduled', true),
      stat(s.stats.pending || 0, 'שליחות מתוזמנות', 'calendar'),
      stat(s.failed, 'נכשלו', 'inbox:failed', true),
      stat(state.customers.length, 'לקוחות', 'customers'),
      s.strangers ? stat(s.strangers, 'פניות ממספרים לא רשומים', 'customers', true) : null),
    h('h2', {}, 'ב-48 השעות הקרובות'),
    pending.length
      ? h('div', { class: 'card list' }, pending.map(calRow))
      : h('div', { class: 'card empty' }, 'אין שליחות מתוזמנות ביומיים הקרובים'))
}

// ---------------- inbox ----------------

async function renderInbox() {
  await loadBasics()
  const f = state.inboxFilter
  const q = new URLSearchParams()
  if (f && f !== 'all') q.set('status', f)
  if (state.inboxPhone) q.set('phone', state.inboxPhone)
  const subs = await api('GET', '/api/submissions?' + q)
  refreshStatus()

  const filters = [['unscheduled', 'ממתינים לתזמון'], ['scheduled', 'מתוזמנים'], ['failed', 'נכשלו'], ['sent', 'נשלחו'], ['all', 'הכל']]
  const customerFilter = h('select', { class: 'chip', style: 'width:auto', onchange: (e) => go('inbox', { inboxPhone: e.target.value || null }) },
    h('option', { value: '' }, 'כל הלקוחות'),
    state.customers.map((c) => h('option', { value: c.phone, selected: c.phone === state.inboxPhone }, customerName(c.phone, c.name))))

  return h('div', {},
    h('div', { class: 'filters' },
      filters.map(([k, l]) => h('button', { class: 'chip' + (f === k ? ' active' : ''), onclick: () => go('inbox', { inboxFilter: k }) }, l)),
      customerFilter),
    subs.length ? h('div', { class: 'grid' }, subs.map(submissionCard)) : h('div', { class: 'card empty' }, 'אין כאן כלום'))
}

function itemPreview(it) {
  const src = `/media/${it.id}`
  if (it.kind === 'image') return h('a', { href: src, target: '_blank' }, h('img', { src, loading: 'lazy', alt: it.caption || 'תמונה' }))
  if (it.kind === 'video') return h('video', { src, controls: true, preload: 'metadata', class: 'full' })
  if (it.kind === 'audio') return h('audio', { src, controls: true, preload: 'none', class: 'full' })
  if (it.kind === 'document') return h('a', { href: src, target: '_blank', class: 'doc full' }, '📄 ', it.filename || 'קובץ')
  return null
}

function submissionCard(s) {
  const media = s.items.filter((i) => i.kind !== 'text')
  const texts = s.items.map((i) => i.caption).filter(Boolean)
  const live = s.deliveries.filter((d) => d.status !== 'cancelled')
  const hasPending = live.some((d) => d.status === 'pending' || d.status === 'failed')

  return h('div', { class: 'card' },
    h('div', { class: 'sub-head' },
      h('div', {},
        h('div', { class: 'who' }, customerName(s.phone, s.customer_name)),
        h('div', { class: 'muted small' }, `${s.source === 'web' ? 'הועלה באתר' : 'התקבל'} ${fmtAgo(s.created_at)}`)),
      badge(s.status)),
    media.length ? h('div', { class: 'media' }, media.map(itemPreview)) : null,
    texts.map((t) => h('div', { class: 'text' }, t)),
    live.length ? h('div', { class: 'deliveries' }, live.map((d) =>
      h('div', { class: 'delivery' },
        badge(d.status),
        h('span', { class: 'when' }, fmtWhen(d.sent_at || d.send_at)),
        h('span', {}, '· ', d.group_name || d.group_jid),
        d.status === 'pending' && h('button', { class: 'btn ghost small', onclick: () => editDelivery(d) }, 'שינוי'),
        d.status === 'pending' && h('button', { class: 'btn ghost small danger', onclick: action(() => api('PATCH', `/api/deliveries/${d.id}`, { status: 'cancelled' }).then(() => 'בוטל')) }, 'ביטול'),
        d.status === 'failed' && h('button', { class: 'btn ghost small', onclick: action(() => api('PATCH', `/api/deliveries/${d.id}`, { status: 'pending' }).then(() => 'יישלח שוב')) }, 'נסה שוב'),
        d.status === 'failed' && d.error && h('div', { class: 'err' }, d.error)))) : null,
    s.status !== 'collecting' && h('div', { class: 'actions' },
      h('button', { class: 'btn primary small', onclick: () => scheduleDialog(s) }, 'תזמון'),
      h('button', { class: 'btn small', onclick: action(() => api('POST', `/api/submissions/${s.id}/auto`, {}).then((r) => `שובץ ל${fmtWhen(r.deliveries.at(-1).send_at)}`)) }, 'למשבצת הבאה'),
      h('button', { class: 'btn small', onclick: () => (hasPending ? confirmSendNow(s) : scheduleDialog(s, { now: true })) }, 'שלח עכשיו'),
      hasPending && h('button', { class: 'btn small danger', onclick: action(() => api('POST', `/api/submissions/${s.id}/cancel`).then(() => 'השליחות בוטלו')) }, 'בטל שליחות'),
      h('button', { class: 'btn ghost small danger', onclick: action(async () => {
        if (!confirm('למחוק את ההגשה ואת הקבצים שלה?')) return
        await api('DELETE', `/api/submissions/${s.id}`)
        return 'נמחק'
      }) }, 'מחיקה')))
}

function confirmSendNow(s) {
  if (!confirm('לשלוח עכשיו את כל השליחות המתוזמנות של הפרסום הזה?')) return
  action(() => api('POST', `/api/submissions/${s.id}/send-now`, {}).then(() => 'נשלח לתור, יוצא תוך רגע'))()
}

function openDialog(...content) {
  const d = $('#dialog')
  $('#dialog-body').replaceChildren(...content)
  d.showModal()
  return d
}
const closeDialog = () => $('#dialog').close()

function groupChecks(selected = []) {
  if (!state.groups.length) return h('p', { class: 'muted' }, 'אין קבוצות. הוסיפו את הבוט לקבוצות בוואטסאפ ורעננו בלשונית "חיבור".')
  return h('div', { class: 'checks' }, state.groups.map((g) =>
    h('label', {}, h('input', { type: 'checkbox', name: 'group', value: g.jid, checked: selected.includes(g.jid) }), g.subject)))
}

function scheduleDialog(s, { now = false } = {}) {
  const customer = state.customers.find((c) => c.phone === s.phone)
  const defaultGroups = [...new Set((customer?.slots || []).flatMap((x) => x.groups))]
  const nextHour = Math.ceil((Date.now() + 60_000) / 3600_000) * 3600_000
  const when = h('input', { type: 'datetime-local', name: 'when', value: toLocalInput(nextHour), required: true })
  const notify = h('input', { type: 'checkbox', name: 'notify', checked: s.source === 'whatsapp' })

  openDialog(
    h('h2', {}, now ? 'שליחה עכשיו' : 'תזמון פרסום'),
    h('div', { class: 'stack' },
      !now && h('label', {}, 'מתי', when),
      h('div', {}, h('label', { style: 'margin-bottom:6px' }, 'לאילו קבוצות'), groupChecks(defaultGroups)),
      !now && s.source === 'whatsapp' && h('label', { class: 'inline' }, notify, 'לעדכן את הלקוח בוואטסאפ')),
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', type: 'button', onclick: action(async () => {
        const groups = [...document.querySelectorAll('#dialog input[name=group]:checked')].map((i) => i.value)
        if (!groups.length) throw new Error('בחרו לפחות קבוצה אחת')
        if (now) await api('POST', `/api/submissions/${s.id}/send-now`, { groups })
        else await api('POST', `/api/submissions/${s.id}/schedule`, { sendAt: fromInput(when.value), groups, notify: notify.checked })
        closeDialog()
        return now ? 'נשלח לתור, יוצא תוך רגע' : 'תוזמן'
      }) }, now ? 'שלח' : 'שמירה'),
      h('button', { class: 'btn', type: 'button', onclick: closeDialog }, 'ביטול')))
}

function editDelivery(d) {
  const when = h('input', { type: 'datetime-local', value: toLocalInput(d.send_at), required: true })
  openDialog(
    h('h2', {}, `שינוי מועד · ${d.group_name || groupName(d.group_jid)}`),
    h('div', { class: 'stack' }, h('label', {}, 'מועד חדש', when)),
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', type: 'button', onclick: action(async () => {
        await api('PATCH', `/api/deliveries/${d.id}`, { sendAt: fromInput(when.value) })
        closeDialog()
        return 'עודכן'
      }) }, 'שמירה'),
      h('button', { class: 'btn', type: 'button', onclick: closeDialog }, 'ביטול')))
}

// ---------------- calendar ----------------

function calRow(d) {
  return h('div', { class: 'cal-row' },
    h('div', { class: 'time' }, fmtTime(d.send_at)),
    h('div', {},
      h('div', {}, h('strong', {}, customerName(d.phone, d.customer_name)), ' ← ', d.group_name || d.group_jid),
      d.error && d.status === 'failed' ? h('div', { class: 'small error' }, d.error) : null),
    h('div', { class: 'row', style: 'gap:6px' },
      badge(d.status),
      d.status === 'pending' && h('button', { class: 'btn ghost small', onclick: () => editDelivery(d) }, 'שינוי'),
      d.status === 'pending' && h('button', { class: 'btn ghost small danger', onclick: action(() => api('PATCH', `/api/deliveries/${d.id}`, { status: 'cancelled' }).then(() => 'בוטל')) }, 'ביטול')))
}

async function renderCalendar() {
  await loadBasics()
  const offset = state.calOffset || 0
  const from = startOfDay(Date.now() + offset * 14 * 86400_000)
  const to = startOfDay(from + 14 * 86400_000 + 3 * 3600_000)
  const rows = await api('GET', `/api/calendar?from=${from}&to=${to}`)

  const byDay = new Map()
  for (const r of rows) {
    const key = fmtDate(r.send_at)
    if (!byDay.has(key)) byDay.set(key, [])
    byDay.get(key).push(r)
  }
  return h('div', {},
    h('div', { class: 'row spread', style: 'margin-bottom:16px' },
      h('button', { class: 'btn small', onclick: () => go('calendar', { calOffset: offset - 1 }) }, '→ שבועיים קודמים'),
      h('strong', {}, `${fmtDate(from)} – ${fmtDate(to - 1)}`),
      h('button', { class: 'btn small', onclick: () => go('calendar', { calOffset: offset + 1 }) }, 'שבועיים הבאים ←')),
    byDay.size
      ? [...byDay].map(([day, list]) => h('div', { class: 'day' }, h('h3', {}, day), h('div', { class: 'card list' }, list.map(calRow))))
      : h('div', { class: 'card empty' }, 'אין שליחות בתקופה הזאת'))
}

// ---------------- customers ----------------

async function renderCustomers() {
  await loadBasics()
  const strangers = await api('GET', '/api/strangers')
  refreshStatus()

  const addForm = h('form', { class: 'card row', style: 'align-items:end', onsubmit: (e) => {
    e.preventDefault()
    const f = e.target
    action(async () => {
      await api('POST', '/api/customers', { name: f.name.value, phone: f.phone.value })
      return 'הלקוח נוסף. עכשיו אפשר להגדיר לו משבצות.'
    })()
  } },
  h('label', { style: 'flex:1;min-width:160px' }, 'שם', h('input', { name: 'name', required: true })),
  h('label', { style: 'flex:1;min-width:160px' }, 'טלפון', h('input', { name: 'phone', type: 'tel', required: true, placeholder: '050-1234567', dir: 'ltr' })),
  h('button', { class: 'btn primary', type: 'submit' }, 'הוספת לקוח'))

  return h('div', { class: 'stack' },
    strangers.length ? h('div', { class: 'card', style: 'border-color:var(--warn)' },
      h('h3', {}, 'כתבו לבוט ואינם רשומים'),
      strangers.map((s) => h('div', { class: 'row spread', style: 'padding:6px 0;border-bottom:1px solid var(--border)' },
        h('div', {}, h('strong', {}, s.name || 'ללא שם'), ' ', h('span', { dir: 'ltr' }, phoneLabel(s.phone)),
          h('div', { class: 'muted small' }, `${fmtAgo(s.last_at)} · "${(s.last_text || '').slice(0, 60)}"`)),
        h('div', { class: 'row', style: 'gap:6px' },
          h('button', { class: 'btn primary small', onclick: action(() => api('POST', '/api/customers', { phone: s.phone, name: s.name || '' }).then(() => 'נוסף כלקוח')) }, 'הוסף כלקוח'),
          h('button', { class: 'btn ghost small', onclick: action(() => api('DELETE', `/api/strangers/${s.phone}`)) }, 'התעלם'))))) : null,
    addForm,
    state.customers.length ? state.customers.map(customerCard) : h('div', { class: 'card empty' }, 'אין עדיין לקוחות'))
}

function customerCard(c) {
  const slotsBox = h('div', {})
  const slotRow = (s = { weekday: 0, time: '10:00', groups: [], active: true }) => {
    const row = h('div', { class: 'slot' },
      h('select', { name: 'weekday' }, WEEKDAYS.map((d, i) => h('option', { value: i, selected: i === s.weekday }, d))),
      h('input', { type: 'time', name: 'time', value: s.time, required: true }),
      groupChecks(s.groups),
      h('button', { class: 'btn ghost small danger slot-del', type: 'button', onclick: () => row.remove() }, 'הסרה'))
    return row
  }
  for (const s of c.slots) slotsBox.append(slotRow(s))

  const saveSlots = action(async () => {
    const slots = [...slotsBox.querySelectorAll('.slot')].map((row) => ({
      weekday: Number(row.querySelector('[name=weekday]').value),
      time: row.querySelector('[name=time]').value,
      groups: [...row.querySelectorAll('input[name=group]:checked')].map((i) => i.value),
    }))
    if (slots.some((s) => !s.groups.length)) throw new Error('בכל משבצת צריך לבחור לפחות קבוצה אחת')
    await api('PUT', `/api/customers/${c.phone}/slots`, slots)
    return 'המשבצות נשמרו'
  })

  return h('details', { class: 'card', open: !c.slots.length || undefined },
    h('summary', { style: 'cursor:pointer;list-style:none' },
      h('div', { class: 'row spread' },
        h('div', {},
          h('strong', {}, c.name || 'ללא שם'), ' ',
          h('span', { class: 'muted', dir: 'ltr' }, phoneLabel(c.phone)),
          !c.active && h('span', { class: 'badge b-cancelled', style: 'margin-inline-start:8px' }, 'מושבת')),
        h('div', { class: 'muted small' },
          c.slots.length ? c.slots.map((s) => `${WEEKDAYS[s.weekday]} ${s.time}`).join(' · ') : 'אין משבצות',
          ` · ${c.submissions} הגשות`))),
    h('div', { class: 'stack', style: 'margin-top:14px' },
      h('h3', {}, 'משבצות קבועות'),
      h('p', { class: 'muted small', style: 'margin:0' }, 'כל מה שהלקוח שולח נכנס אוטומטית למשבצת הפנויה הבאה.'),
      slotsBox,
      h('div', { class: 'row' },
        h('button', { class: 'btn small', type: 'button', onclick: () => slotsBox.append(slotRow()) }, '+ משבצת'),
        h('button', { class: 'btn primary small', type: 'button', onclick: saveSlots }, 'שמירת משבצות')),
      h('div', { class: 'row', style: 'border-top:1px solid var(--border);padding-top:12px' },
        h('button', { class: 'btn small', onclick: () => go('inbox', { inboxFilter: 'all', inboxPhone: c.phone }) }, 'הגשות של הלקוח'),
        h('button', { class: 'btn small', onclick: () => editCustomer(c) }, 'עריכת פרטים'),
        h('button', { class: 'btn small', onclick: action(() => api('PUT', `/api/customers/${c.phone}`, { active: !c.active }).then(() => (c.active ? 'הלקוח הושבת' : 'הלקוח הופעל'))) }, c.active ? 'השבתה' : 'הפעלה'),
        h('button', { class: 'btn ghost small danger', onclick: action(async () => {
          if (!confirm(`למחוק את ${c.name || c.phone}? ההגשות שלו יישארו.`)) return
          await api('DELETE', `/api/customers/${c.phone}`)
          return 'נמחק'
        }) }, 'מחיקה'))))
}

function editCustomer(c) {
  const name = h('input', { value: c.name })
  const notes = h('textarea', { value: c.notes })
  openDialog(
    h('h2', {}, 'עריכת לקוח'),
    h('div', { class: 'stack' }, h('label', {}, 'שם', name), h('label', {}, 'הערות', notes)),
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', type: 'button', onclick: action(async () => {
        await api('PUT', `/api/customers/${c.phone}`, { name: name.value, notes: notes.value })
        closeDialog()
        return 'נשמר'
      }) }, 'שמירה'),
      h('button', { class: 'btn', type: 'button', onclick: closeDialog }, 'ביטול')))
}

// ---------------- new post ----------------

async function renderNew() {
  await loadBasics()
  const form = h('form', { class: 'card stack', onsubmit: (e) => {
    e.preventDefault()
    action(async () => {
      const fd = new FormData(e.target)
      if (!fd.get('text') && !e.target.files.files.length) throw new Error('צריך טקסט או קובץ')
      const sub = await api('POST', '/api/submissions', fd)
      e.target.reset()
      scheduleDialog(sub)
      return 'הועלה. עכשיו בחרו מתי לשלוח.'
    }, { rerender: false })(e)
  } },
  h('h2', {}, 'פרסום חדש מהאתר'),
  h('label', {}, 'עבור', h('select', { name: 'phone' },
    h('option', { value: '' }, 'אני'),
    state.customers.map((c) => h('option', { value: c.phone }, customerName(c.phone, c.name))))),
  h('label', {}, 'טקסט (יוצמד כתיאור לקובץ הראשון)', h('textarea', { name: 'text' })),
  h('label', {}, 'קבצים', h('input', { type: 'file', name: 'files', multiple: true })),
  h('button', { class: 'btn primary', type: 'submit' }, 'העלאה והמשך לתזמון'))
  return form
}

// ---------------- connection ----------------

async function renderConnection() {
  await Promise.all([refreshStatus(), loadBasics()])
  const s = state.status
  const phoneInput = h('input', { type: 'tel', dir: 'ltr', value: (s.ownerPhones || []).map(phoneLabel).join(', '), placeholder: '050-1234567' })
  const curPw = h('input', { type: 'password', autocomplete: 'current-password' })
  const newPw = h('input', { type: 'password', autocomplete: 'new-password' })
  return h('div', { class: 'stack' },
    storageBanner(),
    h('div', { class: 'card qr' },
      h('h2', {}, `וואטסאפ: ${CONN[s.state] || s.state}`),
      s.state === 'open' && h('p', { class: 'muted', dir: 'ltr' }, phoneLabel(s.me)),
      s.state === 'open' && s.connectedSince && h('p', { class: 'muted small' }, `מחובר מאז ${fmtWhen(s.connectedSince)}`),
      s.qr && [h('p', {}, 'בטלפון של הבוט: וואטסאפ ← מכשירים מקושרים ← קישור מכשיר, וסרקו:'), h('img', { src: s.qr, alt: 'QR' })],
      s.pairingCode && [h('p', {}, 'או הזינו קוד צימוד:'), h('div', { class: 'pair' }, s.pairingCode)],
      s.state === 'connecting' || s.state === 'closed' ? h('p', { class: 'muted' }, 'הבוט מתחבר מחדש לבד. אין צורך לעשות כלום.') : null),
    h('div', { class: 'card' },
      h('div', { class: 'row spread' },
        h('h2', { style: 'margin:0' }, `קבוצות (${state.groups.length})`),
        h('button', { class: 'btn small', onclick: action(() => api('POST', '/api/groups/refresh').then(() => 'הרשימה עודכנה')) }, 'רענון מוואטסאפ')),
      h('p', { class: 'muted small' }, 'כדי לשלוח לקבוצה, הבוט צריך להיות חבר בה. מוסיפים אותו כמו כל משתתף.'),
      state.groups.length ? h('div', { class: 'checks' }, state.groups.map((g) => h('span', { class: 'chip' }, g.subject))) : h('p', { class: 'muted' }, 'אין עדיין קבוצות')),
    h('div', { class: 'card stack' },
      h('h2', {}, 'הגדרות'),
      h('div', { class: 'row', style: 'align-items:end' },
        h('label', { style: 'flex:1;min-width:200px' }, 'המספר שלך (מקבל התראות ויכול לתת פקודות לבוט)', phoneInput),
        h('button', { class: 'btn small', onclick: action(() => api('PUT', '/api/settings', { ownerPhone: phoneInput.value }).then(() => 'נשמר')) }, 'שמירה')),
      h('div', { class: 'row', style: 'align-items:end' },
        h('label', { style: 'flex:1;min-width:150px' }, 'סיסמה נוכחית', curPw),
        h('label', { style: 'flex:1;min-width:150px' }, 'סיסמה חדשה', newPw),
        h('button', { class: 'btn small', onclick: action(async () => {
          await api('PUT', '/api/settings', { currentPassword: curPw.value, newPassword: newPw.value })
          showLogin()
          return 'הסיסמה הוחלפה. היכנסו עם הסיסמה החדשה.'
        }, { rerender: false }) }, 'החלפת סיסמה'))))
}

// ---------------- boot ----------------

async function start() {
  try {
    tz = (await api('GET', '/api/status')).timeZone || tz
  } catch {
    return showLogin()
  }
  $('#login').hidden = true
  $('#app').hidden = false
  const fromHash = location.hash.slice(1)
  if (['home', 'inbox', 'calendar', 'customers', 'new', 'connection'].includes(fromHash)) state.tab = fromHash
  await render()
}

// keep the screen fresh without interrupting the user
setInterval(async () => {
  if ($('#app').hidden || document.hidden) return
  await refreshStatus()
  const busy = $('#dialog').open || document.activeElement?.matches('input, textarea, select') || view.querySelector('details[open] .slot')
  if (state.tab === 'connection' || (!busy && ['home', 'inbox', 'calendar'].includes(state.tab))) render()
}, 10_000)

start()
