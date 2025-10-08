import { serverEnv } from "@cap/env/server";

export async function POST(request: Request) {
	const res = await request.json();
	const { email } = res;

	if (!email || typeof email !== "string") {
		return new Response("Email is required and must be a string", {
			status: 400,
		});
	}

	await fetch("https://app.loops.so/api/v1/contacts/create", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${serverEnv().NEXT_LOOPS_KEY}`,
		},
		body: JSON.stringify({
			email,
			userGroup: "Waitlist",
			source: "auth",
		}),
	});

	return new Response("Success", {
		status: 200,
	});
}
