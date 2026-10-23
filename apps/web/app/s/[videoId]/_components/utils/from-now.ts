/**
 * Drop-in replacement for `moment(date).fromNow()` (en locale), which was the
 * share page's only moment call — and shipped all of moment plus every locale
 * (~75 KB gzipped) to say "3 days ago".
 *
 * Replicates moment's actual pipeline for `a.from(b)`: the difference is
 * split into whole calendar months plus a millisecond remainder
 * (`positiveMomentsDifference`), then each unit is independently rounded the
 * way `duration.humanize()` does — months convert to days at moment's
 * 30.436875-day Gregorian average, thresholds are s=44, m=45, h=22, d=26,
 * M=11. Parity is pinned by `__tests__/unit/from-now.test.ts`, which sweeps
 * the boundaries with moment itself as the oracle.
 */

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;
// Days per month averaged over the 400-year Gregorian cycle (146097 / 4800).
const DAYS_PER_MONTH = 146097 / 4800;

const daysInMonth = (year: number, month: number) =>
	new Date(year, month + 1, 0).getDate();

/** Month addition with moment's semantics: day-of-month clamps to month end. */
const addMonths = (date: Date, months: number): Date => {
	const result = new Date(date.getTime());
	const day = result.getDate();
	result.setDate(1);
	result.setMonth(result.getMonth() + months);
	result.setDate(
		Math.min(day, daysInMonth(result.getFullYear(), result.getMonth())),
	);
	return result;
};

export function fromNow(date: Date, now: Date = new Date()): string {
	const inPast = now.getTime() - date.getTime() >= 0;
	const [from, to] = inPast ? [date, now] : [now, date];

	// moment's positiveMomentsDifference: whole calendar months + remainder ms.
	let wholeMonths =
		(to.getFullYear() - from.getFullYear()) * 12 +
		(to.getMonth() - from.getMonth());
	if (addMonths(from, wholeMonths).getTime() > to.getTime()) wholeMonths--;
	const remainderMs = to.getTime() - addMonths(from, wholeMonths).getTime();

	// For second/minute/hour/day units, moment first converts the month part
	// to a WHOLE number of average-length days.
	const smallUnitsMs =
		remainderMs + Math.round(wholeMonths * DAYS_PER_MONTH) * MS_PER_DAY;
	const seconds = Math.round(smallUnitsMs / MS_PER_SECOND);
	const minutes = Math.round(smallUnitsMs / MS_PER_MINUTE);
	const hours = Math.round(smallUnitsMs / MS_PER_HOUR);
	const days = Math.round(smallUnitsMs / MS_PER_DAY);
	// For month/year units, the remainder converts to fractional months.
	const monthsExact = wholeMonths + remainderMs / MS_PER_DAY / DAYS_PER_MONTH;
	const months = Math.round(monthsExact);
	const years = Math.round(monthsExact / 12);

	const phrase =
		seconds <= 44
			? "a few seconds"
			: minutes <= 1
				? "a minute"
				: minutes < 45
					? `${minutes} minutes`
					: hours <= 1
						? "an hour"
						: hours < 22
							? `${hours} hours`
							: days <= 1
								? "a day"
								: days < 26
									? `${days} days`
									: months <= 1
										? "a month"
										: months < 11
											? `${months} months`
											: years <= 1
												? "a year"
												: `${years} years`;

	return inPast ? `${phrase} ago` : `in ${phrase}`;
}
