'use server'

import { revalidatePath } from 'next/cache'
import { db } from "@cap/database"
import { getCurrentUser } from "@cap/database/auth/session"
import { sharedVideos, videos, spaces, organizationMembers, organizations } from "@cap/database/schema"
import { eq, and, inArray, or } from "drizzle-orm"
import { nanoId } from "@cap/database/helpers"

interface ShareCapParams {
  capId: string
  spaceIds: string[]
}

export async function shareCap({ capId, spaceIds }: ShareCapParams) {
  try {
    console.log(`Starting share operation for cap ${capId} with spaces:`, spaceIds)
    
    const user = await getCurrentUser()
    if (!user) {
      console.log('Unauthorized: No user found')
      return { success: false, error: "Unauthorized" }
    }
    console.log(`User authenticated: ${user.id}`)

    const [cap] = await db().select().from(videos).where(eq(videos.id, capId))
    if (!cap || cap.ownerId !== user.id) {
      console.log(`Unauthorized: Cap ${capId} not found or user ${user.id} is not owner`)
      return { success: false, error: "Unauthorized" }
    }
    console.log(`Cap found and user is owner: ${capId}`)

    const userOrganizations = await db()
      .select({
        organizationId: organizationMembers.organizationId,
      })
      .from(organizationMembers)
      .where(eq(organizationMembers.userId, user.id))
    
    const userOrganizationIds = userOrganizations.map(org => org.organizationId)
    console.log(`User has access to ${userOrganizationIds.length} organizations`)

    // Check if any of the spaceIds are actually organization IDs (for "All [Organization]" spaces)
    const directOrgIds = await db()
      .select()
      .from(organizations)
      .where(
        and(
          inArray(organizations.id, spaceIds),
          inArray(organizations.id, userOrganizationIds)
        )
      )
      .then(orgs => orgs.map(org => org.id))
    
    console.log(`Found ${directOrgIds.length} organization IDs in the space IDs`)

    // Find valid spaces from the spaceIds
    const spacesData = await db()
      .select()
      .from(spaces)
      .where(
        and(
          inArray(spaces.id, spaceIds),
          inArray(spaces.organizationId, userOrganizationIds)
        )
      )
    console.log(`Found ${spacesData.length} valid spaces`)

    // Combine organization IDs from both sources
    const orgIdsFromSpaces = [...new Set(spacesData.map(space => space.organizationId))]
    const organizationIds = [...new Set([...directOrgIds, ...orgIdsFromSpaces])]
    console.log(`Unique organization IDs for sharing:`, organizationIds)

    const currentSharedOrganizations = await db()
      .select()
      .from(sharedVideos)
      .where(eq(sharedVideos.videoId, capId))
    console.log(`Current shared organizations:`, currentSharedOrganizations)

    for (const sharedOrganization of currentSharedOrganizations) {
      if (!organizationIds.includes(sharedOrganization.organizationId)) {
        console.log(`Removing share from organization ${sharedOrganization.organizationId}`)
        await db()
          .delete(sharedVideos)
          .where(
            and(
              eq(sharedVideos.videoId, capId),
              eq(sharedVideos.organizationId, sharedOrganization.organizationId)
            )
          )
      }
    }

    for (const organizationId of organizationIds) {
      const existingShare = currentSharedOrganizations.find(
        (share) => share.organizationId === organizationId
      )
      if (!existingShare) {
        console.log(`Adding new share for organization ${organizationId}`)
        await db().insert(sharedVideos).values({
          id: nanoId(),
          videoId: capId,
          organizationId: organizationId,
          sharedByUserId: user.id,
        })
      }
    }
    
    console.log('Revalidating paths')
    revalidatePath('/dashboard/caps')
    revalidatePath(`/dashboard/caps/${capId}`)
    
    console.log('Share operation completed successfully')
    return { success: true }
  } catch (error) {
    console.error('Error sharing cap:', error)
    return { success: false, error: 'Failed to update sharing settings' }
  }
}