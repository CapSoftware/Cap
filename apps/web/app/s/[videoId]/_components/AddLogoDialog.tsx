"use client";

import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@cap/ui";
import { Button, Input, Switch } from "@cap/ui";
import { useState } from "react";
import { editLogo } from "@/actions/videos/edit-logo";
import { toast } from "sonner";

interface AddLogoDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  videoId: string;
  organizationLogoUrl?: string | null;
  initialLogo?: {
    url?: string;
    width?: number;
    useOrganization?: boolean;
  } | null;
}

export const AddLogoDialog = ({
  open,
  onOpenChange,
  videoId,
  organizationLogoUrl,
  initialLogo,
}: AddLogoDialogProps) => {
  const [useOrg, setUseOrg] = useState(initialLogo?.useOrganization || false);
  const [url, setUrl] = useState(initialLogo?.url || "");
  const [width, setWidth] = useState(initialLogo?.width || 56);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      await editLogo(videoId, useOrg ? null : url, width, useOrg);
      toast.success("Logo updated");
      onOpenChange(false);
    } catch (err: any) {
      toast.error(err?.message || "Failed to update logo");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="p-0 w-full max-w-md rounded-xl border bg-gray-2 border-gray-4">
        <DialogHeader description="Customize the logo shown on this page">
          <DialogTitle>Add Custom Logo</DialogTitle>
        </DialogHeader>
        <div className="p-5 space-y-4">
          {organizationLogoUrl && (
            <div className="flex justify-between items-center">
              <span className="text-sm">Use workspace logo</span>
              <Switch checked={useOrg} onCheckedChange={setUseOrg} />
            </div>
          )}
          {!useOrg && (
            <Input
              placeholder="Logo URL"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          )}
          <div>
            <label className="text-sm">Width: {width}px</label>
            <input
              type="range"
              min={20}
              max={200}
              value={width}
              onChange={(e) => setWidth(Number(e.target.value))}
              className="w-full"
            />
          </div>
        </div>
        <DialogFooter>
          <Button size="sm" variant="gray" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="dark"
            onClick={handleSave}
            spinner={saving}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
