# ⚡ AgentPoW

Micro-servicio backend ultra-ligero para agentes de IA autonomos con verificacion de pagos off-chain (EIP-712/ECDSA) y motor Google Gemini.

## Stack
- Node.js + TypeScript
- Express
- ethers v6 (verificacion de firmas ECDSA)
- @google/generative-ai (Gemini 1.5 Flash)
- zod (validacion)

## Endpoints

| Metodo | Ruta | Descripcion |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/` | Consola de pruebas (UI) |
| GET | `/api/v1/payment-info` | Instrucciones de pago + formato del mensaje firmado |
| POST | `/api/v1/solve` | Resuelve codigo (requiere pago) |

## Variables de entorno

```env
PORT=3000
REVENUE_WALLET=0x68256C7DEaeC15669432447524FBaFe18574bF28
GEMINI_API_KEY=AIzaSy...
SERVICE_FEE_USD=0.001
```

## Flujo de pago (off-chain)

1. El agente construye el mensaje canonico:
   ```
   AgentPoW Payment Authorization
   Address: <agent_address>
   Timestamp: <timestamp_ms>
   Fee: 0.001 USD
   PayTo: 0x68256c7deaec15669432447524fbafe18574bf28
   ```
2. Firma el mensaje con su wallet (EIP-191 `personal_sign` / `signMessage`).
3. Envia `POST /api/v1/solve` con headers:
   - `X-Agent-Address`: billetera publica
   - `X-Agent-Signature`: firma (hex)
   - `X-Agent-Timestamp`: timestamp UNIX en ms
4. El middleware verifica con `ethers.verifyMessage` que el signer coincida con la direccion y que el timestamp sea < 60s.
5. Si falla -> HTTP 402 con instrucciones de pago.
6. Si pasa -> procesa con Gemini y devuelve `{ status, result, execution_time_ms, fee_charged }`.

## Body de /api/v1/solve

```json
{ "code": "function add(a,b){return a+b}", "task": "fix|optimize|refactor" }
```

## Respuesta exitosa

```json
{
  "status": "success",
  "result": "codigo_resuelto",
  "execution_time_ms": 230,
  "fee_charged": "0.001 USD"
}
```

## Respuesta 402

```json
{
  "error": "Payment Required",
  "fee_usd": 0.001,
  "pay_to": "0x68256C7DEaeC15669432447524FBaFe18574bF28",
  "network": "Polygon",
  "auth_format": "EIP-712 Signature in Headers"
}
```

## Desarrollo

```bash
npm install
cp .env.example .env
# Editar .env y poner GEMINI_API_KEY real
npm run dev
```

## Produccion (Docker)

```bash
docker build -t agentpow .
docker run -p 3000:3000 --env-file .env agentpow
```

## Estructura

```
src/
  server.ts   # servidor Express + middleware de pago + ruta /api/v1/solve + Gemini
```