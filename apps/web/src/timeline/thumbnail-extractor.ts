// Lightweight thumbnail extractor for timeline clip previews.
// Maintains one pooled <video> element per media file and serialises seeks
// per video so concurrent requests don't clobber each other.

const thumbnailCache = new Map<string, string>();
const pendingPromises = new Map<string, Promise<string | null>>();
const videoPool = new Map<string, HTMLVideoElement>();
const seekChains = new Map<string, Promise<void>>();

function cacheKey(mediaId: string, timeSeconds: number): string {
	// 0.1 s resolution — fine enough for a clip preview tile
	return `${mediaId}:${Math.round(timeSeconds * 10)}`;
}

function getPooledVideo(mediaId: string, file: File): HTMLVideoElement {
	let video = videoPool.get(mediaId);
	if (!video) {
		video = document.createElement("video");
		video.muted = true;
		video.preload = "metadata";
		video.playsInline = true;
		video.src = URL.createObjectURL(file);
		videoPool.set(mediaId, video);
	}
	return video;
}

async function seekAndCapture(
	video: HTMLVideoElement,
	timeSeconds: number,
): Promise<string | null> {
	// Wait for metadata if not yet loaded
	if (video.readyState < 1) {
		await new Promise<void>((resolve, reject) => {
			const onMeta = () => {
				video.removeEventListener("loadedmetadata", onMeta);
				video.removeEventListener("error", onErr);
				resolve();
			};
			const onErr = () => {
				video.removeEventListener("loadedmetadata", onMeta);
				video.removeEventListener("error", onErr);
				reject(new Error("video load error"));
			};
			video.addEventListener("loadedmetadata", onMeta);
			video.addEventListener("error", onErr);
		});
	}

	await new Promise<void>((resolve, reject) => {
		const onSeeked = () => {
			video.removeEventListener("seeked", onSeeked);
			video.removeEventListener("error", onErr);
			resolve();
		};
		const onErr = () => {
			video.removeEventListener("seeked", onSeeked);
			video.removeEventListener("error", onErr);
			reject(new Error("seek error"));
		};
		video.addEventListener("seeked", onSeeked);
		video.addEventListener("error", onErr);
		video.currentTime = timeSeconds;
	});

	try {
		const canvas = document.createElement("canvas");
		canvas.width = 160;
		canvas.height = 90;
		const ctx = canvas.getContext("2d");
		if (!ctx) return null;
		ctx.drawImage(video, 0, 0, 160, 90);
		return canvas.toDataURL("image/jpeg", 0.7);
	} catch {
		return null;
	}
}

export function requestThumbnail(
	mediaId: string,
	file: File,
	timeSeconds: number,
): Promise<string | null> {
	const key = cacheKey(mediaId, timeSeconds);

	const cached = thumbnailCache.get(key);
	if (cached) return Promise.resolve(cached);

	const pending = pendingPromises.get(key);
	if (pending) return pending;

	// Chain onto the previous seek for this video so they don't race
	const prevChain = seekChains.get(mediaId) ?? Promise.resolve();
	const promise: Promise<string | null> = prevChain
		.then(() => {
			// Another request may have populated the cache while we waited
			const hit = thumbnailCache.get(key);
			if (hit) return hit;
			return seekAndCapture(getPooledVideo(mediaId, file), timeSeconds);
		})
		.then((result) => {
			pendingPromises.delete(key);
			if (result) thumbnailCache.set(key, result);
			return result;
		})
		.catch(() => {
			pendingPromises.delete(key);
			return null;
		});

	pendingPromises.set(key, promise);
	// Keep the chain alive so the next request waits for this one
	seekChains.set(
		mediaId,
		promise.then(() => void 0).catch(() => void 0),
	);

	return promise;
}
