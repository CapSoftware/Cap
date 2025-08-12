import { NextResponse } from "next/server";

export async function POST(request: Request) {
	try {
		const body = await request.json();
		console.log("Self-hosted checkout request body:", body);

		// Forward the request to the external service
		console.log("Forwarding request to external service...");
		const response = await fetch("https://l.cap.so/api/selfhost/checkout", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		});

		console.log("External service response status:", response.status);

		// Get the raw response text first
		const responseText = await response.text();
		console.log("External service raw response:", responseText);

		// Then try to parse it as JSON
		let data;
		try {
			data = JSON.parse(responseText);
			console.log("External service parsed response:", data);
		} catch (parseError) {
			console.error("Error parsing external service response:", parseError);
			return NextResponse.json(
				{ message: "Invalid response from external service" },
				{ status: 500 },
			);
		}

		if (!response.ok) {
			return NextResponse.json(
				{ message: data.message || "Failed to process checkout" },
				{ status: response.status },
			);
		}

		return NextResponse.json(data);
	} catch (error) {
		console.error("Error in self-hosted checkout:", error);
		if (error instanceof Error) {
			console.error("Error details:", error.message, error.stack);
		}
		return NextResponse.json(
			{ message: "Internal server error" },
			{ status: 500 },
		);
	}
}
