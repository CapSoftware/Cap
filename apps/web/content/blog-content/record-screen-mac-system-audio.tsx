export const recordScreenMacContent = {
	slug: "record-screen-mac-system-audio",
	title:
		"How to Screen Record on a Mac With Audio (System Sound + Mic), Free in 2026",
	description:
		"The straightforward way to screen record on a Mac with audio — both internal system sound and your microphone — without BlackHole, Terminal commands, or paid software.",
	publishedAt: "2025-04-22",
	updatedAt: "2026-06-26",
	category: "Tutorials",
	author: "Richie McIlroy",
	tags: ["Screen Recording", "Mac", "System Audio", "Tutorials"],
	gradientColors: ["#fed7aa", "#fdba74", "#fb923c"], // pastel oranges/yellows for macOS Big Sur

	heroTLDR:
		"macOS won't record internal audio on its own — Cmd+Shift+5 and QuickTime only capture your mic. The quickest fix is Cap: toggle on system audio, hit record, and you're capturing screen and sound in two clicks. No BlackHole, no Terminal, free.",

	comparisonTable: {
		title: "4 Ways to Record System Audio on a Mac",
		headers: ["Method", "Price", "Setup", "Notes"],
		rows: [
			[
				"<strong>Cap</strong>",
				"Free (open-source)",
				'<span className="rating">★☆☆☆☆</span> (2 clicks)',
				"Captures system audio + mic natively. Works on the latest macOS and every Apple Silicon Mac.",
			],
			[
				"<strong>QuickTime + BlackHole</strong>",
				"Free",
				'<span className="rating">★★★★☆</span>',
				"Needs a virtual audio device, Audio MIDI Setup, and re-routing your output each time.",
			],
			[
				"<strong>OBS Studio</strong>",
				"Free",
				'<span className="rating">★★★☆☆</span>',
				"Powerful, but still needs BlackHole for internal audio and a scene set up first.",
			],
			[
				"<strong>Loopback</strong>",
				"$99",
				'<span className="rating">★★☆☆☆</span>',
				"Polished audio routing, but overkill (and pricey) just to record your screen.",
			],
		],
	},

	methods: [
		{
			title: "Method 1: Record Mac Screen + Audio With Cap (2 Clicks)",
			description:
				"Cap captures internal audio on macOS natively, so there's nothing to route and nothing to install beyond the app itself.",
			steps: [
				{
					title: "Step 1: Install Cap",
					content:
						'Download Cap from <a href="/download">cap.so/download</a> and drag it into Applications. The first time you record, macOS asks for Screen Recording and Microphone permissions in System Settings → Privacy & Security — grant both so Cap can capture your display and audio.',
				},
				{
					title: "Step 2: Turn on system audio and record",
					content: `
            <ol>
              <li>Click the Cap icon in your menu bar.</li>
              <li>Switch the audio control from "No System Audio" to "Record System Audio". Leave your microphone on too if you want to narrate.</li>
              <li>Pick what to capture — the full screen, a single window, or a region you draw.</li>
              <li>Hit Start Recording.</li>
            </ol>
            <p>That's the whole setup. Cap records everything coming out of your speakers — app sounds, a video playing in your browser, a call — alongside your voice, with no BlackHole and no Audio MIDI Setup.</p>
            <p><strong>Good to know:</strong> Cap runs without kernel extensions and works on the latest macOS releases and Apple Silicon (M1 through M4). If you only want a landing page for this workflow, the <a href="/mac-screen-recording-with-audio">Mac screen recorder with internal audio</a> page covers it too.</p>
          `,
				},
				{
					title: "Step 3: Trim, level, and share",
					content: `
            <p>When you stop, Cap hands you a shareable link right away, or you can open the recording in the editor first:</p>
            <ul>
              <li>Trim the dead air off the front and back.</li>
              <li>Balance the two audio tracks — mic and system audio are separate, so you can raise a quiet voiceover or pull down loud app sound independently.</li>
              <li>Add padding or a background if it's going in front of a client.</li>
              <li>Copy the link, or export an MP4 for editing elsewhere.</li>
            </ul>
          `,
				},
			],
		},
		{
			title: "Method 2: QuickTime + BlackHole (Free, but Fiddly)",
			description:
				"If you'd rather stick with Apple's built-in recorder, you can bolt on a free virtual audio driver. It works, but you'll repeat most of these steps every session.",
			steps: [
				{
					content: `
            <ol>
              <li>Install the BlackHole 2ch driver — <code>brew install blackhole-2ch</code>, or grab the installer from Existential Audio.</li>
              <li>Open <strong>Audio MIDI Setup</strong> and create a <strong>Multi-Output Device</strong> that includes both your speakers and BlackHole. This is what lets you keep hearing the audio while it's being captured.</li>
              <li>Set that Multi-Output Device as your system output in Sound settings.</li>
              <li>In QuickTime, choose <strong>File → New Screen Recording</strong>, click the chevron next to the record button, and pick <strong>BlackHole</strong> as the input.</li>
              <li>Record. When you're done, switch your output back to your speakers — otherwise your Mac stays silent.</li>
            </ol>
            <p>The catch: BlackHole routes system audio into the "microphone" slot, so recording your voice <strong>and</strong> system sound together means stacking an Aggregate Device on top of all this — the multi-step dance Cap skips entirely. <a href="/screen-recorder-mac">See how Cap compares as a Mac screen recorder</a>.</p>
          `,
				},
			],
		},
		{
			title: "Method 3: OBS Studio (Free, More Control)",
			description:
				"OBS is the right tool if you're already streaming or compositing multiple sources. For a quick capture with sound, it's more moving parts than most people need.",
			steps: [
				{
					content: `
            <ol>
              <li>Install OBS, then install BlackHole — OBS can't grab macOS system audio on its own either.</li>
              <li>Add a <strong>Display Capture</strong> (or Window Capture) source for your screen.</li>
              <li>Add an <strong>Audio Input Capture</strong> set to BlackHole for system sound, and a second one for your microphone.</li>
              <li>Route your system output through a Multi-Output Device, the same as the QuickTime method, so the sound reaches BlackHole.</li>
              <li>Hit Start Recording, then find the file in your output folder afterward.</li>
            </ol>
            <p>You get fine-grained control over levels and scenes, but no instant share link and a noticeably steeper setup. For tutorials and async updates, that trade rarely pays off.</p>
          `,
				},
			],
		},
	],

	troubleshooting: {
		title: "Troubleshooting Mac Audio Recording",
		items: [
			{
				question: "My recording has no system audio at all",
				answer:
					"With Cap, make sure the menu-bar control is set to \"Record System Audio\" before you start — it's off by default. With QuickTime or OBS, this almost always means your system output isn't pointed at the Multi-Output Device that includes BlackHole.",
			},
			{
				question: "I hear an echo or doubled audio",
				answer:
					"That happens when your mic is picking up the same sound your speakers are playing. Use headphones, or in Cap turn the microphone off and keep only system audio if you don't need narration.",
			},
			{
				question: "My microphone is being recorded but app sound isn't",
				answer:
					"Cap records both at once — toggle System Audio and Microphone on in the recording menu. If you're on QuickTime, it can only listen to one input, which is why capturing voice and system sound together needs an Aggregate Device.",
			},
			{
				question: "FaceTime or Zoom audio isn't captured",
				answer:
					'Some apps apply extra privacy protection to their audio. In Cap, choose "Record entire screen" rather than a single window to capture protected app audio reliably.',
			},
			{
				question: "System audio recording broke after a macOS update",
				answer:
					"Major macOS updates can reset screen recording permissions. Open System Settings → Privacy & Security → Screen Recording and confirm Cap is still enabled, then relaunch it.",
			},
		],
	},

	proTips: {
		title: "Pro Tips for Tutorials and Client Demos",
		tips: [
			{
				title: "Mind your levels first",
				description:
					"Play a few seconds of the loudest thing you'll capture before you hit record, so system audio doesn't clip over your voice. You can still fix the balance afterward, but a clean source saves time.",
			},
			{
				title: "Record at 60 FPS for motion",
				description:
					"If you're demoing animations, transitions, or anything that scrolls fast, bump the frame rate up in Cap's settings — 60 FPS keeps it smooth.",
			},
			{
				title: "Let captions do the work",
				description:
					"Cap can auto-generate captions from the audio it just recorded, which makes tutorials watchable on mute and more accessible without extra effort.",
			},
			{
				title: "Use a custom domain for client work",
				description:
					"Share from your own domain instead of a generic link so demos that land in a client's inbox look like they came from you.",
			},
		],
	},

	videoDemo: {
		title: "See It in Action",
		videoSrc: "https://cap.link/video/system-audio-demo.mp4",
		caption: "Recording a Mac screen with system audio in two clicks",
	},

	faqs: [
		{
			question: "Can Cap record internal audio on a Mac without BlackHole?",
			answer:
				'Yes. Cap captures macOS system audio natively, so you don\'t need BlackHole, Loopback, or any virtual audio driver. Turn on "Record System Audio" and everything playing through your Mac is captured with the screen.',
		},
		{
			question: "Why can't QuickTime or Cmd+Shift+5 record system audio?",
			answer:
				"Apple restricts internal audio capture on macOS for privacy and copyright reasons, so the built-in tools only record your microphone. To capture the sound your apps are playing, you need either a virtual audio device or an app like Cap that handles it natively.",
		},
		{
			question: "Does this work on M1, M2, M3, and M4 Macs?",
			answer:
				"Yes. Cap is built for Apple Silicon and runs natively on every M-series chip, as well as the latest versions of macOS.",
		},
		{
			question: "Is there a time limit on recordings?",
			answer:
				"Cap's Studio Mode records locally with no time limit — record for as long as you need and export the full length. On the free plan, Instant Mode (the instantly shareable links) is capped at 5 minutes per recording; upgrading lifts that cap.",
		},
		{
			question: "Can I record system audio and my microphone at the same time?",
			answer:
				"Yes, and Cap keeps them on separate tracks so you can adjust each one in the editor. That's ideal for narrating a tutorial while the app you're demoing still makes its own sounds.",
		},
		{
			question: "Can I record the audio from just one app?",
			answer:
				"macOS doesn't expose a per-app audio API, so Cap records all system audio together. The simplest workaround is to quit noisy background apps before recording, or trim unwanted sections out afterward.",
		},
		{
			question: "Will recording system audio slow my Mac down?",
			answer:
				"Not noticeably. Cap is lightweight and built natively for macOS, so even recording a high-resolution screen with audio leaves plenty of headroom on a modern Mac.",
		},
	],
	cta: {
		title: "Record Your Mac Screen With Audio — Free",
		description:
			"Skip the BlackHole setup. Cap captures system sound and your mic on macOS natively, then hands you a shareable link the moment you stop.",
		buttonText: "Download Cap",
		buttonLink: "/download",
		subtitle:
			"Free and open-source • Captures internal audio natively • No BlackHole or Terminal required",
	},

	relatedLinks: [
		{
			text: "Mac screen recorder with internal audio",
			url: "/mac-screen-recording-with-audio",
		},
		{
			text: "Best screen recorder for Mac",
			url: "/screen-recorder-mac",
		},
		{
			text: "How to screen record (any device)",
			url: "/how-to-screen-record",
		},
		{
			text: "Cap vs Loom",
			url: "/loom-alternative",
		},
	],
};
