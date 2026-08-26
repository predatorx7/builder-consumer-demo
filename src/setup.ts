/**
 * Idempotent organization setup for the consumer demo.
 *
 * Two things have to exist before the runtime flow (index.ts) works:
 *
 *   1. an **encryption keypair** for the org — the org's Ethereum (secp256k1)
 *      PUBLIC key that verification results get ECIES-encrypted to (when
 *      `canEncryptResult` is enabled). You hold the matching eth PRIVATE key
 *      (0x-hex, the form any wallet/ethers emits) and keep it local to decrypt.
 *   2. a **callback subscription** — the URL the Builder POSTs results to, and
 *      which terminal events we want.
 *
 * Both calls are authenticated by the org secret (RECLAIM_ORG_SECRET).
 *
 * For encryption, set RECLAIM_ETH_PRIVATE_KEY in .env to a 0x-prefixed 32-byte
 * hex private key (e.g. from MetaMask/ethers, or generate one). This registers
 * its public half as the org keypair; the private key stays local — index.ts
 * uses it to decrypt delivered results. NEVER share the private key.
 *
 * Run: node --env-file-if-exists=.env --experimental-strip-types src/setup.ts
 */
import {
	createReclaim,
	deriveFromPrivateKey,
	type RegisterCallbackInput,
} from '@reclaimprotocol/client'

const BUILDER_API_URL = process.env.BUILDER_API_URL || 'http://localhost:4001'
const ORG_SECRET = process.env.RECLAIM_ORG_SECRET
const ORG_ID = process.env.ORG_ID
const CALLBACK_PORT = +(process.env.CALLBACK_PORT || 4010)
const CALLBACK_URL =
	process.env.CALLBACK_URL || `http://localhost:${CALLBACK_PORT}/callback`
const ETH_PRIVATE_KEY = process.env.RECLAIM_ETH_PRIVATE_KEY
const canUseEncryption = process.env.CAN_USE_ENCRYPTION === 'true'
const canBindTee = process.env.CAN_BIND_TEE === 'true'
const CALLBACK_EVENTS = [
	'verification_success',
	'verification_rejected',
	'verification_error',
] satisfies RegisterCallbackInput['events']

if(!ORG_SECRET || !ORG_ID) {
	console.error(
		`Missing config in .env:
RECLAIM_ORG_SECRET — the org secret (rorg_…), issued by an org OWNER
                    via POST /orgs/{orgId}/token
ORG_ID            — the org the token belongs to (addresses the keypair
                    endpoint)`,
	)
	process.exit(1)
}

if((canUseEncryption || canBindTee) && !ETH_PRIVATE_KEY) {
	console.error(
		`Missing RECLAIM_ETH_PRIVATE_KEY. To enable encryption or TEE binding, set it in .env to a
0x-prefixed 32-byte hex private key (e.g. exported from MetaMask/ethers). Its
public half is registered as the org keypair; keep the private key safe —
index.ts uses it to decrypt results.`,
	)
	process.exit(1)
}

const reclaim = createReclaim({
	baseUrl: BUILDER_API_URL,
	orgSecret: ORG_SECRET,
})

if(ETH_PRIVATE_KEY) {
	// Register only the public key. The same organization-owned key can enable
	// callback encryption and authenticate optional legacy-compatible TEE
	// session binding. The private key never leaves this process.
	const { publicKey } = deriveFromPrivateKey(ETH_PRIVATE_KEY)

	const keypair = await reclaim.keypair.set(ORG_ID, {
		publicKey,
		canEncryptResult: canUseEncryption,
		label: 'consumer-demo',
	})
	console.log('✓ organization verification key set')
	console.log('  address :', keypair.ethAddress)
	console.log('  result encryption:', keypair.canEncryptResult ? 'enabled' : 'disabled')
	console.log('  label   :', keypair.label ?? '(none)')
} else {
	const existing = await reclaim.keypair.get(ORG_ID)
	if(existing?.canEncryptResult) {
		await reclaim.keypair.set(ORG_ID, {
			publicKeyJwk: existing.publicKeyJwk,
			canEncryptResult: false,
			...(existing.label ? { label: existing.label } : {}),
		})
		console.log('✓ result encryption disabled for plaintext demo delivery')
	}
}

// Subscribe only to events that carry signed results. Cancellation and expiry
// callbacks are useful operational signals, but they do not carry proofs.
const subscriptions = await reclaim.callbacks.list()
const subscription = subscriptions.find((candidate) => (
	candidate.callbackUrl === CALLBACK_URL
	&& candidate.events.length === CALLBACK_EVENTS.length
	&& CALLBACK_EVENTS.every((event) => candidate.events.includes(event))
)) ?? await reclaim.callbacks.register({
	callbackUrl: CALLBACK_URL,
	events: CALLBACK_EVENTS,
})
console.log('✓ signed-result callback subscription ready')
console.log('  id          :', subscription.id)
console.log('  callbackUrl :', subscription.callbackUrl)
console.log('  events      :', subscription.events.join(', '))

console.log('\nSetup done. Run npm start to create a Builder v2 session.')
