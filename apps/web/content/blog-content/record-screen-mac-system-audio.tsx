export const recordScreenMacContent = {
	slug: "record-screen-mac-system-audio",
	title: "Record Screen + System Audio on Mac (Free, 2025 Guide)",
	description:
		"A simple guide to capturing your Mac screen with internal audio without complex audio routing or expensive software.",
	publishedAt: "2025-04-22",
	category: "Tutorials",
	author: "Richie McIlroy",
	tags: ["Screen Recording", "Mac", "System Audio", "Tutorials"],
	gradientColors: ["#fed7aa", "#fdba74", "#fb923c"], // pastel oranges/yellows for macOS Big Sur

	heroTLDR:
		"Want to record your Mac screen with internal audio without expensive software? Here's how to do it in 2 clicks with Cap—completely free, no audio routing hacks needed.",

	comparisonTable: {
		title: "4 Ways to Capture System Audio on macOS",
		headers: ["Method", "Price", "Complexity", "Notes"],
		rows: [
			[
				"<strong>Cap</strong>",
				"Free (open-source)",
				'<span className="rating">★☆☆☆☆</span> (2 clicks)',
				"Works on all macOS versions including Sonoma, M-series chips",
			],
			[
				"<strong>QuickTime + BlackHole</strong>",
				"Free but technical",
				'<span className="rating">★★★★☆</span>',
				"Requires terminal commands, audio MIDI setup",
			],
			[
				"<strong>OBS</strong>",
				"Free but complex",
				'<span className="rating">★★★☆☆</span>',
				"Large app, needs BlackHole for audio",
			],
			[
				"<strong>Loopback</strong>",
				"$99",
				'<span className="rating">★★☆☆☆</span>',
				"Professional solution, but expensive",
			],
		],
	},

	methods: [
		{
			title: "Method 1: Cap (2-Click Tutorial)",
			description:
				"Cap makes it ridiculously simple to record your Mac screen with system audio:",
			steps: [
				{
					title: "Step 1: Install Cap",
					content:
						'Download and install Cap from <a href="/download">Cap.so/download</a>.',
				},
				{
					title: "Step 2: Start a Recording",
					content: `
            <ol>
              <li>Click the Cap icon in your menu bar</li>
              <li>Toggle "No System Audio" to "Record System Audio"</li>
              <li>Select the screen area you want to capture</li>
              <li>Click "Start Recording"</li>
            </ol>
            <p>That's it! Cap now captures both your screen and all system audio without any complex setup.</p>
            <p><strong>Pro Tip:</strong> Cap works without kernel extensions and is fully compatible with macOS Sonoma and all M-series chips.</p>
          `,
				},
				{
					title: "Step 3: Edit and Share (Optional)",
					content: `
            <p>After recording:</p>
            <ul>
              <li>Trim unwanted sections with Cap's built-in editor</li>
              <li>Adjust audio channels individually - control microphone and system audio levels separately</li>
              <li>Increase or decrease dB gain to make audio louder or quieter as needed</li>
              <li>Add custom backgrounds or padding if needed</li>
              <li>Get a shareable link with one click</li>
            </ul>
          `,
				},
			],
		},
		{
			title: "Method 2: Built-in QuickTime + BlackHole",
			description:
				"If you prefer using Apple's built-in tools, you'll need to:",
			steps: [
				{
					content: `
            <ol>
              <li>Install BlackHole audio driver via Terminal: <code>brew install blackhole-2ch</code></li>
              <li>Open Audio MIDI Setup and create a Multi-Output Device</li>
              <li>Configure QuickTime to use BlackHole as input</li>
              <li>Remember to switch your audio setup back when done</li>
            </ol>
            <p><strong>Skip the hacks and try Cap instead</strong> — no audio configuration required.</p>
          `,
				},
			],
		},
	],

	troubleshooting: {
		title: "Troubleshooting System Audio Recording",
		items: [
			{
				question: "I hear echo or feedback in my recording",
				answer:
					'This typically happens when both microphone and system audio are being recorded. In Cap, make sure only "Record System Audio" is enabled if you don\'t need microphone input.',
			},
			{
				question: "My microphone is muted during system audio recording",
				answer:
					"Cap allows recording both system audio and microphone simultaneously. Toggle both options ON in the recording menu.",
			},
			{
				question: "FaceTime/Zoom audio isn't being captured",
				answer:
					'Some apps have special privacy protections. In Cap, make sure to select "Record entire screen" to capture protected app audio.',
			},
			{
				question: "System audio recording stopped working after update",
				answer:
					"After macOS updates, you may need to re-authorize screen recording permissions. Go to System Preferences → Security & Privacy → Privacy → Screen Recording and ensure Cap is checked.",
			},
		],
	},

	proTips: {
		title: "Pro Tips for Client Demos and Content Creators",
		tips: [
			{
				title: "60 FPS Recording",
				description:
					"Enable high frame rate recording in Cap settings for smoother demos of animations and transitions.",
			},
			{
				title: "Audio Channel Control",
				description:
					"Fine-tune your recording's audio by adjusting microphone and system audio levels independently. Increase dB gain for quiet audio or reduce it to prevent distortion.",
			},
			{
				title: "Auto-Subtitles",
				description:
					"Cap can automatically generate captions for your recording, making content more accessible.",
			},
			{
				title: "Custom Sharing",
				description:
					"Use Cap.link or set up your own custom domain for a branded sharing experience.",
			},
		],
	},

	videoDemo: {
		title: "See It in Action",
		videoSrc: "https://cap.link/video/system-audio-demo.mp4",
		caption: "Cap recording Mac screen with system audio in 2 clicks",
	},

	faqs: [
		{
			question: "Does this work on M1, M2, and M3 Macs?",
			answer:
				"Yes, Cap is fully optimized for all Apple Silicon chips, including M1, M2, and M3 series processors.",
		},
		{
			question: "Will recording system audio affect my computer's performance?",
			answer:
				"Cap is designed to be extremely lightweight. You'll experience minimal performance impact even when recording high-resolution screens with system audio.",
		},
		{
			question: "Can I record specific application audio only?",
			answer:
				"Currently, macOS doesn't provide an API for app-specific audio capture. Cap records all system audio, but you can easily edit out unwanted sections afterward.",
		},
		{
			question: "Is there a time limit for recordings with system audio?",
			answer:
				"Cap's free version has no time limits on recordings. Record as long as you need.",
		},
		{
			question: "Can I record system audio on multiple monitors?",
			answer:
				"Yes, Cap can record system audio while capturing a single monitor, multiple monitors, or just a portion of your screen.",
		},
	],
	cta: {
		title: "Start Recording with System Audio Today",
		description:
			"Cap makes recording your Mac screen with system audio incredibly simple. No complex audio routing, no expensive software.",
		buttonText: "Download Cap",
		buttonLink: "/download",
		subtitle:
			"Download Cap for macOS – free forever • Open-source • 14-day Pro trial",
	},

	relatedLinks: [
		{
			text: "Cap vs Loom",
			url: "/loom-alternative",
		},
		{
			text: "Screen Recording Software",
			url: "/screen-recording-software",
		},
	],
};
