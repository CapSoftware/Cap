import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { nanoId } from "@cap/database/helpers";
import { agentApiAuthorizationCodes } from "@cap/database/schema";
import { Logo } from "@cap/ui";
import { redirect } from "next/navigation";
import {
	buildAgentCallbackUrl,
	createAgentAuthorizationCode,
	hashAgentSecret,
	parseAgentAuthorizationRequest,
} from "@/lib/agent-auth";
import { isRateLimited, RATE_LIMIT_IDS } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

type AuthorizeSearchParams = Record<string, string | string[] | undefined>;

const scopeDescriptions: Record<string, string> = {
	"caps:read": "Read Caps, transcripts, and activity",
	"caps:comment": "Post comments and reactions",
	"caps:write": "Change Cap titles, visibility, and settings",
	"profile:read": "Read your Cap profile",
	"profile:write": "Update your Cap profile",
	"caps:upload": "Upload recordings and imported media",
	"caps:process": "Start paid transcription, AI, translation, and edits",
	"caps:delete": "Delete Caps after explicit confirmation",
	"library:read": "Read folders, spaces, and sharing state",
	"library:write": "Manage folders, spaces, and sharing",
	"analytics:read": "Read Cap and workspace analytics",
	"organizations:read": "Read your organizations and members",
	"organizations:manage": "Manage organization settings",
	"organizations:members": "Invite and manage organization members",
	"notifications:read": "Read notifications and preferences",
	"notifications:write": "Update notifications and preferences",
	"integrations:read": "Read storage and domain integration status",
	"integrations:write": "Manage storage, domains, and branding",
	"billing:read": "Read subscription and billing status",
	"billing:write": "Start approved billing changes",
	"developer:read": "Read developer apps, usage, and credits",
	"developer:write": "Manage developer apps and domains",
	"developer:secrets": "Create developer secrets after secure approval",
};

const authorizationPath = (params: AuthorizeSearchParams) => {
	const query = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (typeof value === "string") query.set(key, value);
	}
	return `/cli/authorize?${query.toString()}`;
};

export default async function CliAuthorizePage(props: {
	searchParams: Promise<AuthorizeSearchParams>;
}) {
	const searchParams = await props.searchParams;
	const request = parseAgentAuthorizationRequest(searchParams);
	if (!request) {
		return (
			<main className="flex min-h-screen items-center justify-center bg-gray-2 px-6">
				<section className="w-full max-w-md rounded-2xl border border-gray-4 bg-white p-8 shadow-sm">
					<Logo className="mb-8 h-8 w-auto" />
					<h1 className="text-xl font-semibold text-gray-12">
						Invalid authorization request
					</h1>
					<p className="mt-3 text-sm leading-6 text-gray-10">
						Return to the terminal and run cap auth login again.
					</p>
				</section>
			</main>
		);
	}

	const user = await getCurrentUser();
	if (!user) {
		redirect(
			`/login?next=${encodeURIComponent(authorizationPath(searchParams))}`,
		);
	}

	async function approve(formData: FormData) {
		"use server";
		const submitted = parseAgentAuthorizationRequest({
			client_id: formData.get("clientId")?.toString(),
			redirect_uri: formData.get("redirectUri")?.toString(),
			response_type: "code",
			state: formData.get("state")?.toString(),
			code_challenge: formData.get("codeChallenge")?.toString(),
			code_challenge_method: "S256",
			scope: formData.get("scope")?.toString(),
		});
		if (!submitted) throw new Error("Invalid authorization request");
		const currentUser = await getCurrentUser();
		if (!currentUser) {
			redirect("/login");
		}
		if (
			await isRateLimited(RATE_LIMIT_IDS.AGENT_AUTHORIZATION, {
				key: `agent-authorization:${currentUser.id}`,
			})
		) {
			throw new Error("Too many authorization attempts. Try again later.");
		}
		const code = createAgentAuthorizationCode();
		await db()
			.insert(agentApiAuthorizationCodes)
			.values({
				id: nanoId(),
				userId: currentUser.id,
				codeHash: hashAgentSecret(code),
				codeChallenge: submitted.codeChallenge,
				redirectUri: submitted.redirectUri,
				scopes: submitted.scopes,
				expiresAt: new Date(Date.now() + 5 * 60 * 1000),
			});
		const callback = buildAgentCallbackUrl(submitted.redirectUri, {
			state: submitted.state,
			code,
		});
		if (!callback) throw new Error("Invalid callback URL");
		redirect(callback);
	}

	const deniedCallback = buildAgentCallbackUrl(request.redirectUri, {
		state: request.state,
		error: "access_denied",
	});

	return (
		<main className="flex min-h-screen items-center justify-center bg-gray-2 px-6">
			<section className="w-full max-w-md rounded-2xl border border-gray-4 bg-white p-8 shadow-sm">
				<Logo className="mb-8 h-8 w-auto" />
				<h1 className="text-xl font-semibold text-gray-12">
					Authorize Cap CLI
				</h1>
				<p className="mt-3 text-sm leading-6 text-gray-10">
					The CLI will be able to access your Cap library with the following
					permissions:
				</p>
				<ul className="mt-5 space-y-3 text-sm text-gray-11">
					{request.scopes.map((scope) => (
						<li className="rounded-lg bg-gray-2 px-4 py-3" key={scope}>
							{scopeDescriptions[scope]}
						</li>
					))}
				</ul>
				<form action={approve} className="mt-8 space-y-3">
					<input name="clientId" type="hidden" value={request.clientId} />
					<input name="redirectUri" type="hidden" value={request.redirectUri} />
					<input name="state" type="hidden" value={request.state} />
					<input
						name="codeChallenge"
						type="hidden"
						value={request.codeChallenge}
					/>
					<input name="scope" type="hidden" value={request.scopes.join(" ")} />
					<button
						className="w-full rounded-lg bg-blue-9 px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-blue-10"
						type="submit"
					>
						Authorize
					</button>
					<a
						className="block w-full rounded-lg border border-gray-5 px-4 py-3 text-center text-sm font-medium text-gray-11 transition-colors hover:bg-gray-2"
						href={deniedCallback ?? "/"}
					>
						Cancel
					</a>
				</form>
				<p className="mt-6 text-xs leading-5 text-gray-9">
					Signed in as {user.email}. The CLI never receives your password.
				</p>
			</section>
		</main>
	);
}
