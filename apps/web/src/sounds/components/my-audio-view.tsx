"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { EditorCore } from "@/core";
import { buildLibraryAudioElement } from "@/timeline/element-utils";
import { mediaTimeFromSeconds } from "@/wasm";
import {
	CloudUploadIcon,
	Delete02Icon,
	Loading03Icon,
	CameraMicrophone01Icon,
	PauseIcon,
	PlayIcon,
	PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@/utils/ui";
import type { LibraryAsset } from "@/app/api/library/assets/route";

export function MyAudioView() {
	const [assets, setAssets] = useState<LibraryAsset[]>([]);
	const [loading, setLoading] = useState(true);
	const [uploading, setUploading] = useState(false);
	const [search, setSearch] = useState("");
	const [playingId, setPlayingId] = useState<string | null>(null);
	const [addingId, setAddingId] = useState<string | null>(null);
	const audioRef = useRef<HTMLAudioElement | null>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);

	const fetchAssets = useCallback(async () => {
		try {
			const res = await fetch("/api/library/assets?type=audio");
			if (!res.ok) {
				const err = await res.json().catch(() => ({})) as { error?: string };
				throw new Error(err.error ?? `HTTP ${res.status}`);
			}
			const data = (await res.json()) as { assets: LibraryAsset[] };
			setAssets(data.assets ?? []);
		} catch (err) {
			console.error("[MyAudio] fetchAssets:", err);
			toast.error("Failed to load audio files");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void fetchAssets();
	}, [fetchAssets]);

	const handleUpload = async (files: FileList | null) => {
		if (!files || files.length === 0) return;
		setUploading(true);
		try {
			for (const file of Array.from(files)) {
				const presignRes = await fetch("/api/library/presign", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ filename: file.name, mimeType: file.type }),
				});
				const { uploadUrl, key, publicUrl } = (await presignRes.json()) as {
					uploadUrl: string;
					key: string;
					publicUrl: string;
				};

				if (!presignRes.ok) {
					const e = await presignRes.json().catch(() => ({})) as { error?: string };
					throw new Error(`Presign failed: ${e.error ?? presignRes.status}`);
				}

				const uploadRes = await fetch(uploadUrl, {
					method: "PUT",
					headers: { "Content-Type": file.type },
					body: file,
				});
				if (!uploadRes.ok) throw new Error(`R2 upload failed (${uploadRes.status})`);

				const metaRes = await fetch("/api/library/assets", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						name: file.name,
						folder: "Audio",
						type: "audio",
						mime_type: file.type,
						size_bytes: file.size,
						r2_key: key,
						url: publicUrl,
					}),
				});
				if (!metaRes.ok) {
					const e = await metaRes.json().catch(() => ({})) as { error?: string };
					throw new Error(`Metadata save failed: ${e.error ?? metaRes.status}`);
				}
			}
			toast.success(
				files.length === 1
					? `${files[0].name} added`
					: `${files.length} files added`,
			);
			await fetchAssets();
		} catch (err) {
			console.error(err);
			toast.error("Upload failed");
		} finally {
			setUploading(false);
		}
	};

	const handlePlay = (asset: LibraryAsset) => {
		if (playingId === asset.id) {
			audioRef.current?.pause();
			setPlayingId(null);
			return;
		}
		audioRef.current?.pause();
		const audio = new Audio(asset.url);
		audio.addEventListener("ended", () => setPlayingId(null));
		audio.play().catch(() => setPlayingId(null));
		audioRef.current = audio;
		setPlayingId(asset.id);
	};

	const handleAddToTimeline = async (asset: LibraryAsset) => {
		setAddingId(asset.id);
		try {
			const editor = EditorCore.getInstance();
			const currentTime = editor.playback.getCurrentTime();

			const res = await fetch(asset.url);
			if (!res.ok) throw new Error("Failed to fetch audio");
			const arrayBuffer = await res.arrayBuffer();
			const audioCtx = new AudioContext();
			const buffer = await audioCtx.decodeAudioData(arrayBuffer);

			const durationSeconds = asset.duration_seconds ?? buffer.duration;
			const element = buildLibraryAudioElement({
				sourceUrl: asset.url,
				name: asset.name,
				duration: mediaTimeFromSeconds({ seconds: durationSeconds }),
				startTime: currentTime,
				buffer,
			});

			editor.timeline.insertElement({
				placement: { mode: "auto", trackType: "audio" },
				element,
			});
			toast.success(`${asset.name} added to timeline`);
		} catch (err) {
			console.error(err);
			toast.error("Failed to add to timeline");
		} finally {
			setAddingId(null);
		}
	};

	const handleDelete = async (asset: LibraryAsset) => {
		try {
			await fetch(`/api/library/assets/${asset.id}`, { method: "DELETE" });
			setAssets((prev) => prev.filter((a) => a.id !== asset.id));
			toast.success(`${asset.name} removed`);
		} catch {
			toast.error("Failed to delete");
		}
	};

	const filtered = search.trim()
		? assets.filter((a) =>
				a.name.toLowerCase().includes(search.toLowerCase()),
			)
		: assets;

	const formatDuration = (seconds: number | null) => {
		if (!seconds) return "";
		const m = Math.floor(seconds / 60);
		const s = Math.floor(seconds % 60);
		return m > 0 ? `${m}:${s.toString().padStart(2, "0")}` : `${s}s`;
	};

	return (
		<div className="mt-1 flex h-full flex-col gap-4">
			<div className="flex items-center gap-2">
				<Input
					placeholder="Search my audio"
					className="w-full"
					containerClassName="w-full"
					value={search}
					onChange={(e) => setSearch(e.currentTarget.value)}
					showClearIcon
					onClear={() => setSearch("")}
				/>
				<Button
					variant="text"
					size="icon"
					disabled={uploading}
					onClick={() => fileInputRef.current?.click()}
					title="Upload audio"
				>
					{uploading ? (
						<HugeiconsIcon icon={Loading03Icon} className="size-4 animate-spin" />
					) : (
						<HugeiconsIcon icon={CloudUploadIcon} className="size-4" />
					)}
				</Button>
				<input
					ref={fileInputRef}
					type="file"
					multiple
					accept="audio/*,.mp3,.wav,.ogg,.m4a,.aac,.flac"
					className="hidden"
					onChange={(e) => handleUpload(e.target.files)}
				/>
			</div>

			{loading ? (
				<div className="text-muted-foreground flex flex-col items-center gap-2 py-12 text-sm">
					<HugeiconsIcon icon={Loading03Icon} className="size-5 animate-spin" />
					Loading…
				</div>
			) : filtered.length === 0 ? (
				<div className="text-muted-foreground flex flex-col items-center gap-3 py-12 text-sm">
					<HugeiconsIcon icon={CameraMicrophone01Icon} className="size-8 opacity-40" />
					<span className="text-center">
						{search ? "No audio files match your search" : "No audio files yet"}
					</span>
					{!search && (
						<Button
							variant="outline"
							size="sm"
							onClick={() => fileInputRef.current?.click()}
						>
							Upload audio
						</Button>
					)}
				</div>
			) : (
				<ScrollArea className="h-full flex-1">
					<div className="flex flex-col gap-3 pb-4">
						{filtered.map((asset) => (
							<ContextMenu key={asset.id}>
								<ContextMenuTrigger>
									<div className="group flex items-center gap-3 hover:opacity-75">
										<button
											type="button"
											className="flex min-w-0 flex-1 items-center gap-3 text-left"
											onClick={() => handlePlay(asset)}
										>
											<div className="bg-accent relative flex size-10 shrink-0 items-center justify-center rounded-md">
												<div className="from-primary/20 absolute inset-0 rounded-md bg-gradient-to-br to-transparent" />
												{playingId === asset.id ? (
													<HugeiconsIcon icon={PauseIcon} className="size-4" />
												) : (
													<HugeiconsIcon icon={PlayIcon} className="size-4" />
												)}
											</div>
											<div className="min-w-0 flex-1 overflow-hidden">
												<p className="truncate text-sm font-medium">{asset.name}</p>
												{asset.duration_seconds != null && (
													<span className="text-muted-foreground text-xs">
														{formatDuration(asset.duration_seconds)}
													</span>
												)}
											</div>
										</button>

										<Button
											variant="text"
											size="icon"
											className={cn(
												"text-muted-foreground hover:text-foreground w-auto !opacity-100",
												addingId === asset.id && "pointer-events-none",
											)}
											onClick={() => handleAddToTimeline(asset)}
											title="Add to timeline"
										>
											{addingId === asset.id ? (
												<HugeiconsIcon
													icon={Loading03Icon}
													className="size-4 animate-spin"
												/>
											) : (
												<HugeiconsIcon icon={PlusSignIcon} className="size-4" />
											)}
										</Button>
									</div>
								</ContextMenuTrigger>
								<ContextMenuContent>
									<ContextMenuItem onClick={() => handleAddToTimeline(asset)}>
										Add to timeline
									</ContextMenuItem>
									<ContextMenuItem
										className="text-destructive focus:text-destructive"
										onClick={() => handleDelete(asset)}
									>
										<HugeiconsIcon icon={Delete02Icon} className="mr-2 size-4" />
										Delete
									</ContextMenuItem>
								</ContextMenuContent>
							</ContextMenu>
						))}
					</div>
				</ScrollArea>
			)}
		</div>
	);
}
