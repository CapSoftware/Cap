import { UpgradeModal } from "@/components/UpgradeModal";
import { Button, Label } from "@cap/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useDashboardContext } from "../../../Contexts";
import CustomDomainDialog from "./CustomDomainDialog/CustomDomainDialog";
import { removeOrganizationDomain } from "@/actions/organization/remove-domain";
import { toast } from "sonner";



export function CustomDomain() {
  const router = useRouter();
  const { activeOrganization, isSubscribed } = useDashboardContext();
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);
  const [showCustomDomainDialog, setShowCustomDomainDialog] = useState(false);
  const [isVerified, setIsVerified] = useState(
    !!activeOrganization?.organization.domainVerified
  );
  const [loading, setLoading] = useState(false);


  const handleRemoveDomain = async () => {
    if (!isSubscribed) {
      setShowUpgradeModal(true);
      return;
    }

    if (!confirm("Are you sure you want to remove this custom domain?")) return;
    setLoading(true);
    try {
      await removeOrganizationDomain(
        activeOrganization?.organization.id as string
      );

      setIsVerified(false);
      toast.success("Custom domain removed");
      router.refresh();
    } catch (error) {
      toast.error("Failed to remove domain");
    } finally {
      setLoading(false);
    }
  };

  const domainVerifiedCheck = activeOrganization?.organization.customDomain


  return (
    <>
      <CustomDomainDialog
        open={showCustomDomainDialog}
        onClose={() => setShowCustomDomainDialog(false)}
      />
      <div className="flex gap-3 justify-between items-center w-full h-fit">
        <div className="space-y-1">
          <Label htmlFor="customDomain">Custom Domain</Label>
          <p className="text-sm w-full max-w-[375px] text-gray-10">
            Set up a custom domain for your organization's shared caps and make
            it unique.
          </p>
          <div>
            <p className="text-sm text-gray-10">{activeOrganization?.organization.customDomain}</p>
          </div>
        </div>
        <Button
          type="submit"
          size="sm"
          className="min-w-fit"
          spinner={loading}
          disabled={loading}
          variant="dark"
          onClick={async (e) => {
            e.preventDefault();
            if (isVerified) {
              await handleRemoveDomain();
            } else {
              setShowCustomDomainDialog(true);
            }
          }}
        >
          {isVerified ? "Remove" : "Setup"}
        </Button>
      </div>

      {showUpgradeModal && (
        <UpgradeModal
          open={showUpgradeModal}
          onOpenChange={setShowUpgradeModal}
        />
      )}
    </>
  );
}
