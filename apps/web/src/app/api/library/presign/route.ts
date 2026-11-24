import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { NextResponse } from "next/server";
import { getR2Client, R2_BUCKET, R2_PUBLIC_URL } from "@/lib/r2";
import { randomUUID } from "crypto";

export async function POST(req: Request) {
	try {
		const { filename, mimeType } = (await req.json()) as {
			filename: string;
			mimeType: string;
		};

		if (!filename || !mimeType) {
			return NextResponse.json(
				{ error: "filename and mimeType are required" },
				{ status: 400 },
			);
		}

		const ext = filename.split(".").pop() ?? "";
		const key = `library/${randomUUID()}${ext ? `.${ext}` : ""}`;

		const client = getR2Client();
		const command = new PutObjectCommand({
			Bucket: R2_BUCKET,
			Key: key,
			ContentType: mimeType,
		});

		const uploadUrl = await getSignedUrl(client, command, { expiresIn: 3600 });
		const publicUrl = `${R2_PUBLIC_URL}/${key}`;

		return NextResponse.json({ uploadUrl, key, publicUrl });
	} catch (err) {
		console.error("[library/presign]", err);
		return NextResponse.json({ error: "Failed to generate upload URL" }, { status: 500 });
	}
}
