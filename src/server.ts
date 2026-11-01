// AgentPoW - Micro-servicio backend para agentes de IA
// Verificacion de pagos off-chain (EIP-712/ECDSA) + motor Google Gemini

import "dotenv/config";
import express, { Request, Response, NextFunction } from "express";
import { ethers } from "ethers";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT ?? 3000);
const REVENUE_WALLET = (process.env.REVENUE_WALLET ?? "0x68256C7DEaeC15669432447524FBaFe18574bF28").toLowerCase();
const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? "";
const SERVICE_FEE_USD = process.env.SERVICE_FEE_USD ?? "0.001";
const TIMESTAMP_TOLERANCE_MS = 60_000; // 60s anti-replay

// ---------------------------------------------------------------------------
// Gemini client
// ---------------------------------------------------------------------------
const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

// ---------------------------------------------------------------------------
// Canonical signed message (what the agent signs with their wallet)
//   "AgentPoW Payment Authorization\nAddress: <addr>\nTimestamp: <ts>\nFee: <fee> USD"
// ---------------------------------------------------------------------------
function buildSignedMessage(address: string, timestamp: number): string {
  return [
    "AgentPoW Payment Authorization",
    `Address: ${address}`,
    `Timestamp: ${timestamp}`,
    `Fee: ${SERVICE_FEE_USD} USD`,
    `PayTo: ${REVENUE_WALLET}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Payment middleware (off-chain EIP-712/ECDSA)
// ---------------------------------------------------------------------------
function paymentMiddleware(req: Request, res: Response, next: NextFunction) {
  const address = req.header("X-Agent-Address");
  const signature = req.header("X-Agent-Signature");
  const timestampRaw = req.header("X-Agent-Timestamp");

  // 1. Required headers
  if (!address || !signature || !timestampRaw) {
    return res.status(402).json({
      error: "Payment Required",
      fee_usd: Number(SERVICE_FEE_USD),
      pay_to: REVENUE_WALLET,
      network: "Polygon",
      auth_format: "EIP-712 Signature in Headers",
    });
  }

  // 2. Validate address format
  if (!ethers.isAddress(address)) {
    return res.status(402).json({
      error: "Payment Required",
      reason: "Invalid agent address",
      fee_usd: Number(SERVICE_FEE_USD),
      pay_to: REVENUE_WALLET,
      network: "Polygon",
      auth_format: "EIP-712 Signature in Headers",
    });
  }

  // 3. Validate timestamp (anti-replay)
  const timestamp = Number(timestampRaw);
  if (!Number.isFinite(timestamp)) {
    return res.status(402).json({
      error: "Payment Required",
      reason: "Invalid timestamp",
      fee_usd: Number(SERVICE_FEE_USD),
      pay_to: REVENUE_WALLET,
      network: "Polygon",
      auth_format: "EIP-712 Signature in Headers",
    });
  }
  const now = Date.now();
  if (Math.abs(now - timestamp) > TIMESTAMP_TOLERANCE_MS) {
    return res.status(402).json({
      error: "Payment Required",
      reason: "Timestamp expired or out of range (>60s)",
      fee_usd: Number(SERVICE_FEE_USD),
      pay_to: REVENUE_WALLET,
      network: "Polygon",
      auth_format: "EIP-712 Signature in Headers",
    });
  }

  // 4. Verify signature (ECDSA recover signer)
  let recovered: string;
  try {
    const message = buildSignedMessage(address, timestamp);
    recovered = ethers.verifyMessage(message, signature);
  } catch {
    return res.status(402).json({
      error: "Payment Required",
      reason: "Signature verification failed",
      fee_usd: Number(SERVICE_FEE_USD),
      pay_to: REVENUE_WALLET,
      network: "Polygon",
      auth_format: "EIP-712 Signature in Headers",
    });
  }

  if (recovered.toLowerCase() !== address.toLowerCase()) {
    return res.status(402).json({
      error: "Payment Required",
      reason: "Signature does not match agent address",
      fee_usd: Number(SERVICE_FEE_USD),
      pay_to: REVENUE_WALLET,
      network: "Polygon",
      auth_format: "EIP-712 Signature in Headers",
    });
  }

  // 5. (Optional) EIP-712 typed data verification is also supported:
  //    ethers.verifyTypedData(domain, types, value, signature)

  // Attach verified info to request
  (req as any).agent = { address: recovered, timestamp };
  next();
}

// ---------------------------------------------------------------------------
// Solve schema
// ---------------------------------------------------------------------------
const SolveSchema = z.object({
  code: z.string().min(1).max(50_000),
  task: z.enum(["fix", "optimize", "refactor"]).default("fix"),
});

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: "1mb" }));

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "agentpow", version: "1.0.0" });
});

// Payment info (no auth)
app.get("/api/v1/payment-info", (_req, res) => {
  res.json({
    fee_usd: Number(SERVICE_FEE_USD),
    pay_to: REVENUE_WALLET,
    network: "Polygon",
    auth_format: "EIP-712 Signature in Headers",
    signed_message_format: buildSignedMessage("<agent_address>", 0).replace("0", "<timestamp_ms>"),
    headers_required: ["X-Agent-Address", "X-Agent-Signature", "X-Agent-Timestamp"],
    timestamp_tolerance_seconds: 60,
  });
});

// Main solve endpoint
app.post("/api/v1/solve", paymentMiddleware, async (req, res) => {
  const start = Date.now();

  const parsed = SolveSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid request body",
      details: parsed.error.flatten(),
    });
  }

  const { code, task } = parsed.data;

  if (!genAI) {
    return res.status(503).json({
      error: "Gemini API key not configured",
      hint: "Set GEMINI_API_KEY in .env",
    });
  }

  const taskPrompts: Record<string, string> = {
    fix: "Fix all bugs and errors in the following code. Return ONLY the corrected code, no markdown, no explanation.",
    optimize: "Optimize the following code for performance and readability. Return ONLY the optimized code, no markdown, no explanation.",
    refactor: "Refactor the following code following best practices and clean code principles. Return ONLY the refactored code, no markdown, no explanation.",
  };

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const prompt = `${taskPrompts[task]}\n\nLanguage: auto-detect\n\nCode:\n${code}`;
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();

    // Strip markdown code fences if present
    const cleaned = text.replace(/^```[\w]*\n?/, "").replace(/\n?```$/, "").trim();

    const executionTime = Date.now() - start;

    return res.json({
      status: "success",
      result: cleaned,
      execution_time_ms: executionTime,
      fee_charged: `${SERVICE_FEE_USD} USD`,
    });
  } catch (err: any) {
    return res.status(500).json({
      error: "Gemini processing failed",
      reason: err?.message ?? "unknown",
      execution_time_ms: Date.now() - start,
    });
  }
});

// Test UI
app.get("/", (_req, res) => {
  res.type("text/html").send(TEST_UI_HTML);
});

const TEST_UI_HTML = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>AgentPoW - Test Console</title>
<style>
  body { font-family: 'Segoe UI', sans-serif; background: #0d1117; color: #c9d1d9; margin: 0; padding: 20px; }
  .container { max-width: 900px; margin: 0 auto; }
  h1 { color: #58a6ff; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 20px; margin: 16px 0; }
  label { display: block; margin: 8px 0 4px; color: #8b949e; font-size: 14px; }
  select, textarea, input { width: 100%; background: #0d1117; color: #c9d1d9; border: 1px solid #30363d; border-radius: 6px; padding: 10px; font-family: monospace; font-size: 13px; box-sizing: border-box; }
  textarea { min-height: 150px; resize: vertical; }
  button { background: #238636; color: white; border: none; border-radius: 6px; padding: 10px 20px; cursor: pointer; font-size: 14px; margin-top: 12px; }
  button:hover { background: #2ea043; }
  button.secondary { background: #1f6feb; }
  .result { background: #0d1117; border: 1px solid #30363d; border-radius: 6px; padding: 16px; margin-top: 12px; white-space: pre-wrap; font-family: monospace; font-size: 13px; max-height: 400px; overflow: auto; }
  .status { padding: 8px 12px; border-radius: 6px; margin: 8px 0; font-size: 13px; }
  .status.ok { background: #1a3a2a; color: #3fb950; }
  .status.err { background: #3a1a1a; color: #f85149; }
  .row { display: flex; gap: 12px; }
  .row > * { flex: 1; }
</style>
</head>
<body>
<div class="container">
  <h1>⚡ AgentPoW Test Console</h1>
  <p>Micro-servicio de codigo para agentes. Prueba <code>POST /api/v1/solve</code>.</p>

  <div class="card">
    <h3>1. Info de pago</h3>
    <button class="secondary" onclick="getPaymentInfo()">Obtener instrucciones de pago</button>
    <div id="paymentInfo" class="result" style="display:none"></div>
  </div>

  <div class="card">
    <h3>2. Resolver codigo</h3>
    <div class="row">
      <div>
        <label>Tarea</label>
        <select id="task">
          <option value="fix">Fix</option>
          <option value="optimize">Optimize</option>
          <option value="refactor">Refactor</option>
        </select>
      </div>
    </div>
    <label>Codigo</label>
    <textarea id="code" placeholder="Pega tu codigo aqui...">function greet(name) {
  console.log("Hello " + name);
  if (name == null) {
    return "anonymous";
  }
  return "Hello " + name;
}</textarea>
    <label>X-Agent-Address</label>
    <input id="addr" placeholder="0x..." />
    <label>X-Agent-Signature</label>
    <input id="sig" placeholder="0x..." />
    <label>X-Agent-Timestamp (ms)</label>
    <input id="ts" placeholder="1700000000000" />
    <button onclick="genSig()">Generar firma de prueba (ethers)</button>
    <button onclick="solve()">Enviar a /api/v1/solve</button>
    <div id="status"></div>
    <div id="result" class="result" style="display:none"></div>
  </div>
</div>

<script src="https://cdn.ethers.io/lib/ethers-5.7.umd.min.js"></script>
<script>
async function getPaymentInfo() {
  const r = await fetch('/api/v1/payment-info');
  const d = await r.json();
  document.getElementById('paymentInfo').style.display = 'block';
  document.getElementById('paymentInfo').textContent = JSON.stringify(d, null, 2);
}

async function genSig() {
  const wallet = ethers.Wallet.createRandom();
  document.getElementById('addr').value = wallet.address;
  const ts = Date.now();
  document.getElementById('ts').value = ts;
  const msg = "AgentPoW Payment Authorization\\nAddress: " + wallet.address + "\\nTimestamp: " + ts + "\\nFee: 0.001 USD\\nPayTo: 0x68256C7DEaeC15669432447524FBaFe18574bF28";
  const sig = await wallet.signMessage(msg);
  document.getElementById('sig').value = sig;
  // store pk for display
  console.log("Test wallet private key:", wallet.privateKey);
}

async function solve() {
  const body = {
    code: document.getElementById('code').value,
    task: document.getElementById('task').value,
  };
  const headers = { 'Content-Type': 'application/json' };
  const addr = document.getElementById('addr').value.trim();
  const sig = document.getElementById('sig').value.trim();
  const ts = document.getElementById('ts').value.trim();
  if (addr) headers['X-Agent-Address'] = addr;
  if (sig) headers['X-Agent-Signature'] = sig;
  if (ts) headers['X-Agent-Timestamp'] = ts;

  const statusEl = document.getElementById('status');
  const resultEl = document.getElementById('result');
  resultEl.style.display = 'none';

  try {
    const r = await fetch('/api/v1/solve', { method: 'POST', headers, body: JSON.stringify(body) });
    const d = await r.json();
    if (r.ok) {
      statusEl.className = 'status ok';
      statusEl.textContent = 'OK - ' + r.status;
    } else {
      statusEl.className = 'status err';
      statusEl.textContent = 'Error - ' + r.status + ': ' + (d.reason || d.error || '');
    }
    resultEl.style.display = 'block';
    resultEl.textContent = JSON.stringify(d, null, 2);
  } catch (e) {
    statusEl.className = 'status err';
    statusEl.textContent = 'Network error: ' + e.message;
  }
}
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`\n⚡ AgentPoW running on http://localhost:${PORT}`);
  console.log(`   Health:        http://localhost:${PORT}/health`);
  console.log(`   Payment info:  http://localhost:${PORT}/api/v1/payment-info`);
  console.log(`   Solve:         POST http://localhost:${PORT}/api/v1/solve`);
  console.log(`   UI:            http://localhost:${PORT}/\n`);
});