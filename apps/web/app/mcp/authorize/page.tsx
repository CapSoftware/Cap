import { getCurrentUser } from "@cap/database/auth/session";
import { Logo } from "@cap/ui";
import { redirect } from "next/navigation";
import { validateMcpAuthorizationRequest } from "@/lib/mcp-auth";
import { authorizeMcpClient } from "./actions";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

export default async function McpAuthorizePage(props: {
	searchParams: Promise<SearchParams>;
}) {
	const searchParams = await props.searchParams;
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(searchParams)) {
		if (typeof value === "string") params.set(key, value);
	}
	const request = await validateMcpAuthorizationRequest(params);
	if (!request) {
		return (
			<main className="flex min-h-screen items-center justify-center bg-gray-2 px-6">
				<section className="w-full max-w-md rounded-2xl border border-gray-4 bg-white p-8 shadow-sm">
					<Logo className="mb-8 h-8 w-auto" />
					<h1 className="text-xl font-semibold text-gray-12">
						Invalid connection request
					</h1>
					<p className="mt-3 text-sm leading-6 text-gray-10">
						Return to your agent and try connecting Cap again.
					</p>
				</section>
			</main>
		);
	}
	const user = await getCurrentUser();
	if (!user)
		redirect(
			`/login?next=${encodeURIComponent(`/mcp/authorize?${params.toString()}`)}`,
		);
	return (
		<main className="flex min-h-screen items-center justify-center bg-gray-2 px-6">
			<section className="w-full max-w-md rounded-2xl border border-gray-4 bg-white p-8 shadow-sm">
				<Logo className="mb-8 h-8 w-auto" />
				<h1 className="text-xl font-semibold text-gray-12">
					Connect {request.clientName} to Cap
				</h1>
				<p className="mt-3 text-sm leading-6 text-gray-10">
					This app will be able to read your recordings, summaries, and
					transcripts. It cannot edit or delete recordings.
				</p>
				<p className="mt-4 text-xs text-gray-9">Signed in as {user.email}</p>
				<p className="mt-2 text-xs text-gray-9">
					After approval, you will return to {new URL(request.redirectUri).host}
					.
				</p>
				<form action={authorizeMcpClient} className="mt-8 space-y-3">
					{Array.from(params.entries()).map(([key, value]) => (
						<input key={key} name={key} type="hidden" value={value} />
					))}
					<button
						className="w-full rounded-lg bg-blue-9 px-4 py-3 text-sm font-medium text-white"
						name="decision"
						type="submit"
						value="approve"
					>
						Authorize
					</button>
					<button
						className="w-full rounded-lg border border-gray-5 px-4 py-3 text-sm font-medium text-gray-11"
						name="decision"
						type="submit"
						value="deny"
					>
						Cancel
					</button>
				</form>
			</section>
		</main>
	);
}
