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


app.get("/api/subscriptions", limiter, auth, async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const months = [0, -1, -2].map(offset => monthInIsrael(offset));
    const results = await Promise.all(months.map(month =>
      callRiseup("get_transactions", { cashflowMonth: month, maxTransactions: 5000 }).catch(() => null)
    ));
    if (results.every(result => !Array.isArray(result?.transactions))) {
      return res.status(503).json({ error: "פירוט העסקאות אינו זמין לזיהוי תשלומים חוזרים." });
    }
    const groups = new Map();
    let excludedNonSubscriptionCount = 0;
    const nonSubscriptionPattern = /משכנתא|משכנתה|הלוואה|החזר הלוואה|שיק|צ׳ק|צ'ק|המחאה|\d+\s*(?:מתוך|\/)\s*\d+|\binstallments?\b|\bloan\b|\bmortgage\b|\bcheque?\b|\bcheck\b/i;
    results.forEach((result, index) => {
      const month = months[index];
      for (const tx of Array.isArray(result?.transactions) ? result.transactions : []) {
        if (tx.isExcluded || tx.isIncome) continue;
        const searchable = [
          tx.businessName, tx.merchantName, tx.description, tx.title, tx.payee,
          tx.category, tx.categoryName, tx.subCategory, tx.subCategoryName,
          tx.transactionType, tx.paymentMethod, tx.notes, tx.comment,
          tx.installment, tx.installments, tx.installmentNumber, tx.installmentsCount,
          tx.isInstallment, tx.isLoan, tx.isMortgage, tx.isCheck
        ].filter(value => value !== null && value !== undefined).map(value =>
          typeof value === "object" ? JSON.stringify(value) : String(value)
        ).join(" ");
        if (tx.isInstallment === true || tx.isLoan === true || tx.isMortgage === true || tx.isCheck === true || nonSubscriptionPattern.test(searchable)) {
          excludedNonSubscriptionCount++;
          continue;
        }
        const amount = abs(tx.amount ?? tx.billingAmount);
        if (!amount) continue;
        const merchant = String(tx.businessName || tx.merchantName || tx.description || tx.title || tx.payee || "").trim();
        if (!merchant) continue;
        const key = merchant.toLocaleLowerCase("he-IL").replace(/[״"']/g, "").replace(/\s+/g, " ").trim();
        const list = groups.get(key) || [];
        list.push({ merchant, amount, month });
        groups.set(key, list);
      }
    });
    const recurring = [];
    for (const entries of groups.values()) {
      const byMonth = new Map();
      for (const entry of entries) {
        const current = byMonth.get(entry.month);
        if (!current || entry.amount > current.amount) byMonth.set(entry.month, entry);
      }
      const monthly = [...byMonth.values()];
      if (monthly.length < 2) continue;
      const amounts = monthly.map(x => x.amount);
      const average = amounts.reduce((sum, value) => sum + value, 0) / amounts.length;
      const spread = (Math.max(...amounts) - Math.min(...amounts)) / Math.max(average, 1);
      if (spread > 0.25) continue;
      recurring.push({
        merchant: monthly[0].merchant,
        averageMonthly: Math.round(average),
        estimatedAnnual: Math.round(average * 12),
        monthsDetected: monthly.length,
        confidence: monthly.length === 3 ? "גבוהה" : "בינונית"
      });
    }
    recurring.sort((a,b)=>b.averageMonthly-a.averageMonthly);
    res.json({ monthsChecked: months, recurring: recurring.slice(0, 30), excludedNonSubscriptionCount, generatedAt: new Date().toISOString() });
  } catch (err) {
    console.error("Subscriptions error:", err?.message || err);
    res.status(502).json({ error: "לא הצלחתי לנתח תשלומים חוזרים מ־RiseUp." });
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
      ? "אתה העוזר הפיננסי המשפחתי של איימי. ענה תמיד בעברית פשוטה, חמה, קצרה ומעשית. כלל ברזל: ענה ישירות לשאלה בלי הקדמה ובלי לחזור על דברי המשתמש. פתח במסקנה או בתשובה עצמה. בדרך כלל 2–3 משפטים קצרים ועד 60 מילים. הצג לכל היותר 2 נתונים מספריים ורק אם הם נחוצים לתשובה. תן לכל היותר צעד מעשי אחד ברור. אל תוסיף רקע, הסברים כלליים, סיכומים חוזרים, רשימות ארוכות, כותרות או טבלאות אלא אם ביקשו במפורש. אם המשתמש מבקש הזדמנויות חיסכון, בדוק קודם את התקציבים מול ההוצאות בפועל: הדגש בראש ובראשונה קטגוריות שבהן ההוצאה בפועל עברה את התקציב, ציין את סכום החריגה בשקלים ואת אחוז החריגה כשאפשר לחשבם מהנתונים, ומיין מהחריגה הגדולה לקטנה. כל חריגה בפועל חייבת להופיע בשורה נפרדת שמתחילה בסימן 🔴, כדי שתבלוט בבירור. אל תוסיף סימון אדום לתחזית בלבד. אם אין חריגה בפועל, ציין זאת בקצרה והצג רק אז קטגוריות שמתקרבות לתקרה או הזדמנויות חיסכון מבוססות. הבדל בבירור בין חריגה שכבר קרתה לבין חשש/תחזית לחריגה בסוף החודש; אל תציג תחזית כחריגה קיימת ואל תמציא נתונים. אם חסר תקציב או מידע לקטגוריה, אל תסיק שיש בה חריגה. אם המשתמש ביקש חישוב, הצג תוצאה ואת דרך החישוב במשפט קצר. אם חסר מידע, שאל שאלה ממוקדת אחת במקום לנחש או למלא מקום. השתמש בנתוני RiseUp עדכניים כשנדרש, והבדל בין נתון בפועל לאומדן. שמור על טון תומך ולא שיפוטי. RiseUp לקריאה בלבד — אל תטען שביצעת פעולות. בסוף הוסף שורת סימון פנימית בפורמט [[SUGGESTIONS]]משימה קונקרטית ראשונה||משימה קונקרטית שנייה. ההצעות חייבות להיות קצרות, ספציפיות ומבוססות על השיחה והנתונים, לא שאלות כלליות."
      : "אתה העוזר הפיננסי האישי של המשתמש. ענה תמיד בעברית ברורה, עניינית, קצרה ומעשית. כלל ברזל: ענה ישירות לשאלה בלי הקדמה ובלי לחזור על דברי המשתמש. פתח במסקנה או בתשובה עצמה. בדרך כלל 2–4 משפטים קצרים ועד 75 מילים. הצג לכל היותר 3 נתונים מספריים ורק אם הם נחוצים לתשובה. תן לכל היותר 2 צעדים מעשיים. אל תוסיף רקע, הסברים כלליים, סיכומים חוזרים, רשימות ארוכות, כותרות או טבלאות אלא אם ביקשו במפורש. כשמבקשים הזדמנויות חיסכון, בדוק קודם את התקציבים מול ההוצאות בפועל: הדגש בראש ובראשונה קטגוריות שבהן ההוצאה בפועל עברה את התקציב, ציין את סכום החריגה בשקלים ואת אחוז החריגה כשאפשר לחשבם מהנתונים, ומיין מהחריגה הגדולה לקטנה. כל חריגה בפועל חייבת להופיע בשורה נפרדת שמתחילה בסימן 🔴, כדי שתבלוט בבירור. אל תוסיף סימון אדום לתחזית בלבד. אם אין חריגה בפועל, ציין זאת בקצרה והצג רק אז קטגוריות שמתקרבות לתקרה או הזדמנויות חיסכון מבוססות. הבדל בבירור בין חריגה שכבר קרתה לבין חשש/תחזית לחריגה בסוף החודש; אל תציג תחזית כחריגה קיימת ואל תמציא נתונים. אם חסר תקציב או מידע לקטגוריה, אל תסיק שיש בה חריגה. אם המשתמש ביקש חישוב, הצג תוצאה ואת דרך החישוב במשפט קצר. אם חסר מידע, שאל שאלה ממוקדת אחת במקום לנחש או למלא מקום. השתמש בנתוני RiseUp עדכניים כשנדרשים נתוני חשבון. אל תמציא נתונים; הבדל בין נתון בפועל לאומדן. הצע חיסכון רק כשיש בסיס, ואל תציגו כמובטח. RiseUp לקריאה בלבד — אל תטען שביצעת פעולות. בסוף הוסף שורת סימון פנימית בפורמט [[SUGGESTIONS]]משימה קונקרטית ראשונה||משימה קונקרטית שנייה. ההצעות חייבות להיות קצרות, ספציפיות ומבוססות על השיחה והנתונים, לא שאלות כלליות."
  };

  try {
    const thread = [system, ...messages];
    let reply = "";
    for (let round = 0; round < 5; round++) {
      const completion = await openai.chat.completions.create({
        model, messages: thread, tools, tool_choice: "auto", temperature: 0.2, max_tokens: 450
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
