// Turns OCR text from a receipt (paper or app screenshot) into structured data.

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

// Lines that have a price but are not food.
const NOT_FOOD = /(sub\s*-?\s*total|\btotal\b|\btax\b|change|cash|visa|master|amex|discover|card|debit|credit|amount|balance|tender|paid|\btip\b|discount|savings|reward|points|refund|fee|bag|order|store|phone|tel\b|survey|auth|approval|ref\b|acct|account|chip|contactless|apple\s*pay|google\s*pay)/i;

const pad = (n) => String(n).padStart(2, '0');

export function parseReceipt(raw) {
  const text = raw.replace(/[|]/g, ' ').replace(/[ \t]+/g, ' ');
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  return {
    order: findOrder(text),
    store: findStore(text),
    date: findDate(text),
    time: findTime(text),
    totalCents: findTotal(lines),
    items: findItems(lines),
  };
}

function findOrder(text) {
  const pats = [
    /order\s*(?:number|num|no\.?|#)\s*[:#]?\s*(\d{1,6})/i,
    /\bord(?:er)?\s*[:#]\s*(\d{1,6})/i,
    /order\s+(\d{1,6})\b/i,
    /(?:^|\s)#\s?(\d{2,6})\b/m,
  ];
  for (const p of pats) { const m = text.match(p); if (m) return m[1]; }
  return '';
}

function findStore(text) {
  const m = text.match(/(?:store|str|restaurant|rest\.?|location)\s*(?:#|no\.?|number|id)?\s*[:#]?\s*(\d{3,6})/i);
  return m ? m[1] : '';
}

function findDate(text) {
  let m = text.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/);
  if (m) {
    let [, a, b, y] = m;
    y = y.length === 2 ? '20' + y : y;
    let mo = +a, d = +b;
    if (mo > 12 && d <= 12) [mo, d] = [d, mo]; // day-first receipts
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return `${y}-${pad(mo)}-${pad(d)}`;
  }
  m = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = text.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/i);
  if (m) return `${m[3]}-${pad(MONTHS[m[1].toLowerCase()])}-${pad(+m[2])}`;
  m = text.match(/\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+(\d{4})/i);
  if (m) return `${m[3]}-${pad(MONTHS[m[2].toLowerCase()])}-${pad(+m[1])}`;
  return '';
}

function findTime(text) {
  const m = text.match(/\b(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap])\.?m?\.?\b/i) || text.match(/\b(\d{1,2}):(\d{2})(?::\d{2})?\b/);
  if (!m) return '';
  let h = +m[1];
  const ap = m[3] && m[3].toLowerCase();
  if (ap === 'p' && h < 12) h += 12;
  if (ap === 'a' && h === 12) h = 0;
  return h < 24 && +m[2] < 60 ? `${pad(h)}:${m[2]}` : '';
}

function toCents(s) { return Math.round(parseFloat(s.replace(',', '.')) * 100); }

function findTotal(lines) {
  let best = null;
  for (const l of lines) {
    if (/sub\s*-?\s*total/i.test(l)) continue;
    const m = l.match(/\btotal\b[^\d]*(\d{1,4}[.,]\d{2})/i);
    if (m) best = toCents(m[1]); // keep the last one; that's usually the grand total
  }
  return best;
}

function findItems(lines) {
  const items = [];
  const re = /^(?:(\d{1,2})\s*[xX]?\s+)?([A-Za-z0-9][A-Za-z0-9 &'’\-.\/®™]{1,48}?)\s+\$?\s?(\d{1,3}[.,]\d{2})\s*$/;
  for (const l of lines) {
    if (NOT_FOOD.test(l)) continue;
    const m = l.match(re);
    if (!m) continue;
    let qty = m[1] ? +m[1] : 1;
    let name = m[2].replace(/[®™]/g, '').replace(/\s+/g, ' ').trim();
    // "10 Pc McNuggets" with no quantity in front: the 10 is the piece count, not the quantity.
    if (m[1] && /^(pc|pcs|piece|pce|ct)\b/i.test(name)) { name = `${m[1]} ${name}`; qty = 1; }
    if (name.length < 3 || !/[a-z]{2}/i.test(name)) continue;
    items.push({ qty: Math.min(qty, 20), name });
  }
  return items;
}

// How many "items" one line is worth. A combo/meal is a main + side + drink.
export function itemWeight(name) {
  return /\b(meal|combo)\b/i.test(name) ? 3 : 1;
}

export function nuggetCount(name) {
  if (!/nug/i.test(name)) return 0;
  const m = name.match(/(\d{1,2})\s*-?\s*(?:pc|pcs|piece|pce|ct)?\b/i);
  return m ? Math.min(+m[1], 50) : 0;
}

export function scoreItems(items) {
  let itemCount = 0, nuggets = 0;
  for (const it of items) {
    const q = Math.max(0, Math.min(20, Math.floor(+it.qty || 0)));
    if (!it.name.trim() || !q) continue;
    itemCount += q * itemWeight(it.name);
    nuggets += q * nuggetCount(it.name);
  }
  return { itemCount, nuggets };
}

// The fingerprint that makes a receipt claimable once. Order numbers recycle,
// so it combines the order # with the store (or time) and the date.
export async function receiptKey({ order, store, date, time, totalCents }) {
  const digits = (s) => String(s || '').replace(/\D/g, '').replace(/^0+/, '');
  const where = digits(store) || (time ? 't' + String(time).slice(0, 5) : '$' + (totalCents ?? ''));
  const basis = `v1|${digits(order)}|${date}|${where}`;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(basis));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 40);
}

export async function fileHash(file) {
  const buf = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
