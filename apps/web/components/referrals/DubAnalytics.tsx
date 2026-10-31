import Script from "next/script";

// Dub partner attribution on the marketing site: stores the ?dub_id= click
// and records ?via= partner links. Served through /_proxy/dub (proxy.ts) so
// ad blockers don't drop it. proxy.ts also stores ?dub_id= server side.
export function DubAnalytics() {
	return (
		<Script
			src="/_proxy/dub/script.js"
			data-api-host="/_proxy/dub"
			data-domains={JSON.stringify({ refer: "go.cap.so" })}
			strategy="afterInteractive"
		/>
	);
}
