import { promises as dns } from "node:dns";

// Throwaway inbox services rotate through new domains faster than any list can
// track, but their domains keep pointing at the same mail servers. So a domain
// counts as disposable when it, a parent domain, or one of its MX hosts is on
// the list (https://github.com/disposable-email-domains/disposable-email-domains).

const MX_LOOKUP_TIMEOUT_MS = 1500;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const FAILURE_CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 5000;
const MAX_HOST_LENGTH = 253;
const MAX_HOST_LABELS = 10;

export type ResolveMx = (domain: string) => Promise<string[]>;

let domainsPromise: Promise<ReadonlySet<string>> | undefined;
const cache = new Map<string, { disposable: boolean; expires: number }>();

function loadDisposableDomains(): Promise<ReadonlySet<string>> {
	domainsPromise ??= import("./disposable-email-domains.json").then(
		(module) => new Set<string>(module.default),
	);
	return domainsPromise;
}

function normalizeHost(host: string): string {
	return host.trim().toLowerCase().replace(/\.$/, "");
}

export function hostMatchesDomainList(
	host: string,
	domains: ReadonlySet<string>,
): boolean {
	const normalized = normalizeHost(host);
	if (!isPlausibleHost(normalized)) return false;
	let suffix = normalized;
	for (let dot = suffix.indexOf("."); dot !== -1; dot = suffix.indexOf(".")) {
		if (domains.has(suffix)) return true;
		suffix = suffix.slice(dot + 1);
	}
	return false;
}

// RFC 1035 limits, plus a label cap no real mail domain comes near, so
// attacker-supplied input stays cheap to check.
function isPlausibleHost(host: string): boolean {
	if (host.length === 0 || host.length > MAX_HOST_LENGTH) return false;
	const labels = host.split(".");
	return (
		labels.length <= MAX_HOST_LABELS &&
		labels.every((label) => label.length > 0 && label.length <= 63)
	);
}

const resolveMxHosts: ResolveMx = async (domain) => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const records = await Promise.race([
			dns.resolveMx(domain),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("MX lookup timed out")),
					MX_LOOKUP_TIMEOUT_MS,
				);
			}),
		]);
		return records.map((record) => record.exchange);
	} finally {
		clearTimeout(timer);
	}
};

/**
 * Whether an email domain belongs to a throwaway inbox service. DNS failures
 * count as not disposable, so a resolver outage never blocks sign-ups.
 * Domains past DNS length limits count as disposable.
 */
export async function isDisposableEmailDomain(
	domain: string,
	resolveMx: ResolveMx = resolveMxHosts,
): Promise<boolean> {
	const host = normalizeHost(domain);
	if (!host.includes(".")) return false;
	// No real mailbox lives on a domain this long or deep, and refusing it
	// keeps a wildcard-MX service's deep subdomains from slipping past.
	if (!isPlausibleHost(host)) return true;

	const cached = cache.get(host);
	if (cached && cached.expires > Date.now()) return cached.disposable;

	const domains = await loadDisposableDomains();
	if (hostMatchesDomainList(host, domains)) {
		remember(host, true);
		return true;
	}

	let mxHosts: string[];
	try {
		mxHosts = await resolveMx(host);
	} catch {
		remember(host, false, FAILURE_CACHE_TTL_MS);
		return false;
	}

	const disposable = mxHosts.some((mx) => hostMatchesDomainList(mx, domains));
	remember(host, disposable);
	return disposable;
}

export async function isDisposableEmail(email: string): Promise<boolean> {
	const domain = email.slice(email.lastIndexOf("@") + 1);
	if (!domain || domain === email) return false;
	return isDisposableEmailDomain(domain);
}

function remember(
	host: string,
	disposable: boolean,
	ttlMs: number = CACHE_TTL_MS,
) {
	if (cache.size >= CACHE_MAX_ENTRIES) {
		const oldest = cache.keys().next().value;
		if (oldest !== undefined) cache.delete(oldest);
	}
	cache.set(host, { disposable, expires: Date.now() + ttlMs });
}
