import { infraLlmsFullTxt } from "@/lib/infra-markdown";

export function GET(request: Request) {
	return new Response(infraLlmsFullTxt(new URL(request.url).origin), {
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Cache-Control": "public, max-age=300",
		},
	});
}
