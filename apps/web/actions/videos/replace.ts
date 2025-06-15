'use server';

import { getCurrentUser } from '@cap/database/auth/session';
import { createVideoAndGetUploadUrl } from '@/actions/video/upload';
import { transcribeVideo } from '@/actions/videos/transcribe';

export async function getVideoReplacePresignedUrl(
  videoId: string,
  options: { duration?: number; resolution?: string; videoCodec?: string; audioCodec?: string } = {}
) {
  const user = await getCurrentUser();
  if (!user) {
    throw new Error('Unauthorized');
  }

  const data = await createVideoAndGetUploadUrl({
    videoId,
    duration: options.duration,
    resolution: options.resolution,
    videoCodec: options.videoCodec,
    audioCodec: options.audioCodec,
  });

  return data.presignedPostData;
}

export async function restartVideoTranscription(videoId: string) {
  const user = await getCurrentUser();
  if (!user) {
    throw new Error('Unauthorized');
  }

  await transcribeVideo(videoId, user.id);
}
