import { LoadingSpinner } from "@cap/ui";
import clsx from "clsx";
import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { parse } from "tldts";
import { useDashboardContext } from "@/app/(org)/dashboard/Contexts";
import type { DomainConfig, DomainVerification } from "./types";

interface VerifyStepProps {
	domain: string;
	domainConfig?: DomainConfig | null;
	isVerified?: boolean;
	checkVerification: (showToasts?: boolean) => void;
	initialConfigLoading: boolean;
}

const POLL_INTERVAL = 5000;

const TXTDomainValueHandler = (record: DomainVerification, domain: string) => {
	if (!record.domain) return "@";
	if (record.domain === domain) return "@";
	const suffix = `.${domain}`;
	if (record.domain.endsWith(suffix)) {
		return record.domain.replace(suffix, "") || "@";
	}
	return record.domain;
};

const VerifyStep = ({
	domain,
	domainConfig,
	isVerified,
	checkVerification,
	initialConfigLoading,
}: VerifyStepProps) => {
	const [copiedField, setCopiedField] = useState<string | null>(null);
	const { activeOrganization } = useDashboardContext();

	const recommendedCnames = domainConfig?.recommendedCNAME || [];
	const recommendedIPv4 = domainConfig?.recommendedIPv4 || [];
	const recommendedARecord = domainConfig?.requiredAValue;
	const currentCnames = domainConfig?.cnames || [];
	const currentAValues = domainConfig?.currentAValues || [];
	const verificationRecords = domainConfig?.verification || [];

	const hasRecommendedCNAME = recommendedCnames.length > 0;
	const hasTXTVerification = verificationRecords.length > 0;

	const getRecommendedAValues = () => {
		if (recommendedARecord) return [recommendedARecord];

		if (recommendedIPv4.length > 0) {
			const sortedIPv4 = recommendedIPv4.sort((a, b) => a.rank - b.rank);
			const primaryRecommendation = sortedIPv4[0];

			if (!primaryRecommendation) return [];

			if (Array.isArray(primaryRecommendation.value)) {
				return primaryRecommendation.value;
			}
			return [primaryRecommendation.value];
		}

		return [];
	};

	const isSubdomain = (raw: string): boolean => {
		// Normalize and extract host (no scheme, path, port, or trailing dot)
		const input =
			raw
				.trim()
				.replace(/^https?:\/\//i, "")
				.split("/")[0] ?? "";
		if (!input) return false;
		const host = (input.replace(/\.$/, "").split(":")[0] || "").toLowerCase();
		try {
			// Prefer PSL-backed parsing for correctness (e.g., co.uk, com.au)
			const { subdomain } = parse(host);
			return Boolean(subdomain);
		} catch {
			// Fallback: conservative heuristic
			const parts = host.split(".");
			return parts.length > 2;
		}
	};
	const recommendedAValues = getRecommendedAValues();

	// Check if DNS records are already correctly configured
	const aRecordConfigured =
		recommendedAValues.length > 0 &&
		recommendedAValues.some((ip) => currentAValues.includes(ip));
	const cnameConfigured =
		recommendedCnames.length > 0 &&
		recommendedCnames.some((rec) => currentCnames.includes(rec.value));
	const showARecord =
		recommendedAValues.length > 0 && !aRecordConfigured && !isSubdomain(domain);
	const showCNAMERecord =
		hasRecommendedCNAME && !cnameConfigured && isSubdomain(domain);
	const showTXTRecord = hasTXTVerification && !isVerified;

	const handleCopy = async (text: string, fieldId: string) => {
		try {
			await navigator.clipboard.writeText(text);
			setCopiedField(fieldId);
			setTimeout(() => setCopiedField(null), 2000);
			toast.success("Copied to clipboard");
		} catch {
			toast.error("Failed to copy to clipboard");
		}
	};

	useEffect(() => {
		let interval: NodeJS.Timeout;
		if (activeOrganization?.organization.customDomain && !isVerified) {
			checkVerification(false);

			interval = setInterval(() => {
				checkVerification(false);
			}, POLL_INTERVAL);
		}

		return () => {
			clearInterval(interval);
		};
	}, [activeOrganization?.organization.customDomain, isVerified]);

	return (
		<div className="space-y-6">
			<div className="text-center">
				<h3 className="text-lg font-semibold text-gray-12">
					{isVerified ? "Domain Verified" : "Verify your domain"}
				</h3>
				<p className="text-sm text-gray-11">
					{isVerified
						? "Your domain is verified!"
						: `Add the DNS records below to verify ownership of ${domain}: wait a minute after updating to verify.`}
				</p>
			</div>

			{initialConfigLoading && !domainConfig ? (
				<div className="flex justify-center items-center w-full h-20">
					<LoadingSpinner size={36} />
				</div>
			) : (
				!isVerified &&
				domainConfig && (
					<div className="custom-scroll px-1 h-full max-h-[300px] space-y-4">
						{/* TXT Record Configuration for Verification */}
						{showTXTRecord && (
							<div className="overflow-hidden rounded-lg border border-gray-4">
								<div className="px-4 py-3 border-b bg-gray-2 border-gray-4">
									<p className="font-medium text-md text-gray-12">
										TXT Record Configuration
									</p>
									<p className="mt-1 text-sm text-gray-10">
										Add this TXT record to verify domain ownership:
									</p>
								</div>
								<div className="px-4 py-3">
									<dl className="grid gap-4">
										{verificationRecords.map((record, index) => (
											<div key={index.toString()} className="space-y-4">
												<div className="grid grid-cols-[100px,1fr] items-center">
													<dt className="text-sm font-medium text-gray-12">
														Type
													</dt>
													<dd className="text-sm text-gray-10">
														{record.type || "TXT"}
													</dd>
												</div>
												<div className="grid grid-cols-[100px,1fr] items-center">
													<dt className="text-sm font-medium text-gray-12">
														Name
													</dt>
													<dd className="text-sm text-gray-10">
														<code className="px-2 py-1 text-xs rounded bg-gray-4">
															{TXTDomainValueHandler(record, domain)}
														</code>
													</dd>
												</div>
												<div className="grid grid-cols-[100px,1fr] items-center">
													<dt className="text-sm font-medium text-gray-12">
														Value
													</dt>
													<dd className="text-sm text-gray-10">
														<div className="flex items-center justify-between gap-1.5 bg-gray-3 px-2 py-1 rounded-lg flex-1 min-w-0 border border-gray-4">
															<code className="text-xs break-all text-gray-10">
																{record.value}
															</code>
															<button
																type="button"
																onClick={() =>
																	handleCopy(
																		record.value,
																		`txt-record-${index}`,
																	)
																}
																className="p-1 rounded-md transition-colors hover:bg-gray-1 shrink-0"
																title="Copy to clipboard"
															>
																{copiedField === `txt-record-${index}` ? (
																	<Check className="size-3.5 text-green-500" />
																) : (
																	<Copy className="size-3.5 text-gray-10" />
																)}
															</button>
														</div>
													</dd>
												</div>
											</div>
										))}
									</dl>
								</div>
							</div>
						)}

						{/* A Record Configuration */}
						{showARecord && (
							<div className="overflow-hidden rounded-lg border border-gray-4">
								<div className="px-4 py-3 border-b bg-gray-2 border-gray-4">
									<p className="font-medium text-md text-gray-12">
										A Record Configuration
									</p>
									<p className="mt-1 text-sm text-gray-10">
										Add this A record to your domain:
									</p>
								</div>
								<div className="px-4 py-3">
									<dl className="grid gap-4">
										{/* Current A Values */}
										{currentAValues.length > 0 && (
											<div className="grid grid-cols-[100px,1fr] items-center">
												<dt className="text-sm font-medium text-gray-12">
													Current
												</dt>
												<dd className="space-y-1.5 text-sm text-gray-10">
													{currentAValues.map((value, index) => (
														<div
															key={`a-${index.toString()}`}
															className={clsx(
																recommendedAValues.includes(value)
																	? "flex items-center gap-2 text-green-300"
																	: "flex items-center gap-2 text-red-200",
															)}
														>
															<code
																className={clsx(
																	recommendedAValues.includes(value)
																		? "px-2 py-1 rounded-lg bg-green-900"
																		: "px-2 py-1 rounded-lg bg-red-900",
																	"text-xs",
																)}
															>
																{value}
															</code>
															{recommendedAValues.includes(value) && (
																<span className="text-xs text-green-600">
																	(Correct)
																</span>
															)}
														</div>
													))}
												</dd>
											</div>
										)}
										<div className="grid grid-cols-[100px,1fr] items-center">
											<dt className="text-sm font-medium text-gray-12">Type</dt>
											<dd className="text-sm text-gray-10">A</dd>
										</div>
										<div className="grid grid-cols-[100px,1fr] items-center">
											<dt className="text-sm font-medium text-gray-12">Name</dt>
											<dd className="text-sm text-gray-10">
												@ (or leave blank)
											</dd>
										</div>
										<div className="grid grid-cols-[100px,1fr] items-center">
											<dt className="text-sm font-medium text-gray-12">
												Value
											</dt>
											<dd className="space-y-2 text-sm text-gray-10">
												{recommendedAValues.map((ipAddress, index) => (
													<div
														key={`ip-${index.toString()}`}
														className="flex gap-2 items-center"
													>
														<div className="flex items-center justify-between gap-1.5 bg-gray-3 px-2 py-1 rounded-lg flex-1 min-w-0 border border-gray-4">
															<code className="text-xs text-gray-10">
																{ipAddress}
															</code>
															<button
																type="button"
																onClick={() =>
																	handleCopy(ipAddress, `a-record-${index}`)
																}
																className="p-1 rounded-md transition-colors hover:bg-gray-1 shrink-0"
																title="Copy to clipboard"
															>
																{copiedField === `a-record-${index}` ? (
																	<Check className="size-3.5 text-green-500" />
																) : (
																	<Copy className="size-3.5 text-gray-10" />
																)}
															</button>
														</div>
														{index === 0 && recommendedAValues.length > 1 && (
															<span className="text-xs text-gray-11">
																(Primary)
															</span>
														)}
													</div>
												))}
											</dd>
										</div>
									</dl>
								</div>
							</div>
						)}

						{/* CNAME Record Configuration */}
						{showCNAMERecord && (
							<div className="overflow-hidden rounded-lg border border-gray-4">
								<div className="px-4 py-3 border-b bg-gray-2 border-gray-4">
									<p className="font-medium text-md text-gray-12">
										CNAME Record Configuration
									</p>
									<p className="mt-1 text-sm text-gray-10">
										Add this CNAME record to your domain:
									</p>
								</div>
								<div className="px-4 py-3">
									<dl className="grid gap-4">
										{/* Current CNAME Values */}
										{currentCnames.length > 0 && (
											<div className="grid grid-cols-[100px,1fr] items-center">
												<dt className="text-sm font-medium text-gray-12">
													Current
												</dt>
												<dd className="space-y-1.5 text-sm text-gray-10">
													{currentCnames.map((value, index) => (
														<div
															key={`cname-${index.toString()}`}
															className={clsx(
																recommendedCnames.some(
																	(rec) => rec.value === value,
																)
																	? "flex items-center gap-2 text-green-300"
																	: "flex items-center gap-2 text-red-200",
															)}
														>
															<code
																className={clsx(
																	recommendedCnames.some(
																		(rec) => rec.value === value,
																	)
																		? "px-2 py-1 rounded-lg bg-green-900"
																		: "px-2 py-1 rounded-lg bg-red-900",
																	"text-xs",
																)}
															>
																{value}
															</code>
															{recommendedCnames.some(
																(rec) => rec.value === value,
															) && (
																<span className="text-xs text-green-600">
																	(Correct)
																</span>
															)}
														</div>
													))}
												</dd>
											</div>
										)}
										<div className="grid grid-cols-[100px,1fr] items-center">
											<dt className="text-sm font-medium text-gray-12">Type</dt>
											<dd className="text-sm text-gray-10">CNAME</dd>
										</div>
										<div className="grid grid-cols-[100px,1fr] items-center">
											<dt className="text-sm font-medium text-gray-12">Name</dt>
											<dd className="text-sm text-gray-10">
												<code className="px-2 py-1 text-xs rounded bg-gray-4">
													{domain.split(".").length > 2
														? domain.split(".")[0]
														: "@"}
												</code>
											</dd>
										</div>

										{/* Show ranked CNAME options */}
										{recommendedCnames
											.sort((a, b) => a.rank - b.rank)
											.map((cname, index) => {
												const fieldId = `cname-${cname.rank}`;
												return (
													<div
														key={cname.rank}
														className="grid grid-cols-[100px,1fr] items-center"
													>
														<dt className="text-sm font-medium text-gray-12">
															{index === 0 ? "Value" : `Option ${index + 1}`}
														</dt>
														<dd className="flex gap-2 items-center text-sm text-gray-10">
															<div className="flex items-center justify-between gap-1.5 bg-gray-3 px-2 py-1 rounded-lg flex-1 min-w-0 border border-gray-4">
																<code className="text-xs text-gray-10">
																	{cname.value}
																</code>
																<button
																	type="button"
																	onClick={() =>
																		handleCopy(cname.value, fieldId)
																	}
																	className="p-1 rounded-md transition-colors hover:bg-gray-1 shrink-0"
																	title="Copy to clipboard"
																>
																	{copiedField === fieldId ? (
																		<Check className="size-3.5 text-green-500" />
																	) : (
																		<Copy className="size-3.5 text-gray-10" />
																	)}
																</button>
															</div>
														</dd>
													</div>
												);
											})}
									</dl>
								</div>
							</div>
						)}
					</div>
				)
			)}
		</div>
	);
};

export default VerifyStep;
