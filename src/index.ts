import assert from 'node:assert'
import { once } from 'node:events'
import {
	type CallbackBody,
	createReclaim,
	ResultVerificationError,
} from '@reclaimprotocol/client'
import express from 'express'

const BUILDER_API_URL = process.env.BUILDER_API_URL || 'http://localhost:4001'
const CALLBACK_PORT = +(process.env.CALLBACK_PORT || 4010)
const CALLBACK_PATH = callbackPath(process.env.CALLBACK_URL)
const ORG_SECRET = requiredEnv('RECLAIM_ORG_SECRET')
const ORG_ID = requiredEnv('ORG_ID')
const PROVIDER_IDS = requiredEnv('PROVIDER_ID')
	.split(',')
	.map((id) => id.trim())
	.filter(Boolean)
const PROVIDER_VERSION = process.env.PROVIDER_VERSION?.trim()
const VERIFICATION_CLIENT_URL = process.env.VERIFICATION_CLIENT_URL?.trim()
const VERIFICATION_CLIENT_QUERY = process.env.VERIFICATION_CLIENT_QUERY?.trim()
const ETH_PRIVATE_KEY = process.env.RECLAIM_ETH_PRIVATE_KEY?.trim()
const canUseEncryption = process.env.CAN_USE_ENCRYPTION === 'true'
const canBindTee = process.env.CAN_BIND_TEE === 'true'

assert(PROVIDER_IDS.length, 'PROVIDER_ID must contain at least one provider UUID')
assert(
	!canUseEncryption || ETH_PRIVATE_KEY,
	'RECLAIM_ETH_PRIVATE_KEY is required when CAN_USE_ENCRYPTION=true',
)
assert(
	!canBindTee || ETH_PRIVATE_KEY,
	'RECLAIM_ETH_PRIVATE_KEY is required when CAN_BIND_TEE=true',
)
const decryptionKey = canUseEncryption
	? requiredOrganizationPrivateKey()
	: undefined
const teePrivateKey = canBindTee
	? requiredOrganizationPrivateKey()
	: undefined

const reclaim = createReclaim({
	baseUrl: BUILDER_API_URL,
	orgSecret: ORG_SECRET,
})

const app = express()
let onDelivery = (_body: CallbackBody) => {}
const delivery = new Promise<CallbackBody>((resolve) => {
	onDelivery = resolve
})

// A production callback should authenticate by verifying the signed result,
// persist before acknowledging, deduplicate deliveries, and process them from
// a durable queue. This demo waits for one signed terminal result in memory.
app.use(express.json({ limit: '1mb' }))
app.post(CALLBACK_PATH, (req, res) => {
	res.sendStatus(202)
	onDelivery(req.body)
})
const server = app.listen(CALLBACK_PORT)
await once(server, 'listening')
console.log(`Callback listener ready on http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`)

try {
	// Builder resolves and pins provider versions at creation. Blank means the
	// latest active version; exact and npm semver ranges are also supported.
	const session = await reclaim.sessions.create({
		providers: PROVIDER_IDS.map((providerId) => ({
			providerId,
			...(PROVIDER_VERSION ? { version: PROVIDER_VERSION } : {}),
		})),
		context: { orderId: `demo-${Date.now()}` },
		...(VERIFICATION_CLIENT_URL
			? { verificationClientUrl: VERIFICATION_CLIENT_URL }
			: {}),
		...(teePrivateKey
			? { teeAttestation: { appSecret: teePrivateKey } }
			: {}),
	})
	const claimantUrl = appendVerificationClientQuery(
		session.verificationUrl,
		VERIFICATION_CLIENT_QUERY,
	)
	assert(
		claimantUrl.searchParams.get('api') === '2',
		'Builder returned a verification URL without api=2',
	)

	console.log('✓ Builder session created:', session.id, `(${session.mode})`)
	console.log('  Verification Client:', session.verificationClientId)
	console.log('  Provider versions:')
	for(const provider of session.providers) {
		console.log(`    ${provider.providerId} → ${provider.resolvedVersion}`)
	}
	console.log('\nOpen this URL for the claimant:')
	console.log(`${claimantUrl}\n`)
	console.log('Waiting for a signed result callback (Ctrl-C to stop)')

	const body = await delivery
	const outcome = await reclaim.results.receive(body, {
		credential: decryptionKey,
		expectedReclaimSessionId: session.id,
		expectedAud: ORG_ID,
		...(teePrivateKey
			? {
				proofValidation: {
					requireSessionBinding: true,
					teeAttestation: { appSecret: teePrivateKey },
				},
			}
			: {}),
	})

	assert(outcome.kind === 'result', `Expected a signed result, got ${outcome.kind}`)
	console.log('✓ Result envelope and every proof verified')
	console.log('  Session:', outcome.result.reclaimSessionId)
	console.log('  Proofs:', outcome.result.proofs?.length ?? 0)

	for(const proof of outcome.result.proofs ?? []) {
		console.log(
			`  ${proof.providerId ?? 'unknown provider'} / `
				+ `${proof.requestId ?? 'unknown request'}: verified by `
				+ `${proof.attestorAddress ?? 'unknown attestor'}`,
		)
		// `proof.data` is the trusted result returned by verifyProof. This demo
		// shows it for clarity; avoid logging personal data in production.
		console.log('    trusted data:', JSON.stringify(proof.data ?? {}, null, 2))
	}

	console.log('\nBuilder event log:')
	for(const event of await reclaim.sessions.listEvents(session.id)) {
		console.log(`  ${event.createdAt}  ${event.event}`)
	}
} catch(error) {
	if(error instanceof ResultVerificationError) {
		console.error('✗ Result verification failed:', error.reason)
		process.exitCode = 1
	} else {
		throw error
	}
} finally {
	await closeServer()
}

function requiredEnv(name: string) {
	const value = process.env[name]?.trim()
	assert(value, `${name} is required; copy .env.example to .env and set it`)
	return value
}

function requiredOrganizationPrivateKey() {
	assert(
		ETH_PRIVATE_KEY,
		'RECLAIM_ETH_PRIVATE_KEY is required for the selected private-key feature',
	)
	return ETH_PRIVATE_KEY
}

function appendVerificationClientQuery(url: string, query?: string) {
	const result = new URL(url)
	if(!query) {
		return result
	}

	for(const [key, value] of new URLSearchParams(query)) {
		assert(
			key !== 'api' && key !== 'sessionId',
			`VERIFICATION_CLIENT_QUERY cannot replace Builder-owned ${key}`,
		)
		result.searchParams.set(key, value)
	}
	return result
}

function callbackPath(callbackUrl?: string) {
	if(!callbackUrl) {
		return '/callback'
	}

	const url = new URL(callbackUrl)
	assert(url.pathname.startsWith('/'), 'CALLBACK_URL must contain an absolute path')
	return url.pathname
}

async function closeServer() {
	if(!server.listening) {
		return
	}

	await new Promise<void>((resolve, reject) => {
		server.close((error) => error ? reject(error) : resolve())
	})
}
