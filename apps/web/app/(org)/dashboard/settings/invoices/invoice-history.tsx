"use client";

import { Button, Card, CardDescription, CardHeader, CardTitle } from "@cap/ui";
import { useRef, useState, useTransition } from "react";
import {
	getInvoiceHistory,
	getInvoiceHistoryPage,
	type InvoiceSection,
} from "@/actions/billing/invoices";
import type { BillingDocument } from "@/lib/billing/invoices";

function amount(document: BillingDocument) {
	const currency = document.currency.toUpperCase();
	const formatter = new Intl.NumberFormat("en", {
		style: "currency",
		currency,
	});
	const decimals = ["ISK", "UGX"].includes(currency)
		? 2
		: formatter.resolvedOptions().maximumFractionDigits;
	return formatter.format(document.total / 10 ** (decimals ?? 2));
}

function InvoiceGroup({ section }: { section: InvoiceSection }) {
	const [page, setPage] = useState(section.page);
	const [failed, setFailed] = useState(false);
	const [pending, startTransition] = useTransition();
	const inFlight = useRef(false);
	const load = () => {
		if (inFlight.current) return;
		inFlight.current = true;
		setFailed(false);
		startTransition(async () => {
			try {
				const result = await getInvoiceHistoryPage(
					section.id,
					page?.next ?? undefined,
				);
				setPage((current) => ({
					documents: [
						...new Map(
							[...(current?.documents ?? []), ...result.documents].map(
								(document) => [document.id, document],
							),
						).values(),
					].sort((a, b) => b.created - a.created || a.id.localeCompare(b.id)),
					next: result.next,
				}));
			} catch {
				setFailed(true);
			} finally {
				inFlight.current = false;
			}
		});
	};
	return (
		<Card>
			<CardHeader>
				<CardTitle>{section.title}</CardTitle>
			</CardHeader>
			{page?.documents.length ? (
				<div className="mt-4 overflow-x-auto">
					<table className="w-full text-left text-sm">
						<caption className="sr-only">
							{section.title} invoices and receipts
						</caption>
						<thead className="text-gray-10">
							<tr>
								{["Date", "Purchase", "Amount", "Status", "Document"].map(
									(label) => (
										<th
											key={label}
											scope="col"
											className="px-3 pb-3 font-medium"
										>
											{label}
										</th>
									),
								)}
							</tr>
						</thead>
						<tbody>
							{page.documents.map((document) => (
								<tr key={document.id} className="border-t border-gray-4">
									<td className="whitespace-nowrap px-3 py-4 text-gray-11">
										{new Date(document.created * 1000).toLocaleDateString(
											"en-GB",
											{
												day: "numeric",
												month: "short",
												year: "numeric",
												timeZone: "UTC",
											},
										)}
									</td>
									<td className="min-w-40 px-3 py-4">
										<p className="text-gray-12">{document.description}</p>
										{document.number && (
											<p className="mt-1 text-xs text-gray-10">
												{document.number}
											</p>
										)}
									</td>
									<td className="whitespace-nowrap px-3 py-4 text-gray-12">
										{amount(document)}
									</td>
									<td className="px-3 py-4 capitalize text-gray-11">
										{document.status.replaceAll("_", " ")}
									</td>
									<td className="whitespace-nowrap px-3 py-4">
										{document.url ? (
											<a
												href={document.url}
												target="_blank"
												rel="noopener noreferrer"
												className="font-medium underline"
											>
												{document.kind === "invoice"
													? "Download PDF"
													: "View receipt"}
												<span className="sr-only">
													{" "}
													for {document.number ?? document.description}
												</span>
											</a>
										) : (
											<span className="text-gray-10">Not available yet</span>
										)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			) : page ? (
				<p className="mt-3 text-sm text-gray-11">
					No invoices or receipts found.
				</p>
			) : null}
			{(failed || !page) && (
				<p role="alert" className="mt-3 text-sm text-gray-11">
					These invoices couldn’t be loaded. Please try again.
				</p>
			)}
			{(!page || page.next) && (
				<Button
					type="button"
					size="sm"
					variant="gray"
					className="mt-4"
					disabled={pending}
					spinner={pending}
					onClick={load}
				>
					{!page || failed ? "Try again" : "Load older documents"}
				</Button>
			)}
		</Card>
	);
}

export function InvoiceHistory({
	initialHistory,
}: {
	initialHistory: Awaited<ReturnType<typeof getInvoiceHistory>> | null;
}) {
	const [history, setHistory] = useState(initialHistory);
	const [version, setVersion] = useState(0);
	const [failed, setFailed] = useState(false);
	const [pending, startTransition] = useTransition();
	const visibleSections = history?.sections.filter(
		(section) =>
			!section.page || section.page.documents.length > 0 || section.page.next,
	);
	return (
		<div className="flex flex-col gap-6">
			<Card>
				<CardHeader>
					<CardTitle>Invoices</CardTitle>
					<CardDescription>
						Invoices and receipts for your Cap purchases, including Pro, desktop
						licenses, and organization subscriptions you manage.
					</CardDescription>
				</CardHeader>
				<Button
					type="button"
					size="sm"
					variant="gray"
					className="mt-4"
					disabled={pending}
					spinner={pending}
					onClick={() =>
						startTransition(async () => {
							setFailed(false);
							try {
								setHistory(await getInvoiceHistory());
								setVersion((value) => value + 1);
							} catch {
								setFailed(true);
							}
						})
					}
				>
					Refresh invoices
				</Button>
				{(failed || !history) && (
					<p role="alert" className="mt-3 text-sm text-gray-11">
						Invoices couldn’t be loaded. Please try again.
					</p>
				)}
				{history?.warnings.map((warning) => (
					<output key={warning} className="mt-3 text-sm text-gray-11">
						{warning}
					</output>
				))}
			</Card>
			{visibleSections?.map((section) => (
				<InvoiceGroup key={`${version}:${section.id}`} section={section} />
			))}
			{history && !visibleSections?.length && !history.warnings.length && (
				<p className="text-sm text-gray-11">
					No invoices or receipts found for this account. Sign in with the email
					you used at checkout.
				</p>
			)}
		</div>
	);
}
