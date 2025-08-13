import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import "./popup.css";
import { Logo } from "../components/Logo";
import UserProfile from "../components/UserProfile";
import LoomImporter from "../components/LoomImporter";
import EmailSelector from "../components/EmailSelector";
import { useAuth } from "../hooks/useAuth";
import {
	ImportProvider,
	useImport,
	ImportStep,
} from "../context/ImportContext";
import { useOrganizations } from "../hooks/useOrganizations";
import { getChecklistItemsForStep } from "../utils/importUtils";
import { useImportStore } from "../store/importStore";
import OrganizationSelector from "../components/OrganizationSelector";

const PopupContent = () => {
	const {
		isAuthenticated,
		user,
		handleLogin,
		handleLogout,
		isError: authError,
		status: authStatus,
	} = useAuth();

	const {
		organizations,
		selectedOrganizationId,
		handleOrganizationSelect,
		createOrganization,
	} = useOrganizations(isAuthenticated);

	const { importState, startImport, sendDataToCap, resetImport } = useImport();

	const { setSelectedUserEmail } = useImportStore();

	const importStarted = importState.currentStep !== ImportStep.IDLE;
	const importComplete = importState.currentStep === ImportStep.IMPORT_COMPLETE;

	const [importError, setImportError] = useState<string | null>(null);

	const handleStartImport = async () => {
		try {
			const result = await startImport(selectedOrganizationId);
			if (!result.success) {
				setImportError(result.message || "Import failed");
			}
		} catch (error) {
			console.error("Error starting import:", error);
			setImportError(
				error instanceof Error
					? error.message
					: "Unknown error starting import",
			);
		}
	};

	const handleEmailSelected = (email: string) => {
		setSelectedUserEmail(email);
	};

	const handleSendToCap = async () => {
		try {
			const result = await sendDataToCap();
			if (!result.success) {
				setImportError(result.message || "Import failed");
			}
		} catch (error) {
			console.error("Error sending to Cap:", error);
			setImportError(
				error instanceof Error ? error.message : "Unknown error sending to Cap",
			);
		}
	};

	const checklistItems = getChecklistItemsForStep(importState.currentStep);

	return (
		<div className="p-4 min-w-[18rem] bg-gray-100 flex flex-col h-full">
			<div className="flex items-center mb-4">
				<Logo className="w-20 h-10" />
			</div>

			{!isAuthenticated ? (
				<div className="flex justify-center items-center mt-4">
					<button
						type="button"
						onClick={handleLogin}
						className="flex items-center justify-center gap-1 rounded-full border-[1px] bg-blue-500 text-white hover:bg-blue-600 border-blue-500 font-[400] text-[1.125rem] px-[1.25em] h-[2.5rem] relative"
					>
						Login to Cap.so
					</button>
				</div>
			) : (
				<>
					<h1 className="my-2 text-lg font-medium">Import Data</h1>

					{(authError || importError || importState.error) && (
						<div className="mb-4 text-sm text-red-500">
							{importError || importState.error || authStatus}
						</div>
					)}
					<div className="bg-white rounded-[20px] p-4 border-[1px] border-gray-200 flex flex-col gap-4">
						{!importStarted && organizations && organizations.length > 0 && (
							<OrganizationSelector
								organizations={organizations}
								selectedOrganizationId={selectedOrganizationId}
								onSelectOrganization={handleOrganizationSelect}
								onCreateOrganization={createOrganization}
							/>
						)}

						{importState.currentStep === ImportStep.PROCESSING_COMPLETE &&
							importState.data.userEmail === null && (
								<EmailSelector
									workspaceMembers={importState.data.workspaceMembers || []}
									onEmailSelected={handleEmailSelected}
									selectedEmail={importState.data.userEmail}
								/>
							)}

						<LoomImporter
							importStarted={importStarted}
							checklistItems={checklistItems}
							selectedOrganizationId={selectedOrganizationId}
							currentStep={importState.currentStep}
							hasSelectedEmail={!!importState.data.userEmail}
							onStartImport={handleStartImport}
							onSendToCap={handleSendToCap}
							onResetImport={resetImport}
						/>
					</div>

					<UserProfile user={user} onLogout={handleLogout} />
				</>
			)}
		</div>
	);
};

const Popup = () => (
	<ImportProvider>
		<PopupContent />
	</ImportProvider>
);

const root = createRoot(document.getElementById("root")!);

root.render(
	<React.StrictMode>
		<Popup />
	</React.StrictMode>,
);
