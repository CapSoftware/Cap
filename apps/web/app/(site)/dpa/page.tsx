import type { Metadata } from "next";

export const metadata: Metadata = {
	title: "Data Processing Agreement - Cap",
	description:
		"Cap's Data Processing Agreement for GDPR, UK GDPR, and related data protection laws.",
};

export default function DataProcessingAgreementPage() {
	return (
		<div className="py-32 wrapper wrapper-sm md:py-40">
			<div className="space-y-6 text-center">
				<h1 className="text-3xl md:text-4xl fade-in-down animate-delay-1">
					Data Processing Agreement
				</h1>
				<p className="pb-10 mx-auto max-w-lg text-lg text-gray-10 fade-in-down animate-delay-2">
					This Data Processing Agreement covers how Cap handles Customer
					Personal Data when customers use Cap for recording, sharing, storage,
					AI, and collaboration.
				</p>
				<div className="text-left legal-body fade-in-up animate-delay-2">
					<p>
						This Data Processing Agreement ("DPA") forms part of the Services
						Agreement between Cap Software, Inc. ("Cap," "we," "us," or "our")
						and the customer using Cap's services ("Customer," "you," or
						"your"). Customer agrees to this DPA by entering into the Services
						Agreement or by using the Services where Cap processes personal data
						on Customer's behalf. This DPA applies to Cap's website, desktop
						application, hosted services, recording and sharing workflows, team
						workspaces, APIs, integrations, support, and related services
						(collectively, the "Services").
					</p>
					<p>
						This DPA is designed to meet Article 28 of the GDPR, the UK GDPR,
						and similar processor contract requirements under applicable Data
						Protection Laws. If Customer has a separate signed data processing
						agreement with Cap, that signed agreement controls to the extent of
						any conflict.
					</p>
					<ol>
						<li>
							<h3>Definitions</h3>
							<br />
							"DPA" means this Data Processing Agreement, including its annexes.
							<br />
							"Services Agreement" means Cap's Terms of Service, an order form,
							a subscription agreement, or any other written agreement governing
							Customer's use of the Services.
							<br />
							"Customer Content" means recordings, screen content, webcam video,
							audio, transcripts, captions, titles, summaries, comments,
							thumbnails, folders, workspace content, files, metadata, and other
							content submitted to or generated through the Services by or for
							Customer.
							<br />
							"Customer Personal Data" means personal data contained in Customer
							Content or otherwise processed by Cap on Customer's behalf as a
							processor or subprocessor under the Services Agreement.
							<br />
							"Data Protection Laws" means all privacy and data protection laws
							applicable to Cap's processing of Customer Personal Data under the
							Services Agreement, including Regulation (EU) 2016/679, the UK
							GDPR, the Swiss Federal Act on Data Protection, the California
							Consumer Privacy Act, and any implementing or supplemental laws.
							<br />
							"Security Incident" means a confirmed breach of security of Cap's
							systems that leads to accidental or unlawful destruction, loss,
							alteration, unauthorized disclosure of, or access to Customer
							Personal Data.
							<br />
							"Subprocessor" means a third party engaged by Cap to process
							Customer Personal Data on Cap's behalf.
						</li>
						<li>
							<h3>Roles of the Parties</h3>
							<br />
							For Customer Personal Data, Customer is the controller and Cap is
							the processor. If Customer acts as a processor for another
							controller, Cap acts as Customer's subprocessor and Customer is
							responsible for ensuring that its instructions to Cap are
							authorized by the relevant controller.
							<br />
							Cap acts as an independent controller for personal data that Cap
							processes for its own business purposes rather than on Customer's
							behalf, including account administration, billing, sales,
							marketing, website analytics, security, fraud prevention, product
							analytics, and legal compliance. Cap's Privacy Policy governs that
							processing.
							<br />
							Customer decides what to record, upload, share, transcribe, store,
							delete, or otherwise process through the Services. Cap does not
							decide the purpose of Customer's recordings or what personal data
							Customer includes in Customer Content.
						</li>
						<li>
							<h3>Customer Instructions</h3>
							<br />
							Cap will process Customer Personal Data only on Customer's
							documented instructions, including the Services Agreement, this
							DPA, Customer's product settings, Customer's use of the Services,
							and written instructions submitted through support or other agreed
							channels.
							<br />
							Customer instructs Cap to process Customer Personal Data to
							provide, secure, maintain, support, troubleshoot, and improve the
							Services for Customer, including their functionality, safety,
							reliability, and performance; to prevent abuse; to comply with
							law; and as otherwise described in Annex I. Cap will notify
							Customer if Cap believes an instruction violates Data Protection
							Laws, unless legally prohibited from doing so.
						</li>
						<li>
							<h3>Customer Content and AI</h3>
							<br />
							Cap will not use Customer Content to train general-purpose AI
							models or third-party AI models unless Customer expressly enables
							a feature that permits that training, provides documented
							instructions, or the data has been aggregated or de-identified so
							that it is no longer Customer Personal Data.
							<br />
							Optional AI features may process Customer Personal Data through
							Subprocessors listed in Cap's trust portal. Customer decides
							whether to use those workflows and whether they are appropriate
							for Customer's data and compliance needs.
							<br />
							Cap may use telemetry, metadata, usage information, and aggregated
							or de-identified information to operate, secure, analyze, and
							improve the Services. Cap does not use Customer Content in
							identifiable form to train generalized models except as described
							in this section.
						</li>
						<li>
							<h3>Customer Responsibilities</h3>
							<br />
							Customer is responsible for complying with Data Protection Laws in
							its use of the Services, including providing required notices,
							obtaining required consents, choosing an appropriate legal basis,
							respecting recording laws, honoring data subject rights, and
							ensuring that Customer Content is lawful.
							<br />
							Customer is responsible for configuring the Services for its
							compliance needs, including whether to use Cap Cloud storage, a
							custom S3-compatible bucket, a self-hosted deployment,
							password-protected sharing, restricted access, optional AI
							features, retention settings, or other available controls.
							<br />
							Customer will not submit special categories of personal data,
							criminal conviction data, protected health information, children's
							data, or other regulated data unless Customer has determined that
							its use of the Services is lawful and appropriate for that data
							and has implemented the required safeguards.
						</li>
						<li>
							<h3>U.S. State Privacy Terms</h3>
							<br />
							To the extent Customer Personal Data is personal information
							governed by U.S. state privacy laws and Customer is a business or
							controller under those laws, Cap will process that information as
							a service provider, contractor, or processor for the limited and
							specified business purposes described in this DPA and the Services
							Agreement.
							<br />
							Cap will not sell or share Customer Personal Data, retain, use, or
							disclose Customer Personal Data outside the business purposes
							described in this DPA and the Services Agreement, or combine
							Customer Personal Data with personal information from other
							sources, except as permitted by applicable U.S. state privacy
							laws.
							<br />
							Cap will provide the level of privacy protection required of
							service providers, contractors, or processors under applicable
							U.S. state privacy laws and will notify Customer if Cap determines
							it can no longer meet those obligations.
						</li>
						<li>
							<h3>Confidentiality</h3>
							<br />
							Cap will ensure that personnel authorized to process Customer
							Personal Data are bound by confidentiality obligations or are
							subject to an appropriate statutory duty of confidentiality. Cap
							will limit access to Customer Personal Data to personnel who need
							access to provide, secure, support, or maintain the Services.
						</li>
						<li>
							<h3>Security Measures</h3>
							<br />
							Cap will maintain appropriate technical and organizational
							measures designed to protect Customer Personal Data against
							accidental or unlawful destruction, loss, alteration, unauthorized
							disclosure, or access. These measures are described in Annex II.
							<br />
							Customer acknowledges that security measures may evolve over time,
							provided that Cap does not materially decrease the overall
							security of the Services during the applicable subscription term.
						</li>
						<li>
							<h3>Subprocessors</h3>
							<br />
							Customer grants Cap general written authorization to engage
							Subprocessors to process Customer Personal Data. Cap will require
							each Subprocessor to protect Customer Personal Data under written
							terms that are at least as protective as the applicable
							data-processing obligations in this DPA.
							<br />
							Cap remains responsible for each Subprocessor's performance of its
							data-processing obligations. Cap maintains its current
							Subprocessor list through Cap's trust portal at{" "}
							<a href="https://trust.cap.so" rel="noreferrer" target="_blank">
								trust.cap.so
							</a>{" "}
							which may require access approval, or makes it available on
							request. That list is the source of truth for Cap Subprocessor
							names, service categories, processing purposes, processing
							locations, and related transfer information.
							<br />
							Cap will provide notice of new or replacement Subprocessors by
							updating the trust portal, through trust portal notifications
							where available, by account or email notice, or through another
							reasonable notice mechanism. Customer may object to a new or
							replacement Subprocessor within 30 days after notice if Customer
							has reasonable data protection grounds for the objection. Cap will
							use reasonable efforts to address the objection. If Cap cannot
							reasonably address the objection, Customer's sole remedy is to
							stop using the affected Service feature or terminate the affected
							portion of the Services before the new or replacement Subprocessor
							is used for Customer Personal Data.
							<br />
							Providers selected, contracted, or configured directly by
							Customer, including Customer's own S3-compatible storage provider,
							identity provider, cloud account, or self-hosted infrastructure
							provider, are not Cap Subprocessors.
						</li>
						<li>
							<h3>International Transfers</h3>
							<br />
							Cap Software, Inc. is established in the United States. Customer
							authorizes Cap and its Subprocessors to process Customer Personal
							Data in the United States and other locations where Cap or its
							Subprocessors maintain operations, subject to this DPA and Data
							Protection Laws.
							<br />
							Where Data Protection Laws require a transfer mechanism for a
							transfer of Customer Personal Data from the European Economic
							Area, the United Kingdom, or Switzerland to a country that has not
							been found to provide an adequate level of protection, the parties
							agree to use the applicable Standard Contractual Clauses, the
							EU-U.S. Data Privacy Framework to the extent Cap is certified and
							the framework applies, or another valid transfer mechanism.
							<br />
							For EEA transfers, the Standard Contractual Clauses adopted by the
							European Commission under Implementing Decision (EU) 2021/914
							apply as follows: Module Two applies where Customer is a
							controller and Cap is a processor; Module Three applies where
							Customer is a processor and Cap is a subprocessor; Clause 7 is
							deemed omitted; Clause 9 uses general written authorization with
							the notice period in Section 7; Clause 11 optional language is
							omitted; and the annexes are completed by Annexes I, II, and III
							of this DPA.
							<br />
							For the Standard Contractual Clauses, Customer is the data
							exporter and Cap is the data importer. The parties' contact
							details are the contact details in the Services Agreement, the
							applicable account, or the order document. The competent
							supervisory authority, governing law, and competent courts are
							determined under the applicable Standard Contractual Clauses. If
							the Standard Contractual Clauses require a selection, the parties
							will use the selection required by the Standard Contractual
							Clauses, the relevant data exporter, or the transfer documentation
							for the applicable transfer.
							<br />
							For UK transfers, the UK International Data Transfer Addendum to
							the EU Standard Contractual Clauses applies as required by UK Data
							Protection Laws, with its tables completed by the Services
							Agreement, this DPA, and Cap's trust portal. For Swiss transfers,
							references to the GDPR are deemed to include the Swiss Federal Act
							on Data Protection, references to EU supervisory authorities are
							deemed to include the Swiss Federal Data Protection and
							Information Commissioner, and data subjects in Switzerland may
							exercise and enforce their rights as required by Swiss law.
							<br />
							Cap will provide reasonable information available to it, including
							information in Cap's trust portal, to help Customer assess
							transfer risks and safeguards. Customer remains responsible for
							determining whether its use of the Services satisfies Customer's
							transfer obligations. Cap will notify Customer if Cap determines
							it can no longer comply with an applicable transfer mechanism.
						</li>
						<li>
							<h3>Data Subject Requests</h3>
							<br />
							Cap will, taking into account the nature of the processing,
							provide reasonable assistance to help Customer respond to requests
							from data subjects exercising rights under Data Protection Laws.
							If Cap receives a request directly from a data subject regarding
							Customer Personal Data, Cap will either direct the data subject to
							Customer or notify Customer, unless legally prohibited from doing
							so.
							<br />
							Customer is responsible for responding to data subject requests.
							Cap will not independently respond to a request for Customer
							Personal Data except to confirm that the request relates to
							Customer or as legally required.
						</li>
						<li>
							<h3>Assistance With Compliance</h3>
							<br />
							Cap will provide reasonable assistance, taking into account the
							nature of the processing and the information available to Cap, to
							help Customer meet Customer's obligations relating to security,
							personal data breach notification, data protection impact
							assessments, and prior consultation with supervisory authorities.
							Cap may charge a reasonable fee for assistance that requires
							material effort beyond standard product functionality or support.
						</li>
						<li>
							<h3>Security Incident Notification</h3>
							<br />
							Cap will notify Customer without undue delay after becoming aware
							of a Security Incident affecting Customer Personal Data and, where
							feasible, within 72 hours after becoming aware of the Security
							Incident. Cap's notification will include information reasonably
							available to Cap, which may include the nature of the incident,
							affected data categories, affected data subjects, likely
							consequences, measures taken or proposed, and a contact point for
							follow-up.
							<br />
							Cap will take reasonable steps to contain, investigate, remediate,
							and mitigate the effects of a Security Incident. Cap's
							notification of or response to a Security Incident is not an
							admission of fault or liability.
						</li>
						<li>
							<h3>Return and Deletion</h3>
							<br />
							During the term of the Services Agreement, Customer may access,
							export, or delete Customer Personal Data using the functionality
							made available in the Services. After termination or expiration of
							the Services Agreement, Cap will delete or return Customer
							Personal Data in accordance with the Services Agreement and
							Customer's documented instructions, unless retention is required
							by law.
							<br />
							Deleted Customer Personal Data may remain in backups, logs, or
							archives for a limited period until overwritten or deleted through
							Cap's normal retention cycles. During that period, Cap will
							protect the retained data under this DPA and use it only for
							backup, recovery, security, legal compliance, or as otherwise
							required by law.
							<br />
							For self-hosted deployments or Customer-controlled storage,
							Customer is responsible for deleting Customer Personal Data from
							infrastructure, backups, logs, and providers under Customer's
							control.
						</li>
						<li>
							<h3>Audits and Information</h3>
							<br />
							Cap will make available information reasonably necessary to
							demonstrate compliance with this DPA, including security
							documentation, product information, Subprocessor information, and
							other materials available through Cap's trust portal, public
							documentation, or support channels.
							<br />
							If that information is not enough to demonstrate compliance with
							this DPA, Customer may request an audit no more than once per
							calendar year, unless Data Protection Laws require more frequent
							access or the request follows a Security Incident. Cap may require
							the audit to begin as a remote documentation-based review. Any
							audit must be conducted during normal business hours, with
							reasonable advance notice, by Customer or an independent auditor
							bound by confidentiality, and in a way that does not compromise
							the security, availability, confidentiality, or privacy of Cap,
							the Services, or any other customer.
							<br />
							Customer will bear its audit costs unless the audit reveals a
							material breach of this DPA by Cap. Customer may not conduct
							penetration tests, vulnerability scans, social engineering, or
							physical security reviews without Cap's prior written approval.
						</li>
						<li>
							<h3>Government and Third-Party Requests</h3>
							<br />
							If Cap receives a legally binding request from a government,
							regulator, court, or law enforcement authority for Customer
							Personal Data, Cap will notify Customer before disclosure unless
							legally prohibited or unless notice would create a risk of harm.
							Cap will review the request and, where appropriate, seek to limit
							or challenge it.
							<br />
							Cap will not voluntarily disclose Customer Personal Data to a
							government authority except as required by law or with Customer's
							instructions.
						</li>
						<li>
							<h3>Records</h3>
							<br />
							Cap will maintain records of processing activities as required by
							Data Protection Laws. Customer is responsible for maintaining its
							own records of processing, including its purposes, legal bases,
							categories of data subjects, categories of personal data,
							retention periods, recipients, and transfer mechanisms.
						</li>
						<li>
							<h3>Order of Precedence</h3>
							<br />
							If there is a conflict between this DPA and the Services
							Agreement, this DPA controls for the processing of Customer
							Personal Data. If there is a conflict between this DPA and the
							applicable Standard Contractual Clauses or another mandatory
							transfer mechanism, the Standard Contractual Clauses or mandatory
							transfer mechanism controls for the relevant transfer.
						</li>
						<li>
							<h3>Liability</h3>
							<br />
							Each party's liability under this DPA is subject to the exclusions
							and limitations of liability in the Services Agreement, except to
							the extent prohibited by Data Protection Laws or the applicable
							Standard Contractual Clauses.
						</li>
						<li>
							<h3>Changes to This DPA</h3>
							<br />
							Cap may update this DPA from time to time, provided that updates
							do not materially reduce Cap's obligations for Customer Personal
							Data during an active subscription term unless required by law or
							agreed by Customer. Cap will post the updated DPA and update the
							"Last Updated" date.
						</li>
						<li>
							<h3>Contact</h3>
							<br />
							For questions about this DPA, data protection, or Subprocessor
							information, contact Cap at hello@cap.so.
						</li>
						<li>
							<h3>Annex I: Details of Processing</h3>
							<br />
							Subject matter: Cap's provision of the Services under the Services
							Agreement.
							<br />
							Duration: The term of the Services Agreement and any period during
							which Cap processes Customer Personal Data under Customer's
							documented instructions or as required by law.
							<br />
							Nature and purpose: Providing, operating, hosting, storing,
							uploading, encoding, streaming, sharing, organizing, displaying,
							transcribing, summarizing, analyzing, securing, supporting,
							troubleshooting, maintaining, and improving the functionality,
							safety, reliability, and performance of the Services.
							<br />
							Processing operations: Collection, receipt, upload, recording,
							storage, retrieval, access, organization, structuring, hosting,
							transmission, disclosure to authorized recipients, restriction,
							encryption, deletion, and other operations necessary to provide
							the Services.
							<br />
							Categories of data subjects: Customer's administrators, employees,
							contractors, workspace members, invited users, viewers,
							commenters, guests, prospects, customers, support contacts, and
							other individuals whose personal data appears in Customer Content.
							<br />
							Categories of personal data: Names, email addresses, account
							identifiers, workspace identifiers, user-generated content, screen
							content, application windows, browser content, webcam images,
							voices, audio, video, captions, transcripts, summaries, comments,
							thumbnails, file names, folder names, share links, viewer
							analytics, device data, IP addresses, approximate location data,
							timestamps, access logs, support content, integration data, and
							encrypted storage configuration details where Customer uses
							bring-your-own-storage features.
							<br />
							Special categories of data: Cap does not intentionally request
							special categories of personal data. Customer Content may contain
							special categories of personal data if Customer chooses to record,
							upload, share, transcribe, or otherwise process that information
							through the Services.
							<br />
							Customer obligations and rights: Customer's obligations and rights
							are described in the Services Agreement, this DPA, and Data
							Protection Laws.
						</li>
						<li>
							<h3>Annex II: Technical and Organizational Measures</h3>
							<br />
							Access controls: Cap uses access controls designed to limit access
							to Customer Personal Data to authorized personnel, systems, and
							Subprocessors with a need to access it.
							<br />
							Authentication and authorization: Cap supports account-based
							access to the Services and uses authorization controls designed to
							restrict access to workspaces, recordings, settings, and sharing
							features.
							<br />
							Encryption: Cap uses encrypted transport for data transmitted to
							and from the Services and uses encryption or equivalent safeguards
							for managed storage and sensitive configuration values where
							appropriate.
							<br />
							Storage control: Cap supports local recording workflows,
							Customer-controlled S3-compatible storage, and self-hosted
							deployments so Customer can choose where recording content is
							stored when those features are available and configured.
							<br />
							Sharing controls: Cap provides controls such as share links,
							password protection, workspace access controls, signed storage
							URLs, and custom domain configuration where available and
							configured by Customer.
							<br />
							Data minimization: Cap processes Customer Personal Data for the
							purposes described in this DPA and supports product controls that
							allow Customer to limit sharing, disable optional AI workflows,
							use Customer-controlled storage, delete content, and export
							content.
							<br />
							Availability and resilience: Cap uses operational safeguards
							designed to support the availability and resilience of the
							Services, including monitoring, backups, recovery processes, and
							incident response practices appropriate to the nature of the
							Services.
							<br />
							Development and change management: Cap uses development practices
							designed to reduce security and privacy risk, including source
							control, code review, testing, dependency management, and
							deployment controls.
							<br />
							Logging and monitoring: Cap uses logs and monitoring designed to
							help secure the Services, troubleshoot issues, detect abuse,
							investigate incidents, and maintain reliability.
							<br />
							Personnel and vendor controls: Cap requires personnel with access
							to Customer Personal Data to protect it and evaluates
							Subprocessors before authorizing them to process Customer Personal
							Data.
						</li>
						<li>
							<h3>Annex III: Subprocessors</h3>
							<br />
							Customer authorizes Cap to use Subprocessors for the following
							categories of services: cloud hosting, database infrastructure,
							object storage, content delivery, email delivery, authentication,
							payment processing, customer support, analytics, error monitoring,
							logging, AI transcription, AI summarization, media processing,
							workflow automation, and other infrastructure or service providers
							needed to provide the Services.
							<br />
							Cap's current Subprocessor list is maintained through Cap's trust
							portal at{" "}
							<a href="https://trust.cap.so" rel="noreferrer" target="_blank">
								trust.cap.so
							</a>{" "}
							which may require access approval, or made available upon request.
							The list is incorporated by reference into this Annex III and is
							the source of truth for Subprocessor names, purposes, processing
							locations, service categories, and related transfer information.
							<br />
							Customer-controlled providers, including Customer's own
							S3-compatible storage provider, identity provider, cloud account,
							or self-hosted infrastructure provider, are selected by Customer
							and are not Cap Subprocessors.
						</li>
					</ol>
					<p>Data Processing Agreement for Cap Software, Inc.</p>
					<p>Last Updated: 8 May 2026</p>
				</div>
			</div>
		</div>
	);
}
