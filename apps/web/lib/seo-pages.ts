import { SeoPageContent } from '@/components/seo/types';
import { ScreenRecorderPage, screenRecorderContent } from '@/components/pages/seo/ScreenRecorderPage';
import { FreeScreenRecorderPage, freeScreenRecorderContent } from '@/components/pages/seo/FreeScreenRecorderPage';

export const seoPages: Record<string, {
  component: React.ComponentType;
  content: SeoPageContent;
}> = {
  'screen-recorder': {
    component: ScreenRecorderPage,
    content: screenRecorderContent,
  },
  'free-screen-recorder': {
    component: FreeScreenRecorderPage,
    content: freeScreenRecorderContent,
  },
};

export const getPageBySlug = (slug: string) => seoPages[slug]; 