"use client";

import Image from "next/image";
import { useEffect, useId, useState } from "react";
import { emptyState, isStale, publicSnapshot } from "../lib/state";
import type { Health, Snapshot } from "../lib/types";
import { Arrow, Check } from "./icons";
import { formatDate, ServiceRow } from "./service-row";

const MESSAGES: Record<Health, { title: string; description: string }> = {
	operational: {
		title: "All systems operational",
		description: "Everything is running smoothly. Happy recording.",
	},
	degraded: {
		title: "Some services are degraded",
		description: "You may experience slower responses on the services below.",
	},
	outage: {
		title: "Some services are unavailable",
		description:
			"We’re detecting an interruption. See affected services below.",
	},
	unknown: {
		title: "Waiting for a clear picture",
		description: "Some services don’t have recent monitoring data yet.",
	},
};

function overallStatus(statuses: Health[]): Health {
	return statuses.includes("outage")
		? "outage"
		: statuses.includes("degraded")
			? "degraded"
			: statuses.includes("unknown")
				? "unknown"
				: "operational";
}

export function StatusPage() {
	const titleId = useId();
	const servicesId = useId();
	const incidentsId = useId();
	const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
	const [unavailable, setUnavailable] = useState(false);
	const [loading, setLoading] = useState(true);
	const [now, setNow] = useState<number | null>(null);
	const [showAll, setShowAll] = useState(false);

	useEffect(() => {
		let active = true;
		let inFlight = false;
		let controller: AbortController | null = null;
		async function refresh() {
			if (document.hidden) return;
			setNow(Date.now());
			if (inFlight) return;
			inFlight = true;
			controller = new AbortController();
			const timeout = setTimeout(() => controller?.abort(), 10_000);
			try {
				const response = await fetch("/api/status", {
					signal: controller.signal,
				});
				if (!response.ok) throw new Error("Status unavailable");
				const data: Snapshot = await response.json();
				if (active) {
					setSnapshot(data);
					setUnavailable(false);
				}
			} catch {
				if (active) setUnavailable(true);
			} finally {
				clearTimeout(timeout);
				inFlight = false;
				if (active) {
					setLoading(false);
					setNow(Date.now());
				}
			}
		}
		setNow(Date.now());
		void refresh();
		const poll = setInterval(() => {
			if (document.hidden) return;
			setNow(Date.now());
			void refresh();
		}, 60_000);
		const clock = setInterval(() => {
			if (!document.hidden) setNow(Date.now());
		}, 15_000);
		document.addEventListener("visibilitychange", refresh);
		return () => {
			active = false;
			controller?.abort();
			clearInterval(poll);
			clearInterval(clock);
			document.removeEventListener("visibilitychange", refresh);
		};
	}, []);

	const data = snapshot ?? (now ? publicSnapshot(emptyState(), now) : null);
	const services =
		data?.services.map((service) => ({
			...service,
			status:
				unavailable || isStale(service.checkedAt, now ?? 0)
					? ("unknown" as const)
					: service.status,
		})) ?? [];
	const overall = overallStatus(
		services.length ? services.map((service) => service.status) : ["unknown"],
	);
	const message = MESSAGES[overall];
	const incidents = data?.incidents ?? [];
	const visibleIncidents = showAll ? incidents : incidents.slice(0, 5);
	const fresh = Boolean(
		snapshot?.checkedAt &&
			!isStale(snapshot.checkedAt, now ?? 0) &&
			!unavailable,
	);
	const secondsAgo =
		snapshot?.checkedAt && now
			? Math.max(0, Math.floor((now - Date.parse(snapshot.checkedAt)) / 1_000))
			: null;

	return (
		<>
			<a href={`#${servicesId}`} className="skip-link">
				Skip to service status
			</a>
			<header className="site-header">
				<a className="brand" href="https://cap.so" aria-label="Cap home">
					<Image
						src="/cap-icon.svg"
						width={34}
						height={34}
						alt=""
						unoptimized
					/>
					<span>Cap</span>
					<span className="brand-divider" />
					<span className="brand-context">Status</span>
				</a>
				<a className="back-link" href="https://cap.so">
					Back to Cap <Arrow diagonal />
				</a>
			</header>
			<main>
				<section className="hero" aria-labelledby={titleId}>
					<div className="sky" aria-hidden="true">
						<Image
							width={896}
							unoptimized
							height={387}
							className="cloud cloud-left"
							src="/cloud-left.webp"
							alt=""
						/>
						<Image
							width={864}
							unoptimized
							height={241}
							className="cloud cloud-right"
							src="/cloud-right.webp"
							alt=""
						/>
					</div>
					<div className="hero-content">
						<h1 id={titleId}>A little peace of mind.</h1>
						<p className="hero-description">
							A live look at the services behind your recordings.
						</p>
						<a href={`#${servicesId}`} className="hero-link">
							Here’s how things are running <span aria-hidden="true">↓</span>
						</a>
					</div>
				</section>
				<div className="content">
					<section className={`summary ${overall}`} aria-label="Overall status">
						<div className="summary-main">
							<span className="summary-icon">
								{overall === "operational" ? (
									<Check />
								) : (
									<span aria-hidden="true">
										{overall === "unknown" ? "· · ·" : "!"}
									</span>
								)}
							</span>
							<div>
								<h2 aria-live="polite">
									{loading
										? "Checking system status"
										: unavailable
											? "Status updates are unavailable"
											: message.title}
								</h2>
								<p>
									{loading
										? "Getting the latest service health."
										: unavailable
											? "We can’t reach the monitor right now. Service health is unknown."
											: message.description}
								</p>
							</div>
						</div>
						<div className="live-label">
							<span className={`dot ${fresh ? "live-dot" : ""}`} />
							{fresh ? "Live" : loading ? "Connecting" : "Awaiting data"}
						</div>
					</section>
					<div className="section-heading" id={servicesId}>
						<div>
							<h2>Service status</h2>
							<p>Small checks. A clearer picture.</p>
						</div>
						<div className="update-label">
							<span className="refresh-icon" aria-hidden="true">
								↻
							</span>
							{secondsAgo !== null && fresh
								? `Updated ${secondsAgo < 60 ? "just now" : `${Math.floor(secondsAgo / 60)}m ago`}`
								: "Checks every 5 minutes"}
						</div>
					</div>
					<section
						className="services-card"
						aria-label="Service uptime over the past 90 days"
						aria-busy={loading}
					>
						{services.map((service) => (
							<ServiceRow key={service.id} service={service} />
						))}
						{!data && (
							<div className="loading-services">Loading service health…</div>
						)}
					</section>
					<div className="history-key">
						<span>Daily uptime · last 90 days · UTC</span>
						<div>
							<span>
								<i className="key-swatch operational" />
								Operational
							</span>
							<span>
								<i className="key-swatch degraded" />
								Degraded
							</span>
							<span>
								<i className="key-swatch outage" />
								Outage
							</span>
							<span>
								<i className="key-swatch unknown" />
								No data
							</span>
						</div>
					</div>
					<section className="incidents" aria-labelledby={incidentsId}>
						<div className="section-heading">
							<div>
								<h2 id={incidentsId}>Incident history</h2>
								<p>A little context, if something goes off track.</p>
							</div>
							<span className="period-label">Past 90 days</span>
						</div>
						{visibleIncidents.length ? (
							<div className="incident-list">
								{visibleIncidents.map((incident) => {
									const service = services.find(
										(entry) => entry.id === incident.serviceId,
									);
									return (
										<article key={incident.id} className="incident">
											<div className="incident-date">
												{formatDate(incident.startedAt)}
											</div>
											<div>
												<span
													className={`incident-tag ${incident.resolvedAt ? "operational" : incident.severity}`}
												>
													{incident.resolvedAt ? "Resolved" : "Detected"}
												</span>
												<h3>
													{service?.name ?? "Service"}{" "}
													{incident.severity === "outage"
														? "interruption"
														: "degraded performance"}
												</h3>
												<p>
													Automated checks detected{" "}
													{incident.severity === "outage"
														? "an availability issue"
														: "reduced service health"}
													.
													{incident.resolvedAt
														? " Service recovered after two successful checks."
														: " Recovery has not yet been confirmed."}
												</p>
												<p className="incident-time">
													{new Date(incident.startedAt).toLocaleTimeString(
														"en-GB",
														{
															hour: "2-digit",
															minute: "2-digit",
															timeZone: "UTC",
														},
													)}{" "}
													UTC
													{incident.resolvedAt
														? ` · Recovered ${formatDate(incident.resolvedAt)} at ${new Date(incident.resolvedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC`
														: " · Ongoing"}
												</p>
											</div>
										</article>
									);
								})}
							</div>
						) : (
							<div className="empty-incidents">
								<span className="empty-icon">
									<Check />
								</span>
								<div>
									<h3>
										{snapshot?.checkedAt
											? "Nothing to report. Just the way we like it."
											: "Your incident history starts here."}
									</h3>
									<p>
										{snapshot?.checkedAt
											? "No incidents recorded in the monitoring history available."
											: "Incidents will appear here once monitoring begins."}
									</p>
								</div>
								<span className="empty-flower" aria-hidden="true">
									✳︎
								</span>
							</div>
						)}
						{incidents.length > 5 && (
							<button
								className="more-incidents"
								type="button"
								onClick={() => setShowAll(!showAll)}
							>
								{showAll
									? "Show fewer incidents"
									: `View all ${incidents.length} incidents`}{" "}
								<Arrow />
							</button>
						)}
					</section>
					<details className="about-monitoring">
						<summary>
							How we keep an eye on things <span aria-hidden="true">+</span>
						</summary>
						<p>
							Lightweight checks run every five minutes, independently of this
							page. We retry an unhealthy response before recording it, confirm
							incidents across two checks, and confirm recovery twice. Grey bars
							mean no data; gaps are never counted as uptime. Percentages
							describe successful observed checks, not unmonitored time. Select
							a service or a day to explore its history. All times are UTC.
						</p>
					</details>
					<footer>
						<div>
							<span className="footer-dot" />
							Made with care. Monitored around the clock.
						</div>
						<nav aria-label="Footer">
							<a href="https://cap.so/support">
								Need a hand? <Arrow diagonal />
							</a>
							<a href="/api/status">
								Status API <Arrow diagonal />
							</a>
						</nav>
					</footer>
				</div>
			</main>
		</>
	);
}
