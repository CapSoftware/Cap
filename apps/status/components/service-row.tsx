"use client";

import { useId, useState } from "react";
import { availability, dayStatus } from "../lib/state";
import type { Day, Health, PublicService } from "../lib/types";
import { ServiceIcon } from "./icons";

export const LABELS: Record<Health, string> = {
	operational: "Operational",
	degraded: "Degraded",
	outage: "Outage",
	unknown: "No recent data",
};

export function formatUptime(days: Day[]): string {
	const value = availability(days);
	return value === null ? "—" : `${value === 100 ? "100" : value.toFixed(2)}%`;
}

export function formatDate(date: string): string {
	return new Date(date).toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		timeZone: "UTC",
	});
}

function dayDescription(day: Day) {
	const checks = day.operational + day.degraded + day.outage;
	return checks
		? `${formatUptime([day])} observed uptime · ${checks.toLocaleString()} checks`
		: "No monitoring data";
}

export function ServiceRow({ service }: { service: PublicService }) {
	const [expanded, setExpanded] = useState(false);
	const [selected, setSelected] = useState(service.days.length - 1);
	const [tooltip, setTooltip] = useState(false);
	const detailsId = useId();
	const activeDay = service.days[selected];
	return (
		<article className="service">
			<div className="service-heading">
				<button
					className="service-name"
					type="button"
					onClick={() => setExpanded(!expanded)}
					aria-expanded={expanded}
					aria-controls={detailsId}
				>
					<span className={`service-icon icon-${service.id}`}>
						<ServiceIcon id={service.id} />
					</span>
					<span>{service.name}</span>
					<span
						className={`chevron ${expanded ? "expanded" : ""}`}
						aria-hidden="true"
					>
						⌄
					</span>
				</button>
				<span className={`status-label ${service.status}`}>
					<span className="dot" />
					{LABELS[service.status]}
				</span>
			</div>
			<div className="history">
				<fieldset
					className="bars"
					onMouseLeave={() => setTooltip(false)}
					aria-label={`${service.name}: daily uptime history. Use arrow keys to explore.`}
				>
					{service.days.map((day, index) => (
						<button
							key={day.date}
							type="button"
							className={`bar ${dayStatus(day)}`}
							aria-label={`${formatDate(day.date)}: ${dayDescription(day)}`}
							tabIndex={index === selected ? 0 : -1}
							onMouseEnter={() => {
								setSelected(index);
								setTooltip(true);
							}}
							onFocus={() => {
								setSelected(index);
								setTooltip(true);
							}}
							onBlur={() => setTooltip(false)}
							onClick={() => {
								setSelected(index);
								setTooltip(true);
							}}
							onKeyDown={(event) => {
								if (
									![
										"ArrowLeft",
										"ArrowRight",
										"Home",
										"End",
										"Escape",
									].includes(event.key)
								)
									return;
								event.preventDefault();
								if (event.key === "Escape") {
									setTooltip(false);
									return;
								}
								const next =
									event.key === "Home"
										? 0
										: event.key === "End"
											? service.days.length - 1
											: Math.min(
													service.days.length - 1,
													Math.max(
														0,
														index + (event.key === "ArrowRight" ? 1 : -1),
													),
												);
								(
									event.currentTarget.parentElement?.children[
										next
									] as HTMLButtonElement
								)?.focus();
							}}
						/>
					))}
				</fieldset>
				{tooltip && activeDay && (
					<output className="history-tooltip">
						<strong>{formatDate(activeDay.date)} UTC</strong>
						<span>{dayDescription(activeDay)}</span>
					</output>
				)}
			</div>
			<div className="history-caption">
				<span>90 days ago</span>
				<span className="uptime">
					<strong>{formatUptime(service.days)}</strong> uptime
					<span className="caption-divider">·</span>Today
				</span>
			</div>
			<div id={detailsId} hidden={!expanded} className="service-details">
				<p>{service.description}</p>
				<div>
					<span>
						Latest response{" "}
						<strong>
							{service.latencyMs === null ? "—" : `${service.latencyMs} ms`}
						</strong>
					</span>
					<span>
						Last checked{" "}
						<strong>
							{service.checkedAt
								? `${new Date(service.checkedAt).toLocaleTimeString("en-GB", {
										timeZone: "UTC",
									})} UTC`
								: "Awaiting first check"}
						</strong>
					</span>
				</div>
				{!service.configured && (
					<p className="detail-note">
						Monitoring has not been configured for this service yet.
					</p>
				)}
			</div>
		</article>
	);
}
