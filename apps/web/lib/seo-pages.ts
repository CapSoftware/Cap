import { SeoPageContent } from "@/components/seo/types";
import {
  ScreenRecorderPage,
  screenRecorderContent,
} from "@/components/pages/seo/ScreenRecorderPage";
import {
  FreeScreenRecorderPage,
  freeScreenRecorderContent,
} from "@/components/pages/seo/FreeScreenRecorderPage";
import {
  ScreenRecordMacPage,
  screenRecordMacContent,
} from "@/components/pages/seo/ScreenRecordMacPage";
import {
  ScreenRecordWindowsPage,
  screenRecordWindowsContent,
} from "@/components/pages/seo/ScreenRecordWindowsPage";
import {
  ScreenRecordingSoftwarePage,
  screenRecordingSoftwareContent,
} from "@/components/pages/seo/ScreenRecordingSoftwarePage";

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
};

export const getPageBySlug = (slug: string) => seoPages[slug];
