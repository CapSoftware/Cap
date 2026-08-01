import { recoverOrganizationInviteDeliveries } from "@/lib/organization-invite-delivery";

async function recoverOrganizationInviteDeliveriesStep() {
	"use step";
	return recoverOrganizationInviteDeliveries();
}
recoverOrganizationInviteDeliveriesStep.maxRetries = 4;

export async function recoverOrganizationInviteDeliveriesWorkflow() {
	"use workflow";
	return recoverOrganizationInviteDeliveriesStep();
}
