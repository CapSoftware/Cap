import { markdownHeaders, markdownNotFoundBody } from "@/lib/agent-markdown";
import { docToMarkdown } from "@/lib/docs-markdown";
import { getDocBySlug } from "@/utils/docs";

// The proxy rewrites a docs page here when an agent asks for Markdown, with
// `Accept: text/markdown` or a `.md` URL.
export async function GET(
	request: Request,
	props: RouteContext<"/api/docs/markdown/[...slug]">,
) {
	const { slug } = await props.params;
	const { origin } = new URL(request.url);
	const doc = getDocBySlug(slug.join("/"));

	if (!doc) {
		return new Response(
			markdownNotFoundBody(origin, `/docs/${slug.join("/")}`),
			{ status: 404, headers: markdownHeaders("private, no-store") },
		);
	}

	return new Response(docToMarkdown(doc, origin), {
		headers: markdownHeaders("public, max-age=300"),
	});
}
