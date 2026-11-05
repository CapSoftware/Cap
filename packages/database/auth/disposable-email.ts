import { promises as dns } from "node:dns";

// Throwaway inbox services rotate through new domains faster than any list can
// track, but their domains keep pointing at the same mail servers. So a domain
// counts as disposable when it, a parent domain, or one of its MX hosts is on
// the list (https://github.com/disposable-email-domains/disposable-email-domains).

const MX_LOOKUP_TIMEOUT_MS = 1500;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 5000;

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
	const labels = normalizeHost(host).split(".");
	for (let i = 0; i < labels.length - 1; i++) {
		if (domains.has(labels.slice(i).join("."))) return true;
	}
	return false;
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
 */
export async function isDisposableEmailDomain(
	domain: string,
	resolveMx: ResolveMx = resolveMxHosts,
): Promise<boolean> {
	const host = normalizeHost(domain);
	if (!host.includes(".")) return false;

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

function remember(host: string, disposable: boolean) {
	if (cache.size >= CACHE_MAX_ENTRIES) {
		const oldest = cache.keys().next().value;
		if (oldest !== undefined) cache.delete(oldest);
	}
	cache.set(host, { disposable, expires: Date.now() + CACHE_TTL_MS });
}
