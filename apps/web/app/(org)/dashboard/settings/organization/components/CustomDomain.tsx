import { UpgradeModal } from "@/components/UpgradeModal";
import { Button } from "@cap/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useDashboardContext } from "../../../Contexts";
import CustomDomainDialog from "./CustomDomainDialog/CustomDomainDialog";
import { removeOrganizationDomain } from "@/actions/organization/remove-domain";
import { toast } from "sonner";
import { CheckCircle, XCircle } from "lucide-react";



export function CustomDomain() {
  const router = useRouter();
  const { activeOrganization, isSubscribed } = useDashboardContext();
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);
  const [showCustomDomainDialog, setShowCustomDomainDialog] = useState(false);
  const [isVerified, setIsVerified] = useState(
    !!activeOrganization?.organization.domainVerified
  );
  const [loading, setLoading] = useState(false);

  const orgCustomDomain = activeOrganization?.organization.customDomain


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

  return (
    <>
    {
      showCustomDomainDialog && (
        <CustomDomainDialog
          isVerified={isVerified}
          setIsVerified={setIsVerified}
          open={showCustomDomainDialog}
          setShowUpgradeModal={(arg) => setShowUpgradeModal(arg)}
          onClose={() => setShowCustomDomainDialog(false)}
        />
      )
    }
      <div className="flex gap-3 justify-between items-center w-full h-fit">
        <div className="space-y-1">
          <h1 className="text-sm font-medium text-gray-12">Custom Domain</h1>
          <p className="text-sm w-full max-w-[375px] text-gray-10">
            Set up a custom domain for your organization's shared caps and make
            it unique.
          </p>
          {isVerified && orgCustomDomain ? (
            <div className="pt-4">
              <div className="flex gap-2 items-center px-3 py-1 text-sm bg-green-900 rounded-full w-fit">
                <CheckCircle className="text-green-200 size-3" />
                <p className="text-xs italic font-medium text-white">{orgCustomDomain}
                  <span className="ml-1 not-italic text-white/60">verified</span></p>
              </div>
            </div>
          ) : orgCustomDomain ? (
            <div className="pt-4">
              <div className="flex gap-2 items-center px-3 py-1 text-sm bg-red-900 rounded-full w-fit">
                <XCircle className="text-red-200 size-3" />
                <p className="text-xs italic font-medium text-white">{orgCustomDomain}
                  <span className="ml-1 not-italic text-white/60">not verified</span></p>
              </div>
            </div>
          ) : null}
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
