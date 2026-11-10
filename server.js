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
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const port = Number(process.env.PORT || 3000);
const root = path.dirname(fileURLToPath(import.meta.url));
app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(root, "public"), { etag: false, maxAge: 0 }));

const limiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false });

function authorized(req) {
  const a = Buffer.from(req.get("authorization") || "");
  const b = Buffer.from("Bearer " + process.env.APP_ACCESS_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
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
function summarizeBudget(budget, transactions) {
  const envelopes = Array.isArray(budget?.envelopes) ? budget.envelopes : [];
  const byCategory = new Map();
  let income = 0, expenses = 0, transactionCount = 0;
  let plannedExpenses = 0;

  const addExpense = (name, amount, type, planned = null) => {
    const key = String(name || "אחר").trim() || "אחר";
    const current = byCategory.get(key) || {
      name: key, type, actual: 0, planned: null, transactionCount: 0
    };
    current.actual += amount;
    current.transactionCount += 1;
    if (planned !== null) current.planned = (current.planned || 0) + planned;
    byCategory.set(key, current);
  };

  for (const env of envelopes) {
    const type = env.type || "other";
    const actuals = Array.isArray(env.actuals) ? env.actuals : [];
    const trackingName = env.details?.trackingCategory?.name;
    const envelopeName = String(trackingName || env.name || env.title || "הוצאה קבועה");
    const planned = Math.abs(num(env.balancedAmount ?? env.originalAmount));

    // Savings goals are not expenses. Income envelopes are not part of the expense budget.
    if (type === "riseupGoal" || type === "variableIncome") {
      for (const tx of actuals) {
        if (tx.isIncome || type === "variableIncome") income += abs(tx.incomeAmount);
        transactionCount++;
      }
      if (type === "variableIncome" && !actuals.length) continue;
      continue;
    }

    if (["fixed", "variable", "trackingCategory"].includes(type)) {
      plannedExpenses += planned;
    }

    for (const tx of actuals) {
      transactionCount++;
      if (tx.isIncome) {
        income += abs(tx.incomeAmount);
        continue;
      }
      const amount = abs(tx.billingAmount);
      if (!amount) continue;
      expenses += amount;

      if (type === "variable") {
        // RiseUp's variable envelope contains many everyday categories.
        // Split it by the transaction's own category instead of showing one large "variable" bucket.
        const transactionCategory = tx.expense || tx.categoryLabel || tx.category || "אחר";
        addExpense(transactionCategory, amount, "variable");
      } else if (type === "fixed" || type === "trackingCategory") {
        // The envelope is the budgeted unit for fixed and tracked categories.
        addExpense(envelopeName, amount, type, null);
      } else {
        addExpense(tx.expense || tx.categoryLabel || tx.category || envelopeName, amount, type);
      }
    }

    // Keep a zero-spend budget category visible so the user can see its unused budget.
    if (["fixed", "trackingCategory"].includes(type) && !actuals.length && planned > 0) {
      byCategory.set(envelopeName, {
        name: envelopeName, type, actual: 0, planned, transactionCount: 0
      });
    }
  }

  const categories = [...byCategory.values()].map(c => ({
    ...c,
    remaining: c.planned === null ? null : c.planned - c.actual,
    utilization: c.planned > 0 ? Math.round(c.actual / c.planned * 100) : null,
    share: expenses > 0 ? Math.round(c.actual / expenses * 100) : 0
  })).sort((a,b)=>b.actual-a.actual);

  return {
    month: budget?.budgetDate || null,
    lastUpdatedAt: budget?.lastUpdatedAt || null,
    income, expenses, net: income - expenses,
    plannedExpenses,
    categories: categories.slice(0, 20),
    transactionCount
  };
}

app.get("/health", (_req, res) => res.json({ ok: true }));
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
    const [currentTransactions, previousBudget, balancesResult, benchmarksResult] = await Promise.all([
      callRiseup("get_transactions", { cashflowMonth: currentMonth, maxTransactions: 5000 }).catch(() => null),
      callRiseup("get_budget", { date: "previous" }).catch(() => null),
      callRiseup("get_current_bank_balances_data").catch(() => null),
      callRiseup("get_benchmarks_data").catch(() => null)
    ]);
    const current = summarizeBudget(currentBudget, currentTransactions);
    const previous = previousBudget ? summarizeBudget(previousBudget, null) : null;
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
        budget: true, transactions: Boolean(currentTransactions),
        balances: Boolean(balancesResult), benchmarks: Boolean(benchmarksResult)
      },
      generatedAt: new Date().toISOString()
    });
  } catch (err) {
    console.error("Dashboard error:", err?.message || err);
    res.status(502).json({ error: "לא הצלחתי לטעון את תמונת המצב. בדוק הרשאות RiseUp ונסה שוב." });
  }
});

app.post("/api/chat", limiter, auth, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
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
    content: "אתה סמנכ״ל הכספים האישי של המשתמש ועונה בעברית. נהל את הכסף כמו עסק: הצג הכנסות, הוצאות, תזרים, תקציב מול ביצוע, חריגות והזדמנויות חיסכון. השתמש בכלי RiseUp לנתונים עדכניים. אל תמציא סכומים, קטגוריות או עסקאות; ציין תקופה ומקור נתונים, והבדל בין נתון שנשלף לבין אומדן או חישוב. כשמציעים חיסכון, הצג פעולה מעשית, חיסכון חודשי משוער והנחות. אל תציג חיסכון מובטח. אם אין גישה לנתון, אמור זאת. כלי RiseUp לקריאה בלבד — לעולם אל תטען ששינית תקציב או ביצעת פעולה בחשבון."
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
    res.json({ reply: reply || "הגעתי למגבלת קריאות הכלים. נסה שאלה ממוקדת יותר." });
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
