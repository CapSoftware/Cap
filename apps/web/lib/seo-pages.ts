import {
	FreeScreenRecorderPage,
	freeScreenRecorderContent,
} from "@/components/pages/seo/FreeScreenRecorderPage";
import {
	HowToScreenRecordPage,
	howToScreenRecordContent,
} from "@/components/pages/seo/HowToScreenRecordPage";
import {
	LoomAlternativePage,
	loomAlternativeContent,
} from "@/components/pages/seo/LoomAlternativePage";
import {
	RemoteTeamCollaborationPage,
	remoteTeamCollaborationContent,
} from "@/components/pages/seo/RemoteTeamCollaborationPage";
import {
	ScreenRecorderPage,
	screenRecorderContent,
} from "@/components/pages/seo/ScreenRecorderPage";
import {
	ScreenRecordingSoftwarePage,
	screenRecordingSoftwareContent,
} from "@/components/pages/seo/ScreenRecordingSoftwarePage";
import {
	ScreenRecordMacPage,
	screenRecordMacContent,
} from "@/components/pages/seo/ScreenRecordMacPage";
import {
	ScreenRecordWindowsPage,
	screenRecordWindowsContent,
} from "@/components/pages/seo/ScreenRecordWindowsPage";
import type { SeoPageContent } from "@/components/seo/types";

export const seoPages: Record<
	string,
	{
		component: React.ComponentType;
		content: SeoPageContent;
	}
> = {
	"screen-recorder": {
		component: ScreenRecorderPage,
		content: screenRecorderContent,
	},
	"free-screen-recorder": {
		component: FreeScreenRecorderPage,
		content: freeScreenRecorderContent,
	},
	"screen-recorder-mac": {
		component: ScreenRecordMacPage,
		content: screenRecordMacContent,
	},
	"screen-recorder-windows": {
		component: ScreenRecordWindowsPage,
		content: screenRecordWindowsContent,
	},
	"screen-recording-software": {
		component: ScreenRecordingSoftwarePage,
		content: screenRecordingSoftwareContent,
	},
	"loom-alternative": {
		component: LoomAlternativePage,
		content: loomAlternativeContent,
	},
	"solutions/remote-team-collaboration": {
		component: RemoteTeamCollaborationPage,
		content: remoteTeamCollaborationContent,
	},
	"how-to-screen-record": {
		component: HowToScreenRecordPage,
		content: howToScreenRecordContent,
	},
};

export const getPageBySlug = (slug: string) => seoPages[slug];
