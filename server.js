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

app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/api/status", limiter, auth, (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ connected: true, tools: riseupTools.map(t => ({ name: t.name, description: t.description })) });
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
    content: "אתה אנליסט פיננסי אישי שעונה בעברית על בסיס נתוני RiseUp. השתמש בכלי RiseUp לנתונים עדכניים. אל תמציא סכומים או עסקאות. הבדל בין נתון שהוחזר לבין חישוב שלך. אם אין גישה לנתון, אמור זאת. כלי RiseUp לקריאה בלבד."
  };

  try {
    const thread = [system, ...messages];
    let reply = "";
    for (let round = 0; round < 5; round++) {
      const completion = await openai.chat.completions.create({
        model,
        messages: thread,
        tools,
        tool_choice: "auto",
        temperature: 0.2
      });
      const assistant = completion.choices?.[0]?.message;
      if (!assistant) throw new Error("Empty model response");
      thread.push(assistant);
      if (!assistant.tool_calls?.length) {
        reply = assistant.content || "לא התקבלה תשובה.";
        break;
      }
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
        const text = (result.content || [])
          .filter(c => c.type === "text")
          .map(c => c.text)
          .join("\n")
          .slice(0, 20000);
        thread.push({
          role: "tool",
          tool_call_id: call.id,
          content: result.isError ? JSON.stringify({ error: text }) : (text || JSON.stringify(result))
        });
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
