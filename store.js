// Data layer. Two backends with the same interface:
//  - cloud: Firebase Auth + Firestore (friends, global leaderboard, receipts unique across everyone)
//  - local: localStorage on this device (solo mode, used when no Firebase config is set)

import { firebaseConfig } from './firebase-config.js';

const FB = 'https://www.gstatic.com/firebasejs/10.12.2/';
const ZERO = { items: 0, meals: 0, spendCents: 0, nuggets: 0 };

export class DuplicateReceipt extends Error {
  constructor(mine) { super(mine ? 'You already claimed this receipt.' : 'Someone already claimed this receipt.'); this.mine = mine; }
}

function makeCode() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const r = crypto.getRandomValues(new Uint8Array(6));
  return [...r].map((n) => abc[n % abc.length]).join('');
}

export async function createStore() {
  return firebaseConfig ? createCloudStore() : createLocalStore();
}

/* ---------------- Cloud ---------------- */

async function createCloudStore() {
  const [{ initializeApp }, A, F] = await Promise.all([
    import(FB + 'firebase-app.js'),
    import(FB + 'firebase-auth.js'),
    import(FB + 'firebase-firestore.js'),
  ]);
  const app = initializeApp(firebaseConfig);
  const auth = A.getAuth(app);
  const db = F.getFirestore(app);
  let me = null; // { uid, ...profile }

  async function loadProfile(user) {
    const ref = F.doc(db, 'users', user.uid);
    let snap = await F.getDoc(ref);
    if (!snap.exists()) {
      await F.setDoc(ref, {
        name: (user.displayName || 'Hungry Player').slice(0, 30),
        friendCode: makeCode(),
        totals: { ...ZERO },
        createdAt: F.serverTimestamp(),
      });
      snap = await F.getDoc(ref);
    }
    return { uid: user.uid, ...snap.data() };
  }

  const profileOf = async (uid) => {
    const s = await F.getDoc(F.doc(db, 'users', uid));
    return s.exists() ? { uid, ...s.data() } : null;
  };

  return {
    mode: 'cloud',

    onUser(cb) {
      A.getRedirectResult(auth).catch(() => {});
      A.onAuthStateChanged(auth, async (user) => {
        me = user ? await loadProfile(user) : null;
        cb(me);
      });
    },

    async signIn() {
      const provider = new A.GoogleAuthProvider();
      try { await A.signInWithPopup(auth, provider); }
      catch (e) {
        if (/popup|cancelled-popup|operation-not-supported/.test(e.code || '')) await A.signInWithRedirect(auth, provider);
        else throw e;
      }
    },

    signOut: () => A.signOut(auth),

    me: () => me,
    async refreshMe() { me = await profileOf(me.uid); return me; },

    async rename(name) {
      await F.updateDoc(F.doc(db, 'users', me.uid), { name });
      me.name = name;
    },

    async claimMeal(key, meal) {
      const rRef = F.doc(db, 'receipts', key);
      const uRef = F.doc(db, 'users', me.uid);
      const mRef = F.doc(F.collection(db, 'users', me.uid, 'meals'));
      await F.runTransaction(db, async (tx) => {
        const r = await tx.get(rRef);
        if (r.exists()) throw new DuplicateReceipt(r.data().uid === me.uid);
        const u = await tx.get(uRef);
        const t = { ...ZERO, ...u.data().totals };
        tx.set(rRef, { uid: me.uid, mealId: mRef.id, createdAt: F.serverTimestamp() });
        tx.set(mRef, { ...meal, receiptKey: key, createdAt: F.serverTimestamp() });
        tx.update(uRef, {
          totals: {
            items: t.items + meal.itemCount,
            meals: t.meals + 1,
            spendCents: t.spendCents + meal.totalCents,
            nuggets: t.nuggets + meal.nuggets,
          },
          lastMeal: mRef.id,
        });
      });
      await this.refreshMe();
    },

    async meals(max = 50) {
      const q = F.query(F.collection(db, 'users', me.uid, 'meals'), F.orderBy('createdAt', 'desc'), F.limit(max));
      return (await F.getDocs(q)).docs.map((d) => ({ id: d.id, ...d.data(), createdAt: d.data().createdAt?.toDate?.() }));
    },

    async friends() {
      const snap = await F.getDocs(F.collection(db, 'users', me.uid, 'friends'));
      return (await Promise.all(snap.docs.map((d) => profileOf(d.id)))).filter(Boolean);
    },

    async addFriend(code) {
      const q = F.query(F.collection(db, 'users'), F.where('friendCode', '==', code.toUpperCase()), F.limit(1));
      const res = await F.getDocs(q);
      if (res.empty) throw new Error('No one has that code.');
      const them = res.docs[0].id;
      if (them === me.uid) throw new Error("That's your own code.");
      const b = F.writeBatch(db);
      b.set(F.doc(db, 'users', me.uid, 'friends', them), { since: F.serverTimestamp() });
      b.set(F.doc(db, 'users', them, 'friends', me.uid), { since: F.serverTimestamp() });
      await b.commit();
      return res.docs[0].data().name;
    },

    async removeFriend(uid) {
      const b = F.writeBatch(db);
      b.delete(F.doc(db, 'users', me.uid, 'friends', uid));
      b.delete(F.doc(db, 'users', uid, 'friends', me.uid));
      await b.commit();
    },

    async leaderboard(scope, metric) {
      if (scope === 'global') {
        const q = F.query(F.collection(db, 'users'), F.orderBy(`totals.${metric}`, 'desc'), F.limit(50));
        return (await F.getDocs(q)).docs.map((d) => ({ uid: d.id, ...d.data() }));
      }
      const list = [await this.refreshMe(), ...(await this.friends())];
      return list.sort((a, b) => (b.totals?.[metric] || 0) - (a.totals?.[metric] || 0));
    },
  };
}

/* ---------------- Local (solo) ---------------- */

function createLocalStore() {
  const K = 'fryleague:v1';
  const load = () => { try { return JSON.parse(localStorage.getItem(K)) || null; } catch { return null; } };
  const save = (s) => { try { localStorage.setItem(K, JSON.stringify(s)); } catch {} };
  let state = load();
  let listener = () => {};
  const me = () => state && { uid: 'local', name: state.name, friendCode: state.friendCode, totals: state.totals };

  return {
    mode: 'local',
    onUser(cb) { listener = cb; cb(me()); },
    async signIn(name) {
      state = { name, friendCode: makeCode(), totals: { ...ZERO }, meals: [], receipts: {} };
      save(state); listener(me());
    },
    async signOut() {
      if (!confirm('Signing out of solo mode erases your meals on this device. Continue?')) return;
      try { localStorage.removeItem(K); } catch {}
      state = null; listener(null);
    },
    me,
    async refreshMe() { return me(); },
    async rename(name) { state.name = name; save(state); },
    async claimMeal(key, meal) {
      if (state.receipts[key]) throw new DuplicateReceipt(true);
      const id = crypto.randomUUID();
      state.receipts[key] = id;
      state.meals.unshift({ id, ...meal, receiptKey: key, createdAt: new Date().toISOString() });
      const t = state.totals;
      t.items += meal.itemCount; t.meals += 1; t.spendCents += meal.totalCents; t.nuggets += meal.nuggets;
      save(state);
    },
    async meals(max = 50) { return state.meals.slice(0, max).map((m) => ({ ...m, createdAt: new Date(m.createdAt) })); },
    async friends() { return []; },
    async addFriend() { throw new Error('Friends need the online version. See the README to switch it on.'); },
    async removeFriend() {},
    async leaderboard(scope, metric) {
      return [me()].sort((a, b) => b.totals[metric] - a.totals[metric]);
    },
  };
}
