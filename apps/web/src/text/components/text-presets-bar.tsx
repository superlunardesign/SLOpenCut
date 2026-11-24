"use client";

import { useRef, useState } from "react";
import { useEditor } from "@/editor/use-editor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { getElementParam, readElementParamValue } from "@/params/registry";
import type { ParamValue } from "@/params";
import type { TextElement } from "@/timeline";
import { cn } from "@/utils/ui";
import { Add01Icon, BookmarkCheckIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTextPresets } from "@/text/use-text-presets";

const PRESET_PARAM_KEYS = [
	"fontFamily",
	"fontSize",
	"color",
	"textAlign",
	"fontWeight",
	"fontStyle",
	"textDecoration",
	"letterSpacing",
	"lineHeight",
	"background.enabled",
	"background.color",
	"background.cornerRadius",
	"background.paddingX",
	"background.paddingY",
	"background.offsetX",
	"background.offsetY",
] as const;

function captureParams(element: TextElement): Record<string, ParamValue> {
	const result: Record<string, ParamValue> = {};
	for (const key of PRESET_PARAM_KEYS) {
		const param = getElementParam({ element, key });
		if (!param) continue;
		const value = readElementParamValue({ element, param });
		if (value !== null) result[key] = value;
	}
	return result;
}

export function TextPresetsBar({
	element,
	trackId,
}: {
	element: TextElement;
	trackId: string;
}) {
	const editor = useEditor();
	const { presets, savePreset, deletePreset, renamePreset } = useTextPresets();
	const [saveName, setSaveName] = useState("");
	const [saveOpen, setSaveOpen] = useState(false);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [editingName, setEditingName] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);

	const handleApplyPreset = (params: Record<string, ParamValue>) => {
		if (!("params" in element)) return;
		const merged = { ...element.params, ...params };
		editor.timeline.previewElements({
			updates: [
				{
					trackId,
					elementId: element.id,
					updates: { params: merged },
				},
			],
		});
		editor.timeline.commitPreview();
	};

	const handleSave = () => {
		const name = saveName.trim() || `Style ${presets.length + 1}`;
		savePreset(name, captureParams(element));
		setSaveName("");
		setSaveOpen(false);
	};

	const handleStartRename = (id: string, currentName: string) => {
		setEditingId(id);
		setEditingName(currentName);
		setTimeout(() => inputRef.current?.focus(), 0);
	};

	const handleFinishRename = () => {
		if (editingId && editingName.trim()) {
			renamePreset(editingId, editingName.trim());
		}
		setEditingId(null);
		setEditingName("");
	};

	if (presets.length === 0 && !saveOpen) {
		return (
			<div className="flex items-center gap-1 pb-2">
				<Popover open={saveOpen} onOpenChange={setSaveOpen}>
					<PopoverTrigger asChild>
						<Button variant="outline" size="sm" className="h-7 gap-1 text-xs">
							<HugeiconsIcon icon={BookmarkCheckIcon} className="size-3" />
							Save style preset
						</Button>
					</PopoverTrigger>
					<SavePresetPopover
						name={saveName}
						onNameChange={setSaveName}
						onSave={handleSave}
						onCancel={() => setSaveOpen(false)}
					/>
				</Popover>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-1.5 pb-2">
			<div className="flex items-center justify-between">
				<span className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
					Presets
				</span>
				<Popover open={saveOpen} onOpenChange={setSaveOpen}>
					<PopoverTrigger asChild>
						<Button
							variant="text"
							size="icon"
							className="size-5"
							title="Save current style as preset"
						>
							<HugeiconsIcon icon={Add01Icon} className="size-3.5" />
						</Button>
					</PopoverTrigger>
					<SavePresetPopover
						name={saveName}
						onNameChange={setSaveName}
						onSave={handleSave}
						onCancel={() => setSaveOpen(false)}
					/>
				</Popover>
			</div>

			<div className="flex flex-wrap gap-1.5">
				{presets.map((preset) => (
					<ContextMenu key={preset.id}>
						<ContextMenuTrigger>
							{editingId === preset.id ? (
								<Input
									ref={inputRef}
									value={editingName}
									onChange={(e) => setEditingName(e.currentTarget.value)}
									onBlur={handleFinishRename}
									onKeyDown={(e) => {
										if (e.key === "Enter") handleFinishRename();
										if (e.key === "Escape") setEditingId(null);
									}}
									className="h-6 w-24 px-1.5 text-xs"
									containerClassName="inline-flex"
								/>
							) : (
								<button
									type="button"
									onClick={() => handleApplyPreset(preset.params)}
									className={cn(
										"bg-accent text-foreground hover:bg-accent/80 inline-flex items-center rounded-full px-2.5 py-0.5 text-xs transition-colors",
										"border border-transparent hover:border-border",
									)}
								>
									{preset.name}
								</button>
							)}
						</ContextMenuTrigger>
						<ContextMenuContent>
							<ContextMenuItem onClick={() => handleApplyPreset(preset.params)}>
								Apply preset
							</ContextMenuItem>
							<ContextMenuItem
								onClick={() => handleStartRename(preset.id, preset.name)}
							>
								Rename
							</ContextMenuItem>
							<ContextMenuItem
								className="text-destructive focus:text-destructive"
								onClick={() => deletePreset(preset.id)}
							>
								Delete
							</ContextMenuItem>
						</ContextMenuContent>
					</ContextMenu>
				))}
			</div>
		</div>
	);
}

function SavePresetPopover({
	name,
	onNameChange,
	onSave,
	onCancel,
}: {
	name: string;
	onNameChange: (v: string) => void;
	onSave: () => void;
	onCancel: () => void;
}) {
	return (
		<PopoverContent side="top" align="start" className="w-56 p-3">
			<p className="mb-2 text-sm font-medium">Save style preset</p>
			<Input
				placeholder="Preset name (optional)"
				value={name}
				onChange={(e) => onNameChange(e.currentTarget.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter") onSave();
					if (e.key === "Escape") onCancel();
				}}
				className="mb-2"
				autoFocus
			/>
			<div className="flex gap-2">
				<Button variant="text" size="sm" className="flex-1" onClick={onCancel}>
					Cancel
				</Button>
				<Button size="sm" className="flex-1" onClick={onSave}>
					Save
				</Button>
			</div>
		</PopoverContent>
	);
}
