# Run the Builder consumer demo

This Fastify server shows the production integration shape:

1. Your backend creates a Builder verification.
2. Your frontend opens the returned `verificationUrl`.
3. Builder sends the signed result to your callback.
4. Your backend verifies the result with `@reclaimprotocol/client` and stores
   only the verified payload.

The demo stores sessions and verified results in SQLite. Fastify writes
structured HTTP logs with Pino. It doesn't log callback bodies, proofs, or
claimant data.

## Configure the server

Create `.env`:

```dotenv
RECLAIM_ORG_SECRET=rorg_replace_me
ORG_ID=00000000-0000-0000-0000-000000000000
PROVIDER_ID=00000000-0000-0000-0000-000000000000
CONSUMER_API_KEY=replace_with_a_random_server_api_key
PUBLIC_URL=https://consumer.example.com
```

`PUBLIC_URL` must be reachable by Builder. The server registers
`PUBLIC_URL/callbacks/reclaim` as the callback when it starts.

The following variables are optional:

| Variable | Default | Purpose |
| --- | --- | --- |
| `BUILDER_API_URL` | `https://build.reclaimprotocol.org` | Builder deployment to use. |
| `VERIFICATION_CLIENT` | `builder` | Registered client name from `VERIFICATION_CLIENT_URLS`. |
| `PROVIDER_VERSION` | Latest active version | Exact version or semantic-version range. |
| `RECLAIM_ETH_PRIVATE_KEY` | None | Decrypt results when organization callback encryption is enabled. |
| `PORT` | `3000` | HTTP port. |
| `DATABASE_PATH` | `consumer-demo.sqlite` | SQLite database path. |
| `LOG_LEVEL` | `info` | Pino log level. |

For staging or local Builder, set `BUILDER_API_URL`. The SDK derives the same
complete Verification Client URL map that Builder registers for that origin.

## Start the server

```bash
npm install
npm run check
npm start
```

Create a verification:

```bash
curl -X POST http://localhost:3000/verifications \
  -H 'authorization: Bearer replace_with_a_random_server_api_key' \
  -H 'content-type: application/json' \
  -d '{"context":{"orderId":"order-123"}}'
```

Open the returned `verificationUrl`. After Builder delivers and the server
verifies the callback, read the verification status and verified proof data:

```bash
curl http://localhost:3000/verifications/SESSION_ID \
  -H 'authorization: Bearer replace_with_a_random_server_api_key'
```

## Test with a Cloudflare quick tunnel

Start the server on port 3000, then expose it:

```bash
cloudflared tunnel --url http://localhost:3000
```

Set `PUBLIC_URL` to the generated HTTPS origin and restart the server. For a
local Builder, also set `BUILDER_API_URL=http://localhost:4001`.

The authenticated status endpoint returns the stored result and proof data when
verification is complete. The `sessionId`, `event`, and `timestamp` callback
fields are routing hints. The server trusts and stores only data returned by
`results.receive`, which verifies the Builder signature, expected organization,
expected session, and each proof. Keep the organization secret and consumer API
key on the server.
