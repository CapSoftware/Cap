/**
 * Single source of truth for the plan prices quoted across the site: marketing
 * copy, comparison tables, JSON-LD schema and the in-app upgrade surfaces.
 *
 * The numbers are identical in every presentment currency (USD, GBP, EUR) and
 * only the symbol changes, so these are plain amounts with no currency attached.
 * Keep this file import-free so it stays safe to pull into client components.
 */
export const PRICING = {
	pro: {
		/** Per user, billed monthly. */
		monthly: 12,
		/** Per user, per month, when billed annually. */
		annualPerMonth: 8.16,
		/** Per user, charged once a year. */
		yearlyTotal: 98,
	},
	commercial: {
		/** Per license, billed yearly. */
		yearly: 29,
		/** Per license, one-time payment. */
		lifetime: 58,
	},
} as const;
