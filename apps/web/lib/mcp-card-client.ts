import { App, applyDocumentTheme } from "@modelcontextprotocol/ext-apps";

type Cue = { startMs: number; text: string; url: string };
type Card = {
	title: string;
	url: string;
	summary: string | null;
	transcriptStatus: string;
	cues: Cue[];
	hasMoreCues: boolean;
};

const title = document.getElementById("title");
const summary = document.getElementById("summary");
const cues = document.getElementById("cues");
const status = document.getElementById("status");
const open = document.getElementById("open");
const app = new App({ name: "Cap recording card", version: "1.0.0" });

const safeUrl = (value: string) => {
	try {
		const url = new URL(value);
		return url.protocol === "https:" ? url.toString() : null;
	} catch {
		return null;
	}
};

const render = (data: Card) => {
	if (!title || !summary || !cues || !status || !open) return;
	title.textContent = data.title;
	summary.textContent = data.summary ?? "No summary available";
	status.textContent =
		data.transcriptStatus === "disabled"
			? "Transcript disabled"
			: data.transcriptStatus === "too_large"
				? "Transcript too large to display"
				: data.transcriptStatus === "not_ready"
					? "Transcript not ready"
					: "Transcript";
	cues.replaceChildren();
	for (const cue of data.cues) {
		const url = safeUrl(cue.url);
		if (!url) continue;
		const button = document.createElement("button");
		button.type = "button";
		button.className = "cue";
		const time = document.createElement("strong");
		const seconds = Math.floor(cue.startMs / 1_000);
		time.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
		const text = document.createElement("span");
		text.textContent = cue.text;
		button.append(time, text);
		button.addEventListener("click", () => app.openLink({ url }));
		cues.append(button);
	}
	if (data.hasMoreCues) {
		const more = document.createElement("p");
		more.className = "more";
		more.textContent = "More transcript moments are available in Cap.";
		cues.append(more);
	}
	const shareUrl = safeUrl(data.url);
	if (shareUrl)
		open.onclick = () => {
			void app.openLink({ url: shareUrl });
		};
};

app.ontoolresult = (result) => {
	const data = result.structuredContent as Partial<Card> | undefined;
	if (
		data &&
		typeof data.title === "string" &&
		typeof data.url === "string" &&
		Array.isArray(data.cues) &&
		typeof data.transcriptStatus === "string"
	)
		render(data as Card);
};

app.onhostcontextchanged = (context) => {
	if (context.theme) applyDocumentTheme(context.theme);
};

void app.connect();
