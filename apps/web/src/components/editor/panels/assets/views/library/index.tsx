"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useEditor } from "@/editor/use-editor";
import { processMediaAssets } from "@/media/processing";
import { buildElementFromMedia } from "@/timeline/element-utils";
import { DEFAULT_NEW_ELEMENT_DURATION } from "@/timeline/creation";
import { mediaTimeFromSeconds } from "@/wasm";
import {
	CloudUploadIcon,
	Delete02Icon,
	FolderLibraryIcon,
	Loading03Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@/utils/ui";
import type { LibraryAsset } from "@/app/api/library/assets/route";

type AssetTypeFilter = "all" | "video" | "image" | "audio";

function getAssetType(mimeType: string): "video" | "image" | "audio" | "other" {
	if (mimeType.startsWith("video/")) return "video";
	if (mimeType.startsWith("image/")) return "image";
	if (mimeType.startsWith("audio/")) return "audio";
	return "other";
}

export function LibraryView() {
	const editor = useEditor();
	const [assets, setAssets] = useState<LibraryAsset[]>([]);
	const [loading, setLoading] = useState(true);
	const [uploading, setUploading] = useState(false);
	const [filter, setFilter] = useState<AssetTypeFilter>("all");
	const [addingId, setAddingId] = useState<string | null>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);

	const fetchAssets = useCallback(async () => {
		try {
			const res = await fetch("/api/library/assets");
			const data = (await res.json()) as { assets: LibraryAsset[] };
			setAssets(data.assets ?? []);
		} catch {
			toast.error("Failed to load library");
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
				// 1. Get presigned URL
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

				// 2. Upload directly to R2
				const uploadRes = await fetch(uploadUrl, {
					method: "PUT",
					headers: { "Content-Type": file.type },
					body: file,
				});
				if (!uploadRes.ok) throw new Error("R2 upload failed");

				// 3. Save metadata to D1
				const type = getAssetType(file.type);
				await fetch("/api/library/assets", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						name: file.name,
						folder: "Uncategorized",
						type,
						mime_type: file.type,
						size_bytes: file.size,
						r2_key: key,
						url: publicUrl,
					}),
				});
			}
			toast.success(
				files.length === 1
					? `${files[0].name} added to library`
					: `${files.length} files added to library`,
			);
			await fetchAssets();
		} catch (err) {
			console.error(err);
			toast.error("Upload failed");
		} finally {
			setUploading(false);
		}
	};

	const handleDelete = async (asset: LibraryAsset) => {
		try {
			await fetch(`/api/library/assets/${asset.id}`, { method: "DELETE" });
			setAssets((prev) => prev.filter((a) => a.id !== asset.id));
			toast.success(`${asset.name} removed from library`);
		} catch {
			toast.error("Failed to delete asset");
		}
	};

	const handleAddToTimeline = async (asset: LibraryAsset) => {
		setAddingId(asset.id);
		try {
			// Fetch the file from R2 and import into project media
			const res = await fetch(asset.url);
			if (!res.ok) throw new Error("Failed to fetch asset");
			const blob = await res.blob();
			const file = new File([blob], asset.name, { type: asset.mime_type });

			const processed = await processMediaAssets({ files: [file] });
			if (!processed.length) throw new Error("Processing failed");

			const mediaAsset = processed[0];
			editor.media.addAssets({ assets: processed });

			const currentTime = editor.playback.getCurrentTime();
			const scene = editor.scenes.getActiveScene();
			const element = buildElementFromMedia({
				media: mediaAsset,
				startTime: currentTime,
				duration:
					mediaAsset.type === "video" || mediaAsset.type === "audio"
						? mediaTimeFromSeconds({
								seconds: mediaAsset.duration ?? DEFAULT_NEW_ELEMENT_DURATION,
							})
						: DEFAULT_NEW_ELEMENT_DURATION,
			});

			editor.timeline.addElement({
				trackId: scene.tracks.main.id,
				element,
			});
		} catch (err) {
			console.error(err);
			toast.error("Failed to add to timeline");
		} finally {
			setAddingId(null);
		}
	};

	const filtered =
		filter === "all" ? assets : assets.filter((a) => a.type === filter);

	const filterButtons: { key: AssetTypeFilter; label: string }[] = [
		{ key: "all", label: "All" },
		{ key: "video", label: "Video" },
		{ key: "image", label: "Image" },
		{ key: "audio", label: "Audio" },
	];

	return (
		<PanelView
			title="Library"
			actions={
				<div className="flex items-center gap-1">
					<Button
						variant="text"
						size="sm"
						disabled={uploading}
						onClick={() => fileInputRef.current?.click()}
						className="gap-1.5"
					>
						{uploading ? (
							<HugeiconsIcon
								icon={Loading03Icon}
								className="size-4 animate-spin"
							/>
						) : (
							<HugeiconsIcon icon={CloudUploadIcon} className="size-4" />
						)}
						Upload
					</Button>
					<input
						ref={fileInputRef}
						type="file"
						multiple
						accept="video/*,image/*,audio/*,.gif"
						className="hidden"
						onChange={(e) => handleUpload(e.target.files)}
					/>
				</div>
			}
		>
			{/* Type filter pills */}
			<div className="mb-3 flex gap-1">
				{filterButtons.map(({ key, label }) => (
					<button
						key={key}
						type="button"
						onClick={() => setFilter(key)}
						className={cn(
							"rounded-full px-2.5 py-0.5 text-xs transition-colors",
							filter === key
								? "bg-primary text-primary-foreground"
								: "bg-accent text-muted-foreground hover:text-foreground",
						)}
					>
						{label}
					</button>
				))}
			</div>

			{loading ? (
				<div className="text-muted-foreground flex flex-col items-center gap-2 py-12 text-sm">
					<HugeiconsIcon
						icon={Loading03Icon}
						className="size-6 animate-spin"
					/>
					Loading library…
				</div>
			) : filtered.length === 0 ? (
				<div className="text-muted-foreground flex flex-col items-center gap-3 py-12 text-sm">
					<HugeiconsIcon
						icon={FolderLibraryIcon}
						className="size-8 opacity-40"
					/>
					<span>
						{filter === "all"
							? "Your library is empty"
							: `No ${filter} assets yet`}
					</span>
					<Button
						variant="outline"
						size="sm"
						onClick={() => fileInputRef.current?.click()}
					>
						Upload files
					</Button>
				</div>
			) : (
				<div className="grid grid-cols-2 gap-2 pb-4">
					{filtered.map((asset) => (
						<ContextMenu key={asset.id}>
							<ContextMenuTrigger>
								<div
									className="bg-accent group relative cursor-pointer overflow-hidden rounded-sm"
									onClick={() => handleAddToTimeline(asset)}
								>
									<div className="relative aspect-video w-full overflow-hidden">
										{asset.type === "image" || asset.type === "video" ? (
											// eslint-disable-next-line @next/next/no-img-element
											<img
												src={asset.url}
												alt={asset.name}
												className="size-full object-cover"
											/>
										) : (
											<div className="bg-accent flex size-full items-center justify-center">
												<HugeiconsIcon
													icon={FolderLibraryIcon}
													className="text-muted-foreground size-6"
												/>
											</div>
										)}
										{asset.type === "video" && (
											<div className="absolute right-1 bottom-1 rounded bg-black/70 px-1 py-0.5 text-[10px] text-white">
												{asset.duration_seconds
													? `${Math.round(asset.duration_seconds)}s`
													: "video"}
											</div>
										)}
										{addingId === asset.id && (
											<div className="absolute inset-0 flex items-center justify-center bg-black/50">
												<HugeiconsIcon
													icon={Loading03Icon}
													className="size-5 animate-spin text-white"
												/>
											</div>
										)}
									</div>
									<div className="px-1.5 py-1">
										<p
											className="text-muted-foreground truncate text-[0.65rem]"
											title={asset.name}
										>
											{asset.name}
										</p>
									</div>
								</div>
							</ContextMenuTrigger>
							<ContextMenuContent>
								<ContextMenuItem
									onClick={() => handleAddToTimeline(asset)}
									disabled={addingId === asset.id}
								>
									Add to timeline
								</ContextMenuItem>
								<ContextMenuItem
									className="text-destructive focus:text-destructive"
									onClick={() => handleDelete(asset)}
								>
									<HugeiconsIcon icon={Delete02Icon} className="mr-2 size-4" />
									Remove from library
								</ContextMenuItem>
							</ContextMenuContent>
						</ContextMenu>
					))}
				</div>
			)}
		</PanelView>
	);
}
