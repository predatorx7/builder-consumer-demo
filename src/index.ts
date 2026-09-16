import assert from 'node:assert'
import {
	ReclaimVerification,
	type VerificationResultDelivery,
	type VerifyResultFullOutcome,
	VerificationClient,
} from '@reclaimprotocol/client'
import Fastify from 'fastify'
import pino from 'pino'
import providerConfig from '../providers.json' with { type: 'json' }

const PORT = 3000
const ORG_SECRET = requiredEnv('RECLAIM_ORG_SECRET')

// Best practise: Use this for result validation
const ORG_ID = requiredEnv('ORG_ID')

// Optional, only needed if you want to do tee attestation OR decrypt result if you
// have encryption enabled for your organization
const ORG_ETH_PRIVATE_KEY = process.env.RECLAIM_ETH_PRIVATE_KEY?.trim()

const reclaim = ReclaimVerification.create({
	orgSecret: ORG_SECRET,
});

const sessions = new Set<string>()
const results = new Map<string, VerifyResultFullOutcome>()

const logger = pino({
	redact: ['req.headers.authorization'],
})
const app = Fastify({ loggerInstance: logger })

app.post<{ Body: CreateVerificationBody }>('/verifications', {
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
}, async (request, reply) => {
	const session = await reclaim.sessions.create({
		providers: providerConfig.providers,
		context: request.body.context || {},
		// Portals is the default verification client, you can always change it using verificationClientUrl
		// or use a custom one.
		// verificationClientUrl: VerificationClient.custom('http://localhost:4001/verifier-app'),
		...(ORG_ETH_PRIVATE_KEY
			? { orgEthPrivateKey: ORG_ETH_PRIVATE_KEY }
			: {}),
	})
	sessions.add(session.id)
	request.log.info(
		{ reclaimSessionId: session.id },
		'verification created',
	)
	return reply.code(201).send({
		reclaimSessionId: session.id,
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
}, async (request, reply) => {
	const { sessionId } = request.body
	if (!sessions.has(sessionId)) {
		return reply.code(404).send({ error: 'Unknown verification session' })
	}

	const delivery = await reclaim.results.receive(request.body, {
		expectedAud: ORG_ID,
		reclaimSessionId: sessionId,
		...(ORG_ETH_PRIVATE_KEY
			? { orgEthPrivateKey: ORG_ETH_PRIVATE_KEY }
			: {}),
	})
	assert(delivery.kind === 'result', 'Expected a signed terminal result')
	results.set(sessionId, delivery.result)
	request.log.info(
		{ reclaimSessionId: sessionId },
		'verification result accepted',
	)
	return reply.code(204).send()
})

app.get<{ Params: { reclaimSessionId: string } }>(
	'/verifications/:reclaimSessionId',
	async (request, reply) => {
		const { reclaimSessionId } = request.params
		if (!sessions.has(reclaimSessionId)) {
			return reply.code(404).send({ error: 'Verification session not found' })
		}
		const result = results.get(reclaimSessionId)
		if (!result) {
			return {
				reclaimSessionId,
				status: 'pending',
			}
		}
		return {
			reclaimSessionId,
			status: 'complete',
			result,
		}
	},
)

await app.listen({ host: '0.0.0.0', port: PORT })
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
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

async function shutdown(signal: string) {
	logger.info({ signal }, 'server stopping')
	await app.close()
}
