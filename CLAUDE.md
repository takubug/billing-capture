# CLAUDE.md — BillingCapture

A mobile-first Progressive Web App (PWA) for capturing patient billing information from label photos, storing records in Google Sheets, and emailing billing reports. Built for OA Surgery.

---

## Repository Structure

```
billing-capture/
├── src/
│   ├── App.jsx                    # Entire application (single component file, ~754 lines)
│   └── main.jsx                   # React entry point
├── public/
│   └── icon.svg                   # PWA icon
├── dist/                          # Production build output (auto-generated, do not edit)
├── .github/workflows/
│   └── deploy.yml                 # CI/CD: build + deploy to GitHub Pages on push to main
├── anthropic-proxy-worker.js      # Cloudflare Worker source (deploy separately)
├── index.html                     # HTML template with PWA/mobile meta tags
├── vite.config.js                 # Vite config (base: /billing-capture/)
├── package.json                   # NPM scripts and dependencies
├── deploy.sh                      # Manual GitHub Pages deploy script
└── README.md                      # User-facing setup instructions
```

**This is intentionally a minimal codebase.** All application logic lives in `src/App.jsx`. There are no additional component files, no CSS files (all styles are inline), no state management library, and no test suite.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | React 18.2.0 |
| Build tool | Vite 5.1.4 |
| Deployment | GitHub Pages (via `gh-pages` npm package + GitHub Actions) |
| AI OCR | Claude Sonnet (`claude-sonnet-4-6`) via Cloudflare Worker proxy |
| Data storage | Google Sheets API v4 |
| Image storage | Google Drive API v3 |
| Email | Gmail API v1 |
| Auth | Google OAuth 2.0 (implicit flow / token in URL hash) |
| Styling | Inline CSS only (no CSS files, no CSS-in-JS library) |

---

## Development Workflow

### Local dev

```bash
npm install
npm run dev         # Vite dev server at http://localhost:5173/billing-capture/
```

### Build

```bash
npm run build       # Outputs to dist/
```

### Deploy

Deployment happens automatically via GitHub Actions on every push to `main`. The workflow (`.github/workflows/deploy.yml`) builds the project and pushes `dist/` to GitHub Pages using `peaceiris/actions-gh-pages@v4`.

For a manual deploy:
```bash
./deploy.sh YOUR_GITHUB_TOKEN
```

Live URL: `https://takubug.github.io/billing-capture`

---

## Architecture & Key Conventions

### Single-file component structure (`src/App.jsx`)

The file is organised into clearly labelled sections using banner comments:

```
// ── Brand ──────────     OA Surgery brand colours (constants only)
// ── Helpers ────────     extractLabelData() — calls Anthropic via proxy
// ── Google Drive ───     getOrCreateDriveFolder(), uploadImageToDrive()
// ── Google Sheets ──     appendToSheet(), createSheet(), getSheetData()
// ── Google OAuth ───     useGoogleAuth() custom hook
// ── Constants ──────     EMPTY_FIELDS, FIELD_LABELS
// ── App ────────────     App() default export — all UI and state
```

When adding new functionality, follow this same section structure. Keep helper functions outside the component; only React hooks and event handlers belong inside `App()`.

### Brand colours

All UI must use the OA Surgery palette:

| Name | Hex |
|---|---|
| Forest Floor | `#002521` |
| Forest Biome | `#194B46` |
| Chalk Blue | `#BFCDCC` |
| Light Turquoise | `#84C4C0` |
| Bright Jade | `#CFF4D2` |
| White | `#FFFFFF` |
| Black | `#27272A` |

The app uses a dark theme (`#0d0d1a` page background). Do not introduce colours outside this palette without explicit approval.

### Inline CSS

All styles are inline style objects passed directly to JSX elements. There are no external CSS files and no CSS modules. Keep this convention — do not add a CSS file or a styling library.

### State management

State is managed with React hooks only (`useState`, `useRef`, `useCallback`). There is no Redux, Zustand, or Context. The two pieces of persistent state (`clientId`, `sheetId`) are stored in `localStorage`.

### Google OAuth — implicit flow

The app uses the OAuth 2.0 implicit flow: after sign-in, Google redirects back to the app with `#access_token=...` in the URL hash. `parseToken()` (called once on mount via a `useState` initialiser) reads this hash and stores the token in state. The token is **not** persisted — users must re-authenticate after a page reload.

Required OAuth scopes:
- `https://www.googleapis.com/auth/spreadsheets`
- `https://www.googleapis.com/auth/gmail.send`
- `https://www.googleapis.com/auth/userinfo.email`
- `https://www.googleapis.com/auth/drive.file`

### Anthropic API proxy (Cloudflare Worker)

The app cannot call the Anthropic API directly from the browser (no API key should be shipped client-side). Instead, all AI calls go through:

```
POST https://billing-capture.oscar-137.workers.dev/
```

The source for this worker is `anthropic-proxy-worker.js`. It:
- Accepts `POST` requests only from `https://takubug.github.io`
- Forwards the request body to `https://api.anthropic.com/v1/messages`
- Injects the `ANTHROPIC_API_KEY` secret (set in Cloudflare dashboard, never in code)
- Returns the response with appropriate CORS headers

If you change the AI model, update `ANTHROPIC_MODEL` at the top of `App.jsx`. Current model: `claude-sonnet-4-6`.

---

## Google Sheets Schema

Records are appended to `Sheet1` with 14 columns in this exact order:

| Column | Field | Notes |
|---|---|---|
| A | Timestamp | ISO 8601 string |
| B | Patient Name | `Firstname LASTNAME` format |
| C | DOB | `YYYY-MM-DD` format |
| D | Medicare Number | 10 digits, no spaces |
| E | Medicare IRN | Single digit |
| F | Medicare Expiry | As extracted |
| G | Address | Full address, one line |
| H | Insurer | 3-letter code after "PVT" |
| I | Insurance Number | Alphanumeric string |
| J | Referrer | Sentence case |
| K | GP | Sentence case |
| L | Service Code | Required field |
| M | Date of Service | `YYYY-MM-DD` format |
| N | Label Image | Google Drive `webViewLink` |

**Do not change column order** — existing spreadsheets depend on positional indexing in `getSheetData()` / report generation.

---

## Google Drive

Patient label images are stored in a Drive folder named `MediSnap`. The folder is created automatically if it does not exist (`getOrCreateDriveFolder()`). Image filenames follow the pattern:

```
{SafePatientName}_{ISO-timestamp-with-dashes}.{ext}
```

---

## AI Extraction Prompt

The prompt in `extractLabelData()` instructs Claude to return a strict JSON object from a base64-encoded label image. Key formatting rules enforced by the prompt:

- DOB → `YYYY-MM-DD`
- Medicare number → 10 digits only (no spaces/hyphens)
- Medicare IRN → single digit following medicare number
- Patient name → `Firstname LASTNAME`
- Insurer → 3-letter code following "PVT"
- All text → sentence case

If you modify the extraction prompt, verify all formatting rules are preserved and that the output remains valid JSON (no markdown fences).

---

## App Tabs / Navigation

The app has four tabs controlled by `step` state:

| Step | Tab name | Purpose |
|---|---|---|
| `capture` | Capture | Take photo or upload label image |
| `review` | Review | Edit AI-extracted fields, save to Sheets |
| `report` | Report | Filter records, email billing summary |
| `settings` | Settings | Configure OAuth Client ID and Sheet ID |

Tab state (`step`) is a plain string — not a router. Navigation is done by calling `setStep("tab-name")`.

---

## External Service Configuration

| Service | Where configured |
|---|---|
| Anthropic API key | Cloudflare Workers dashboard → Secret `ANTHROPIC_API_KEY` |
| Cloudflare Worker URL | `PROXY_URL` constant in `App.jsx` |
| Google OAuth Client ID | App Settings tab → stored in `localStorage` |
| Google Sheet ID | Auto-created on first save → stored in `localStorage` |
| GitHub Pages base path | `vite.config.js` (`base: "/billing-capture/"`) |
| Allowed CORS origin | `ALLOWED_ORIGIN` in `anthropic-proxy-worker.js` |

---

## No Tests

There is no test suite. There is no Jest, Vitest, or any testing framework. Do not add tests unless explicitly requested — the project is intentionally kept minimal.

---

## Common Tasks

### Change the AI model

Update `ANTHROPIC_MODEL` at line 12 of `src/App.jsx`:
```js
const ANTHROPIC_MODEL = "claude-sonnet-4-6";
```

### Add a new form field

1. Add the key to `EMPTY_FIELDS` (line ~202)
2. Add a label to `FIELD_LABELS` (line ~208)
3. Add the column to `appendToSheet()` values array (line ~101) — **append to end only**
4. Update the AI extraction prompt in `extractLabelData()` if the field should be auto-populated
5. Update the Google Sheets header row in `createSheet()` (line ~122)

### Update the Cloudflare Worker

Edit `anthropic-proxy-worker.js` and redeploy via the Cloudflare dashboard (paste worker code into the editor) or via Wrangler CLI. The worker is **not** deployed by the GitHub Actions pipeline.

### Change the deployed URL

Update all of:
- `vite.config.js` — `base` option
- `package.json` — `homepage` field
- `anthropic-proxy-worker.js` — `ALLOWED_ORIGIN`
- Google Cloud Console — Authorized redirect URIs
