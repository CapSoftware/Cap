"use server";

import { getCurrentUser } from "@cap/database/auth/session";
import { redirect } from "next/navigation";
import {
	createMcpAuthorizationCode,
	mcpIssuer,
	validateMcpAuthorizationRequest,
} from "@/lib/mcp-auth";
import { isRateLimited, RATE_LIMIT_IDS } from "@/lib/rate-limit";

export async function authorizeMcpClient(formData: FormData) {
	const params = new URLSearchParams();
	for (const key of [
		"client_id",
		"redirect_uri",
		"response_type",
		"state",
		"code_challenge",
		"code_challenge_method",
		"scope",
		"resource",
	]) {
		const value = formData.get(key);
		if (typeof value === "string") params.set(key, value);
	}
	const request = await validateMcpAuthorizationRequest(params);
	if (!request) throw new Error("Invalid authorization request");
	const user = await getCurrentUser();
	if (!user) redirect("/login");
	if (
		await isRateLimited(RATE_LIMIT_IDS.AGENT_AUTHORIZATION, {
			key: `mcp-authorization:${user.id}`,
		})
	)
		throw new Error("Too many authorization attempts. Try again later.");
	const callback = new URL(request.redirectUri);
	const decision = formData.get("decision");
	if (decision === "approve") {
		callback.searchParams.set(
			"code",
			await createMcpAuthorizationCode(user.id, request),
		);
	} else {
		callback.searchParams.set("error", "access_denied");
	}
	if (request.state) callback.searchParams.set("state", request.state);
	callback.searchParams.set("iss", mcpIssuer());
	redirect(callback.toString());
}
