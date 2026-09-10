import assert from 'node:assert'
import { timingSafeEqual } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import {
	createReclaim,
	DEFAULT_BASE_URL,
	KNOWN_VERIFICATION_CLIENTS,
	type KnownVerificationClientName,
	ResultVerificationError,
	type VerificationResultDelivery,
	VERIFICATION_CLIENT_URLS,
	verificationClientUrls,
} from '@reclaimprotocol/client'
import Fastify from 'fastify'
import type { FastifyReply, FastifyRequest } from 'fastify'
import pino from 'pino'

const PORT = Number(process.env.PORT || 3000)
const BUILDER_API_URL = process.env.BUILDER_API_URL || DEFAULT_BASE_URL
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`
const ORG_SECRET = requiredEnv('RECLAIM_ORG_SECRET')
const ORG_ID = requiredEnv('ORG_ID')
const CONSUMER_API_KEY = requiredEnv('CONSUMER_API_KEY')
const PROVIDER_ID = requiredEnv('PROVIDER_ID')
const PROVIDER_VERSION = process.env.PROVIDER_VERSION?.trim()
const RESULT_DECRYPTION_KEY = process.env.RECLAIM_ETH_PRIVATE_KEY?.trim()
const DATABASE_PATH = process.env.DATABASE_PATH || 'consumer-demo.sqlite'
const urls = BUILDER_API_URL === DEFAULT_BASE_URL
	? VERIFICATION_CLIENT_URLS
	: verificationClientUrls(BUILDER_API_URL)
const verificationClientName = process.env.VERIFICATION_CLIENT
	|| KNOWN_VERIFICATION_CLIENTS.builder

assert(
	isKnownVerificationClient(verificationClientName),
	`VERIFICATION_CLIENT must be one of: ${Object.keys(urls).join(', ')}`,
)

const callbackUrl = new URL('/callbacks/reclaim', PUBLIC_URL).toString()
const reclaim = createReclaim({
	baseUrl: BUILDER_API_URL,
	orgSecret: ORG_SECRET,
})
const database = new DatabaseSync(DATABASE_PATH)
database.exec(`
	PRAGMA foreign_keys = ON;
	PRAGMA journal_mode = WAL;
	CREATE TABLE IF NOT EXISTS verification_sessions (
		id TEXT PRIMARY KEY,
		created_at TEXT NOT NULL
	);
	CREATE TABLE IF NOT EXISTS verification_results (
		session_id TEXT PRIMARY KEY REFERENCES verification_sessions(id),
		received_at TEXT NOT NULL,
		result_json TEXT NOT NULL
	);
`)

const insertSession = database.prepare(`
	INSERT INTO verification_sessions (id, created_at) VALUES (?, ?)
`)
const findSession = database.prepare(`
	SELECT id FROM verification_sessions WHERE id = ?
`)
const insertResult = database.prepare(`
	INSERT INTO verification_results (session_id, received_at, result_json)
	VALUES (?, ?, ?)
	ON CONFLICT (session_id) DO NOTHING
`)
const findResult = database.prepare(`
	SELECT result_json FROM verification_results WHERE session_id = ?
`)

const logger = pino({
	level: process.env.LOG_LEVEL || 'info',
	redact: ['req.headers.authorization'],
})
const app = Fastify({ loggerInstance: logger })

app.post<{ Body: CreateVerificationBody }>('/verifications', {
	preHandler: authenticateConsumer,
	schema: {
		body: {
			type: 'object',
			additionalProperties: false,
			properties: {
				context: {
					type: 'object',
					additionalProperties: true,
					maxProperties: 20,
				},
			},
		},
	},
}, async(request, reply) => {
	const session = await reclaim.sessions.create({
		providers: [{
			providerId: PROVIDER_ID,
			...(PROVIDER_VERSION ? { version: PROVIDER_VERSION } : {}),
		}],
		context: request.body.context || {},
		verificationClientUrl: urls[verificationClientName],
	})
	insertSession.run(session.id, new Date().toISOString())
	request.log.info({ sessionId: session.id }, 'verification created')
	return reply.code(201).send({
		sessionId: session.id,
		verificationUrl: session.verificationUrl,
	})
})

app.post<{ Body: VerificationResultDelivery }>('/callbacks/reclaim', {
	schema: {
		body: {
			type: 'object',
			additionalProperties: false,
			required: ['sessionId', 'event', 'timestamp', 'data'],
			properties: {
				sessionId: { type: 'string', format: 'uuid' },
				event: { type: 'string' },
				timestamp: { type: 'string', format: 'date-time' },
				data: { type: 'string', maxLength: 5_000_000 },
			},
		},
	},
}, async(request, reply) => {
	const { sessionId } = request.body
	if(!findSession.get(sessionId)) {
		return reply.code(404).send({ error: 'Unknown verification session' })
	}

	try {
		const delivery = await reclaim.results.receive(request.body, {
			credential: RESULT_DECRYPTION_KEY,
			expectedAud: ORG_ID,
			expectedReclaimSessionId: sessionId,
		})
		assert(delivery.kind === 'result', 'Expected a signed terminal result')
		const stored = insertResult.run(
			sessionId,
			new Date().toISOString(),
			JSON.stringify(delivery.result),
		)
		request.log.info(
			{ sessionId, stored: stored.changes === 1 },
			'verification result accepted',
		)
		return reply.code(204).send()
	} catch(error) {
		if(error instanceof ResultVerificationError) {
			request.log.warn(
				{ sessionId, reason: error.reason },
				'verification result rejected',
			)
			return reply.code(400).send({ error: 'Invalid verification result' })
		}
		throw error
	}
})

app.get<{ Params: { sessionId: string } }>(
	'/verifications/:sessionId',
	{ preHandler: authenticateConsumer },
	async(request, reply) => {
		if(!findSession.get(request.params.sessionId)) {
			return reply.code(404).send({ error: 'Verification session not found' })
		}
		const result = findResult.get(request.params.sessionId)
		if(!hasStoredResult(result)) {
			return {
				sessionId: request.params.sessionId,
				status: 'pending',
			}
		}
		return {
			sessionId: request.params.sessionId,
			status: 'complete',
			result: JSON.parse(result.result_json),
		}
	},
)

await ensureCallbackSubscription()
await app.listen({ host: '0.0.0.0', port: PORT })
for(const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.once(signal, () => void shutdown(signal))
}

interface CreateVerificationBody {
	context?: Record<string, unknown>
}

function requiredEnv(name: string) {
	const value = process.env[name]?.trim()
	assert(value, `${name} is required`)
	return value
}

function isKnownVerificationClient(
	name: string,
): name is KnownVerificationClientName {
	return Object.hasOwn(urls, name)
}

function hasStoredResult(value: unknown): value is { result_json: string } {
	return typeof value === 'object'
		&& value !== null
		&& 'result_json' in value
		&& typeof value.result_json === 'string'
}

async function authenticateConsumer(
	request: FastifyRequest,
	reply: FastifyReply,
) {
	const supplied = Buffer.from(request.headers.authorization || '')
	const expected = Buffer.from(`Bearer ${CONSUMER_API_KEY}`)
	if(
		supplied.length !== expected.length
		|| !timingSafeEqual(supplied, expected)
	) {
		return reply.code(401).send({ error: 'Unauthorized' })
	}
}

async function ensureCallbackSubscription() {
	const subscriptions = await reclaim.callbacks.list()
	const events = [
		'verification_success',
		'verification_rejected',
		'verification_error',
	] as const
	if(subscriptions.some((subscription) => (
		subscription.callbackUrl === callbackUrl
		&& events.every((event) => subscription.events.includes(event))
	))) {
		return
	}

	await reclaim.callbacks.register({ callbackUrl, events: [...events] })
	logger.info({ callbackUrl }, 'callback subscription registered')
}

async function shutdown(signal: string) {
	logger.info({ signal }, 'server stopping')
	await app.close()
	database.close()
}
