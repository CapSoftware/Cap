import { promises as fs } from 'fs';
import path from 'path';
import { getBlogPosts } from "@/utils/updates";

async function getPagePaths(dir: string): Promise<{ path: string; lastModified: string }[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const paths: { path: string; lastModified: string }[] = [];
  
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== 'dashboard' && !entry.name.startsWith('s') && entry.name !== 'updates') {
        const subPaths = await getPagePaths(fullPath);
        paths.push(...subPaths);
      } else if (entry.isFile() && (entry.name === 'page.tsx' || entry.name === 'page.mdx')) {
        const relativePath = path.relative(process.cwd(), dir);
        const routePath = '/' + relativePath.split(path.sep).slice(1).join('/');
        if (!routePath.includes('/dashboard') && !routePath.split('/').some(segment => segment.startsWith('s'))) {
          const stats = await fs.stat(fullPath);
          paths.push({
            path: routePath === '/app' ? '/' : routePath,
            lastModified: stats.mtime.toISOString()
          });
        }
      }
    }
  
    return paths;
  }
  
  export default async function sitemap() {
    const appDirectory = path.join(process.cwd(), 'app');
    const pagePaths = await getPagePaths(appDirectory);
  
    // Add blog post routes
    const blogPosts = getBlogPosts();
    const blogRoutes = blogPosts.map(post => {
      const publishDate = new Date(post.metadata.publishedAt);
      publishDate.setHours(9, 0, 0, 0); // Set time to 9:00 AM
      return {
        path: `/updates/${post.slug}`,
        lastModified: publishDate.toISOString()
      };
    });
  
    const routes = [...pagePaths, ...blogRoutes].map((route) => ({
      url: `https://cap.so${route.path}`,
      lastModified: route.lastModified,
    }));
  
    return routes;
  }