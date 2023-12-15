"use client";
import { useRouter } from "next/navigation";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";

import { Button } from "ui";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "ui";
import { Input } from "ui";
import { useForm } from "react-hook-form";
import { useSupabase } from "@/utils/database/supabase/provider";
import { useState } from "react";

export function NewSpace() {
  const { supabase } = useSupabase();
  const [isLoading, setIsLoading] = useState(false);
  const { replace } = useRouter();

  const formSchema = z.object({
    name: z.string().min(1),
  });

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
  });

  async function onSubmit(values: z.infer<typeof formSchema>) {
    setIsLoading(true);

    const { name } = values;

    const session = await supabase.auth.getSession();
    const userId = session.data?.session ? session.data.session.user.id : null;

    if (!userId) {
      alert("You must be logged in to create a space.");
      setIsLoading(false);
      return;
    }

    console.log("userId:");
    console.log(userId);

    console.log("session:");
    console.log(session);

    const { error } = await supabase
      .from("spaces")
      .insert([{ name, owner_id: userId }]);

    if (error) {
      alert(error.message);
    } else {
      window.location.href = "/dashboard";
    }
    setIsLoading(false);
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)}>
        <div className="space-y-4 mb-8">
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Name</FormLabel>
                <FormControl>
                  <Input placeholder="Your space name" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
        <Button type="submit" disabled={isLoading}>
          {isLoading ? "Loading..." : "Create Space"}
        </Button>
      </form>
    </Form>
  );
}
