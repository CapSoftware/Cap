import type { CurrentUser, Video } from "@cap/web-domain";
import { Context, type Effect, type Option } from "effect";

// Who may download is decided by the web app (membership, the organization and
// cap download settings, the view gates and the share limit), so the RPC layer
// asks it instead of trusting view access alone.
export class VideoDownloadGate extends Context.Tag("VideoDownloadGate")<
	VideoDownloadGate,
	{
		readonly access: (
			videoId: Video.VideoId,
			viewer: Option.Option<CurrentUser["Type"]>,
		) => Effect.Effect<"member" | "viewer" | "denied">;
	}
>() {}
