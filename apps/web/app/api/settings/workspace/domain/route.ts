export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = 'force-no-store'

import { type NextRequest } from "next/server";
import { getCurrentUser } from "@cap/database/auth/session";
import { spaces } from "@cap/database/schema";
import { db } from "@cap/database";
import { eq } from "drizzle-orm";

const getConfigResponse = async (domain: string) => {
  console.log(`[Domain Config] Fetching config for domain: ${domain}`);
  const response = await fetch(
    `https://api.vercel.com/v6/domains/${domain.toLowerCase()}/config?teamId=${process.env.VERCEL_TEAM_ID}&strict=true`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${process.env.VERCEL_AUTH_TOKEN}`,
        "Content-Type": "application/json",
      },
      cache: "no-store"
    },
  ).then((res) => res.json());
  console.log(`[Domain Config] Response:`, response);
  return response;
};

const getDomainResponse = async (domain: string) => {
  console.log(`[Domain Status] Checking status for domain: ${domain}`);
  const response = await fetch(
    `https://api.vercel.com/v9/projects/${process.env.VERCEL_PROJECT_ID}/domains/${domain.toLowerCase()}?teamId=${process.env.VERCEL_TEAM_ID}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${process.env.VERCEL_AUTH_TOKEN}`,
        "Content-Type": "application/json",
      },
      cache: "no-store"
    },
  ).then((res) => res.json());
  console.log(`[Domain Status] Response:`, response);
  return response;
};

const verifyDomain = async (domain: string) => {
  console.log(`[Domain Verify] Verifying domain: ${domain}`);
  const response = await fetch(
    `https://api.vercel.com/v9/projects/${process.env.VERCEL_PROJECT_ID}/domains/${domain.toLowerCase()}/verify?teamId=${process.env.VERCEL_TEAM_ID}&strict=true`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.VERCEL_AUTH_TOKEN}`,
        "Content-Type": "application/json",
      },
    },
  ).then((res) => res.json());
  console.log(`[Domain Verify] Response:`, response);
  return response;
};

const addDomain = async (domain: string) => {
  console.log(`[Domain Add] Adding new domain: ${domain}`);
  const response = await fetch(
    `https://api.vercel.com/v9/projects/${process.env.VERCEL_PROJECT_ID}/domains?teamId=${process.env.VERCEL_TEAM_ID}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.VERCEL_AUTH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: domain }),
      cache: "no-store"
    },
  ).then((res) => res.json());
  console.log(`[Domain Add] Response:`, response);
  return response;
};

const getRequiredConfig = async (domain: string) => {
  console.log(`[Required Config] Fetching required config for domain: ${domain}`);
  const response = await fetch(
    `https://vercel.com/api/v6/domains/${domain.toLowerCase()}/config?strict=true&teamId=${process.env.VERCEL_TEAM_ID}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${process.env.VERCEL_AUTH_TOKEN}`,
        "Content-Type": "application/json",
      },
      cache: "no-store"
    },
  ).then((res) => res.json());
  console.log(`[Required Config] Response:`, response);
  return response;
};

async function checkDomainStatus(domain: string) {
  console.log(`[Domain Check] Checking domain status for: ${domain}`);
  try {
    const [domainJson, configJson, requiredConfigJson] = await Promise.all([
      getDomainResponse(domain),
      getConfigResponse(domain),
      getRequiredConfig(domain),
    ]);

    let verified = false;

    if (configJson.misconfigured || domainJson?.error?.code === "not_found") {
      verified = false;
    } else if (domainJson.verified) {
      verified = true;
    } else {
      const verificationJson = await verifyDomain(domain);
      verified = verificationJson && verificationJson.verified;
    }

    // Get the current and required A records
    const currentAValues = configJson.aValues || [];
    const requiredAValue = requiredConfigJson.aValues?.[0];

    return {
      verified,
      config: {
        ...configJson,
        verification: domainJson?.verification || [],
        currentAValues,
        requiredAValue
      },
      status: domainJson
    };
  } catch (error) {
    console.error('[Domain Check] Error checking domain status:', error);
    return {
      verified: false,
      error: "Failed to check domain status"
    };
  }
}

export async function POST(request: NextRequest) {
  console.log('[POST] Processing domain addition request');
  const user = await getCurrentUser();
  const { domain, spaceId } = await request.json();
  console.log(`[POST] Request details - Domain: ${domain}, SpaceId: ${spaceId}`);

  if (!user) {
    console.log('[POST] Unauthorized - No user found');
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [space] = await db.select().from(spaces).where(eq(spaces.id, spaceId));

  if (!space || space.ownerId !== user.id) {
    console.log('[POST] Unauthorized - Invalid space or ownership');
    return Response.json({ error: "Unauthorized" }, { status: 403 });
  }

  try {
    console.log(`[POST] Adding domain to Vercel: ${domain}`);
    const addDomainResponse = await addDomain(domain);
    
    if (addDomainResponse.error) {
      console.error('[POST] Error adding domain:', addDomainResponse.error);
      return Response.json({ error: addDomainResponse.error.message }, { status: 400 });
    }

    console.log(`[POST] Updating space with custom domain: ${domain}`);
    await db
      .update(spaces)
      .set({
        customDomain: domain,
        domainVerified: null,
      })
      .where(eq(spaces.id, spaceId));

    console.log('[POST] Checking domain verification status');
    const status = await checkDomainStatus(domain);

    if (status.verified) {
      console.log(`[POST] Domain verified, updating verification timestamp: ${domain}`);
      await db
        .update(spaces)
        .set({
          domainVerified: new Date(),
        })
        .where(eq(spaces.id, spaceId));
    }

    return Response.json(status);
  } catch (error) {
    console.error('[POST] Error in domain verification:', error);
    return Response.json(
      { error: "Failed to verify domain" },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  console.log('[DELETE] Processing domain removal request');
  const user = await getCurrentUser();
  const { spaceId } = await request.json();
  console.log(`[DELETE] Request details - SpaceId: ${spaceId}`);

  if (!user) {
    console.log('[DELETE] Unauthorized - No user found');
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [space] = await db.select().from(spaces).where(eq(spaces.id, spaceId));

  if (!space || space.ownerId !== user.id) {
    console.log('[DELETE] Unauthorized - Invalid space or ownership');
    return Response.json({ error: "Unauthorized" }, { status: 403 });
  }

  try {
    if (space.customDomain) {
      console.log(`[DELETE] Removing domain from Vercel: ${space.customDomain}`);
      await fetch(
        `https://api.vercel.com/v9/projects/${process.env.VERCEL_PROJECT_ID}/domains/${space.customDomain.toLowerCase()}?teamId=${process.env.VERCEL_TEAM_ID}`,
        {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${process.env.VERCEL_AUTH_TOKEN}`,
          },
        }
      );
    }

    console.log('[DELETE] Updating space to remove custom domain');
    await db
      .update(spaces)
      .set({
        customDomain: null,
        domainVerified: null,
      })
      .where(eq(spaces.id, spaceId));

    return Response.json({ success: true });
  } catch (error) {
    console.error('[DELETE] Error removing domain:', error);
    return Response.json(
      { error: "Failed to remove domain" },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  console.log('[GET] Processing domain status check request');
  const searchParams = request.nextUrl.searchParams;
  const spaceId = searchParams.get('spaceId');
  console.log(`[GET] Request details - SpaceId: ${spaceId}`);
  const user = await getCurrentUser();

  if (!user || !spaceId) {
    console.log('[GET] Unauthorized - No user or spaceId found');
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [space] = await db.select().from(spaces).where(eq(spaces.id, spaceId));

  if (!space || space.ownerId !== user.id) {
    console.log('[GET] Unauthorized - Invalid space or ownership');
    return Response.json({ error: "Unauthorized" }, { status: 403 });
  }

  if (!space.customDomain) {
    console.log('[GET] No custom domain set for space');
    return Response.json({ error: "No custom domain set" }, { status: 400 });
  }

  try {
    console.log(`[GET] Checking status for domain: ${space.customDomain}`);
    const status = await checkDomainStatus(space.customDomain);

    if (status.verified && !space.domainVerified) {
      console.log(`[GET] Updating domain verification timestamp: ${space.customDomain}`);
      await db
        .update(spaces)
        .set({
          domainVerified: new Date(),
        })
        .where(eq(spaces.id, spaceId));
    } else if (!status.verified && space.domainVerified) {
      console.log(`[GET] Removing domain verification timestamp: ${space.customDomain}`);
      await db
        .update(spaces)
        .set({
          domainVerified: null,
        })
        .where(eq(spaces.id, spaceId));
    }

    return Response.json(status);
  } catch (error) {
    console.error('[GET] Error checking domain status:', error);
    return Response.json(
      { error: "Failed to check domain status" },
      { status: 500 }
    );
  }
} 