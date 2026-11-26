// Meeting audio goes to Cap's own speech service first, which speaks the
// AssemblyAI API and is set as ASSEMBLY_BASE_URL (that service may still hand a
// clip on as its own backup). Without it, or when it points at AssemblyAI
// itself, cloud transcription for meetings is off and the desktop app keeps its
// local model.
export function isCapSpeechService(baseUrl: string | undefined): boolean {
	if (!baseUrl) return false;
	let url: URL;
	try {
		url = new URL(baseUrl);
	} catch {
		return false;
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") return false;
	const host = url.hostname.toLowerCase().replace(/\.+$/, "");
	return (
		host !== "" &&
		host !== "assemblyai.com" &&
		!host.endsWith(".assemblyai.com")
	);
}
