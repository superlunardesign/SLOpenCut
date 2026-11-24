import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { NextResponse } from "next/server";
import { d1Query } from "@/lib/d1";
import { getR2Client, R2_BUCKET } from "@/lib/r2";
import type { LibraryAsset } from "../route";

export async function DELETE(
	_req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	try {
		const { id } = await params;

		const rows = await d1Query<LibraryAsset>(
			"SELECT r2_key FROM library_assets WHERE id = ?",
			[id],
		);

		if (!rows.length) {
			return NextResponse.json({ error: "Asset not found" }, { status: 404 });
		}

		const { r2_key } = rows[0];

		// Delete from R2 first, then remove metadata
		const client = getR2Client();
		await client.send(
			new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: r2_key }),
		);

		await d1Query("DELETE FROM library_assets WHERE id = ?", [id]);

		return NextResponse.json({ ok: true });
	} catch (err) {
		console.error("[library/assets DELETE]", err);
		return NextResponse.json({ error: "Failed to delete asset" }, { status: 500 });
	}
}
