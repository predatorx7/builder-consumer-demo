import assert from 'node:assert'
import { timingSafeEqual } from 'node:crypto'
import {
	createReclaim,
	type KnownVerificationClientName,
	type VerificationResultDelivery,
	type VerifyResultFullOutcome,
	verificationClientUrls,
} from '@reclaimprotocol/client'
import Fastify from 'fastify'
import type { FastifyReply, FastifyRequest } from 'fastify'
import pino from 'pino'
import providerConfig from '../providers.json' with { type: 'json' }

const PORT = 3000
const BUILDER_API_URL = requiredEnv('BUILDER_API_URL')
const ORG_SECRET = requiredEnv('RECLAIM_ORG_SECRET')
const ORG_ID = requiredEnv('ORG_ID')
const CONSUMER_API_KEY = requiredEnv('CONSUMER_API_KEY')
const RESULT_DECRYPTION_KEY = process.env.RECLAIM_ETH_PRIVATE_KEY?.trim()
const urls = verificationClientUrls(BUILDER_API_URL)
const verificationClientName = requiredEnv('VERIFICATION_CLIENT')

assert(
	isKnownVerificationClient(verificationClientName),
	`VERIFICATION_CLIENT must be one of: ${Object.keys(urls).join(', ')}`,
)

const reclaim = createReclaim({
	baseUrl: BUILDER_API_URL,
	orgSecret: ORG_SECRET,
})
const sessions = new Set<string>()
const results = new Map<string, VerifyResultFullOutcome>()

const logger = pino({
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
		providers: providerConfig.providers,
		context: request.body.context || {},
		verificationClientUrl: urls[verificationClientName],
	})
	sessions.add(session.id)
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
	if(!sessions.has(sessionId)) {
		return reply.code(404).send({ error: 'Unknown verification session' })
	}

	const delivery = await reclaim.results.receive(request.body, {
		credential: RESULT_DECRYPTION_KEY,
		expectedAud: ORG_ID,
		expectedReclaimSessionId: sessionId,
	})
	assert(delivery.kind === 'result', 'Expected a signed terminal result')
	results.set(sessionId, delivery.result)
	request.log.info({ sessionId }, 'verification result accepted')
	return reply.code(204).send()
})

app.get<{ Params: { sessionId: string } }>(
	'/verifications/:sessionId',
	{ preHandler: authenticateConsumer },
	async(request, reply) => {
		if(!sessions.has(request.params.sessionId)) {
			return reply.code(404).send({ error: 'Verification session not found' })
		}
		const result = results.get(request.params.sessionId)
		if(!result) {
			return {
				sessionId: request.params.sessionId,
				status: 'pending',
			}
		}
		return {
			sessionId: request.params.sessionId,
			status: 'complete',
			result,
		}
	},
)

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

async function shutdown(signal: string) {
	logger.info({ signal }, 'server stopping')
	await app.close()
}
