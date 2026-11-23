"use client";

import { useEffect, useState } from "react";
import { requestThumbnail } from "@/timeline/thumbnail-extractor";
import { mediaTimeToSeconds } from "@/wasm";
import type { MediaTime } from "@/wasm";

export function useClipThumbnail({
	mediaId,
	file,
	trimStart,
}: {
	mediaId: string | undefined;
	file: File | undefined;
	trimStart: MediaTime;
}): string | null {
	const [url, setUrl] = useState<string | null>(null);
	const timeSeconds = mediaTimeToSeconds({ time: trimStart });

	useEffect(() => {
		if (!mediaId || !file) return;

		let cancelled = false;
		requestThumbnail(mediaId, file, timeSeconds).then((result) => {
			if (!cancelled && result) setUrl(result);
		});

		return () => {
			cancelled = true;
		};
	}, [mediaId, file, timeSeconds]);

	return url;
}
