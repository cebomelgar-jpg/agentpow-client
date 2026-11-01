/**
 * AgentPoW Client SDK
 *
 * Lightweight helper to consume the AgentPoW code-solving API with
 * automatic EIP-191 payment signing.
 *
 * Usage (3 lines):
 *   const { solveCode } = require("./sdk");
 *   const result = await solveCode({ code, task: "fix", privateKey });
 *   console.log(result.result);
 *
 * Peer dependency: ethers ^6
 */

const BASE_URL = "https://agentpow-client.vercel.app";

async function getPaymentInfo() {
  const res = await fetch(`${BASE_URL}/api/v1/payment-info`);
  if (!res.ok) throw new Error(`payment-info failed: ${res.status}`);
  return res.json();
}

function buildCanonicalMessage(address, timestamp, fee, payTo) {
  return [
    "AgentPoW Payment Authorization",
    `Address: ${address}`,
    `Timestamp: ${timestamp}`,
    `Fee: ${fee} USD`,
    `PayTo: ${payTo}`,
  ].join("\n");
}

/**
 * Solve/optimize/refactor code via AgentPoW.
 *
 * @param {object} opts
 * @param {string} opts.code           - Source code to process.
 * @param {"fix"|"optimize"|"refactor"} [opts.task="fix"] - Task type.
 * @param {string} opts.privateKey     - Hex private key (0x...) of the paying agent wallet.
 * @param {string} [opts.agentAddress] - Optional explicit address (derived from key if omitted).
 * @param {string} [opts.baseUrl]      - Override API base URL.
 * @returns {Promise<object>} API response { status, result, execution_time_ms, fee_charged }.
 */
async function solveCode(opts) {
  const { code, task = "fix", privateKey, agentAddress, baseUrl } = opts || {};
  if (!code) throw new Error("solveCode: `code` is required");
  if (!privateKey) throw new Error("solveCode: `privateKey` is required");

  const root = (baseUrl || BASE_URL).replace(/\/$/, "");
  const ethers = require("ethers");
  const wallet = new ethers.Wallet(privateKey);
  const address = agentAddress || wallet.address;

  // 1. Fetch payment info (fee + recipient) and capture server time from Date header
  const infoRes = await fetch(`${root}/api/v1/payment-info`);
  const info = await infoRes.json();
  const fee = info.fee_usd;
  const payTo = info.pay_to;

  // Use server clock (from Date header) to avoid client/server clock skew
  let timestamp = Date.now();
  const serverDate = infoRes.headers.get("date");
  if (serverDate) {
    const parsed = Date.parse(serverDate);
    if (!isNaN(parsed)) timestamp = parsed;
  }

  // 2. Build & sign canonical message
  const message = buildCanonicalMessage(address, timestamp, fee, payTo);
  const signature = await wallet.signMessage(message);

  // 3. POST to /api/v1/solve
  const res = await fetch(`${root}/api/v1/solve`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Agent-Address": address,
      "X-Agent-Signature": signature,
      "X-Agent-Timestamp": String(timestamp),
    },
    body: JSON.stringify({ code, task }),
  });

  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.reason || data.error || `solve failed: ${res.status}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

module.exports = { solveCode, getPaymentInfo, buildCanonicalMessage, BASE_URL };