# RiseUp Personal Finance Assistant

A private Hebrew chat app that connects to the official read-only RiseUp MCP package and uses the OpenAI API to answer questions about your cashflow.

## Tools and permissions

The app discovers the tools exposed by the installed `@riseup-oss/mcp` package at startup. Current package documentation lists budget, transactions, balances, mortgage, future-balance prediction and benchmarks tools. The available tools depend on the PAT scopes.

Create a RiseUp Personal Access Token with the scopes you need:
- `budget:read` — budget and transactions
- `balances:read` — current/historical balances; future prediction also requires `budget:read`
- `mortgages:read` — mortgage details
- `benchmarks:read` — comparison data

Scopes cannot be added to an existing PAT; create a new token if you need more scopes. PATs expire after 30 days by default.

## Railway deployment

1. Create a Railway project and choose Deploy from GitHub Repo.
2. Select this private repository.
3. Add these Railway Variables:
   - `RISEUP_PAT` — your RiseUp PAT
   - `OPENAI_API_KEY` — API key from the OpenAI platform
   - `APP_ACCESS_TOKEN` — a long, random password used to protect this app
   - Optional `OPENAI_MODEL` (default `gpt-4.1-mini`)
4. Deploy. Railway runs `npm start`.
5. Open the generated domain and enter the APP_ACCESS_TOKEN.

OpenAI API usage is billed separately from a ChatGPT subscription.

## Local development (Windows PowerShell)

Install Node.js 20+, then run:

```powershell
npm install
$env:RISEUP_PAT="your_riseup_pat"
$env:OPENAI_API_KEY="your_openai_api_key"
$env:APP_ACCESS_TOKEN="a-long-random-password"
npm start
```

Open http://localhost:3000.

## Security and privacy

- RiseUp tools are read-only.
- RiseUp data returned by tools is sent to OpenAI API to generate the answer.
- The app does not persist chat history or financial responses.
- Secrets belong only in Railway Variables, never in GitHub.
- Keep this repository private and use a strong unique APP_ACCESS_TOKEN.
- This initial version is intended for one user and does not provide multi-user accounts.


## Install as a PWA

The web app includes a web app manifest, service worker and custom SVG icon. After the latest deployment finishes, open the Railway HTTPS domain in a supported browser:
- **Android / Chrome:** use the Install button when it appears, or Chrome menu → Install app.
- **iPhone / iPad:** open the site in Safari → Share → Add to Home Screen.
- **Desktop / Chrome or Edge:** use the install icon in the address bar or the browser menu → Install app.

The service worker caches only the static app shell. API requests and financial data are never cached. Chat history exists only in the current page session and is not persisted by the server.
