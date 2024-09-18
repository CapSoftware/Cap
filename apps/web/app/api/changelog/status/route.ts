import { NextResponse } from 'next/server';
import { getChangelogPosts } from "../../../../utils/changelog";

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const version = searchParams.get('version');

  const allUpdates = getChangelogPosts();

  const changelogs = allUpdates
    .map(post => ({
      metadata: post.metadata,
      content: post.content,
      slug: parseInt(post.slug)
    }))
    .sort((a, b) => b.slug - a.slug)
    .map(({ metadata, content }) => ({ ...metadata, content }));

  const latestVersion = changelogs[0].version;
  const hasUpdate = version ? latestVersion === version : false;

  const response = NextResponse.json({ hasUpdate });
  
  // Set CORS headers
  response.headers.set('Access-Control-Allow-Origin', '*');
  response.headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type');

  return response;
}

export async function OPTIONS() {
  const response = new NextResponse(null, { status: 204 });
  
  // Set CORS headers for preflight requests
  response.headers.set('Access-Control-Allow-Origin', '*');
  response.headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type');
  
  return response;
}