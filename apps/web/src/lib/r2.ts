import { S3Client } from "@aws-sdk/client-s3";

export function getR2Client() {
	const accountId = process.env.R2_ACCOUNT_ID;
	const accessKeyId = process.env.R2_ACCESS_KEY_ID;
	const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

	if (!accountId || !accessKeyId || !secretAccessKey) {
		throw new Error("Missing R2 environment variables");
	}

	return new S3Client({
		region: "auto",
		endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
		credentials: { accessKeyId, secretAccessKey },
	});
}

export const R2_BUCKET = process.env.R2_BUCKET_NAME ?? "slopencut";
export const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL ?? "";
