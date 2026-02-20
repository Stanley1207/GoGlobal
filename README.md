# GoToMarket Compliance Lab

**Global Regulatory & Market Entry Intelligence Platform**

AI-powered FDA compliance risk screening for food and dietary supplement products targeting the U.S. market. Upload product packaging photos, get a structured compliance report with regulatory citations, risk scoring, and actionable recommendations.

---

## Features

### Core Capabilities
- **AI Compliance Analysis** — Upload product images/PDFs, get structured risk assessment via Google Gemini 2.0 Flash
- **5 Core Modules** — Ingredient risk, label compliance, facility registration, regulatory referral, market readiness
- **3-Layer Service Model** — Digital screening → Advisory optimization → Market entry & brand strategy
- **Bilingual Interface** — Full English/Chinese UI with one-click language switching
- **Regulatory Citations** — Every finding references specific CFR sections (21 CFR 170, DSHEA, FALCPA, etc.)

### Report & Export
- **Full-Screen Report Overlay** — Professional report in dedicated view with clear visual hierarchy
- **PDF Export** — Multi-page PDF with cover, table of contents, sections, recommendations, and legal disclaimer
- **PPT Export** — Server-side PowerPoint generation (7 slides) via PptxGenJS with branded layout
- **Report Saving** — Logged-in users can save reports to PostgreSQL and revisit from "My Reports" dashboard

### User System
- **User Registration & Login** — Email/password auth with bcrypt hashing
- **Session Management** — Server-side sessions stored in PostgreSQL
- **My Reports Dashboard** — View, reopen, and delete saved compliance reports

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Vanilla HTML/CSS/JS (single-page, no framework) |
| Backend | Node.js 18+ / Express |
| AI | Google Gemini 2.0 Flash API |
| Database | PostgreSQL (users, reports, sessions) |
| Auth | bcryptjs + express-session + connect-pg-simple |
| Upload | Multer (multi-file, JPG/PNG/WEBP/PDF, 20MB limit) |
| PDF Export | jsPDF + jspdf-autotable (client-side) |
| PPT Export | PptxGenJS (server-side) |
| Fonts | Playfair Display, Sora, Noto Sans SC, JetBrains Mono |

---

## Project Structure

```
gotomarket-app/
├── server.js              # Express server (API, auth, Gemini, PPTX generation)
├── public/
│   └── index.html         # Single-page frontend (UI, report rendering, PDF export)
├── package.json
├── db-init.sql            # Database schema reference
├── .env.example           # Environment variable template
└── uploads/               # Temporary upload directory (auto-created)
```

---

## Local Development

### Prerequisites
- Node.js >= 18
- PostgreSQL (optional — app works without it in demo mode)

### Setup

```bash
git clone <your-repo-url>
cd gotomarket-app
npm install

cp .env.example .env
# Edit .env with your values

npm start
# → http://localhost:3000
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GEMINI_API_KEY` | For AI analysis | Google Gemini API key from [AI Studio](https://aistudio.google.com/apikey) |
| `DATABASE_URL` | For user accounts | PostgreSQL connection string |
| `SESSION_SECRET` | For production | Random string for session encryption |
| `PORT` | No (default: 3000) | Server port |
| `NODE_ENV` | No | Set `production` for secure cookies |

### Without API Key
App works in **demo mode** — returns sample compliance data for full UI preview.

### Without PostgreSQL
All analysis and export features work. Only registration, login, and report saving require a database.

---

## Deploy to Railway

1. Push to GitHub → [railway.app](https://railway.app) → Deploy from GitHub
2. Add PostgreSQL: **+ New** → **Database** → **PostgreSQL** (`DATABASE_URL` auto-injected)
3. Set env vars: `GEMINI_API_KEY`, `SESSION_SECRET`, `NODE_ENV=production`
4. Deploy — tables auto-create on startup

**Build:** `npm install` | **Start:** `npm start`

---

## API Endpoints

### Public
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Health check |
| `POST` | `/api/analyze` | Upload files → AI analysis |
| `POST` | `/api/generate-slides` | Generate PPTX |

### Auth
| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/auth/register` | Create account |
| `POST` | `/api/auth/login` | Login |
| `POST` | `/api/auth/logout` | Logout |
| `GET` | `/api/auth/me` | Current user |

### Reports (auth required)
| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/reports` | Save report |
| `GET` | `/api/reports` | List reports |
| `GET` | `/api/reports/:id` | Get report |
| `DELETE` | `/api/reports/:id` | Delete report |

### Example

```bash
# Analyze
curl -X POST http://localhost:3000/api/analyze \
  -F "files=@packaging.jpg" -F "lang=en"

# Generate PPT
curl -X POST http://localhost:3000/api/generate-slides \
  -H "Content-Type: application/json" -d '{"lang":"en"}' -o report.pptx
```

---

## Report Structure

4 assessment dimensions, each with regulatory citations:

1. **Ingredient Risk** — GRAS, banned substances, NDI (21 CFR 170, 189)
2. **Label Compliance** — Nutrition facts, allergens, net weight (21 CFR 101, FALCPA)
3. **Facility Registration** — FEI, DUNS, FSVP (21 CFR 1.225, FSMA)
4. **Marketing Claims** — Health/nutrient/structure-function claims (DSHEA, FD&C Act)

Overall 0–100 risk score with verdict and prioritized recommendations.

---

## Key Design Decisions

- **jsPDF** (not html2pdf) — Programmatic PDF avoids html2canvas rendering bugs. English-only (CJK not supported in built-in fonts)
- **PptxGenJS server-side** — Native .pptx generation, no client dependency
- **Facility "Pending"** — Never says "unable to determine"; states "requires FEI/DUNS confirmation" with FDA database disclaimer
- **Regulatory language** — Gemini prompted for formal CFR-cited assessments, not casual descriptions

---

## License

MIT