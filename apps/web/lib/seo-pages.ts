import {
	AgenciesPage,
	agenciesContent,
} from "@/components/pages/seo/AgenciesPage";
import {
	BestScreenRecorderPage,
	bestScreenRecorderContent,
} from "@/components/pages/seo/BestScreenRecorderPage";
import {
	DailyStandupSoftwarePage,
	dailyStandupSoftwareContent,
} from "@/components/pages/seo/DailyStandupSoftwarePage";
import {
	EmployeeOnboardingPlatformPage,
	employeeOnboardingContent,
} from "@/components/pages/seo/EmployeeOnboardingPlatformPage";
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
	OnlineClassroomToolsPage,
	onlineClassroomToolsContent,
} from "@/components/pages/seo/OnlineClassroomToolsPage";
import {
	OpenSourceScreenRecorderPage,
	openSourceScreenRecorderContent,
} from "@/components/pages/seo/OpenSourceScreenRecorderPage";
import {
	RemoteTeamCollaborationPage,
	remoteTeamCollaborationContent,
} from "@/components/pages/seo/RemoteTeamCollaborationPage";
import {
	ScreenRecorderPage,
	screenRecorderContent,
} from "@/components/pages/seo/ScreenRecorderPage";
import {
	ScreenRecordingPage,
	screenRecordingContent,
} from "@/components/pages/seo/ScreenRecordingPage";
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
	"best-screen-recorder": {
		component: BestScreenRecorderPage,
		content: bestScreenRecorderContent,
	},
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
	"screen-recording": {
		component: ScreenRecordingPage,
		content: screenRecordingContent,
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
	"solutions/agencies": {
		component: AgenciesPage,
		content: agenciesContent,
	},
	"solutions/daily-standup-software": {
		component: DailyStandupSoftwarePage,
		content: dailyStandupSoftwareContent,
	},
	"solutions/employee-onboarding-platform": {
		component: EmployeeOnboardingPlatformPage,
		content: employeeOnboardingContent,
	},
	"solutions/online-classroom-tools": {
		component: OnlineClassroomToolsPage,
		content: onlineClassroomToolsContent,
	},
	"how-to-screen-record": {
		component: HowToScreenRecordPage,
		content: howToScreenRecordContent,
	},
	"open-source-screen-recorder": {
		component: OpenSourceScreenRecorderPage,
		content: openSourceScreenRecorderContent,
	},
};

export const getPageBySlug = (slug: string) => seoPages[slug];
