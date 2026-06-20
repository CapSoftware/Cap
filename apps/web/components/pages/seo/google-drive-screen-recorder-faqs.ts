export const googleDriveScreenRecorderFaqs = [
	{
		question: "Can I connect Google Drive to Cap?",
		answer:
			"Yes. Cap Pro includes a built-in Google Drive integration. Sign in with Google from the Cap desktop app or your organization dashboard, approve access, and Cap stores new shareable links in your own Google Drive.",
	},
	{
		question: "Does Cap upload my screen recordings to my own Google Drive?",
		answer:
			"Once Google Drive is the active storage provider, every new shareable link uploads directly to a private Cap folder in your Drive. You keep ownership of the video files in the Google account you already use.",
	},
	{
		question: "Can my whole organization use one Google Drive?",
		answer:
			"Yes. Google Drive can be connected for an individual user or for an entire organization. When an admin connects it at the organization level, it applies to all members and overrides personal storage settings, so every recording lands in the same place.",
	},
	{
		question: "Do my share links still work when videos live in Google Drive?",
		answer:
			"Absolutely. Your share links stay on Cap, complete with comments, viewer analytics, chapters, and optional password protection. Cap serves the video from your Google Drive after running its normal access checks, so the viewing experience is identical.",
	},
	{
		question: "Can I switch between Google Drive, S3, and Cap Cloud?",
		answer:
			"Yes. You can keep Cap Cloud, a custom S3 bucket, and Google Drive available at the same time, then choose the active provider with a single toggle. Existing recordings keep the storage they were created with, so nothing breaks when you switch.",
	},
	{
		question: "Does Cap have access to the rest of my Google Drive?",
		answer:
			"No. Cap uses Google's drive.file permission, which limits access to only the files Cap creates. Cap cannot see, read, or modify any other files in your Google Drive.",
	},
	{
		question: "Is the Google Drive integration free?",
		answer:
			"Creating a Cap account is free, and Studio Mode is free for personal use. Connecting your own Google Drive is part of Cap Pro, which starts at $8.16 per month per user, less than half the price of Loom.",
	},
	{
		question: "What happens to my existing recordings when I connect Drive?",
		answer:
			"Existing recordings keep their current storage, whether that is Cap Cloud or a custom S3 bucket. Only new shareable links created after you make Google Drive active are uploaded to your Drive.",
	},
];
