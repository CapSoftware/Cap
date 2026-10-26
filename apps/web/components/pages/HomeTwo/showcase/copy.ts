/**
 * Copy for the tabs inside each animated stage. Lives in a plain module so
 * the server-rendered sections can put the same words in the HTML for
 * crawlers and screen readers, while the client stages show them as tab
 * labels and captions.
 */
export type StageCopy = {
	key: string;
	label: string;
	lead: string;
	body: string;
};

export const INSTANT_COPY: StageCopy[] = [
	{
		key: "record",
		label: "Record",
		lead: "Instant share links.",
		body: "Your Cap.so link is live the moment you hit record, and the video uploads while you are still talking.",
	},
	{
		key: "share",
		label: "Stop and paste",
		lead: "Link copied when you stop.",
		body: "Press stop and paste the link into Slack, a ticket, or an email. The video is ready when it lands.",
	},
	{
		key: "watch",
		label: "Watch",
		lead: "Watch in any browser.",
		body: "No download and no account needed. Viewers leave timestamped comments and emoji reactions on the share page.",
	},
];

export const STUDIO_COPY: StageCopy[] = [
	{
		key: "zoom",
		label: "Zoom",
		lead: "Automatic zoom.",
		body: "Cap zooms in on every click and follows your cursor with the same spring physics as the editor, then eases back out.",
	},
	{
		key: "layouts",
		label: "Camera",
		lead: "Camera layouts.",
		body: "Switch any part of the timeline between a webcam bubble, split screen, camera only, or screen only.",
	},
	{
		key: "captions",
		label: "Captions",
		lead: "Automatic captions.",
		body: "Cap transcribes your voice on your own machine in 19 languages and shows each word as you say it.",
	},
	{
		key: "blur",
		label: "Blur",
		lead: "Blur and pixelate.",
		body: "Hide an email, a password, or a face with blur or pixelate, or use highlight to dim everything else.",
	},
	{
		key: "background",
		label: "Background",
		lead: "Backgrounds and padding.",
		body: "Pick a wallpaper, gradient, or color, and Cap adds padding, rounded corners, and a shadow.",
	},
];

export const AI_COPY: StageCopy[] = [
	{
		key: "summary",
		label: "Summary",
		lead: "AI titles and summaries.",
		body: "Cap renames the recording and writes a summary as soon as you stop, so viewers know what it covers before pressing play.",
	},
	{
		key: "chapters",
		label: "Chapters",
		lead: "Automatic chapters.",
		body: "Recordings split into chapters on the timeline. Click one and the video jumps straight to that part.",
	},
	{
		key: "transcript",
		label: "Transcript",
		lead: "Searchable transcripts.",
		body: "Every word is transcribed and timestamped, follows along as the video plays, and doubles as captions.",
	},
];

export const STORAGE_COPY: StageCopy[] = [
	{
		key: "cloud",
		label: "Cap Cloud",
		lead: "Cap Cloud.",
		body: "Zero setup. Encrypted, and shareable the second you stop.",
	},
	{
		key: "s3",
		label: "Your S3 bucket",
		lead: "Your own S3 bucket.",
		body: "Any S3 compatible bucket, in any region you choose.",
	},
	{
		key: "drive",
		label: "Google Drive",
		lead: "Google Drive.",
		body: "Recordings land in a Drive folder you pick.",
	},
	{
		key: "self",
		label: "Self hosted",
		lead: "Self hosting.",
		body: "Run the whole Cap platform on your own infrastructure.",
	},
];

export const copyOf = (list: StageCopy[], key: string) => {
	const item = list.find((entry) => entry.key === key);
	if (!item) throw new Error(`Missing stage copy for ${key}`);
	return item;
};
