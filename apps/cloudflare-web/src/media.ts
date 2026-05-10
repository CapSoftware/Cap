import { Container } from "@cloudflare/containers";

interface Env {
	CAP_MEDIA: DurableObjectNamespace<CapMediaContainer>;
	MEDIA_SERVER_WEBHOOK_SECRET?: string;
}

export class CapMediaContainer extends Container<Env> {
	defaultPort = 3456;
	sleepAfter = "6h";
	enableInternet = true;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.envVars = {
			MEDIA_SERVER_WEBHOOK_SECRET: env.MEDIA_SERVER_WEBHOOK_SECRET ?? "",
			PORT: "3456",
		};
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/cf-health") {
			return new Response("OK");
		}

		const id = env.CAP_MEDIA.idFromName("media");
		const container = env.CAP_MEDIA.get(id);

		return container.fetch(request);
	},
};
