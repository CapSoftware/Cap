import { createS3Client, getS3Bucket } from "@/utils/s3";
import { CompleteMultipartUploadCommand, HeadObjectCommand, CopyObjectCommand } from "@aws-sdk/client-s3";
import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { s3Buckets } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { clientEnv } from "@cap/env";

export async function POST(request: NextRequest) {
  try {
    const { fileKey, uploadId, parts } = await request.json();

    if (!fileKey || !uploadId || !parts || !Array.isArray(parts)) {
      return Response.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    const token = request.headers.get("authorization")?.split(" ")[1];
    if (token) {
      cookies().set({
        name: "next-auth.session-token",
        value: token,
        path: "/",
        sameSite: "none",
        secure: true,
        httpOnly: true,
      });
    }

    const user = await getCurrentUser();
    if (!user) {
      return Response.json({ error: true }, { status: 401 });
    }

    try {
      const [bucket] = await db
        .select()
        .from(s3Buckets)
        .where(eq(s3Buckets.ownerId, user.id));

      const s3Config = bucket
        ? {
            endpoint: bucket.endpoint || undefined,
            region: bucket.region,
            accessKeyId: bucket.accessKeyId,
            secretAccessKey: bucket.secretAccessKey,
            forcePathStyle: true,
          }
        : null;

      const s3Client = await createS3Client(s3Config);
      const bucketName = await getS3Bucket(bucket);

      console.log(`Completing multipart upload ${uploadId} with ${parts.length} parts for key: ${fileKey}`);
      
      let totalSize = 0;
      parts.forEach(part => {
        const size = part.Size || 0;
        totalSize += parseInt(size, 10);
        console.log(`Part ${part.PartNumber}: ETag ${part.ETag}, Size: ${size || 'unknown'}`);
      });
      console.log(`Total size of all parts: ${totalSize} bytes`);

      const sortedParts = [...parts].sort((a, b) => {
        const partA = typeof a.PartNumber === 'number' ? a.PartNumber : parseInt(a.PartNumber, 10);
        const partB = typeof b.PartNumber === 'number' ? b.PartNumber : parseInt(b.PartNumber, 10);
        return partA - partB;
      });
      
      console.log('Parts after sorting:');
      let sortedTotalSize = 0;
      sortedParts.forEach(part => {
        const size = part.Size || 0;
        sortedTotalSize += parseInt(size, 10);
        console.log(`Part ${part.PartNumber}: ETag ${part.ETag}, Size: ${size || 'unknown'}`);
      });
      console.log(`Total size after sorting: ${sortedTotalSize} bytes`);
      
      const sequentialCheck = sortedParts.every((part, index) => {
        const partNumber = typeof part.PartNumber === 'number' ? part.PartNumber : parseInt(part.PartNumber, 10);
        return partNumber === index + 1;
      });
      
      if (!sequentialCheck) {
        console.warn("WARNING: Part numbers are not sequential! This may cause issues with the assembled file.");
      }
      
      const formattedParts = sortedParts.map(part => ({
        PartNumber: typeof part.PartNumber === 'number' ? part.PartNumber : parseInt(part.PartNumber, 10),
        ETag: part.ETag
      }));

      console.log('Sending to S3:', JSON.stringify({
        Bucket: bucketName,
        Key: fileKey, 
        UploadId: uploadId,
        Parts: formattedParts
      }, null, 2));

      const command = new CompleteMultipartUploadCommand({
        Bucket: bucketName,
        Key: fileKey,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: formattedParts,
        },
      });

      try {
        const result = await s3Client.send(command);
        console.log(`Multipart upload completed successfully: ${result.Location || 'no location'}`);
        console.log(`Complete response: ${JSON.stringify(result, null, 2)}`);
        
        try {
          console.log("Performing metadata fix by copying the object to itself...");
          const copyCommand = new CopyObjectCommand({
            Bucket: bucketName,
            CopySource: `${bucketName}/${fileKey}`,
            Key: fileKey,
            ContentType: "video/mp4",
            MetadataDirective: "REPLACE"
          });
          
          const copyResult = await s3Client.send(copyCommand);
          console.log("Copy for metadata fix successful:", copyResult);
        } catch (copyError) {
          console.error("Warning: Failed to copy object to fix metadata:", copyError);
        }
        
        try {
          const headCommand = new HeadObjectCommand({
            Bucket: bucketName,
            Key: fileKey
          });
          
          const headResult = await s3Client.send(headCommand);
          console.log(`Object verification successful: ContentType=${headResult.ContentType}, ContentLength=${headResult.ContentLength}`);
        } catch (headError) {
          console.error(`Warning: Unable to verify object: ${headError}`);
        }

        const videoId = fileKey.split("/")[1];
        if (videoId) {
          try {
            await fetch(`${clientEnv.NEXT_PUBLIC_WEB_URL}/api/revalidate`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ videoId }),
            });
            console.log(`Revalidation triggered for videoId: ${videoId}`);
          } catch (revalidateError) {
            console.error("Failed to revalidate page:", revalidateError);
          }
        }

        return Response.json({ 
          location: result.Location,
          success: true,
          fileKey,
          bucketName
        });
      } catch (completeError) {
        console.error("Failed to complete multipart upload:", completeError);
        return Response.json({ 
          error: "Failed to complete multipart upload",
          details: completeError instanceof Error ? completeError.message : String(completeError),
          uploadId, 
          fileKey,
          parts: formattedParts.length
        }, { status: 500 });
      }
    } catch (s3Error) {
      console.error("S3 operation failed:", s3Error);
      throw new Error(
        `S3 operation failed: ${
          s3Error instanceof Error ? s3Error.message : "Unknown error"
        }`
      );
    }
  } catch (error) {
    console.error("Error completing multipart upload", error);
    return Response.json(
      {
        error: "Error completing multipart upload",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
} 