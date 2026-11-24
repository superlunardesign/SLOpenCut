import { NextResponse } from "next/server";
import { d1Query } from "@/lib/d1";
import { randomUUID } from "crypto";

export interface LibraryAsset {
	id: string;
	name: string;
	folder: string;
	type: string;
	mime_type: string;
	size_bytes: number;
	r2_key: string;
	url: string;
	width: number | null;
	height: number | null;
	duration_seconds: number | null;
	created_at: string;
}

export async function GET(req: Request) {
	try {
		const { searchParams } = new URL(req.url);
		const folder = searchParams.get("folder");
		const type = searchParams.get("type");

		let sql =
			"SELECT * FROM library_assets WHERE 1=1";
		const params: (string | number | null)[] = [];

		if (folder) {
			sql += " AND folder = ?";
			params.push(folder);
		}
		if (type) {
			sql += " AND type = ?";
			params.push(type);
		}
		sql += " ORDER BY created_at DESC";

		const assets = await d1Query<LibraryAsset>(sql, params);
		return NextResponse.json({ assets });
	} catch (err) {
		console.error("[library/assets GET]", err);
		return NextResponse.json({ error: "Failed to list assets" }, { status: 500 });
	}
}

export async function POST(req: Request) {
	try {
		const body = (await req.json()) as Omit<LibraryAsset, "id" | "created_at">;
		const id = randomUUID();

		await d1Query(
			`INSERT INTO library_assets
        (id, name, folder, type, mime_type, size_bytes, r2_key, url, width, height, duration_seconds)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				body.name,
				body.folder ?? "Uncategorized",
				body.type,
				body.mime_type,
				body.size_bytes,
				body.r2_key,
				body.url,
				body.width ?? null,
				body.height ?? null,
				body.duration_seconds ?? null,
			],
		);

		return NextResponse.json({ id });
	} catch (err) {
		console.error("[library/assets POST]", err);
		return NextResponse.json({ error: "Failed to save asset" }, { status: 500 });
	}
}
