import { infraLlmsTxt } from "@/lib/infra-markdown";

export function GET(request: Request) {
	return new Response(infraLlmsTxt(new URL(request.url).origin), {
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Cache-Control": "public, max-age=300",
		},
	});
}
