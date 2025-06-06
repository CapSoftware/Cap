"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { spaces } from "@cap/database/schema";
import { nanoId } from "@cap/database/helpers";
import { revalidatePath } from "next/cache";

interface CreateSpaceResponse {
  success: boolean;
  spaceId?: string;
  name?: string;
  iconUrl?: string | null;
  error?: string;
}

export async function createSpace(formData: FormData): Promise<CreateSpaceResponse> {
  try {
    const user = await getCurrentUser();

    if (!user || !user.activeOrganizationId) {
      return { 
        success: false, 
        error: "User not logged in or no active organization" 
      };
    }

    const name = formData.get('name') as string;
    
    if (!name) {
      return { 
        success: false, 
        error: "Space name is required" 
      };
    }

    const iconFile = formData.get('icon') as File | null;
    let iconUrl = null;

    if (iconFile) {
      iconUrl = `/images/spaces/${Date.now()}-${iconFile.name}`;
      
    }

    const spaceId = nanoId();
    
    await db()
      .insert(spaces)
      .values({
        id: spaceId,
        name,
        organizationId: user.activeOrganizationId,
        createdById: user.id,
        description: iconUrl ? `Space with custom icon: ${iconUrl}` : null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

    revalidatePath('/dashboard');
    
    return { 
      success: true,
      spaceId,
      name,
      iconUrl
    };
  } catch (error) {
    console.error("Error creating space:", error);
    return { 
      success: false, 
      error: "Failed to create space" 
    };
  }
} 