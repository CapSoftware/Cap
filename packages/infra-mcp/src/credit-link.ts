import { asRecord, type InfraClient } from "./http";

const LOOKUP_MS = 5_000;

export const appBillingUrl = (consoleUrl: string, appId: string) =>
	`${consoleUrl}/${encodeURIComponent(appId)}/billing`;

type LookUpAppId = (input: {
	signal?: AbortSignal;
	deadlineAt: number;
}) => Promise<unknown>;

// The console root opens whichever app the owner viewed last, so a credit link
// names the app the key belongs to. A server that does not say which app that
// is gets the console root, as before.
export class CreditLink {
	private appId: string | null;
	private pending: Promise<void> | null = null;

	constructor(
		private readonly consoleUrl: string,
		appId: string | null,
		private readonly lookUp: LookUpAppId | null,
	) {
		this.appId = appId || null;
	}

	get url() {
		return this.appId === null
			? this.consoleUrl
			: appBillingUrl(this.consoleUrl, this.appId);
	}

	learn(usage: unknown) {
		const appId = asRecord(usage).appId;
		if (this.appId === null && typeof appId === "string" && appId !== "") {
			this.appId = appId;
		}
	}

	async resolve(signal?: AbortSignal) {
		if (this.appId === null && this.lookUp !== null) {
			const lookUp = this.lookUp;
			this.pending ??= lookUp({ signal, deadlineAt: Date.now() + LOOKUP_MS })
				.then((reply) => this.learn(asRecord(reply).data))
				.catch(() => {})
				.finally(() => {
					this.pending = null;
				});
			await this.pending;
		}
		return this.url;
	}
}

export const creditLinkFor = (
	consoleUrl: string,
	client: InfraClient,
	appId: string | null = null,
) =>
	new CreditLink(consoleUrl, appId, (input) =>
		client.call("getUsage", { ...input, once: true }),
	);
