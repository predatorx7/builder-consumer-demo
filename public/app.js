// The launcher is browser-only and carries no credentials. The org secret stays
// on the server; this page only ever handles a `verificationUrl`.
import { ReclaimFlow } from '@reclaimprotocol/client/launch'

// Only needed for strict-mode matching against a specific build of the
// extension. Omit it and any installed Reclaim extension answers.
const EXTENSION_ID = undefined

const status = document.getElementById('status')
const output = document.getElementById('output')

for(const button of document.querySelectorAll('[data-client]')) {
	button.addEventListener('click', () => {
		verify(button.dataset.client).catch(fail)
	})
}

/**
 * The server decides which Verification Client the session belongs to — a
 * session is bound to one at creation and cannot be moved afterwards. This
 * page never chooses; it reads the choice out of `verificationUrl` and works
 * out how to open it on this device.
 *
 * @param {string} client which client the server should bind the session to
 */
async function verify(client) {
	output.textContent = ''

	// Open the tab now, inside the click.
	//
	// Creating the session is a network round trip, and a popup opened after one
	// has lost its user gesture, so browsers block it. Claim the tab first and
	// point it at the URL once there is one. The launcher skips it for clients
	// that need no tab, such as the extension.
	const preOpenedTab = window.open('about:blank', '_blank')

	const created = await postJson('/verifications', {
		client,
		context: { orderId: 'order-123' },
	})

	// `verificationUrl` is everything the launcher needs: the session id, the
	// `api=2` marker, and — in its path — which client to launch.
	const flow = ReclaimFlow.from(created.verificationUrl, {
		preOpenedTab,
		extensionID: EXTENSION_ID,
	})

	const target = await flow.resolveTarget()
	say(`launching ${target.client} (${target.mechanism})`)

	const handle = await flow.launch()

	// Wait for the server to relay Builder's callback. The page cannot read the
	// session from Builder itself — that needs the org secret.
	try {
		const result = await waitForResult(created.reclaimSessionId)
		say('verified')
		output.textContent = JSON.stringify(result, null, 2)
	} finally {
		// Closes the QR modal, the tab, or the iframe. It does not cancel the
		// session; nothing in the browser can.
		handle.close()
	}
}

function waitForResult(reclaimSessionId) {
	return new Promise((resolve, reject) => {
		const source = new EventSource(
			`/verifications/${encodeURIComponent(reclaimSessionId)}/events`,
		)
		source.onmessage = (event) => {
			source.close()
			resolve(JSON.parse(event.data))
		}
		source.onerror = () => {
			source.close()
			reject(new Error('Lost the result stream'))
		}
	})
}

async function postJson(url, body) {
	const response = await fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	})
	if(!response.ok) {
		throw new Error(`${url} responded ${response.status}`)
	}
	return response.json()
}

function say(message) {
	status.textContent = message
}

function fail(error) {
	say(`failed: ${error.message}`)
}
