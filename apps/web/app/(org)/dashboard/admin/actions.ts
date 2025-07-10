"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { users, videos } from "@cap/database/schema";
import { eq, gte, and, sql, isNotNull, or, lte } from "drizzle-orm";
import { stripe } from "@cap/utils";

export type DateRange = "today" | "yesterday" | "last7days" | "thisMonth" | "allTime";

export function getDateRangeFilter(range: DateRange): { start: Date; end: Date } {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  
  switch (range) {
    case "today":
      return {
        start: today,
        end: new Date(today.getTime() + 24 * 60 * 60 * 1000)
      };
    case "yesterday":
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      return {
        start: yesterday,
        end: today
      };
    case "last7days":
      const last7Days = new Date(today);
      last7Days.setDate(last7Days.getDate() - 7);
      return {
        start: last7Days,
        end: new Date(today.getTime() + 24 * 60 * 60 * 1000)
      };
    case "thisMonth":
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      return {
        start: monthStart,
        end: monthEnd
      };
    case "allTime":
      return {
        start: new Date(0),
        end: new Date()
      };
  }
}

export async function lookupUserById(data: FormData) {
  const currentUser = await getCurrentUser();
  if (!currentUser?.email.endsWith("@cap.so")) return;

  const [user] = await db()
    .select()
    .from(users)
    .where(eq(users.id, data.get("id") as string));

  return user;
}

export async function getUsersCreatedToday() {
  const currentUser = await getCurrentUser();
  if (!currentUser?.email.endsWith("@cap.so")) return null;

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const result = await db()
    .select({ count: sql<number>`count(*)` })
    .from(users)
    .where(gte(users.created_at, startOfToday));

  return result[0]?.count || 0;
}

export async function getUsersCreatedInRange(dateRange: DateRange) {
  const currentUser = await getCurrentUser();
  if (!currentUser?.email.endsWith("@cap.so")) return null;

  const { start, end } = getDateRangeFilter(dateRange);

  const result = await db()
    .select({ count: sql<number>`count(*)` })
    .from(users)
    .where(
      and(
        gte(users.created_at, start),
        lte(users.created_at, end)
      )
    );

  return result[0]?.count || 0;
}

export async function getPaidUsersStats() {
  const currentUser = await getCurrentUser();
  if (!currentUser?.email.endsWith("@cap.so")) return null;

  // Get all users with active subscriptions (including third-party)
  const paidUsers = await db()
    .select({
      id: users.id,
      email: users.email,
      stripeCustomerId: users.stripeCustomerId,
      stripeSubscriptionStatus: users.stripeSubscriptionStatus,
      stripeSubscriptionId: users.stripeSubscriptionId,
      thirdPartyStripeSubscriptionId: users.thirdPartyStripeSubscriptionId,
      created_at: users.created_at,
    })
    .from(users)
    .where(
      or(
        and(
          isNotNull(users.stripeSubscriptionId),
          or(
            eq(users.stripeSubscriptionStatus, "active"),
            eq(users.stripeSubscriptionStatus, "trialing")
          )
        ),
        isNotNull(users.thirdPartyStripeSubscriptionId)
      )
    );

  // For each paid user, check if they created videos before subscribing
  const paidUsersWithVideoCheck = await Promise.all(
    paidUsers.map(async (user) => {
      // Get subscription start date from Stripe
      let subscriptionStartDate: Date | null = null;
      
      if (user.stripeCustomerId && user.stripeSubscriptionId && !user.thirdPartyStripeSubscriptionId) {
        try {
          const subscription = await stripe().subscriptions.retrieve(
            user.stripeSubscriptionId
          );
          subscriptionStartDate = new Date(subscription.created * 1000);
        } catch (error) {
          console.error(`Failed to fetch subscription for user ${user.id}:`, error);
          // For third-party subscriptions or errors, assume they subscribed when first video was created
          const firstVideo = await db()
            .select({ createdAt: videos.createdAt })
            .from(videos)
            .where(eq(videos.ownerId, user.id))
            .orderBy(videos.createdAt)
            .limit(1);
          
          if (firstVideo[0]) {
            // Add 1 day to first video as a conservative estimate
            subscriptionStartDate = new Date(firstVideo[0].createdAt);
            subscriptionStartDate.setDate(subscriptionStartDate.getDate() + 1);
          }
        }
      } else if (user.thirdPartyStripeSubscriptionId) {
        // For third-party subscriptions, we can't get the exact date from Stripe
        // So we'll use a conservative approach: assume they subscribed after their first video
        const firstVideo = await db()
          .select({ createdAt: videos.createdAt })
          .from(videos)
          .where(eq(videos.ownerId, user.id))
          .orderBy(videos.createdAt)
          .limit(1);
        
        if (firstVideo[0]) {
          // Add 1 day to first video as a conservative estimate
          subscriptionStartDate = new Date(firstVideo[0].createdAt);
          subscriptionStartDate.setDate(subscriptionStartDate.getDate() + 1);
        }
      }

      // Check if user created videos before subscription
      let createdVideoBeforeSubscription = false;
      if (subscriptionStartDate) {
        const videosBeforeSubscription = await db()
          .select({ count: sql<number>`count(*)` })
          .from(videos)
          .where(
            and(
              eq(videos.ownerId, user.id),
              sql`${videos.createdAt} < ${subscriptionStartDate}`
            )
          );
        
        createdVideoBeforeSubscription = (videosBeforeSubscription[0]?.count || 0) > 0;
      }

      return {
        ...user,
        subscriptionStartDate,
        createdVideoBeforeSubscription,
      };
    })
  );

  const totalPaidUsers = paidUsersWithVideoCheck.length;
  const usersWhoCreatedVideoFirst = paidUsersWithVideoCheck.filter(
    (user) => user.createdVideoBeforeSubscription
  ).length;

  const percentage = totalPaidUsers > 0 
    ? Math.round((usersWhoCreatedVideoFirst / totalPaidUsers) * 100) 
    : 0;

  return {
    totalPaidUsers,
    usersWhoCreatedVideoFirst,
    percentage,
  };
}

export async function getPaidUsersStatsInRange(dateRange: DateRange) {
  const currentUser = await getCurrentUser();
  if (!currentUser?.email.endsWith("@cap.so")) return null;

  const { start, end } = getDateRangeFilter(dateRange);

  // Get all users with active subscriptions created in the date range
  const paidUsers = await db()
    .select({
      id: users.id,
      email: users.email,
      stripeCustomerId: users.stripeCustomerId,
      stripeSubscriptionStatus: users.stripeSubscriptionStatus,
      stripeSubscriptionId: users.stripeSubscriptionId,
      thirdPartyStripeSubscriptionId: users.thirdPartyStripeSubscriptionId,
      created_at: users.created_at,
    })
    .from(users)
    .where(
      and(
        or(
          and(
            isNotNull(users.stripeSubscriptionId),
            or(
              eq(users.stripeSubscriptionStatus, "active"),
              eq(users.stripeSubscriptionStatus, "trialing")
            )
          ),
          isNotNull(users.thirdPartyStripeSubscriptionId)
        ),
        dateRange !== "allTime" ? and(
          gte(users.created_at, start),
          lte(users.created_at, end)
        ) : sql`1=1`
      )
    );

  // For each paid user, check if they created videos before subscribing
  const paidUsersWithVideoCheck = await Promise.all(
    paidUsers.map(async (user) => {
      // Get subscription start date from Stripe
      let subscriptionStartDate: Date | null = null;
      
      if (user.stripeCustomerId && user.stripeSubscriptionId && !user.thirdPartyStripeSubscriptionId) {
        try {
          const subscription = await stripe().subscriptions.retrieve(
            user.stripeSubscriptionId
          );
          subscriptionStartDate = new Date(subscription.created * 1000);
        } catch (error) {
          console.error(`Failed to fetch subscription for user ${user.id}:`, error);
          // For third-party subscriptions or errors, assume they subscribed when first video was created
          const firstVideo = await db()
            .select({ createdAt: videos.createdAt })
            .from(videos)
            .where(eq(videos.ownerId, user.id))
            .orderBy(videos.createdAt)
            .limit(1);
          
          if (firstVideo[0]) {
            // Add 1 day to first video as a conservative estimate
            subscriptionStartDate = new Date(firstVideo[0].createdAt);
            subscriptionStartDate.setDate(subscriptionStartDate.getDate() + 1);
          }
        }
      } else if (user.thirdPartyStripeSubscriptionId) {
        // For third-party subscriptions, we can't get the exact date from Stripe
        // So we'll use a conservative approach: assume they subscribed after their first video
        const firstVideo = await db()
          .select({ createdAt: videos.createdAt })
          .from(videos)
          .where(eq(videos.ownerId, user.id))
          .orderBy(videos.createdAt)
          .limit(1);
        
        if (firstVideo[0]) {
          // Add 1 day to first video as a conservative estimate
          subscriptionStartDate = new Date(firstVideo[0].createdAt);
          subscriptionStartDate.setDate(subscriptionStartDate.getDate() + 1);
        }
      }

      // Check if user created videos before subscription
      let createdVideoBeforeSubscription = false;
      if (subscriptionStartDate) {
        const videosBeforeSubscription = await db()
          .select({ count: sql<number>`count(*)` })
          .from(videos)
          .where(
            and(
              eq(videos.ownerId, user.id),
              sql`${videos.createdAt} < ${subscriptionStartDate}`
            )
          );
        
        createdVideoBeforeSubscription = (videosBeforeSubscription[0]?.count || 0) > 0;
      }

      return {
        ...user,
        subscriptionStartDate,
        createdVideoBeforeSubscription,
      };
    })
  );

  const totalPaidUsers = paidUsersWithVideoCheck.length;
  const usersWhoCreatedVideoFirst = paidUsersWithVideoCheck.filter(
    (user) => user.createdVideoBeforeSubscription
  ).length;

  const percentage = totalPaidUsers > 0 
    ? Math.round((usersWhoCreatedVideoFirst / totalPaidUsers) * 100) 
    : 0;

  return {
    totalPaidUsers,
    usersWhoCreatedVideoFirst,
    percentage,
  };
}
