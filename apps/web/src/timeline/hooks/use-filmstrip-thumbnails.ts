"use client";

import { useEffect, useState } from "react";
import { requestThumbnail } from "@/timeline/thumbnail-extractor";

const MAX_TILES = 50;

export function useFilmstripThumbnails({
	mediaId,
	file,
	trimStartSeconds,
	durationSeconds,
	tileWidth,
	pixelsPerSecond,
}: {
	mediaId: string | undefined;
	file: File | undefined;
	trimStartSeconds: number;
	durationSeconds: number;
	tileWidth: number;
	pixelsPerSecond: number;
}): (string | null)[] {
	const count = Math.min(
		MAX_TILES,
		Math.max(1, Math.ceil((durationSeconds * pixelsPerSecond) / tileWidth) + 1),
	);

	const [urls, setUrls] = useState<(string | null)[]>(() =>
		Array(count).fill(null),
	);

	useEffect(() => {
		if (!mediaId || !file || tileWidth <= 0 || pixelsPerSecond <= 0) return;

		const newCount = Math.min(
			MAX_TILES,
			Math.max(
				1,
				Math.ceil((durationSeconds * pixelsPerSecond) / tileWidth) + 1,
			),
		);
		setUrls(Array(newCount).fill(null));

		let cancelled = false;

		for (let i = 0; i < newCount; i++) {
			const t = trimStartSeconds + (i * tileWidth) / pixelsPerSecond;
			const idx = i;
			void requestThumbnail(mediaId, file, t).then((result) => {
				if (!cancelled && result) {
					setUrls((prev) => {
						const next = [...prev];
						if (idx < next.length) next[idx] = result;
						return next;
					});
				}
			});
		}

		return () => {
			cancelled = true;
		};
	}, [mediaId, file, trimStartSeconds, durationSeconds, tileWidth, pixelsPerSecond]);

	return urls;
}
