import { Container } from "@cloudflare/containers";

interface Env {
	CAP_WEB: DurableObjectNamespace<CapWebContainer>;
	CAP_AWS_ACCESS_KEY?: string;
	CAP_AWS_BUCKET?: string;
	CAP_AWS_REGION?: string;
	CAP_AWS_SECRET_KEY?: string;
	CAP_STORAGE_LIMIT_BYTES?: string;
	CAP_VIDEOS_DEFAULT_PUBLIC?: string;
	CLOUDFLARE_EMAIL_FROM_DOMAIN?: string;
	CLOUDFLARE_EMAIL_SECRET?: string;
	CLOUDFLARE_EMAIL_WORKER_URL?: string;
	CRON_SECRET?: string;
	DATABASE_ENCRYPTION_KEY?: string;
	EMAIL: {
		send(message: {
			cc?: string | string[];
			from: string | { email: string; name: string };
			html?: string;
			replyTo?: string;
			subject: string;
			text?: string;
			to: string | string[];
		}): Promise<{ messageId: string }>;
	};
	MEDIA_SERVER_URL?: string;
	MEDIA_SERVER_WEBHOOK_SECRET?: string;
	MEDIA_SERVER_WEBHOOK_URL?: string;
	NEXTAUTH_SECRET?: string;
	NEXTAUTH_URL?: string;
	NEXT_PUBLIC_WEB_URL?: string;
	NODE_ENV?: string;
	S3_INTERNAL_ENDPOINT?: string;
	S3_PATH_STYLE?: string;
	S3_PUBLIC_ENDPOINT?: string;
	WEB_URL?: string;
	WORKFLOWS_RPC_SECRET?: string;
}

const copiedKeys = [
	"CAP_AWS_ACCESS_KEY",
	"CAP_AWS_BUCKET",
	"CAP_AWS_REGION",
	"CAP_AWS_SECRET_KEY",
	"CAP_STORAGE_LIMIT_BYTES",
	"CAP_VIDEOS_DEFAULT_PUBLIC",
	"CLOUDFLARE_EMAIL_FROM_DOMAIN",
	"CLOUDFLARE_EMAIL_SECRET",
	"CLOUDFLARE_EMAIL_WORKER_URL",
	"CRON_SECRET",
	"DATABASE_ENCRYPTION_KEY",
	"MEDIA_SERVER_URL",
	"MEDIA_SERVER_WEBHOOK_SECRET",
	"MEDIA_SERVER_WEBHOOK_URL",
	"NEXTAUTH_SECRET",
	"NEXTAUTH_URL",
	"NEXT_PUBLIC_WEB_URL",
	"NODE_ENV",
	"S3_INTERNAL_ENDPOINT",
	"S3_PATH_STYLE",
	"S3_PUBLIC_ENDPOINT",
	"WEB_URL",
	"WORKFLOWS_RPC_SECRET",
] as const;

function buildEnv(env: Env): Record<string, string> {
	const vars: Record<string, string> = {
		DATABASE_URL: "mysql://cap:cap-local-pwd@127.0.0.1:3306/cap",
		HOSTNAME: "0.0.0.0",
		MYSQL_DATABASE: "cap",
		MYSQL_PASSWORD: "cap-local-pwd",
		MYSQL_USER: "cap",
		CLOUDFLARE_EMAIL_FROM_DOMAIN:
			env.CLOUDFLARE_EMAIL_FROM_DOMAIN ?? "shashanksn.xyz",
		CLOUDFLARE_EMAIL_WORKER_URL:
			env.CLOUDFLARE_EMAIL_WORKER_URL ??
			"https://video.shashanksn.xyz/cf-email/send",
		NEXT_PUBLIC_DOCKER_BUILD: "true",
		NEXT_PUBLIC_WEB_URL:
			env.NEXT_PUBLIC_WEB_URL ?? "https://video.shashanksn.xyz",
		NEXTAUTH_URL: env.NEXTAUTH_URL ?? "https://video.shashanksn.xyz",
		NODE_ENV: env.NODE_ENV ?? "production",
		PORT: "8080",
		WEB_URL: env.WEB_URL ?? "https://video.shashanksn.xyz",
	};

	for (const key of copiedKeys) {
		const value = env[key];

		if (typeof value === "string" && value.length > 0) {
			vars[key] = value;
		}
	}

	return vars;
}

export class CapWebContainer extends Container<Env> {
	defaultPort = 8080;
	sleepAfter = "24h";
	enableInternet = true;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.envVars = buildEnv(env);
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/cf-health") {
			return new Response("OK");
		}

		if (url.pathname === "/cf-email/send") {
			const token = request.headers
				.get("authorization")
				?.replace("Bearer ", "");

			if (
				!env.CLOUDFLARE_EMAIL_SECRET ||
				token !== env.CLOUDFLARE_EMAIL_SECRET
			) {
				return new Response("Unauthorized", { status: 401 });
			}

			const message = (await request.json()) as {
				cc?: string | string[];
				from: string | { email: string; name: string };
				html?: string;
				replyTo?: string;
				subject?: string;
				text?: string;
				to?: string | string[];
			};

			if (!message.to || !message.from || !message.subject) {
				return new Response("Missing required email fields", { status: 400 });
			}

			const result = await env.EMAIL.send({
				cc: message.cc,
				from: message.from,
				html: message.html,
				replyTo: message.replyTo,
				subject: message.subject,
				text: message.text,
				to: message.to,
			});

			return Response.json(result);
		}

		const id = env.CAP_WEB.idFromName("web");
		const container = env.CAP_WEB.get(id);

		return container.fetch(request);
	},
};
