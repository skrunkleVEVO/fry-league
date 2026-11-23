# 🍟 Fry League

A competitive fast-food tracker. Scan your receipts, rack up items, and out-eat your friends on the leaderboard.

- **Scan receipts**: snap a paper receipt or upload a screenshot of the receipt in your fast-food app. Text is read on your phone with [Tesseract.js](https://github.com/naptha/tesseract.js); the image never leaves the device.
- **Every receipt counts once, ever**: each receipt gets a fingerprint from its order number, date, and store number (or time). The database refuses a second claim of the same fingerprint, by you or by anyone else. The exact same image is also blocked on your device.
- **Friends**: share your 6-letter friend code; adding someone links you both.
- **Leaderboards**: friends or global, ranked by items, meals, nuggets, or money spent. Meals and combos count as 3 items (main, side, drink).
- Only receipts from the last 30 days count.

Fan-made. Not affiliated with or endorsed by any restaurant chain.

## Running it

It's a static site (plain HTML/JS, no build step), hosted on GitHub Pages.

Out of the box it runs in **solo mode**: everything is saved in the browser on one device, and there are no friends or global rankings. To turn those on, connect a free Firebase project:

### Turn on friends and leaderboards (about 5 minutes, free)

1. Go to <https://console.firebase.google.com> → **Add project** (Analytics not needed).
2. **Build → Authentication → Get started → Sign-in method → Google → Enable**.
3. **Authentication → Settings → Authorized domains → Add domain** → `skrunklevevo.github.io`.
4. **Build → Firestore Database → Create database** (production mode, any region).
5. **Firestore → Rules**: replace everything with the contents of [`firestore.rules`](firestore.rules) and click **Publish**.
6. **Project settings (gear) → Your apps → Web (`</>`)** → register an app → copy the `firebaseConfig` object.
7. Paste it into [`firebase-config.js`](firebase-config.js) in place of `null`, then commit and push.

The Firebase web config is meant to be public; the security rules in `firestore.rules` are what protect the data.

## How cheating is limited

The rules in `firestore.rules` make sure:
- a receipt fingerprint can be created once and never edited or deleted;
- a meal can only be saved in the same transaction that claims its receipt;
- your totals can only go up by exactly what that meal adds, so nobody can type in a score.

What it can't stop: someone typing in an order number from a receipt they don't have. Text recognition runs on the phone, so a determined cheater can edit what it read. Treat the leaderboard as a friendly competition.

## Files

| File | What it does |
| --- | --- |
| `index.html`, `styles.css` | The app's screens |
| `app.js` | Screens, scanning, leaderboard, friends |
| `parser.js` | Turns receipt text into order #, date, items, total; builds the fingerprint |
| `store.js` | Saves data: Firebase when configured, otherwise this device |
| `firebase-config.js` | Your Firebase config (or `null` for solo mode) |
| `firestore.rules` | Database security rules (paste into the Firebase console) |
