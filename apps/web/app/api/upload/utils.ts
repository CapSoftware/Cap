export function parseVideoIdOrFileKey(
  userId: string,
  input:
    | { videoId: string; subpath: string }
    | {
        // deprecated
        fileKey: string;
      }
) {
  let videoId;
  let subpath;

  if ("fileKey" in input) {
    const [_, _videoId, ...subpathParts] = input.fileKey.split("/");
    if (!_videoId) throw new Error("Invalid fileKey");
    videoId = _videoId;
    subpath = subpathParts.join("/");
  } else {
    videoId = input.videoId;
    subpath = input.subpath;
  }

  return `${userId}/${videoId}/${subpath}`;
}
