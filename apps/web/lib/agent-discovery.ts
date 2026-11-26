import { serverEnv } from "@cap/env";
import { API_DOCS_URL } from "@/lib/api-errors";
import { developerOpenApiSpec } from "@/lib/developer-openapi";
import { INFRA_MCP_PATH } from "@/lib/infra-mcp-path";

const webUrl = () => serverEnv().WEB_URL.replace(/\/$/, "");

const publicJson = (body: unknown, contentType = "application/json") =>
	new Response(JSON.stringify(body, null, 2), {
		headers: {
			"Content-Type": `${contentType}; charset=utf-8`,
			"Access-Control-Allow-Origin": "*",
			"Cache-Control": "public, max-age=3600",
		},
	});

export const openApiResponse = () => publicJson(developerOpenApiSpec(webUrl()));

export const infraMcpServerCardResponse = (contentType?: string) => {
	const base = webUrl();
	return publicJson(
		{
			$schema:
				"https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
			name: "so.cap/infra",
			title: "Cap Infra",
			description:
				"Cap Infra video hosting and speech to text for an app: upload a video and get HLS, MP4, poster and player links, transcribe a URL or a stored video, and read usage. Takes the app's secret key as a bearer token, with no OAuth.",
			version: "1.0.0",
			websiteUrl: `${base}/docs/api/get-started#10-use-with-agents-mcp`,
			repository: {
				source: "github",
				url: "https://github.com/CapSoftware/Cap",
			},
			remotes: [
				{
					type: "streamable-http",
					url: `${base}${INFRA_MCP_PATH}`,
					headers: [
						{
							name: "Authorization",
							description:
								"Bearer followed by the app's secret key (csk_), from the Cap Infra console.",
							isRequired: true,
							isSecret: true,
						},
					],
				},
			],
		},
		contentType,
	);
};

export const apiCatalogResponse = () => {
	const base = webUrl();
	const response = publicJson(
		{
			linkset: [
				{
					anchor: `${base}/api/developer/v1`,
					"service-desc": [
						{ href: `${base}/openapi.json`, type: "application/json" },
					],
					"service-doc": [{ href: API_DOCS_URL, type: "text/html" }],
				},
				{
					anchor: `${base}/api/developer/sdk/v1`,
					"service-desc": [
						{ href: `${base}/openapi.json`, type: "application/json" },
					],
					"service-doc": [{ href: API_DOCS_URL, type: "text/html" }],
				},
			],
		},
		'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"',
	);
	response.headers.set(
		"Link",
		`<${base}/.well-known/api-catalog>; rel="api-catalog", <${base}/openapi.json>; rel="service-desc"; type="application/json"`,
	);
	return response;
};

export const mcpServerCardResponse = (contentType?: string) => {
	const base = webUrl();
	return publicJson(
		{
			$schema:
				"https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
			name: "so.cap/cap",
			title: "Cap",
			description:
				"Read-only access to your Cap screen recordings: find recordings by title, get status and share links, and read summaries and timestamped transcripts.",
			version: "1.0.0",
			websiteUrl: `${base}/agents`,
			repository: {
				source: "github",
				url: "https://github.com/CapSoftware/Cap",
			},
			remotes: [
				{
					type: "streamable-http",
					url: `${base}/api/mcp`,
				},
			],
		},
		contentType,
	);
};
