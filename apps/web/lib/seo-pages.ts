import { SeoPageContent } from '@/components/seo/types';
import { ScreenRecorderPage } from '@/components/pages/ScreenRecorderPage';
import { screenRecorderContent } from '@/components/pages/ScreenRecorderPage';

export const seoPages: Record<string, {
  component: React.ComponentType;
  content: SeoPageContent;
}> = {
  'screen-recorder': {
    component: ScreenRecorderPage,
    content: screenRecorderContent,
  },
};

export const getPageBySlug = (slug: string) => seoPages[slug]; 