# AgentPoW Client SDK

Lightweight client to consume the AgentPoW code-solving API with automatic EIP-191 payment signing.

## Install

```bash
npm install ethers
# copy the sdk/ folder into your project, or import from the repo
```

## Usage (3 lines)

```js
const { solveCode } = require("./sdk");
const result = await solveCode({ code: "function add(a,b){return a+b}", task: "optimize", privateKey: "0xYOUR_PRIVATE_KEY" });
console.log(result.result);
```

## API

`solveCode({ code, task?, privateKey, agentAddress?, baseUrl? })`

- `code` (string, required) - source code to process.
- `task` (string) - `"fix" | "optimize" | "refactor"` (default `"fix"`).
- `privateKey` (string, required) - hex private key of the paying wallet.
- `agentAddress` (string, optional) - explicit address (derived from key if omitted).
- `baseUrl` (string, optional) - override API base URL (default `https://agentpow-client.vercel.app`).

Returns the API response: `{ status, result, execution_time_ms, fee_charged }`.

## Notes

- Each successful call charges `0.001 USD` to the wallet.
- The SDK fetches payment info automatically and signs the canonical EIP-191 message.
- Requires Node 18+ (global `fetch`) and `ethers` v6 as a peer dependency.