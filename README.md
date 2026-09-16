# Run the Builder consumer demo

Both halves of a Builder integration:

**Server** (`src/index.ts`)

1. Create a Builder verification, bound to the Verification Client the page asked for.
2. Return the `verificationUrl`.
3. Receive the Builder callback.
4. Verify the proof with `@reclaimprotocol/client`, and relay the outcome to the page.

**Browser** (`public/`)

1. Ask the server for a session.
2. Read which client it was bound to, out of `verificationUrl`.
3. Launch it the way this device needs: extension handoff, portal tab or iframe,
   app deep link, App Clip, or QR.
4. Wait for the server to relay the result.

## The browser half needs the launcher

`public/app.js` imports `@reclaimprotocol/client/launch`, which is planned but
not built yet — see `../plans/client-launch-api.md`. The server runs today and
`/` loads, but `/vendor/launch.js` answers 501 and the buttons fail until that
subpath ships. Everything else in this README works now.

## The server picks the client, the page picks the mechanism

A session is bound to one Verification Client when it is created, and nothing
can change it afterwards: every Builder call re-checks the binding and answers
403 on a mismatch. So the choice stays where it already is — in the code that
creates the session.

The page never overrides it. It reads the client out of `verificationUrl` and
decides only *how* to open it here: a tab or an iframe, an App Clip or a deep
link, a QR code on a desktop. Same session, same attribution, whatever device
the claimant is on.

`POST /verifications` takes a `client` in this demo only so the buttons can show
each path. A real app usually hardcodes one. The server still keeps an allowlist
(`LAUNCH_CLIENTS`) rather than trusting the name: Builder only accepts a
registered URL, but an app should choose from the clients it has tested.

## Why the result comes back over SSE

The page cannot ask Builder how a session ended — that needs the org secret,
which never leaves the server. Builder posts the result to
`/callbacks/reclaim`, and `/verifications/:id/events` forwards it to whoever is
waiting. Server-sent events keep the demo small; use whatever your app already
has.

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
# Optional. Defaults to https://build.reclaimprotocol.org
BUILDER_BASE_URL=http://localhost:4001
```

`BUILDER_BASE_URL` also derives the Verification Client URLs, and each must
equal a registered client's `uri` exactly — Builder answers 400 rather than
creating a session otherwise.

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

Open <http://localhost:3000> and use the buttons, or drive the server directly:

```bash
curl -X POST http://localhost:3000/verifications \
  -H 'content-type: application/json' \
  -d '{"client":"portals","context":{"orderId":"order-123"}}'
```

`client` is one of `builder`, `portals`, `verifier-app`, or
`reclaim-browser-extension`, and defaults to `builder`.

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
