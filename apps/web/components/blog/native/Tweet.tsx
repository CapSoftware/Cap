import { Tweet as XTweet } from "react-tweet";

/**
 * A real X embed, rendered on the server by react-tweet from X's public
 * syndication data, so it looks like X and needs no third-party script.
 * `x-embed` undoes the forced prose sizes in globals.css.
 */
export function Tweet({ id }: { id: string }) {
	return (
		<div className="not-prose x-embed my-10 flex justify-center [&_.react-tweet-theme]:my-0">
			<XTweet id={id} />
		</div>
	);
}
