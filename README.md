# Tripppyyy ✈️

> Real-time trip expense sharing with a group chat feel.

Plan trips together, split expenses in a group chat, and settle up with one-tap UPI payments.

---

## Setup (5 minutes)

### Step 1 — Create a Firebase project

1. Go to [console.firebase.google.com](https://console.firebase.google.com)
2. Click **Add project** → enter a name → Continue
3. Disable Google Analytics (optional) → **Create project**

### Step 2 — Add a web app

1. On the project overview, click the **⟨/⟩ Web** icon
2. Give it a nickname (e.g. "tripppyyy") → click **Register app**
3. Copy the `firebaseConfig` object shown

### Step 3 — Create your config file

In this project folder, create `firebase-config.js`:

```js
const FIREBASE_CONFIG = {
  apiKey: "...",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project-id",
  storageBucket: "your-project.appspot.com",
  messagingSenderId: "...",
  appId: "..."
};
```

> ⚠️ `firebase-config.js` is in `.gitignore` — **never commit it**.

### Step 4 — Enable Firestore

1. In Firebase Console → **Build → Firestore Database**
2. Click **Create database**
3. Choose **Start in test mode** → Next → select a region → **Done**
4. (Optional) Go to **Rules** tab and paste the contents of `firestore.rules`

### Step 5 — Run or Deploy

Open `index.html` directly in a browser, or deploy to GitHub Pages:

1. Push the repo to GitHub (without `firebase-config.js`)
2. Settings → Pages → Source: **GitHub Actions**
3. The included workflow auto-deploys on every push to `main`
4. After deployment, open the site URL and you'll see the Firebase setup screen with instructions (since config isn't in the repo)

For personal/team use, you can host `firebase-config.js` on the server separately, or use **Netlify/Vercel environment variables** (requires a build step).

---

## How It Works

### Creating a Trip
1. Click **+ New Trip**
2. Enter trip name, your name, and optional Google Maps URL to import stops
3. A unique 6-character invite code is generated (e.g. `GOAX42`)
4. Share the code or link with friends

### Joining a Trip
1. Click **Join Trip** and enter the invite code + your name
2. Or open the shared link — the code auto-fills
3. You're instantly added as a member, visible to everyone in real time

### Adding Expenses (Group Chat)
- Expenses appear as a **group chat feed** — your expenses on the right, others on the left
- Tap **+ Add Expense** to log who paid, how much, and split among members
- Split types: **Equal**, **Custom Amount**, **By Percentage**
- All members see the expense appear in real time (no refresh needed)

### Settling Up
- The **Settle** tab shows who owes whom with the minimum number of transfers
- Your debts are highlighted in purple
- **Pay Now** opens GPay, PhonePe, Paytm, or any UPI app with the amount pre-filled

---

## Architecture

| Component | Technology |
|-----------|-----------|
| Storage | Firebase Firestore (real-time) |
| Identity | Device ID in `localStorage` (no login required) |
| Map | Leaflet.js + OpenStreetMap |
| Geocoding | Nominatim (free, no API key) |
| Maps URL import | allorigins.win CORS proxy |
| Hosting | GitHub Pages / Netlify / Vercel |

### Firestore Structure
```
trips/{tripId}
  name, inviteCode, places[], adminDeviceId, createdAt

trips/{tripId}/members/{memberId}
  name, upiId, color, deviceId, isAdmin, joinedAt

trips/{tripId}/expenses/{expenseId}
  description, amount, paidBy, splits[], category, date, createdBy, createdAt

inviteCodes/{code}
  tripId, createdAt
```

---

## Hosting Options

| Platform | How to deploy | Notes |
|----------|--------------|-------|
| **GitHub Pages** | Enable in repo Settings → Pages → GitHub Actions | Auto-deploys; `firebase-config.js` must be added manually |
| **Netlify** | Drag & drop folder at netlify.com | Instant; add `firebase-config.js` via site settings |
| **Vercel** | `vercel --prod` | Fast CDN; use environment vars for config |
| **Cloudflare Pages** | Connect GitHub repo | Free tier; global CDN |

For all options: host `firebase-config.js` separately or use the in-app setup screen.
