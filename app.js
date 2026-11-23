import { createStore, DuplicateReceipt } from './store.js';
import { parseReceipt, scoreItems, receiptKey, fileHash, itemWeight } from './parser.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (c) => '$' + ((c || 0) / 100).toFixed(2);
const MAX_AGE_DAYS = 30;

let store;
let board = { scope: 'friends', metric: 'items' };
let pending = null; // { imgHash }

/* ---------- toast ---------- */
let toastTimer;
function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast' + (bad ? ' bad' : ''); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 3200);
}

/* ---------- boot ---------- */
(async function boot() {
  try { store = await createStore(); }
  catch (e) { console.error(e); toast('Could not reach the server. Check your connection.', true); return; }

  $('#mode-banner').hidden = store.mode !== 'local';
  $('#welcome-cloud').hidden = store.mode !== 'cloud';
  $('#welcome-local').hidden = store.mode !== 'local';
  if (store.mode === 'local') $('#board-scope').hidden = true;

  store.onUser((me) => {
    $('#view-welcome').hidden = !!me;
    $('#app').hidden = !me;
    $('#user-chip').hidden = !me;
    if (me) { renderChip(); showView('scan'); }
  });
})();

const AUTH_ERRORS = {
  'auth/configuration-not-found': 'Google sign-in isn\'t turned on for this site yet.',
  'auth/operation-not-allowed': 'Google sign-in isn\'t turned on for this site yet.',
  'auth/unauthorized-domain': 'This website isn\'t on the sign-in allow list yet.',
  'auth/popup-closed-by-user': 'Sign-in was closed before it finished.',
  'auth/network-request-failed': 'No connection. Try again.',
};
$('#btn-google').onclick = () => store.signIn().catch((e) => { console.error(e); toast(AUTH_ERRORS[e.code] || 'Sign-in failed. Try again.', true); });
$('#welcome-local').onsubmit = (e) => { e.preventDefault(); store.signIn($('#local-name').value.trim()); };
$('#btn-signout').onclick = () => store.signOut();
$('#user-chip').onclick = () => showView('me');

function renderChip() {
  const me = store.me();
  $('#user-chip').textContent = `${me.name} · ${me.totals.items} 🍔`;
}

/* ---------- tabs ---------- */
document.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => showView(b.dataset.view)));

function showView(name) {
  for (const v of ['scan', 'board', 'friends', 'me']) $('#view-' + v).hidden = v !== name;
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === name));
  window.scrollTo(0, 0);
  ({ scan: renderRecent, board: renderBoard, friends: renderFriends, me: renderMe })[name]();
}

/* ---------- scanning ---------- */
$('#file-camera').onchange = (e) => handleFile(e.target);
$('#file-upload').onchange = (e) => handleFile(e.target);

let tesseractReady;
function loadTesseract() {
  return (tesseractReady ||= new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.0/dist/tesseract.min.js';
    s.onload = () => res(window.Tesseract);
    s.onerror = () => { tesseractReady = null; rej(new Error('Could not load the text reader.')); };
    document.head.appendChild(s);
  }));
}

async function prepImage(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(2.5, Math.max(1, 1800 / Math.max(bmp.width, bmp.height)));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  const ctx = c.getContext('2d');
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  // Grayscale and stretch contrast. Dark-mode screenshots get inverted so text is dark on light.
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum += d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
  const invert = sum / (d.length / 4) < 110;
  for (let i = 0; i < d.length; i += 4) {
    let g = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    if (invert) g = 255 - g;
    g = Math.max(0, Math.min(255, (g - 128) * 1.5 + 128));
    d[i] = d[i + 1] = d[i + 2] = g;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function seenImages() { try { return JSON.parse(localStorage.getItem('fryleague:imgs')) || []; } catch { return []; } }
function rememberImage(h) { try { localStorage.setItem('fryleague:imgs', JSON.stringify([h, ...seenImages()].slice(0, 500))); } catch {} }

async function handleFile(input) {
  const file = input.files[0];
  input.value = '';
  if (!file) return;

  const imgHash = await fileHash(file);
  if (seenImages().includes(imgHash)) return toast('You already scanned this exact picture.', true);

  $('#scan-start').hidden = true;
  $('#scan-progress').hidden = false;
  $('#review-thumb').src = URL.createObjectURL(file);
  setProgress(0.05, 'Loading the text reader');

  let parsed;
  try {
    const T = await loadTesseract();
    const canvas = await prepImage(file);
    const { data } = await T.recognize(canvas, 'eng', {
      logger: (m) => {
        if (m.status === 'recognizing text') setProgress(0.3 + m.progress * 0.7, 'Reading text');
        else if (m.progress != null) setProgress(0.05 + m.progress * 0.25, 'Getting ready');
      },
    });
    parsed = parseReceipt(data.text);
    console.debug('[ocr]', data.text, parsed);
  } catch (e) {
    console.error(e);
    toast("Couldn't read that one. You can type it in.", true);
    parsed = { order: '', store: '', date: '', time: '', totalCents: null, items: [] };
  }
  pending = { imgHash };
  openReview(parsed);
}

function setProgress(p, label) {
  $('#progress-bar').style.width = Math.round(p * 100) + '%';
  $('#progress-label').textContent = label;
}

function openReview(p) {
  $('#scan-progress').hidden = true;
  $('#scan-review').hidden = false;
  $('#r-order').value = p.order;
  $('#r-store').value = p.store;
  $('#r-date').value = p.date;
  $('#r-time').value = p.time;
  $('#r-total').value = p.totalCents != null ? (p.totalCents / 100).toFixed(2) : '';
  $('#r-items').innerHTML = '';
  (p.items.length ? p.items : [{ qty: 1, name: '' }]).forEach(addItemRow);
  updateScore();
  if (!p.order) toast("Couldn't find the order number. Type it in from the receipt.");
}

function addItemRow(it = { qty: 1, name: '' }) {
  const li = document.createElement('li');
  li.innerHTML = `<input class="q" type="number" min="0" max="20" value="${esc(it.qty)}" aria-label="Quantity">
    <input class="n" value="${esc(it.name)}" placeholder="Item name" aria-label="Item">
    <button type="button" class="x" aria-label="Remove">✕</button>`;
  li.querySelector('.x').onclick = () => { li.remove(); updateScore(); };
  li.addEventListener('input', updateScore);
  $('#r-items').appendChild(li);
}
$('#btn-add-item').onclick = () => { addItemRow(); updateScore(); $('#r-items li:last-child .n').focus(); };

function readItems() {
  return [...document.querySelectorAll('#r-items li')]
    .map((li) => ({ qty: Math.floor(+li.querySelector('.q').value || 0), name: li.querySelector('.n').value.trim().slice(0, 60) }))
    .filter((it) => it.name && it.qty > 0);
}

function updateScore() {
  const items = readItems();
  const { itemCount, nuggets } = scoreItems(items);
  const combos = items.filter((i) => itemWeight(i.name) > 1).length;
  $('#score-preview').textContent =
    `+${itemCount} items` + (nuggets ? ` · +${nuggets} nuggets` : '') + (combos ? ` (meals/combos count as 3)` : '');
}

function closeReview() {
  $('#scan-review').hidden = true;
  $('#scan-start').hidden = false;
  pending = null;
}
$('#btn-cancel').onclick = closeReview;

$('#scan-review').onsubmit = async (e) => {
  e.preventDefault();
  const order = $('#r-order').value.replace(/\D/g, '');
  const date = $('#r-date').value;
  const totalCents = Math.round(parseFloat(($('#r-total').value || '0').replace(',', '.')) * 100) || 0;
  const items = readItems();
  const { itemCount, nuggets } = scoreItems(items);

  if (!order) return toast('Add the order number.', true);
  const age = (Date.now() - new Date(date + 'T12:00').getTime()) / 864e5;
  if (!date || age < -1) return toast('That date looks wrong.', true);
  if (age > MAX_AGE_DAYS) return toast(`Only receipts from the last ${MAX_AGE_DAYS} days count.`, true);
  if (!$('#r-store').value && !$('#r-time').value && !totalCents) return toast('Add the store #, time, or total so we can tell receipts apart.', true);
  if (!itemCount) return toast('Add at least one item.', true);
  if (itemCount > 40) return toast("That's more than 40 items. Split it up or check the quantities.", true);
  if (totalCents > 30000) return toast('Totals over $300 are not allowed.', true);

  const meta = { order, store: $('#r-store').value.replace(/\D/g, ''), date, time: $('#r-time').value, totalCents };
  const key = await receiptKey(meta);
  $('#btn-claim').disabled = true;
  try {
    await store.claimMeal(key, { ...meta, items, itemCount, nuggets });
    if (pending) rememberImage(pending.imgHash);
    closeReview();
    renderChip();
    renderRecent();
    toast(`+${itemCount} items claimed! 🍟`);
  } catch (err) {
    console.error(err);
    if (err instanceof DuplicateReceipt) toast(err.message, true);
    else toast("Couldn't save that. Try again.", true);
  } finally {
    $('#btn-claim').disabled = false;
  }
};

/* ---------- feeds ---------- */
function mealRow(m) {
  const names = m.items.map((i) => (i.qty > 1 ? `${i.qty}× ` : '') + i.name).join(', ');
  return `<li><div><div>${esc(names)}</div><div class="sub">${esc(m.date)} · order #${esc(m.order)}${m.totalCents ? ' · ' + money(m.totalCents) : ''}</div></div><b>+${m.itemCount}</b></li>`;
}

async function renderRecent() {
  const meals = await store.meals(5);
  $('#recent-meals').innerHTML = meals.length ? meals.map(mealRow).join('') : '<li class="empty">Nothing yet. Go eat something.</li>';
}

/* ---------- leaderboard ---------- */
document.querySelectorAll('#board-scope button').forEach((b) => (b.onclick = () => { board.scope = b.dataset.scope; segOn('#board-scope', b); renderBoard(); }));
document.querySelectorAll('#board-metric button').forEach((b) => (b.onclick = () => { board.metric = b.dataset.metric; segOn('#board-metric', b); renderBoard(); }));
function segOn(sel, btn) { document.querySelectorAll(sel + ' button').forEach((b) => b.classList.toggle('on', b === btn)); }

async function renderBoard() {
  const el = $('#board');
  el.innerHTML = '<li class="empty">Loading…</li>';
  try {
    const rows = await store.leaderboard(board.scope, board.metric);
    const me = store.me();
    const fmt = (v) => (board.metric === 'spendCents' ? money(v) : (v || 0).toLocaleString());
    el.innerHTML = rows.map((r, i) => `<li class="${r.uid === me.uid ? 'me' : ''}">
      <span class="rank">${i + 1}</span><span class="name">${esc(r.name)}${r.uid === me.uid ? ' (you)' : ''}</span>
      <span class="val">${fmt(r.totals?.[board.metric])}</span></li>`).join('');
    if (board.scope === 'friends' && rows.length < 2)
      el.insertAdjacentHTML('beforeend', `<li class="empty">${store.mode === 'local' ? 'Friends and rankings need the online version.' : 'Add friends to start a rivalry.'}</li>`);
  } catch (e) {
    console.error(e);
    el.innerHTML = '<li class="empty">Could not load the leaderboard.</li>';
  }
}

/* ---------- friends ---------- */
async function renderFriends() {
  $('#my-code').textContent = store.me().friendCode;
  const list = await store.friends();
  $('#friends').innerHTML = list.length
    ? list.map((f) => `<li><div><div>${esc(f.name)}</div><div class="sub">${f.totals.items} items · ${f.totals.meals} meals</div></div><button class="btn btn-ghost" data-rm="${esc(f.uid)}">Remove</button></li>`).join('')
    : '<li class="empty">No friends yet. Share your code.</li>';
  document.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = async () => {
    if (!confirm('Remove this friend?')) return;
    await store.removeFriend(b.dataset.rm); renderFriends();
  }));
}

$('#btn-share').onclick = async () => {
  const code = store.me().friendCode;
  const text = `Think you can out-eat me? Add me on Fry League with code ${code}: ${location.origin}${location.pathname}`;
  try {
    if (navigator.share) await navigator.share({ text });
    else { await navigator.clipboard.writeText(text); toast('Copied invite to clipboard'); }
  } catch {}
};

$('#add-friend').onsubmit = async (e) => {
  e.preventDefault();
  try {
    const name = await store.addFriend($('#friend-code').value.trim());
    $('#friend-code').value = '';
    toast(`You and ${name} are now rivals.`);
    renderFriends();
  } catch (err) { toast(err.message, true); }
};

/* ---------- me ---------- */
async function renderMe() {
  const me = await store.refreshMe();
  const t = me.totals;
  $('#my-stats').innerHTML = [
    [t.items, 'items eaten'], [t.meals, 'receipts'], [t.nuggets, 'nuggets'], [money(t.spendCents), 'spent'],
  ].map(([v, l]) => `<div class="stat"><b>${esc(v)}</b><span>${l}</span></div>`).join('');
  $('#my-name').value = me.name;
  const meals = await store.meals(50);
  $('#all-meals').innerHTML = meals.length ? meals.map(mealRow).join('') : '<li class="empty">No meals yet.</li>';
}

$('#rename').onsubmit = async (e) => {
  e.preventDefault();
  const name = $('#my-name').value.trim();
  if (!name) return;
  await store.rename(name);
  renderChip();
  toast('Saved');
};
