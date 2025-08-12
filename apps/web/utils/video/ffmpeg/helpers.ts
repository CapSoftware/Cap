export function generateM3U8Playlist(
  urls: {
    url: string;
    duration: string;
    resolution?: string;
    bandwidth?: string;
  }[]
) {
  const baseM3U8Content = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:5
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
`;

  let m3u8Content = baseM3U8Content;
  urls.forEach((segment) => {
    const { url, duration } = segment;
    m3u8Content += `#EXTINF:${duration},\n${url.replace(
      "https://capso.s3.us-east-1.amazonaws.com",
      "https://v.cap.so"
    )}\n`;
  });

  m3u8Content += "#EXT-X-ENDLIST";

  return m3u8Content;
}

export function generateMasterPlaylist(
  resolution: string,
  bandwidth: string,
  videoPlaylistUrl: string,
  audioPlaylistUrl: string | null,
  xStreamInfo?: string
) {
  const streamInfo = xStreamInfo
    ? xStreamInfo + ',AUDIO="audio"'
    : `BANDWIDTH=${bandwidth},RESOLUTION=${resolution},AUDIO="audio"`;
  const masterPlaylist = `#EXTM3U
#EXT-X-VERSION:4
#EXT-X-INDEPENDENT-SEGMENTS
${
  audioPlaylistUrl
    ? `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Audio",DEFAULT=YES,AUTOSELECT=YES,LANGUAGE="en",URI="${audioPlaylistUrl}"`
    : ""
}
#EXT-X-STREAM-INF:${streamInfo}
${videoPlaylistUrl}
`;

  return masterPlaylist;
}
