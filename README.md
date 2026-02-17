# GoToMarket Compliance Lab

Global Regulatory & Market Entry Intelligence Platform — AI-powered FDA compliance analysis for food and supplement exporters.

## Features

- **AI Packaging Analysis** — Upload product images, get structured compliance reports via Gemini AI
- **5 Core Modules** — Ingredient risk, label compliance, facility registration, regulatory referral, market readiness
- **3-Layer Service Model** — Digital screening → Advisory optimization → Legal support
- **Bilingual Support** — Full English/Chinese interface
- **Structured Reports** — 4-dimension compliance dashboard with risk scoring

## Tech Stack

- **Frontend**: Vanilla HTML/CSS/JS (single-page)
- **Backend**: Node.js + Express
- **AI**: Google Gemini 2.0 Flash API
- **Upload**: Multer (multi-file, JPG/PNG/PDF)

## Local Development

```bash
# Install dependencies
npm install

# Create .env from example
cp .env.example .env
# Edit .env and add your GEMINI_API_KEY

# Run
npm start
# → http://localhost:3000
```

## Deploy to Railway

### Option 1: GitHub Integration (Recommended)

1. Push this repo to GitHub
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub repo
3. Add environment variable: `GEMINI_API_KEY` = your key
4. Railway auto-detects Node.js and deploys

### Option 2: Railway CLI

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login
railway login

# Init project
railway init

# Set env vars
railway variables set GEMINI_API_KEY=your_key_here

# Deploy
railway up
```

### Railway Settings

- **Build Command**: `npm install`
- **Start Command**: `npm start`
- **Environment Variables**:
  - `GEMINI_API_KEY` — Get from [Google AI Studio](https://aistudio.google.com/apikey)

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Health check + Gemini status |
| `POST` | `/api/analyze` | Upload files + run AI analysis |

### POST /api/analyze

```bash
curl -X POST http://localhost:3000/api/analyze \
  -F "files=@packaging-front.jpg" \
  -F "files=@packaging-back.jpg" \
  -F "lang=en"
```

**Parameters:**
- `files` — One or more image/PDF files (max 10, 20MB each)
- `lang` — `en` or `cn` (affects AI response language)

**Response:** Structured JSON with `ingredientRisk`, `labelCompliance`, `facilityRegistration`, `marketingClaims`, `overallScore`, and `recommendations`.

## Without Gemini API Key

The app works in **demo mode** without an API key — it returns sample compliance data so you can preview the full UI and report structure.

## License

MIT
