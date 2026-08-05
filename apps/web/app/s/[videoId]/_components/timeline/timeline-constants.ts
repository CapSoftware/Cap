/**
 * Geometry for the share-page timeline band.
 *
 * Everything horizontal is expressed against a rail that is inset by
 * `RAIL_PAD_X` on both sides, so branches, ruler ticks, chapter ticks and the
 * playhead all share one coordinate system (the same padded-calc trick the
 * player uses for its comment stamps).
 */

/**
 * Horizontal inset of the rail inside the band, in px. Zero: the strip runs
 * edge to edge under the full-bleed video so the two read as one widescreen
 * surface. Nodes near t=0 clamp themselves inward instead (`clampedRailLeft`).
 */
export const RAIL_PAD_X = 0;

/**
 * Height of the filmstrip scrubber, in px. The strip is the top band, fixed to
 * the bottom edge of the video, so the film reads as a continuation of the
 * frame above it.
 */
export const STRIP_H = 64;
export const STRIP_H_MOBILE = 44;

export const stripHeight = (compact: boolean): number =>
	compact ? STRIP_H_MOBILE : STRIP_H;

/**
 * Height of the docked controls row under the strip, in px (`h-14`). Sized to
 * the player's own control bar (size-8 buttons plus its py-3), which renders
 * here through a portal while the timeline owns seeking.
 */
export const CONTROLS_H = 56;
export const CONTROLS_H_MOBILE = 56;

/**
 * Height of the comments surface at the bottom of the band, in px. Branches
 * hang *down* from its top edge (the anchor line the ruler draws), so it has to
 * clear a lane-1 node: `LANE_STEM` plus half a node, plus a little air.
 */
export const COMMENTS_H = 88;
export const COMMENTS_H_MOBILE = 80;

export const commentsHeight = (compact: boolean): number =>
	compact ? COMMENTS_H_MOBILE : COMMENTS_H;

/**
 * Deck height with the comments shelf open, in px. The band itself is
 * content-sized (the shelf collapses to zero when nothing is on it); this is
 * the ceiling, kept for anything budgeting viewport space.
 */
export const BAND_H = STRIP_H + CONTROLS_H + COMMENTS_H;
export const BAND_H_MOBILE =
	STRIP_H_MOBILE + CONTROLS_H_MOBILE + COMMENTS_H_MOBILE;

/** Diameter of a branch node, in px. */
export const NODE_SIZE = 30;

/**
 * Minimum horizontal distance between two branch nodes in the same lane before
 * the later one is pushed to lane 1 (and eventually folded into a cluster).
 */
export const MIN_NODE_GAP = 34;
export const MIN_NODE_GAP_MOBILE = 40;

/** Distance from the anchor line down to the node centre, per lane, in px. */
export const LANE_STEM: readonly [number, number] = [26, 62];
export const LANE_STEM_MOBILE: readonly [number, number] = [22, 56];

/** Hard cap on how many comments one cluster node represents. */
export const CLUSTER_MAX = 9;

/**
 * Track width is quantised before it reaches the layout memo: resizing by a
 * pixel must not rebuild every branch, and 24px is well under the gap that
 * decides lane assignment.
 */
export const WIDTH_QUANTUM = 24;

export const quantizeWidth = (width: number): number =>
	Number.isFinite(width) && width > 0
		? Math.round(width / WIDTH_QUANTUM) * WIDTH_QUANTUM
		: 0;

/** Usable rail width for a given band width. */
export const usableWidth = (trackWidth: number): number =>
	Math.max(0, trackWidth - RAIL_PAD_X * 2);

/**
 * `left` value that places a 0-100 percentage inside the padded rail.
 * Mirrors `CapVideoPlayer`'s comment-stamp positioning so both views agree.
 */
export const railLeft = (percent: number): string =>
	`calc(${RAIL_PAD_X}px + (${percent}% * (100% - ${RAIL_PAD_X * 2}px) / 100%))`;

/**
 * `railLeft`, kept far enough inside the surface that a centred element of the
 * given width survives the edge-to-edge rail without being clipped at 0% or
 * 100%. Stems lean off-time by a few px at the extremes, which reads better
 * than half a node.
 */
export const clampedRailLeft = (percent: number, width: number): string =>
	`clamp(${width / 2}px, ${railLeft(percent)}, calc(100% - ${width / 2}px))`;

/**
 * Where a moment sits inside the current zoom window, as 0-1. Unclamped on
 * purpose: callers cull or clamp depending on what they do off-window (the
 * playhead hides, the ghost clamps).
 */
export const fractionInWindow = (
	t: number,
	start: number,
	end: number,
): number => {
	const span = end - start;
	if (!Number.isFinite(span) || span <= 0) return 0;
	return (t - start) / span;
};

/**
 * Time under a pointer, given the rect of an element that spans the whole band
 * and the window that element is currently showing.
 */
export const timeFromClientX = (
	clientX: number,
	rect: { left: number; width: number },
	start: number,
	end: number,
): number => {
	const usable = usableWidth(rect.width);
	const span = end - start;
	if (usable <= 0 || !Number.isFinite(span) || span <= 0) return 0;
	const x = Math.min(Math.max(clientX - rect.left - RAIL_PAD_X, 0), usable);
	return start + (x / usable) * span;
};

/** Seek step for the rail's arrow keys, in seconds. */
export const KEYBOARD_SEEK_STEP = 5;

/** Span multiplier for the deck's zoom buttons. */
export const ZOOM_STEP = 1.5;

/** How close the playhead has to be for a branch to read as "now", in seconds. */
export const ACTIVE_CUE_WINDOW = 2;

/** Hover card timings, in ms. */
export const CARD_OPEN_DELAY = 120;
export const CARD_CLOSE_GRACE = 200;

/** Hover card width, in px (`w-72`). */
export const CARD_WIDTH = 288;

/** Hover ghost preview card width, in px. */
export const GHOST_CARD_WIDTH = 148;
