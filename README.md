# Tripppyyy ✈️

> Plan trips. Split expenses. Explore together.

A beautiful, fully client-side trip expense sharing app with interactive maps, UPI payments, and Google Maps URL import.

## Features

- **Interactive Map** — View your route on an OpenStreetMap-powered Leaflet map with numbered markers
- **Google Maps Import** — Paste any Google Maps URL (directions, places, short links) to auto-extract destinations
- **Itinerary Management** — Add, remove, and tick off visited destinations
- **Expense Splitting** — Equal, custom amount, or percentage splits
- **Member Management** — Add trip members with UPI IDs
- **Debt Settlement** — Simplified debt algorithm with Pay Now buttons
- **UPI Payments** — Direct links to GPay, PhonePe, Paytm, and any UPI app
- **Offline-first** — All data stored in localStorage, works without internet after load
- **Zero dependencies** — Pure HTML/CSS/JS, no backend, no build step

## Hosting

### GitHub Pages (Recommended)
1. Push this repo to GitHub
2. Go to **Settings → Pages → Source → GitHub Actions**
3. The workflow in `.github/workflows/deploy.yml` auto-deploys on every push to `main`

### Alternatives
| Platform | Steps | Notes |
|----------|-------|-------|
| **Netlify** | Drag & drop the folder on netlify.com | Instant, free |
| **Vercel** | `vercel --prod` | Free tier, fast CDN |
| **Cloudflare Pages** | Connect GitHub repo | Free, global CDN |
| **Firebase Hosting** | `firebase deploy` | Google infra |

All options are **free** and work with static files.

## Usage

1. **Create a Trip** — Click "+ New Trip", paste a Google Maps link or add places manually
2. **Add Members** — Go to the Members tab, add everyone with their UPI IDs
3. **Log Expenses** — Add expenses with who paid and how to split
4. **Settle Up** — See the Settle Up tab for who owes whom with one-click UPI payments

## Data Storage

All trip data is stored in your browser's `localStorage` under the key `tripppyyy_v1`. Data persists across sessions but is device-specific. To share trips, you can export/import the JSON from browser dev tools.

## Tech Stack

- **Leaflet.js** — Interactive maps
- **OpenStreetMap** — Map tiles (free, no API key)
- **Nominatim** — Geocoding (free, no API key)
- **allorigins.win** — CORS proxy for expanding Google Maps short URLs

No API keys required!
