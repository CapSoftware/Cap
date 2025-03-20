import nacl from 'tweetnacl';
import { Buffer } from 'buffer';
import { Hono } from 'hono';
import { vValidator } from '@hono/valibot-validator';
import * as v from 'valibot';
import * as jose from 'jose';
import { createMiddleware } from 'hono/factory';

const DISCORD_APP_ID = '1334742236096757861';
const PUBLIC_KEY = 'fea8bb4c1432223609db5a37e074c5a5474b89bf4bea12515bc4e09d564e4f61';

const GITHUB_ORG = 'CapSoftware';
const GITHUB_REPO = 'Cap';
const WORKFLOW_FILE = 'publish.yml';

const CHANNEL_MESSAGE_WITH_SOURCE = 4;

type InteractionBody = {
	id: string;
	token: string;
	channel_id: string;
	member: {
		user: {
			id: string;
			username: string;
		};
	};
	data: {
		id: string;
		name: string;
		type: 1;
	};
};

const app = new Hono<{ Bindings: Env }>();

app.post('/', async (c) => {
	const body = await c.req.json();

	if (!verifyRequest(c.req.raw, body)) return new Response('Invalid signature', { status: 401 });

	// Ping
	if (body.type === 1) return Response.json({ type: 1 });

	// Slash command
	if (body.type === 2) {
		const response = await handleCommand(body, c.env);
		return Response.json(response);
	}
});

const ghActionsOidc = createMiddleware<{ Variables: { githubToken: { run_id: string; repository_id: string; actor: string } } }>(
	async (c, next) => {
		const authHeader = c.req.header('Authorization');
		if (!authHeader || !authHeader.startsWith('Bearer ')) return new Response('No token provided', { status: 401 });

		const token = authHeader.slice('Bearer '.length);

		try {
			const keysResponse = await fetch('https://token.actions.githubusercontent.com/.well-known/jwks');
			const { keys } = (await keysResponse.json()) as { keys: { kty: string; alg: string; use: string; kid: string; n: string }[] };

			const [header] = token.split('.');
			const { kid } = JSON.parse(Buffer.from(header, 'base64').toString());

			const signingKey = keys.find((key) => key.kid === kid);
			if (!signingKey) return new Response('Invalid key ID', { status: 401 });

			const publicKey = await jose.importJWK(signingKey);
			const { payload } = await jose.jwtVerify(token, publicKey, {
				issuer: 'https://token.actions.githubusercontent.com',
				audience: 'cap-discord-bot',
			});

			if (!payload.sub) return new Response('Missing sub claim', { status: 401 });

			if (!payload.sub?.includes(`${GITHUB_ORG}/${GITHUB_REPO}`)) {
				return new Response('Invalid repository', { status: 401 });
			}

			c.set('githubToken', payload as any);
		} catch (error) {
			if (error instanceof Error) return new Response(`Token validation failed: ${error.message}`, { status: 401 });
		}

		await next();
	}
);

app.post(
	'/github-workflow',
	ghActionsOidc,
	vValidator(
		'json',
		v.union([
			v.object({
				type: v.literal('release-ready'),
				tag: v.string(),
				version: v.string(),
				interactionId: v.string(),
				releaseUrl: v.string(),
				cnReleaseId: v.string(),
			}),
			v.object({
				type: v.literal('release-done'),
				version: v.string(),
				interactionId: v.string(),
				releaseUrl: v.string(),
				cnReleaseId: v.string(),
			}),
		])
	),
	async (c) => {
		const body = c.req.valid('json');

		const interactionStr = await c.env.release_discord_interactions.get(body.interactionId);
		if (!interactionStr) return new Response('Interaction not found', { status: 404 });

		const interaction: InteractionBody = JSON.parse(interactionStr);

		if (interaction.data.name !== 'release') return new Response('Invalid interaction', { status: 400 });

		switch (body.type) {
			case 'release-ready': {
				await fetch(`https://discord.com/api/v10/webhooks/${DISCORD_APP_ID}/${interaction.token}/messages/@original`, {
					method: 'PATCH',
					body: JSON.stringify(releaseWorkflowRunningMessageData({ ...body, workflowRunId: c.get('githubToken').run_id })),
					headers: { 'Content-Type': 'application/json' },
				});

				return new Response('Successfully updated message', { status: 200 });
			}
			case 'release-done': {
				await fetch(`https://discord.com/api/v10/channels/${interaction.channel_id}/messages`, {
					method: 'POST',
					body: JSON.stringify(
						releaseWorkflowDoneMessageData({
							...body,
							userId: interaction.member.user.id,
							workflowRunId: c.get('githubToken').run_id,
						})
					),
					headers: {
						'Content-Type': 'application/json',
						Authorization: `Bot ${c.env.DISCORD_BOT_TOKEN}`,
					},
				});

				return new Response('Successfully sent message', { status: 200 });
			}
			default: {
				return new Response('Invalid type', { status: 400 });
			}
		}
	}
);

export default app;

async function handleCommand(interaction: InteractionBody, env: Env) {
	const { data } = interaction;

	switch (data.name) {
		case 'release': {
			await env.release_discord_interactions.put(interaction.id, JSON.stringify(interaction));

			const workflowResponse = await fetch(
				`https://api.github.com/repos/${GITHUB_ORG}/${GITHUB_REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
				{
					method: 'POST',
					body: JSON.stringify({ ref: 'main', inputs: { interactionId: interaction.id } }),
					headers: {
						Accept: 'application/vnd.github+json',
						Authorization: `Bearer ${env.GITHUB_TOKEN}`,
						'X-GitHub-Api-Version': '2022-11-28',
						'User-Agent': 'CapBot',
					},
				}
			);

			if (workflowResponse.status !== 204)
				return { type: 4, data: { content: `Failed to start release workflow: ${await workflowResponse.text()}` } };

			return {
				type: CHANNEL_MESSAGE_WITH_SOURCE,
				data: releaseWorkflowStartedMessageData(),
			};
		}
		default: {
			return { type: 4, data: { content: `Unknown command ${data.name}` } };
		}
	}
}

async function verifyRequest(request: Request, jsonBody: any) {
	const signature = request.headers.get('X-Signature-Ed25519');
	if (!signature) throw new Error('Signature header not found');

	const timestamp = request.headers.get('X-Signature-Timestamp');
	if (!timestamp) throw new Error('Timestamp header not found');

	return nacl.sign.detached.verify(
		new Buffer(timestamp + JSON.stringify(jsonBody)),
		new Buffer(signature, 'hex'),
		new Buffer(PUBLIC_KEY, 'hex')
	);
}

function releaseWorkflowStartedMessageData() {
	return {
		content: 'Release workflow started, standby...',
		components: [
			{
				type: 1,
				components: [
					{
						type: 2,
						label: 'Workflow Runs',
						url: `https://github.com/${GITHUB_ORG}/${GITHUB_REPO}/actions/workflows/${WORKFLOW_FILE}`,
						style: 5,
					},
				],
			},
		],
	};
}

function releaseWorkflowRunningMessageData(props: { version: string } & Parameters<typeof releaseDraftedMessageComponents>[0]) {
	return {
		content: `v${props.version} workflow running, go edit the release notes!`,
		components: [
			{
				type: 1,
				components: releaseDraftedMessageComponents(props),
			},
		],
	};
}

function releaseWorkflowDoneMessageData(
	props: {
		userId: string;
		version: string;
	} & Parameters<typeof releaseDraftedMessageComponents>[0]
) {
	return {
		content: [`<@${props.userId}> v${props.version} has finished building!`],
		components: [
			{
				type: 1,
				components: releaseDraftedMessageComponents(props),
			},
		],
	};
}

function releaseDraftedMessageComponents(props: { releaseUrl: string; cnReleaseId: string; workflowRunId: string }) {
	return [
		{
			type: 2,
			label: 'Release Notes',
			url: props.releaseUrl,
			style: 5,
		},
		{
			type: 2,
			label: 'CN Cloud Release',
			url: `https://web.crabnebula.cloud/org/cap/cap/releases/${props.cnReleaseId}`,
			style: 5,
		},
		{
			type: 2,
			label: 'Workflow Run',
			url: `https://github.com/${GITHUB_ORG}/${GITHUB_REPO}/actions/runs/${props.workflowRunId}`,
			style: 5,
		},
	];
}
