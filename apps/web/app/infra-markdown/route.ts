import { markdownHeaders } from "@/lib/agent-markdown";
import { infraMarkdown } from "@/lib/infra-markdown";

export function GET(request: Request) {
	return new Response(infraMarkdown(new URL(request.url).origin), {
		headers: markdownHeaders("public, max-age=300"),
	});
}
