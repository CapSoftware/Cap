export const recordScreenWindowsContent = {
	slug: "windows-11-record-screen-system-audio-no-stereo-mix",
	title: "Record Screen + System Audio on Windows 11 (No Stereo Mix)",
	description:
		"Learn how to record your screen with crisp internal audio on Windows 11—without Stereo Mix. Capture mic + system sound together using Cap. Step-by-step setup, fixes, and FAQs.",
	publishedAt: "2025-09-17",
	category: "Tutorials",
	author: "Cap Team",
	tags: ["Screen Recording", "Windows", "System Audio", "Tutorials"],
	gradientColors: ["#dbeafe", "#bfdbfe", "#93c5fd"],

	heroTLDR:
		"You don't need the old Stereo Mix device. Cap uses modern WASAPI loopback capture to record exactly what's playing through your speakers or headphones, plus your microphone, in just a couple of clicks.",

	comparisonTable: {
		title: "4 Ways to Capture System Audio on Windows 11",
		headers: ["Method", "Price", "Complexity", "Notes"],
		rows: [
			[
				"<strong>Cap</strong>",
				"Free (open-source)",
				'<span className="rating">★☆☆☆☆</span> (2 clicks)',
				"Uses WASAPI loopback, works on all Windows 11 versions",
			],
			[
				"<strong>Xbox Game Bar</strong>",
				"Built-in Windows",
				'<span className="rating">★★☆☆☆</span>',
				"Good for games, limited for desktop workflows",
			],
			[
				"<strong>OBS</strong>",
				"Free but complex",
				'<span className="rating">★★★☆☆</span>',
				"Powerful but requires audio setup knowledge",
			],
			[
				"<strong>Stereo Mix Method</strong>",
				"Free but unreliable",
				'<span className="rating">★★★★☆</span>',
				"Often unavailable on modern Windows 11 hardware",
			],
		],
	},

	methods: [
		{
			title: "Method 1: Cap (Fastest Path)",
			description:
				"Cap makes it simple to record your Windows screen with system audio using modern WASAPI loopback:",
			steps: [
				{
					title: "Step 1: Install Cap",
					content:
						'Download and install Cap from <a href="/download">Cap.so/download</a>.',
				},
				{
					title: "Step 2: Configure Audio (1 Minute Setup)",
					content: `
            <p><strong>Pick Your Output Device:</strong></p>
            <p>Go to Settings → System → Sound and confirm which device you're actually using (speakers, headphones, etc.).</p>
            <p><strong>Check Per-App Audio Routing:</strong></p>
            <p>Go to Settings → System → Sound → Volume mixer. Make sure the app you plan to record (Chrome, Spotify, Teams, etc.) is set to output to the same device you're listening on.</p>
          `,
				},
				{
					title: "Step 3: Start Recording",
					content: `
            <ol>
              <li>Open Cap and choose your recording mode (Instant or Studio)</li>
              <li>Enable "Record System Audio" in the recording options</li>
              <li>Optionally enable "Microphone" for narration</li>
              <li>Choose your capture area (Screen, Window, or Region)</li>
              <li>Click "Start Recording"</li>
            </ol>
            <p><strong>Pro Tip:</strong> Cap captures both audio sources on separate tracks so you can adjust levels independently in the editor.</p>
          `,
				},
			],
		},
		{
			title: "Method 2: Xbox Game Bar (Built-in Windows)",
			description:
				"Windows 11's built-in Game Bar can record system audio, but with limitations:",
			steps: [
				{
					content: `
            <ol>
              <li>Press Win+G to open Xbox Game Bar</li>
              <li>Go to Capture → Win+Alt+R to start/stop recording</li>
              <li>Toggle the mic icon for narration</li>
            </ol>
            <p><strong>Limitation:</strong> Game Bar is designed for recording games and app windows, not desktop workflows or File Explorer tutorials.</p>
            <p><strong>Use Cap instead</strong> for better control and desktop recording capabilities.</p>
          `,
				},
			],
		},
	],

	troubleshooting: {
		title: "Troubleshooting Common Audio Issues",
		items: [
			{
				question: "No desktop audio in recording",
				answer:
					"Check Volume mixer (Settings → System → Sound → Volume mixer) and verify the app's output is set to your active speakers or headset.",
			},
			{
				question: "Microphone not being captured",
				answer:
					'Go to Control Panel → Sound → Recording → Microphone → Advanced, then uncheck "Allow applications to take exclusive control of this device."',
			},
			{
				question: "Recording is completely silent",
				answer:
					"Double-check the Volume mixer settings and confirm the app is playing to the output device Cap is monitoring. Cap captures from your default output device using WASAPI loopback.",
			},
			{
				question: "Can't find Stereo Mix on Windows 11",
				answer:
					"Many modern devices hide Stereo Mix or don't include it. You don't need it—Cap uses WASAPI loopback to record internal audio directly from your default output device.",
			},
		],
	},

	proTips: {
		title: "Pro Tips for Windows Screen Recording",
		tips: [
			{
				title: "Separate Audio Tracks",
				description:
					"Cap records system audio and microphone on separate tracks, allowing you to adjust levels independently in the editor.",
			},
			{
				title: "Monitor While Recording",
				description:
					"If you're wearing headphones, you can monitor your recording comfortably while capturing system audio without feedback loops.",
			},
			{
				title: "Auto-Subtitles",
				description:
					"Cap can automatically generate captions for your recording, making content more accessible.",
			},
			{
				title: "Privacy Compliance",
				description:
					"When recording meetings or calls, ensure you have everyone's consent and follow local privacy laws.",
			},
		],
	},

	faqs: [
		{
			question: "Can I record mic and system audio at the same time?",
			answer:
				"Yes, absolutely. In Cap, enable both 'System Audio' and 'Microphone' in the recording options. Cap captures both on separate tracks so you can adjust levels independently in the editor.",
		},
		{
			question: "Why can't I find Stereo Mix on Windows 11?",
			answer:
				"Many modern devices hide Stereo Mix or don't include it at all in their drivers. The good news is you don't actually need it anymore. Cap uses WASAPI loopback to record internal audio directly from your default output device.",
		},
		{
			question: "Does Game Bar record everything on the desktop?",
			answer:
				"Not really. Game Bar is optimized for recording games and specific application windows, not general desktop activities or File Explorer workflows. For tutorial creation or full-desktop walkthroughs, dedicated tools like Cap give you much more control and better results.",
		},
		{
			question: "Will this work on older Windows versions?",
			answer:
				"Cap's WASAPI loopback capture works on Windows 10 and Windows 11. It's more reliable than the old Stereo Mix method across different hardware configurations.",
		},
		{
			question: "Can I record specific application audio only?",
			answer:
				"Windows doesn't provide easy app-specific audio capture, but you can control which apps output to which devices in Volume mixer, then record from that specific output device.",
		},
	],

	cta: {
		title: "Start Recording with System Audio Today",
		description:
			"Cap makes recording your Windows screen with system audio incredibly simple. No Stereo Mix required, no complex audio routing.",
		buttonText: "Download Cap",
		buttonLink: "/download",
		subtitle:
			"Download Cap for Windows – free forever • Open-source • 14-day Pro trial",
	},

	relatedLinks: [
		{
			text: "Record Screen Mac System Audio",
			url: "/record-screen-mac-system-audio",
		},
		{
			text: "Video Trimmer Tool",
			url: "/tools/trim",
		},
		{
			text: "Speed Controller Tool",
			url: "/tools/speed",
		},
	],
};
