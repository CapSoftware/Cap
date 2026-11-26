// Collapsing the search widens the title box it is measured against, and
// fractional display scaling (125%, 150% on Windows) rounds those widths
// differently in each state. Expanding again only once there is clear room
// keeps the two states from flipping on every render.
export const SEARCH_EXPAND_MARGIN = 16;

export function nextCompactSearch(
	compact: boolean,
	titleWidth: number,
	roomWithFullSearch: number,
) {
	if (compact) return titleWidth + SEARCH_EXPAND_MARGIN > roomWithFullSearch;
	return titleWidth > roomWithFullSearch;
}
