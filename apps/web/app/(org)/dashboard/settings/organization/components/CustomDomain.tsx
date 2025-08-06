import { UpgradeModal } from "@/components/UpgradeModal";
import { Button, Label } from "@cap/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useDashboardContext } from "../../../Contexts";
import CustomDomainDialog from "./CustomDomainDialog/CustomDomainDialog";




export function CustomDomain() {
  const router = useRouter();
  const { activeOrganization, isSubscribed } = useDashboardContext();
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);
  const [showCustomDomainDialog, setShowCustomDomainDialog] = useState(false);



  // const handleRemoveDomain = async () => {
  //   if (!isSubscribed) {
  //     setShowUpgradeModal(true);
  //     return;
  //   }

  //   if (!confirm("Are you sure you want to remove this custom domain?")) return;

  //   setLoading(true);
  //   try {
  //     await removeOrganizationDomain(
  //       activeOrganization?.organization.id as string
  //     );

  //     if (pollInterval.current) {
  //       clearInterval(pollInterval.current);
  //       pollInterval.current = undefined;
  //     }

  //     setIsVerified(false);
  //     toast.success("Custom domain removed");
  //     router.refresh();
  //   } catch (error) {
  //     toast.error("Failed to remove domain");
  //   } finally {
  //     setLoading(false);
  //   }
  // };


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
        </div>
        <Button
          type="submit"
          size="sm"
          className="min-w-fit"
          variant="dark"
          onClick={(e) => {
            e.preventDefault();
            setShowCustomDomainDialog(true);
          }}
        >
          Setup
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
