import { type NextRequest, NextResponse } from "next/server";
import { webEnv } from "@/env/web";

export const runtime = "nodejs";
export const maxDuration = 120;

interface CloudflareWhisperWord {
	word: string;
	start: number;
	end: number;
}

interface CloudflareWhisperSegment {
	text: string;
	start: number;
	end: number;
	words?: CloudflareWhisperWord[];
}

interface CloudflareWhisperResponse {
	text: string;
	segments?: CloudflareWhisperSegment[];
	words?: CloudflareWhisperWord[];
	word_count?: number;
}

export async function POST(request: NextRequest) {
	const accountId = webEnv.CLOUDFLARE_ACCOUNT_ID;
	const apiToken = webEnv.CLOUDFLARE_API_TOKEN;

	if (!accountId || !apiToken) {
		return NextResponse.json(
			{ error: "Cloudflare transcription is not configured" },
			{ status: 501 },
		);
	}

	let audioData: ArrayBuffer;
	try {
		audioData = await request.arrayBuffer();
	} catch {
		return NextResponse.json(
			{ error: "Failed to read audio data" },
			{ status: 400 },
		);
	}

	if (audioData.byteLength === 0) {
		return NextResponse.json({ error: "Empty audio data" }, { status: 400 });
	}

	const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/openai/whisper-large-v3-turbo`;

	// Cloudflare Workers AI REST API expects {"audio": [uint8 integers]}
	const audioBytes = Array.from(new Uint8Array(audioData));

	const response = await fetch(cfUrl, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiToken}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ audio: audioBytes }),
	});

	if (!response.ok) {
		const text = await response.text().catch(() => "unknown error");
		console.error(
			`Cloudflare Whisper ${response.status}:`,
			text.slice(0, 500),
			`| audio bytes: ${audioBytes.length}`,
		);
		return NextResponse.json(
			{ error: `Transcription failed: ${response.status} — ${text.slice(0, 200)}` },
			{ status: 502 },
		);
	}

	const cfResult = (await response.json()) as {
		result: CloudflareWhisperResponse;
		success: boolean;
	};

	if (!cfResult.success || !cfResult.result) {
		return NextResponse.json(
			{ error: "Transcription returned no result" },
			{ status: 502 },
		);
	}

	const { result } = cfResult;

	// Normalize words: prefer top-level words array, fall back to segment-level
	const words: CloudflareWhisperWord[] = result.words?.length
		? result.words
		: (result.segments ?? []).flatMap((s) => s.words ?? []);

	return NextResponse.json({
		text: result.text,
		words,
		segments: result.segments ?? [],
		language: "auto",
	});
}
