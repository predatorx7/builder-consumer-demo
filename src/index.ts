import assert from 'node:assert'
import { createReadStream, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
	ReclaimVerification,
	type VerificationResultDelivery,
	type VerifyResultFullOutcome,
	VerificationClient,
} from '@reclaimprotocol/client'
import FastifyStatic from '@fastify/static'
import Fastify, { type FastifyReply } from 'fastify'
import pino from 'pino'
import providerConfig from '../providers.json' with { type: 'json' }

const PORT = 3000
const ORG_SECRET = requiredEnv('RECLAIM_ORG_SECRET')

// Best practise: Use this for result validation
const ORG_ID = requiredEnv('ORG_ID')

// Optional, only needed if you want to do tee attestation OR decrypt result if you
// have encryption enabled for your organization
const ORG_ETH_PRIVATE_KEY = process.env.RECLAIM_ETH_PRIVATE_KEY?.trim()

// Point at a local Builder while developing. The Verification Client URLs below
// are derived from it, and each must match a registered client's `uri` exactly
// — Builder rejects anything else with a 400 rather than creating a session.
const BUILDER_BASE_URL = (
	process.env.BUILDER_BASE_URL?.trim() || 'https://build.reclaimprotocol.org'
).replace(/\/+$/, '')

const reclaim = ReclaimVerification.create({
	orgSecret: ORG_SECRET,
	baseUrl: BUILDER_BASE_URL,
})

/**
 * The Verification Clients this app supports, keyed by the name its frontend
 * sends.
 *
 * Never pass a client name straight through from the browser. Builder only
 * accepts a registered URL, so the blast radius is small, but a page that could
 * name any client could still steer a claimant to one this app has never
 * tested against.
 */
const LAUNCH_CLIENTS: Record<string, string> = {
	'builder': `${BUILDER_BASE_URL}/v/{sessionId}`,
	'portals': `${BUILDER_BASE_URL}/portals`,
	// Builder's own share page, `GET /s` — a real openable URL, so the
	// returned `verificationUrl` doubles as the share link (QR, clipboard,
	// SMS). The other three below are attribution-only labels.
	'verifier-app': `${BUILDER_BASE_URL}/s`,
	'reclaim-browser-extension': `${BUILDER_BASE_URL}/reclaim-browser-extension`,
}

const sessions = new Set<string>()
const results = new Map<string, VerifyResultFullOutcome>()
// One verification can be watched by several tabs, so a session maps to a set.
const watchers = new Map<string, Set<FastifyReply>>()

const logger = pino({
	redact: ['req.headers.authorization'],
})
const app = Fastify({ loggerInstance: logger })

await app.register(FastifyStatic, {
	root: fileURLToPath(new URL('../public', import.meta.url)),
})

/**
 * Serve the browser launcher straight out of the installed SDK, so the page
 * needs no bundler and runs exactly the published build. A real app imports
 * `@reclaimprotocol/client/launch` and lets its bundler do this.
 */
app.get('/vendor/launch.js', async (request, reply) => {
	const entry = fileURLToPath(
		new URL(
			'../node_modules/@reclaimprotocol/client/lib/launch/index.js',
			import.meta.url,
		),
	)
	if (!existsSync(entry)) {
		request.log.error('the client SDK has no /launch build')
		return reply.code(501).send(
			'@reclaimprotocol/client/launch is not built yet.',
		)
	}
	return reply.type('text/javascript').send(createReadStream(entry))
})

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
				// Which Verification Client to bind this session to. The browser
				// resolves it BEFORE calling here, because a session's client is
				// fixed at creation and cannot be changed afterwards.
				client: { type: 'string', enum: Object.keys(LAUNCH_CLIENTS) },
			},
		},
	},
}, async (request, reply) => {
	const client = request.body.client ?? 'builder'
	const verificationClientUrl = LAUNCH_CLIENTS[client]
	if (!verificationClientUrl) {
		return reply.code(400).send({ error: `Unsupported client ${client}` })
	}

	const session = await reclaim.sessions.create({
		providers: providerConfig.providers,
		context: request.body.context || {},
		verificationClientUrl: VerificationClient.custom(verificationClientUrl),
		...(ORG_ETH_PRIVATE_KEY
			? { orgEthPrivateKey: ORG_ETH_PRIVATE_KEY }
			: {}),
	})
	sessions.add(session.id)
	request.log.info(
		{ reclaimSessionId: session.id, client },
		'verification created',
	)
	// `verificationUrl` is all the browser needs: it carries the session id, the
	// `api=2` marker, and — in its path — which client the session is bound to.
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
	notifyWatchers(sessionId)
	return reply.code(204).send()
})

/**
 * Relay the outcome to the page.
 *
 * The browser cannot learn it any other way: reading a session from Builder
 * needs the org secret, which never leaves this server. Builder posts the
 * result to `/callbacks/reclaim` above, and this stream forwards it to whoever
 * is waiting. Server-sent events keep the demo small; a production app would
 * use whatever it already has.
 */
app.get<{ Params: { reclaimSessionId: string } }>(
	'/verifications/:reclaimSessionId/events',
	async (request, reply) => {
		const { reclaimSessionId } = request.params
		if (!sessions.has(reclaimSessionId)) {
			return reply.code(404).send({ error: 'Verification session not found' })
		}

		reply.raw.writeHead(200, {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache',
			'connection': 'keep-alive',
		})

		const done = results.get(reclaimSessionId)
		if (done) {
			sendEvent(reply, done)
			reply.raw.end()
			return reply
		}

		let watching = watchers.get(reclaimSessionId)
		if (!watching) {
			watching = new Set()
			watchers.set(reclaimSessionId, watching)
		}
		watching.add(reply)
		request.raw.on('close', () => {
			watching.delete(reply)
			if (!watching.size) {
				watchers.delete(reclaimSessionId)
			}
		})
		return reply
	},
)

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
	client?: string
}

function sendEvent(reply: FastifyReply, result: VerifyResultFullOutcome) {
	reply.raw.write(`data: ${JSON.stringify(result)}\n\n`)
}

function notifyWatchers(sessionId: string) {
	const result = results.get(sessionId)
	const watching = watchers.get(sessionId)
	if (!result || !watching) {
		return
	}
	for (const reply of watching) {
		sendEvent(reply, result)
		reply.raw.end()
	}
	watchers.delete(sessionId)
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
