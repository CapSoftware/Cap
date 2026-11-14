import type { ActionResult, CapPayload } from "@cap/app-store";
import { FIRST_PARTY_CONNECTION_PREFIX } from "@cap/app-store";
import { capJson, readVerifiedCapRequest } from "./verify";

const DISCORD_WEBHOOK =
	/^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d{5,30}\/[A-Za-z0-9_-]{20,200}$/;

export const isDiscordWebhookUrl = (value: unknown): value is string =>
	typeof value === "string" && DISCORD_WEBHOOK.test(value);

export function discordMessage(cap: CapPayload) {
	const title = cap.title.replace(/[*_~`|>]/g, "").slice(0, 200);
	return {
		content: `**${title}**\n${cap.url}`,
		username: "Cap",
		allowed_mentions: { parse: [] },
	};
}

export async function postToDiscord(
	webhookUrl: string,
	cap: CapPayload,
	fetcher: typeof fetch = fetch,
): Promise<"posted" | "rejected" | "retry"> {
	const response = await fetcher(webhookUrl, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(discordMessage(cap)),
		redirect: "manual",
		signal: AbortSignal.timeout(8_000),
	});
	await response.body?.cancel().catch(() => {});
	if (response.ok) return "posted";
	if (response.status === 429 || response.status >= 500) return "retry";
	return "rejected";
}

const toast = (message: string): ActionResult => ({ type: "toast", message });

export async function discordConnection(request: Request): Promise<Response> {
	const verified = await readVerifiedCapRequest(
		request,
		`${FIRST_PARTY_CONNECTION_PREFIX}discord`,
	);
	if (!verified.ok) return verified.response;
	const capRequest = verified.request;

	if (capRequest.kind === "lifecycle") return capJson(200, { ok: true });

	const webhookUrl = capRequest.settings.webhookUrl;
	if (!isDiscordWebhookUrl(webhookUrl)) {
		return capRequest.kind === "action"
			? capJson(
					200,
					toast(
						"Add a Discord webhook URL in the app's settings, then try again",
					),
				)
			: capJson(200, { ok: true, skipped: "no_webhook" });
	}

	if (capRequest.kind === "event") {
		if (
			capRequest.type !== "cap.ready" ||
			capRequest.settings.postNewCaps !== true
		) {
			return capJson(200, { ok: true, skipped: "not_enabled" });
		}
		const outcome = await postToDiscord(webhookUrl, capRequest.data.cap).catch(
			() => "retry" as const,
		);
		if (outcome === "retry") return capJson(503, { error: "Discord is busy" });
		return capJson(200, { ok: true, outcome });
	}

	if (verified.path !== "actions/post") {
		return capJson(404, { error: "Unknown action" });
	}
	const outcome = await postToDiscord(webhookUrl, capRequest.data.cap).catch(
		() => "retry" as const,
	);
	return capJson(
		200,
		outcome === "posted"
			? toast("Posted to Discord")
			: outcome === "rejected"
				? toast(
						"Discord rejected the post. Check the webhook URL in the app's settings",
					)
				: toast("Discord is busy right now. Try again in a moment"),
	);
}
