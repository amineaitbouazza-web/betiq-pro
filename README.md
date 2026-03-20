# BETIQ PRO ⚡

AI-powered football betting picks — searches the web for real fixtures, then Claude AI picks the 10 best value bets.

## How It Works
1. You click **Get Real Picks**
2. The app calls `/api/picks` (Vercel serverless function)
3. The function asks Claude to **search the web** for real fixtures on your date
4. Claude finds real matches on BBC Sport, FlashScore, SofaScore etc.
5. Claude picks 10 best value bets from the real fixtures
6. Picks are returned with odds, confidence, form, and reasoning

---

## Deploy in 10 Minutes

### Step 1 — Get your Anthropic API key
- Go to **console.anthropic.com**
- Create account → API Keys → Create Key
- Copy it (starts with `sk-ant-...`)

### Step 2 — Push to GitHub
```bash
git init
git add .
git commit -m "BETIQ PRO initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/betiq-pro.git
git push -u origin main
```

### Step 3 — Deploy to Vercel (free)
1. Go to **vercel.com** → Sign up with GitHub
2. Click **Add New Project**
3. Import your `betiq-pro` repository
4. Click **Deploy** (Vercel auto-detects Vite)

### Step 4 — Add your API key to Vercel
1. In Vercel dashboard → your project → **Settings**
2. Click **Environment Variables**
3. Add:
   - **Name:** `ANTHROPIC_API_KEY`
   - **Value:** `sk-ant-your-key-here`
4. Click Save → **Redeploy**

### Done! 🎉
Your app is live at `https://betiq-pro.vercel.app`

---

## Local Development
```bash
npm install
cp .env.example .env.local
# Add your ANTHROPIC_API_KEY to .env.local
npm run dev
```

> For local dev, the Vite proxy forwards `/api` calls to Vercel's local dev server.
> Run `vercel dev` instead of `npm run dev` for full local API support.

## File Structure
```
betiq-pro/
├── index.html          # HTML entry point
├── src/
│   ├── main.jsx        # React bootstrap
│   └── App.jsx         # Main app UI
├── api/
│   └── picks.js        # Vercel serverless function (calls Anthropic)
├── package.json
├── vite.config.js
├── vercel.json
├── .env.example
└── .gitignore
```

## Tech Stack
- **Frontend:** React + Vite
- **Hosting:** Vercel (free)
- **AI:** Claude Sonnet via Anthropic API
- **Data:** Claude web_search tool (searches live sports sites)
- **No external sports API needed**
