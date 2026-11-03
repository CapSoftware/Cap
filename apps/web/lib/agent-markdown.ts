const MARKDOWN_TYPE = "text/markdown";
const PROBE_HEADER = "x-cap-markdown-probe";
const PROBE_TIMEOUT_MS = 3_000;

const qualityOf = (params: string[]) => {
	for (const param of params) {
		const [key, value] = param.split("=").map((part) => part.trim());
		if (key?.toLowerCase() !== "q") continue;
		const quality = Number(value);
		return Number.isFinite(quality) ? Math.min(Math.max(quality, 0), 1) : 0;
	}
	return 1;
};

export const prefersMarkdown = (accept: string | null) => {
	if (!accept) return false;

	let markdown = 0;
	let html = 0;
	for (const range of accept.split(",")) {
		const [type, ...params] = range.split(";");
		const mediaType = type?.trim().toLowerCase();
		const quality = qualityOf(params);
		if (mediaType === MARKDOWN_TYPE) markdown = Math.max(markdown, quality);
		else if (mediaType === "text/html") html = Math.max(html, quality);
	}

	return markdown > 0 && markdown >= html;
};

const markdownHeaders = (cacheControl: string) => ({
	"Content-Type": `${MARKDOWN_TYPE}; charset=utf-8`,
	Vary: "Accept",
	"Cache-Control": cacheControl,
});

const displayPath = (pathname: string) => {
	let decoded = pathname;
	try {
		decoded = decodeURIComponent(pathname);
	} catch {}
	const printable = [...decoded]
		.filter((char) => {
			const code = char.charCodeAt(0);
			return code >= 0x20 && code !== 0x7f && char !== "`";
		})
		.join("");
	return printable.length > 200 ? `${printable.slice(0, 200)}...` : printable;
};

export const markdownNotFoundBody = (origin: string, pathname: string) =>
	[
		"# Page not found",
		"",
		`There is no page at \`${displayPath(pathname)}\` on Cap.so.`,
		"",
		"Where to go instead:",
		"",
		`- Product overview for agents: ${origin}/llms.txt`,
		`- Documentation: ${origin}/docs`,
		`- Developer API (OpenAPI): ${origin}/openapi.json`,
		`- Sitemap: ${origin}/sitemap.xml`,
		"",
	].join("\n");

type Fetch = (input: URL, init: RequestInit) => Promise<Response>;

type Options = {
	isPublicAsset: (pathname: string) => boolean;
	fetch?: Fetch;
};

export async function agentMarkdownResponse(
	request: Request,
	{ isPublicAsset, fetch: fetchImpl = fetch }: Options,
): Promise<Response | null> {
	if (request.method !== "GET" && request.method !== "HEAD") return null;
	if (request.headers.has(PROBE_HEADER)) return null;
	if (!prefersMarkdown(request.headers.get("accept"))) return null;

	const url = new URL(request.url);
	const body = (markdown: string) =>
		request.method === "HEAD" ? null : markdown;

	try {
		if (url.pathname === "/") {
			const llms = await fetchImpl(new URL("/llms.txt", url.origin), {
				headers: { [PROBE_HEADER]: "1" },
				signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
			});
			if (!llms.ok) return null;
			const markdown = await llms.text();
			if (!markdown.trim()) return null;
			return new Response(body(markdown), {
				status: 200,
				headers: markdownHeaders("public, max-age=300"),
			});
		}

		if (isPublicAsset(url.pathname)) return null;
		if (request.headers.has("cookie") || request.headers.has("authorization"))
			return null;

		const probe = await fetchImpl(
			new URL(url.pathname + url.search, url.origin),
			{
				method: "HEAD",
				headers: { accept: "text/html", [PROBE_HEADER]: "1" },
				redirect: "manual",
				signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
			},
		);
		if (probe.status !== 404) return null;

		return new Response(body(markdownNotFoundBody(url.origin, url.pathname)), {
			status: 404,
			headers: markdownHeaders("private, no-store"),
		});
	} catch {
		return null;
	}
}
