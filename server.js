import express from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import OpenAI from "openai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

for (const name of ["RISEUP_PAT", "OPENAI_API_KEY", "APP_ACCESS_TOKEN"]) {
  if (!process.env[name]) {
    console.error("Missing required environment variable:", name);
    process.exit(1);
  }
}

const app = express();
// Railway terminates TLS at its proxy; trust the single proxy hop for client IP detection.
app.set("trust proxy", 1);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const port = Number(process.env.PORT || 3000);
const root = path.dirname(fileURLToPath(import.meta.url));
app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(root, "public"), { etag: false, maxAge: 0 }));

const limiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false });

function matchesAccessToken(value) {
  if (typeof value !== "string" || !value) return false;
  const a = Buffer.from(value);
  const b = Buffer.from(process.env.APP_ACCESS_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}
function authorized(req) {
  const header = req.get("authorization") || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  const cookieMatch = (req.headers.cookie || "").match(new RegExp("(?:^|;\\s*)kis_session=([^;]*)"));
  let cookieToken = "";
  try { cookieToken = cookieMatch ? decodeURIComponent(cookieMatch[1]) : ""; } catch {}
  return matchesAccessToken(bearer) || matchesAccessToken(cookieToken);
}
function auth(req, res, next) {
  if (!authorized(req)) return res.status(401).json({ error: "מפתח גישה שגוי או חסר." });
  next();
}

const transport = new StdioClientTransport({
  command: "npx",
  args: ["--yes", "@riseup-oss/mcp"],
  env: { ...process.env, RISEUP_PAT: process.env.RISEUP_PAT }
});
const mcp = new Client({ name: "riseup-personal-finance", version: "1.0.0" });
await mcp.connect(transport);
const { tools: riseupTools } = await mcp.listTools();
if (!riseupTools?.length) throw new Error("RiseUp MCP returned no tools.");
console.log("RiseUp MCP tools:", riseupTools.map(t => t.name).join(", "));

const toolByName = name => riseupTools.find(t => t.name === name);
function decodeToolResult(result) {
  if (result?.isError) throw new Error((result.content || []).map(c => c.text || "").join(" ").slice(0, 500));
  if (result?.structuredContent) return result.structuredContent;
  const textBlock = (result?.content || []).find(c => c.type === "text")?.text;
  if (typeof textBlock === "string") {
    try { return JSON.parse(textBlock); } catch {}
    const start = textBlock.indexOf("{"), end = textBlock.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try { return JSON.parse(textBlock.slice(start, end + 1)); } catch {}
    }
  }
  return result;
}
async function callRiseup(name, args = {}) {
  if (!toolByName(name)) return null;
  return decodeToolResult(await mcp.callTool({ name, arguments: args }));
}
function monthInIsrael(offset = 0) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit"
  }).formatToParts(new Date());
  let year = Number(parts.find(p => p.type === "year").value);
  let month = Number(parts.find(p => p.type === "month").value) + offset;
  while (month < 1) { month += 12; year--; }
  while (month > 12) { month -= 12; year++; }
  return year + "-" + String(month).padStart(2, "0");
}
const num = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const abs = value => Math.abs(num(value));
function normalizeCategoryName(value) {
  const name = String(value || "אחר").trim() || "אחר";
  return name === "כלכלה" ? "סופר" : name;
}
function summarizeBudget(budget, transactions) {
  const envelopes = Array.isArray(budget?.envelopes) ? budget.envelopes : [];
  const txs = Array.isArray(transactions?.transactions) ? transactions.transactions : null;
  const byCategory = new Map();
  let income = 0, expenses = 0, transactionCount = 0, plannedExpenses = 0;

  if (txs) {
    for (const tx of txs) {
      if (tx.isExcluded) continue;
      const amount = abs(tx.amount);
      if (!amount) continue;
      transactionCount++;
      if (tx.isIncome) { income += amount; continue; }
      expenses += amount;
      const name = normalizeCategoryName(tx.categoryLabel);
      const item = byCategory.get(name) || { name, type: tx.actualType || "other", actual: 0, transactionCount: 0 };
      item.actual += amount;
      item.transactionCount++;
      byCategory.set(name, item);
    }
  } else {
    for (const env of envelopes) {
      const type = env.type || "other";
      const actuals = Array.isArray(env.actuals) ? env.actuals : [];
      const name = normalizeCategoryName(env.details?.trackingCategory?.name || env.name || env.title);
      for (const tx of actuals) {
        if (tx.isExcluded) continue;
        transactionCount++;
        if (tx.isIncome) { income += abs(tx.incomeAmount); continue; }
        const amount = abs(tx.billingAmount);
        if (!amount) continue;
        expenses += amount;
        const category = normalizeCategoryName(tx.expense || name);
        const item = byCategory.get(category) || { name: category, type, actual: 0, transactionCount: 0 };
        item.actual += amount;
        item.transactionCount++;
        byCategory.set(category, item);
      }
    }
  }

  const plannedByCategory = new Map();
  for (const env of envelopes) {
    const type = env.type || "other";
    const isSaving = env.details?.trackingCategory?.trackingCategoryType === "saving";
    const planned = abs(env.originalAmount ?? (type === "fixed" ? env.balancedAmount : null));
    if (!isSaving && ["fixed", "trackingCategory"].includes(type)) plannedExpenses += planned;
    // Tracking-category budgets are the user's category-level spending limits.
    // Fixed commitments are handled separately by RiseUp's future-balance forecast.
    if (type === "trackingCategory" && !isSaving) {
      const name = normalizeCategoryName(env.details?.trackingCategory?.name || env.name || env.title);
      if (name) plannedByCategory.set(name, (plannedByCategory.get(name) || 0) + planned);
    }
  }

  const names = new Set([...byCategory.keys(), ...plannedByCategory.keys()]);
  const categories = [...names].map(name => {
    const actual = byCategory.get(name) || { name, type: "other", actual: 0, transactionCount: 0 };
    const planned = plannedByCategory.has(name) ? plannedByCategory.get(name) : null;
    const remaining = planned === null ? null : Math.max(0, planned - actual.actual);
    return {
      ...actual, planned, remaining,
      utilization: planned > 0 ? Math.round(actual.actual / planned * 100) : null,
      share: expenses > 0 ? Math.round(actual.actual / expenses * 100) : 0
    };
  }).sort((x,y)=>y.actual-x.actual);

  return {
    month: budget?.budgetDate || null, lastUpdatedAt: budget?.lastUpdatedAt || null,
    income, expenses, net: income-expenses, plannedExpenses,
    budgetReserveTotal: categories.reduce((sum,c)=>sum+(c.remaining||0),0),
    categories: categories.slice(0,30), transactionCount,
    transactionsAvailable: Boolean(txs)
  };
}

app.get("/health", (_req, res) => res.json({ ok: true }));
app.post("/api/login", limiter, (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!matchesAccessToken(req.body?.token)) {
    return res.status(401).json({ error: "מפתח גישה שגוי או חסר." });
  }
  res.setHeader("Set-Cookie", "kis_session=" + encodeURIComponent(process.env.APP_ACCESS_TOKEN) + "; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000");
  res.json({ connected: true });
});
app.post("/api/logout", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Set-Cookie", "kis_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
  res.json({ connected: false });
});

app.get("/api/status", limiter, auth, (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ connected: true, tools: riseupTools.map(t => ({ name: t.name, description: t.description })) });
});

app.get("/api/dashboard", limiter, auth, async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const currentMonth = monthInIsrael(0);
    const previousMonth = monthInIsrael(-1);
    const currentBudget = await callRiseup("get_budget", { date: "current" });
    if (!currentBudget) return res.status(503).json({ error: "כלי התקציב אינו זמין. ודא שלמפתח RiseUp יש הרשאת budget:read." });
    const [currentTransactions, previousBudget, previousTransactions, balancesResult, benchmarksResult] = await Promise.all([
      callRiseup("get_transactions", { cashflowMonth: currentMonth, maxTransactions: 5000 }).catch(() => null),
      callRiseup("get_budget", { date: "previous" }).catch(() => null),
      callRiseup("get_transactions", { cashflowMonth: previousMonth, maxTransactions: 5000 }).catch(() => null),
      callRiseup("get_current_bank_balances_data").catch(() => null),
      callRiseup("get_benchmarks_data").catch(() => null)
    ]);
    const current = summarizeBudget(currentBudget, currentTransactions);
    const previous = previousBudget ? summarizeBudget(previousBudget, previousTransactions) : null;
    const balances = Array.isArray(balancesResult?.balances) ? balancesResult.balances.map(b => ({
      account: b.accountNickname || b.source || "חשבון", balance: num(b.balance), lastUpdated: b.lastUpdated || null
    })) : [];
    const benchmarks = Array.isArray(benchmarksResult?.benchmarks) ? benchmarksResult.benchmarks.map(b => ({
      category: b.category || b.spendArea, customerSpend: num(b.customerSpend),
      percentile: num(b.customerSpendPercentile), peerMean: num(b.similarCustomersMean),
      potentialMonthlySaving: Math.max(0, num(b.customerSpend)-num(b.similarCustomersMean))
    })).sort((a,b)=>b.potentialMonthlySaving-a.potentialMonthlySaving) : [];
    res.json({
      current, previous: previous ? { month: previous.month || previousMonth, income: previous.income, expenses: previous.expenses, net: previous.net } : null,
      balances, totalBalance: balances.length ? balances.reduce((s,b)=>s+b.balance,0) : null,
      benchmarks, capabilities: {
        budget: true, transactions: Boolean(currentTransactions?.transactions),
        balances: Boolean(balancesResult), benchmarks: Boolean(benchmarksResult)
      },
      generatedAt: new Date().toISOString()
    });
  } catch (err) {
    console.error("Dashboard error:", err?.message || err);
    res.status(502).json({ error: "לא הצלחתי לטעון את תמונת המצב. בדוק הרשאות RiseUp ונסה שוב." });
  }
});

app.get("/api/forecast", limiter, auth, async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const forecastTool = "get_future_bank_balances_prediction";
    if (!toolByName(forecastTool)) {
      return res.status(503).json({ error: "כלי תחזית היתרות אינו זמין בחיבור RiseUp הנוכחי." });
    }
    const budget = await callRiseup("get_budget", { date: "current" });
    const month = String(budget?.budgetDate || monthInIsrael(0));
    const match = /^(\d{4})-(\d{2})$/.exec(month);
    if (!match) throw new Error("Invalid RiseUp budget month");
    const year = Number(match[1]), monthNumber = Number(match[2]);
    const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
    const futureDateForPrediction = year + "-" + String(monthNumber).padStart(2,"0") + "-" + String(lastDay).padStart(2,"0");
    const [prediction, transactions] = await Promise.all([
      callRiseup(forecastTool, { futureDateForPrediction }),
      callRiseup("get_transactions", { cashflowMonth: month, maxTransactions: 5000 }).catch(() => null)
    ]);
    const budgetSummary = summarizeBudget(budget, transactions);
    const accounts = Array.isArray(prediction?.accounts) ? prediction.accounts.map(a => ({
      bank: a.bankName || "חשבון בנק",
      account: a.accountNickname || a.bankName || "חשבון",
      currentBalance: num(a.currentBalance),
      currentBalanceUpdatedAt: a.currentBalanceUpdatedAt || null,
      predictedBalance: num(a.futurePredictedBalance),
      billedUntilDate: num(a.amountToBeBilledUntilFuturePredictionDate),
      fixedPredictedUntilDate: num(a.amountFixedPredictedToBeBilledUntilFuturePredictionDate),
      knownTransactions: Array.isArray(a.transactionsBilledUntilFuturePredictionDate) ? a.transactionsBilledUntilFuturePredictionDate : [],
      fixedTransactions: Array.isArray(a.fixedTransactionsPredictedToBeBilledUntilFuturePredictionDate) ? a.fixedTransactionsPredictedToBeBilledUntilFuturePredictionDate : []
    })) : [];
    const totalCurrentBalance = accounts.length ? accounts.reduce((sum,a)=>sum+a.currentBalance,0) : null;
    const totalPredictedBalance = accounts.length ? accounts.reduce((sum,a)=>sum+a.predictedBalance,0) : null;
    const knownTransactions = accounts.flatMap(a => a.knownTransactions.map(t => ({
      account: a.account, businessName: t.businessName || "עסקה ידועה",
      amount: num(t.amount), isIncome: Boolean(t.isIncome), date: t.billingDate || null
    })));
    const fixedTransactions = accounts.flatMap(a => a.fixedTransactions.map(t => ({
      account: a.account, businessName: t.businessName || "תנועה קבועה",
      amount: num(t.amount), isIncome: Boolean(t.isIncome), date: t.predictedBillingDate || null
    })));
    const reserveCategories = budgetSummary.categories
      .filter(c => c.planned !== null && c.planned > 0)
      .map(c => ({ name: c.name, planned: c.planned, actual: c.actual, remaining: c.remaining }));
    const budgetReserveTotal = budgetSummary.budgetReserveTotal;
    // Fixed expenses are already deducted by RiseUp from the predicted balance.
    // Include them in the reserve display, but do not deduct them a second time.
    const fixedExpenseTransactions = fixedTransactions.filter(t => !t.isIncome);
    const fixedExpenseReserveTotal = fixedExpenseTransactions.reduce((sum, t) => sum + abs(t.amount), 0);
    const totalReserved = budgetReserveTotal + fixedExpenseReserveTotal;
    res.json({
      month, futureDateForPrediction, accounts,
      totalCurrentBalance, totalPredictedBalance,
      knownTransactions, fixedTransactions, fixedExpenseTransactions,
      budgetReserveAvailable: budgetSummary.transactionsAvailable,
      budgetReserveTotal: budgetSummary.transactionsAvailable ? budgetReserveTotal : null,
      fixedExpenseReserveTotal,
      totalReserved: budgetSummary.transactionsAvailable ? totalReserved : null,
      availableAfterBudgetReserve: budgetSummary.transactionsAvailable && totalPredictedBalance !== null
        ? totalPredictedBalance - budgetReserveTotal : null,
      reserveCategories,
      generatedAt: new Date().toISOString(),
      available: accounts.length > 0
    });
  } catch (err) {
    console.error("Forecast error:", err?.message || err);
    res.status(502).json({ error: "לא הצלחתי לקבל תחזית יתרות מ־RiseUp. בדוק את הרשאות התקציב והיתרות ונסה שוב." });
  }
});

app.post("/api/chat", limiter, auth, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const profile = req.body?.profile === "amy" ? "amy" : "dor";
  const raw = req.body?.messages;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 20) {
    return res.status(400).json({ error: "מבנה הודעות לא תקין." });
  }
  const messages = raw
    .filter(m => m && ["user", "assistant"].includes(m.role) && typeof m.content === "string")
    .slice(-12)
    .map(m => ({ role: m.role, content: m.content.slice(0, 5000) }));
  if (!messages.length || messages.at(-1).role !== "user") {
    return res.status(400).json({ error: "נדרשת הודעת משתמש אחרונה." });
  }

  const tools = riseupTools.map(t => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || t.name,
      parameters: t.inputSchema || { type: "object", properties: {} }
    }
  }));
  const system = {
    role: "system",
    content: profile === "amy"
      ? "אתה העוזר הפיננסי המשפחתי של איימי ועונה בעברית פשוטה, חמה ומעודדת. פתח בשורה התחתונה, הוסף עד 2 או 3 נתונים רלוונטיים והצע צעד קטן אחד או שניים. בדרך כלל ענה ב-2 עד 5 משפטים קצרים; הרחב רק אם ביקשו. בלי הקדמות ארוכות, חזרות, הטפות או ז׳רגון. עזור להבין את מצב הכסף, התקציבים והוצאות שכדאי לבדוק. השתמש בנתוני RiseUp עדכניים כשנדרש; אל תמציא נתונים והבדל בין נתון לאומדן. עודד בלי לבייש או להאשים. RiseUp לקריאה בלבד — אל תטען שביצעת פעולות. בסוף התשובה הוסף שורת סימון פנימית בפורמט [[SUGGESTIONS]]שאלה ראשונה||שאלה שנייה. השאלות צריכות להיות פשוטות, תומכות ומעשיות."
      : "אתה העוזר הפיננסי האישי של המשתמש ועונה בעברית ברורה, עניינית ומעשית. פתח בשורה התחתונה, הצג עד 3 נתונים רלוונטיים ועד 2 צעדים מעשיים. בדרך כלל ענה ב-3 עד 6 משפטים קצרים; הרחב רק אם ביקשו. בלי חזרות, הקדמות ארוכות או ז׳רגון. השתמש בנתוני RiseUp עדכניים כשנדרשים נתוני חשבון. אל תמציא נתונים; הבדל בין נתון בפועל לאומדן. הצע חיסכון רק כשיש בסיס, ואל תציגו כמובטח. אם חסר נתון מהותי, אמור זאת בקצרה. RiseUp לקריאה בלבד — אל תטען שביצעת פעולות. בסוף התשובה הוסף שורת סימון פנימית בפורמט [[SUGGESTIONS]]שאלה ראשונה||שאלה שנייה. השאלות צריכות להיות קצרות, רלוונטיות ומעשיות."
  };

  try {
    const thread = [system, ...messages];
    let reply = "";
    for (let round = 0; round < 5; round++) {
      const completion = await openai.chat.completions.create({
        model, messages: thread, tools, tool_choice: "auto", temperature: 0.2
      });
      const assistant = completion.choices?.[0]?.message;
      if (!assistant) throw new Error("Empty model response");
      thread.push(assistant);
      if (!assistant.tool_calls?.length) { reply = assistant.content || "לא התקבלה תשובה."; break; }
      for (const call of assistant.tool_calls) {
        const selected = riseupTools.find(t => t.name === call.function.name);
        if (!selected) {
          thread.push({ role: "tool", tool_call_id: call.id, content: "Unknown tool" });
          continue;
        }
        let args;
        try { args = JSON.parse(call.function.arguments || "{}"); }
        catch {
          thread.push({ role: "tool", tool_call_id: call.id, content: "Invalid tool arguments" });
          continue;
        }
        const result = await mcp.callTool({ name: selected.name, arguments: args });
        const text = (result.content || []).filter(c => c.type === "text").map(c => c.text).join("\n").slice(0, 20000);
        thread.push({ role: "tool", tool_call_id: call.id, content: result.isError ? JSON.stringify({ error: text }) : (text || JSON.stringify(result)) });
      }
    }
    const finalText = reply || "הגעתי למגבלת קריאות הכלים. נסה שאלה ממוקדת יותר.";
    let cleanReply = finalText.trim(), suggestions = [];
    const marker = cleanReply.match(/\[\[SUGGESTIONS\]\]([\s\S]*)$/);
    if (marker) { suggestions = marker[1].split("||").map(x => x.trim()).filter(Boolean).slice(0,3).map(x => x.slice(0,100)); cleanReply = cleanReply.slice(0, marker.index).trim(); }
    res.json({ reply: cleanReply || "לא הצלחתי לנסח תשובה. אפשר לנסות שוב בשאלה ממוקדת יותר.", suggestions });
  } catch (err) {
    console.error("Chat error:", err?.message || err);
    res.status(502).json({ error: "הבקשה נכשלה. בדוק את חיבור RiseUp ואת הגדרות OpenAI." });
  }
});

const server = app.listen(port, "0.0.0.0", () => console.log("App listening on", port));
async function stop() {
  server.close();
  try { await mcp.close(); } catch {}
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
