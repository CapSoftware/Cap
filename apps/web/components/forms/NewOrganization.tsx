"use client";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";

import {
  Form,
  FormControl,
  FormField,
  Input,
  CardDescription,
  Label,
} from "@cap/ui";
import { useForm } from "react-hook-form";
import { createOrganization } from "./server";
import { useState } from "react";
import { toast } from "sonner";
import { FileInput } from "@/components/FileInput";

export interface NewOrganizationProps {
  onOrganizationCreated: () => void;
  formRef?: React.RefObject<HTMLFormElement>;
  setCreateLoading?: React.Dispatch<React.SetStateAction<boolean>>;
  onNameChange?: (name: string) => void;
}

export const NewOrganization: React.FC<NewOrganizationProps> = (props) => {
  const formSchema = z.object({
    name: z.string().min(1),
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
            props.setCreateLoading?.(true);

            // Create FormData to send both the organization name and icon file
            const formData = new FormData();
            formData.append("name", values.name);

            // Add the icon file if one was selected
            if (selectedFile) {
              formData.append("icon", selectedFile);
              setIsUploading(true);
            }

            await createOrganization(formData);
            props.onOrganizationCreated();
          } catch (error) {
            console.error("Error creating organization:", error);
            error instanceof Error ? toast.error(error.message) : toast.error("Failed to create organization");
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
                  placeholder="Your organization name"
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
            <Label htmlFor="icon">Organization Icon</Label>
            <CardDescription className="w-full max-w-[400px]">
              Upload a custom logo or icon for your organization.
            </CardDescription>
          </div>

          <div className="relative mt-2">
            <FileInput
              id="icon"
              name="icon"
              notDraggingClassName="hover:bg-gray-3"
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
