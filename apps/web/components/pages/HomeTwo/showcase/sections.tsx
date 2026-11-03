import { classNames } from "@cap/utils/helpers";
import {
	ArrowUpRight,
	AudioLines,
	Bot,
	Braces,
	Captions,
	ChartNoAxesColumn,
	ClipboardCheck,
	Code,
	Crop,
	Download,
	Github,
	Globe,
	Hand,
	HardDrive,
	HeartPulse,
	Image as ImageIcon,
	Import,
	Layers,
	Lock,
	LockOpen,
	MessageSquare,
	MousePointer2,
	MoveUpRight,
	Palette,
	PencilLine,
	Plug,
	Rotate3d,
	Scissors,
	ScrollText,
	ShieldCheck,
	SquareDashedMousePointer,
	SquareTerminal,
	Type,
	UserRound,
	Wand,
	Zap,
} from "lucide-react";
import Link from "next/link";
import {
	InstantIcon,
	ScreenshotIcon,
	StudioIcon,
} from "@/components/pages/HomePage/modeIcons";
import { BTN_SECONDARY } from "../theme";
import { AI_COPY, INSTANT_COPY, STORAGE_COPY, STUDIO_COPY } from "./copy";
import {
	Badge,
	Details,
	Em,
	Section,
	SectionHead,
	StageFeatures,
	TONES,
} from "./layout";
import { SplitSection } from "./split";
import { Stage } from "./stage";

// Server rendered: headings, copy and detail lists are plain HTML for
// crawlers and first paint. Only the animated stages are client code, and
// those load as the visitor scrolls near them. Canvas sizes mirror the
// CANVAS constants in each stage module.

const WIDE = { w: 1040, h: 600 };

export const InstantSection = () => (
	<Section anchor="instant" tone={TONES.instant}>
		<SectionHead
			title="Stop recording. The link is already copied."
			badge={<Badge icon={<InstantIcon />}>Instant Mode</Badge>}
		>
			<Em>Instant Mode</Em> uploads while you talk, so there is nothing to wait
			for. Paste the link anywhere and <Em>people watch in the browser</Em>, no
			account needed.
		</SectionHead>
		<Stage
			name="instant"
			canvas={WIDE}
			tone={TONES.instant}
			className="mt-14"
		/>
		<StageFeatures items={INSTANT_COPY} />
		<Details
			className="mt-16"
			items={[
				{
					lead: "Screen, window, or area.",
					icon: <SquareDashedMousePointer />,
					body: "Record a whole display, a single window, a custom area, or just your camera.",
				},
				{
					lead: "Microphone and system audio.",
					icon: <AudioLines />,
					body: "Capture your voice and the sound from your computer together.",
				},
				{
					lead: "Password protected links.",
					icon: <Lock />,
					body: "Lock a Cap behind a password, keep it to your organization, or make it public.",
				},
				{
					lead: "Viewer analytics.",
					icon: <ChartNoAxesColumn />,
					body: "Views, comments, and reactions on every Cap, broken down by country, city, browser, and device.",
				},
				{
					lead: "Custom domains.",
					icon: <Globe />,
					body: "Share from cap.yourcompany.com instead of Cap.so on Cap Pro.",
				},
				{
					lead: "Embed anywhere.",
					icon: <Code />,
					body: "Drop a Cap into docs, a help center, or your site with an embed code.",
				},
			]}
		/>
	</Section>
);

export const StudioSection = () => (
	<Section anchor="studio" tone={TONES.studio}>
		<SectionHead
			title="Polish it before anyone sees it"
			badge={<Badge icon={<StudioIcon />}>Studio Mode</Badge>}
		>
			<Em>Studio Mode</Em> records in full quality straight to your computer,
			then opens an editor made for screen recordings.{" "}
			<Em>Zooms, layouts, captions, and privacy</Em> take a click each.
		</SectionHead>
		<Stage name="studio" canvas={WIDE} tone={TONES.studio} className="mt-14" />
		<StageFeatures items={STUDIO_COPY} />
		<Details
			className="mt-16"
			items={[
				{
					lead: "Animated text and titles.",
					icon: <Type />,
					body: "Titles, lower thirds, and callouts that fade, slide, pop, or type in word by word.",
				},
				{
					lead: "Cursor smoothing and click effects.",
					icon: <MousePointer2 />,
					body: "Smooth out shaky mouse movement, resize the cursor, add click animations and motion blur, and hide it when idle.",
				},
				{
					lead: "3D camera effects.",
					icon: <Rotate3d />,
					body: "Tilt, rotate, and pan the frame in 3D, with radial, directional, or tilt shift blur.",
				},
				{
					lead: "Color grading.",
					icon: <Palette />,
					body: "Presets like Cinematic, Noir, Vintage, and Golden, plus exposure, contrast, saturation, and vignette for the screen and camera.",
				},
				{
					lead: "Trim, split, and speed up.",
					icon: <Scissors />,
					body: "Cut and rearrange clips, change speed from 0.25x to 8x, and add music from the built in library.",
				},
				{
					lead: "4K export at 60fps.",
					icon: <Download />,
					body: "Export an MP4 or a GIF, or share it as a Cap.so link like everything else.",
				},
				{
					lead: "Camera background blur.",
					icon: <UserRound />,
					body: "Blur the room behind you on your webcam, without a green screen.",
				},
				{
					lead: "Separate screen, camera, and mic tracks.",
					icon: <Layers />,
					body: "Each is recorded on its own track, so you can fix one without touching the others.",
				},
				{
					lead: "Crop and aspect ratios.",
					icon: <Crop />,
					body: "Crop to the part that matters and export wide, square, or vertical for social.",
				},
			]}
		/>
	</Section>
);

export const ScreenshotSection = () => (
	<SplitSection
		anchor="screenshot"
		tone={TONES.screenshot}
		title="Screenshots that look designed"
		badge={<Badge icon={<ScreenshotIcon />}>Screenshot Mode</Badge>}
		lede={
			<>
				<Em>Screenshot Mode</Em> grabs any window or area with one hotkey and
				drops it on a background with padding and a shadow.{" "}
				<Em>It is on your clipboard</Em> before you let go.
			</>
		}
		details={[
			{
				lead: "Screenshot backgrounds.",
				icon: <ImageIcon />,
				body: "Wallpapers, gradients, or a solid color, with rounded corners and a soft shadow.",
			},
			{
				lead: "Annotation tools.",
				icon: <MoveUpRight />,
				body: "Arrows, rectangles, circles, text, and blur to point out the bug or the button you mean.",
			},
			{
				lead: "Copy to clipboard.",
				icon: <ClipboardCheck />,
				body: "Your screenshot is copied the moment you let go, or saved as a PNG or shared as a Cap.so link.",
			},
			{
				lead: "Any window or area.",
				icon: <SquareDashedMousePointer />,
				body: "Grab a full display, one window, or a region you draw, from a single hotkey.",
			},
		]}
		visual={
			<Stage
				name="screenshot"
				canvas={{ w: 640, h: 520 }}
				tone={TONES.screenshot}
				caption={false}
			/>
		}
	/>
);

export const AiSection = () => (
	<Section anchor="ai" tone={TONES.ai}>
		<SectionHead
			title="Every recording, understood"
			badge={<Badge icon={<ScrollText />}>Cap AI</Badge>}
		>
			Titles, summaries, chapters, and a transcript arrive with every recording,
			right on the share page, so{" "}
			<Em>the work after recording is already done</Em>.
		</SectionHead>
		<Stage name="ai" canvas={WIDE} tone={TONES.ai} className="mt-14" />
		<StageFeatures items={AI_COPY} />
		<Details
			className="mt-16"
			items={[
				{
					lead: "No prompts needed.",
					icon: <Zap />,
					body: "AI runs on every Cap automatically. There is nothing to write and no button to press.",
				},
				{
					lead: "Edit the transcript and summary.",
					icon: <PencilLine />,
					body: "Fix a misheard word or rewrite the summary right on the share page.",
				},
				{
					lead: "Captions for viewers.",
					icon: <Captions />,
					body: "The transcript doubles as captions viewers can switch on in the player.",
				},
				{
					lead: "Timestamped comments.",
					icon: <MessageSquare />,
					body: "Feedback lands on the second it is about, next to the transcript.",
				},
				{
					lead: "Readable by your AI agents.",
					icon: <Bot />,
					body: "Transcripts and summaries come back as data from the Cap CLI and MCP server.",
				},
				{
					lead: "Works with imported Loom videos.",
					icon: <Import />,
					body: "Videos you bring over from Loom get a title, transcript, and chapters too.",
				},
			]}
		/>
	</Section>
);

export const OwnershipSection = () => (
	<Section anchor="ownership" tone={TONES.storage}>
		<SectionHead
			title="Your recordings. Actually yours."
			badge={<Badge icon={<HardDrive />}>Storage you own</Badge>}
		>
			Cap is open source, and every recording goes{" "}
			<Em>exactly where you say</Em>. Use Cap Cloud, point it at your own bucket
			or Drive, or self host the whole thing.
		</SectionHead>
		<Stage
			name="ownership"
			canvas={{ w: 1040, h: 440 }}
			tone={TONES.storage}
			className="mt-14"
		/>
		<StageFeatures items={STORAGE_COPY} />
		<Details
			className="mt-16 lg:grid-cols-4"
			items={[
				{
					lead: "Open source.",
					icon: <Github />,
					body: "Every line is on GitHub. Audit it, fork it, or contribute the feature you need.",
				},
				{
					lead: "SOC 2 Type II and ISO 27001.",
					icon: <ShieldCheck />,
					body: "Independently audited controls behind Cap Cloud.",
				},
				{
					lead: "HIPAA compliant.",
					icon: <HeartPulse />,
					body: "Signed BAAs for organizations handling PHI.",
				},
				{
					lead: "No vendor lock in.",
					icon: <LockOpen />,
					body: "Recordings are plain video files. Take them anywhere, any time.",
				},
			]}
		/>
	</Section>
);

export const AgentsSection = () => (
	<Section anchor="agents" tone={TONES.agents}>
		<SectionHead
			title="Your agent can record, share, and read Caps"
			badge={<Badge icon={<SquareTerminal />}>Cap for Agents</Badge>}
		>
			Cap ships a CLI and a local MCP server, so{" "}
			<Em>Claude Code, Cursor, Codex, or any shell capable agent</Em> can record
			your screen, upload it, and read back the transcript.
		</SectionHead>
		<Stage
			name="agents"
			canvas={{ w: 1040, h: 450 }}
			tone={TONES.agents}
			caption={false}
			className="mt-14"
		/>
		<Details
			className="mt-16 lg:grid-cols-4"
			items={[
				{
					lead: "One prompt setup.",
					icon: <Wand />,
					body: "Your agent installs the CLI, the Cap skill, and the MCP server for Claude Code, Cursor, or Codex.",
				},
				{
					lead: "JSON output on every command.",
					icon: <Braces />,
					body: "Add one flag and the answer comes back as data, with live events while recording.",
				},
				{
					lead: "MCP server with 76 tools.",
					icon: <Plug />,
					body: "Read and manage Caps, comments, and sharing. Capture and upload stay in the CLI, so no secret passes through the model.",
				},
				{
					lead: "Permission prompts.",
					icon: <Hand />,
					body: "The agent checks with you before anything records, uploads, or costs money.",
				},
			]}
		/>
		<div className="mt-10 flex justify-center">
			<Link href="/agents" className={classNames(BTN_SECONDARY, "gap-2")}>
				Explore Cap for Agents
				<ArrowUpRight className="size-4" />
			</Link>
		</div>
	</Section>
);
