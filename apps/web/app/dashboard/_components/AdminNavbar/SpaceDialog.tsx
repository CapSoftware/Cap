"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Form,
  FormControl,
  FormField,
  Input,
  CardDescription,
  DialogFooter,
  Button,
  Label,
} from "@cap/ui";
import { useForm } from "react-hook-form";
import { useState, useRef } from "react";
import { toast } from "sonner";
import { FileInput } from "@/components/FileInput";
import { createSpace } from "./server";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faLayerGroup } from "@fortawesome/free-solid-svg-icons";

interface SpaceDialogProps {
  open: boolean;
  onClose: () => void;
}

export const SpaceDialog = ({ open, onClose }: SpaceDialogProps) => {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const formRef = useRef<HTMLFormElement | null>(null);
  const [spaceName, setSpaceName] = useState("");

  return (
    <Dialog open={open} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="p-0 w-full max-w-md rounded-xl border bg-gray-2 border-gray-4">
        <DialogHeader
          icon={<FontAwesomeIcon icon={faLayerGroup} />}
          description="A new space for your team to collaborate"
        >
          <DialogTitle className="text-lg text-gray-12">
            Create New Space
          </DialogTitle>
        </DialogHeader>
        <div className="p-5">
          <NewSpaceForm
            formRef={formRef}
            setCreateLoading={setIsSubmitting}
            onSpaceCreated={onClose}
            onNameChange={setSpaceName}
          />
        </div>
        <DialogFooter>
          <Button variant="gray" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="dark"
            size="sm"
            disabled={isSubmitting || !spaceName.trim().length}
            spinner={isSubmitting}
            onClick={() => formRef.current?.requestSubmit()}
            type="submit"
          >
            {isSubmitting ? "Creating..." : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export interface NewSpaceFormProps {
  onSpaceCreated: () => void;
  formRef?: React.RefObject<HTMLFormElement>;
  setCreateLoading?: React.Dispatch<React.SetStateAction<boolean>>;
  onNameChange?: (name: string) => void;
}

export const NewSpaceForm: React.FC<NewSpaceFormProps> = (props) => {
  const formSchema = z.object({
    name: z
      .string()
      .min(1, "Space name is required")
      .max(25, "Space name must be at most 25 characters"),
  });

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: "",
    },
  });

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  return (
    <Form {...form}>
      <form
        className="space-y-4"
        ref={props.formRef}
        onSubmit={form.handleSubmit(async (values) => {
          try {
            setIsUploading(true);
            props.setCreateLoading?.(true);

            const formData = new FormData();
            formData.append("name", values.name);

            if (selectedFile) {
              formData.append("icon", selectedFile);
            }

            await createSpace(formData);
            toast.success("Space created successfully");
            form.reset();
            setSelectedFile(null);
            props.onSpaceCreated();
          } catch (error) {
            console.error("Error creating space:", error);
            toast.error("Failed to create space");
          } finally {
            setIsUploading(false);
            props.setCreateLoading?.(false);
          }
        })}
      >
        <div className="space-y-4">
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormControl>
                <Input
                  placeholder="Space name"
                  maxLength={25}
                  {...field}
                  onChange={(e) => {
                    field.onChange(e);
                    props.onNameChange?.(e.target.value);
                  }}
                />
              </FormControl>
            )}
          />

          <div className="space-y-1">
            <Label htmlFor="icon">Space Icon</Label>
            <CardDescription className="w-full max-w-[400px]">
              Upload a custom logo or icon for your space.
            </CardDescription>
          </div>

          <div className="relative mt-2">
            <FileInput
              id="icon"
              name="icon"
              onChange={setSelectedFile}
              disabled={isUploading}
              isLoading={isUploading}
            />
          </div>
        </div>
      </form>
    </Form>
  );
};

export default SpaceDialog;
