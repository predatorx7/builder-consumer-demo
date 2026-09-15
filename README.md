# Run the Builder consumer demo

This demo contains the essential server-side integration:

1. Create a Builder verification.
2. Send the returned URL to the claimant.
3. Receive the Builder callback.
4. Verify and store the proof with `@reclaimprotocol/client`.

Fastify stores sessions and verified results in memory. Restarting the process
clears them. Pino logs HTTP requests and errors without logging proof contents.
The demo endpoints are intentionally unauthenticated; use your application's
normal authentication before exposing equivalent endpoints in production.

## Configure providers

Set the providers and versions in `providers.json`:

```json
{
  "providers": [
    {
      "providerId": "00000000-0000-0000-0000-000000000000",
      "version": "1.0.0"
    }
  ]
}
```

Omit `version` to use the latest active version. You can also use a semantic
version range.

## Configure the server

Create `.env`:

```dotenv
RECLAIM_ORG_SECRET=rorg_replace_me
ORG_ID=00000000-0000-0000-0000-000000000000
```

Optionally set `RECLAIM_ETH_PRIVATE_KEY` to the organization's Ethereum private
key. The SDK keeps it on this server and uses it to bind the session to the app,
verify the proof's TEE binding, and decrypt callback results when organization
encryption is enabled.

Builder requires a callback subscription before it creates a verification.
Configure the subscription separately with this callback URL:

```text
https://your-server.example/callbacks/reclaim
```

The demo doesn't create or check the subscription. Builder errors appear in
the Fastify logs.

## Run the server

```bash
npm install
npm run check
npm start
```

The server listens on port 3000.

Create a verification:

```bash
curl -X POST http://localhost:3000/verifications \
  -H 'content-type: application/json' \
  -d '{"context":{"orderId":"order-123"}}'
```

Open the returned `verificationUrl`. Save its `reclaimSessionId`. After the
callback arrives, read the verified result and proof data:

```bash
curl http://localhost:3000/verifications/RECLAIM_SESSION_ID
```

The callback's `sessionId`, `event`, and `timestamp` fields are routing hints.
The server stores only the result returned by `results.receive`, which verifies
the Builder signature, organization, session, and each proof.

## Use a Cloudflare quick tunnel

Expose the local server:

```bash
cloudflared tunnel --url http://localhost:3000
```

Register the generated HTTPS URL with `/callbacks/reclaim` appended. Restarting
the tunnel changes the URL, so update the Builder callback subscription.
