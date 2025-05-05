"use client";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";

import {
  Form,
  FormControl,
  FormField,
  Input,
} from "@cap/ui";
import { useForm } from "react-hook-form";
import { createOrganization } from "./server";

export interface NewOrganizationProps {
  onOrganizationCreated: () => void;
  formRef?: React.Dispatch<React.SetStateAction<HTMLFormElement | null>>;
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

  return (
    <Form {...form}>
      <form
        className="space-y-4"
        ref={props.formRef ? (form) => props.formRef?.(form) : undefined}
        onSubmit={form.handleSubmit(async (values) => {
          try {
            await createOrganization(values);
            props.onOrganizationCreated();
          } catch (error) {
            console.error("Error creating organization:", error);
          }
        })}
      >
        <div className="space-y-4">
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormControl>
                <Input required placeholder="Your organization name" {...field} />
              </FormControl>
            )}
          />
        </div>
      </form>
    </Form>
  );
};
