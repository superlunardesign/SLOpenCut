"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { Section, SectionContent } from "@/components/section";
import { Spinner } from "@/components/ui/spinner";
import { useEditor } from "@/editor/use-editor";
import { extractTimelineAudio } from "@/media/mediabunny";
import { TICKS_PER_SECOND, mediaTimeFromSeconds } from "@/wasm";
import { rippleShiftElements } from "@/ripple";
import type { TranscriptionWord } from "@/transcription/types";


// ---- types ----

interface WordWithTimeline extends TranscriptionWord {
	timelineStart: number; // seconds on the timeline
	timelineEnd: number;
}

type TranscriptState =
	| { status: "idle"; error: string | null }
	| { status: "extracting" }
	| { status: "transcribing" }
	| { status: "done"; words: WordWithTimeline[] };

type TranscriptAction =
	| { type: "start_extract" }
	| { type: "start_transcribe" }
	| { type: "done"; words: WordWithTimeline[] }
	| { type: "fail"; error: string }
	| { type: "reset" };

/* eslint-disable opencut/prefer-object-params */
function transcriptReducer(
	state: TranscriptState,
	action: TranscriptAction,
): TranscriptState {
	switch (action.type) {
		case "start_extract":
			return { status: "extracting" };
		case "start_transcribe":
			return { status: "transcribing" };
		case "done":
			return { status: "done", words: action.words };
		case "fail":
			return { status: "idle", error: action.error };
		case "reset":
			return { status: "idle", error: null };
	}
}
/* eslint-enable opencut/prefer-object-params */

// ---- helpers ----

// Map word timestamps (relative to full mixed-audio export) to timeline time.
// The mixed audio buffer starts at t=0 of the timeline, so words timestamps
// are already timeline timestamps in seconds — no extra mapping needed.
function buildTimelineWords(words: TranscriptionWord[]): WordWithTimeline[] {
	return words.map((w) => ({
		...w,
		timelineStart: w.start,
		timelineEnd: w.end,
	}));
}

// ---- component ----

export function TranscriptView() {
	const editor = useEditor();
	const [state, dispatch] = useReducer(transcriptReducer, {
		status: "idle",
		error: null,
	});

	// word selection: set of word indices
	const [selectedIndices, setSelectedIndices] = useState<Set<number>>(
		new Set(),
	);
	// anchor index for shift-click range selection
	const anchorRef = useRef<number | null>(null);

	const tracks = useEditor((e) => e.scenes.getActiveScene().tracks);
	const mediaAssets = useEditor((e) => e.media.getAssets());
	const totalDuration = useEditor((e) => e.timeline.getTotalDuration());
	const currentTime = useEditor((e) => e.playback.getCurrentTime());

	const handleTranscribe = useCallback(async () => {
		try {
			dispatch({ type: "start_extract" });
			const audioBlob = await extractTimelineAudio({
				tracks,
				mediaAssets,
				totalDuration,
				onProgress: () => {},
			});

			dispatch({ type: "start_transcribe" });

			const response = await fetch("/api/transcription", {
				method: "POST",
				body: audioBlob,
				headers: { "Content-Type": audioBlob.type || "audio/wav" },
			});

			if (!response.ok) {
				const err = await response.json().catch(() => ({}));
				throw new Error((err as { error?: string }).error ?? `HTTP ${response.status}`);
			}

			const data = (await response.json()) as {
				words?: TranscriptionWord[];
				text?: string;
			};

			const rawWords: TranscriptionWord[] = data.words ?? [];
			if (rawWords.length === 0) {
				throw new Error(
					"No word-level timestamps returned. Check your Cloudflare Whisper model supports word timestamps.",
				);
			}

			dispatch({
				type: "done",
				words: buildTimelineWords(rawWords),
			});
			setSelectedIndices(new Set());
		} catch (err) {
			dispatch({
				type: "fail",
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}, [tracks, mediaAssets, totalDuration]);

	const handleWordClick = useCallback(
		(index: number, shiftKey: boolean, ctrlKey: boolean) => {
			setSelectedIndices((prev) => {
				if (shiftKey && anchorRef.current !== null) {
					const lo = Math.min(anchorRef.current, index);
					const hi = Math.max(anchorRef.current, index);
					const next = new Set(prev);
					for (let i = lo; i <= hi; i++) next.add(i);
					return next;
				}
				if (ctrlKey || ctrlKey) {
					const next = new Set(prev);
					if (next.has(index)) {
						next.delete(index);
					} else {
						next.add(index);
					}
					anchorRef.current = index;
					return next;
				}
				anchorRef.current = index;
				return new Set([index]);
			});

			// seek playhead to word start
			if (state.status === "done") {
				const word = state.words[index];
				if (word) {
					editor.playback.seek({
						time: mediaTimeFromSeconds({ seconds: word.timelineStart }),
					});
				}
			}
		},
		[editor, state],
	);

	// Highlight word at current playhead
	const activeWordIndex =
		state.status === "done"
			? state.words.findIndex(
					(w) =>
						currentTime / TICKS_PER_SECOND >= w.timelineStart &&
						currentTime / TICKS_PER_SECOND < w.timelineEnd,
				)
			: -1;

	const handleDeleteSelected = useCallback(() => {
		if (state.status !== "done" || selectedIndices.size === 0) return;

		const words = state.words;
		const indices = [...selectedIndices].sort((a, b) => b - a); // right-to-left

		for (const idx of indices) {
			const word = words[idx];
			if (!word) continue;

			const cutStart = mediaTimeFromSeconds({ seconds: word.timelineStart });
			const cutEnd = mediaTimeFromSeconds({ seconds: word.timelineEnd });

			const sceneTracks = editor.scenes.getActiveScene().tracks;
			const allTracks = [
				...sceneTracks.overlay,
				sceneTracks.main,
				...sceneTracks.audio,
			];

			// Collect elements that overlap this cut range
			const elementsInRange: { trackId: string; elementId: string }[] = [];
			for (const track of allTracks) {
				for (const el of track.elements) {
					const elEnd = el.startTime + el.duration;
					if (el.startTime < cutEnd && elEnd > cutStart) {
						elementsInRange.push({ trackId: track.id, elementId: el.id });
					}
				}
			}

			if (elementsInRange.length === 0) continue;

			// Split at cutEnd first (so element IDs stay stable for cutStart split)
			editor.timeline.splitElements({
				elements: elementsInRange,
				splitTime: cutEnd,
				retainSide: "left",
			});

			// Re-collect elements after split
			const afterSplit = editor.scenes.getActiveScene().tracks;
			const allTracksAfter = [
				...afterSplit.overlay,
				afterSplit.main,
				...afterSplit.audio,
			];
			const elementsForCutStart: { trackId: string; elementId: string }[] = [];
			for (const track of allTracksAfter) {
				for (const el of track.elements) {
					const elEnd = el.startTime + el.duration;
					if (el.startTime < cutEnd && elEnd > cutStart) {
						elementsForCutStart.push({
							trackId: track.id,
							elementId: el.id,
						});
					}
				}
			}

			// Split at cutStart
			editor.timeline.splitElements({
				elements: elementsForCutStart,
				splitTime: cutStart,
				retainSide: "right",
			});

			// Collect the resulting middle fragments for deletion
			const afterSecondSplit = editor.scenes.getActiveScene().tracks;
			const allTracksAfter2 = [
				...afterSecondSplit.overlay,
				afterSecondSplit.main,
				...afterSecondSplit.audio,
			];
			const toDelete: { trackId: string; elementId: string }[] = [];
			for (const track of allTracksAfter2) {
				for (const el of track.elements) {
					const elEnd = el.startTime + el.duration;
					// Middle fragment: entirely within [cutStart, cutEnd]
					if (el.startTime >= cutStart && elEnd <= cutEnd) {
						toDelete.push({ trackId: track.id, elementId: el.id });
					}
				}
			}

			if (toDelete.length > 0) {
				editor.timeline.deleteElements({ elements: toDelete });

				// Ripple: shift everything right of cutEnd left by cut duration
				const cutDuration = cutEnd - cutStart;
				const afterDelete = editor.scenes.getActiveScene().tracks;
				const rippleTracks = {
					overlay: afterDelete.overlay.map((track) => {
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						const shifted = rippleShiftElements({
							elements: track.elements as any[],
							afterTime: cutEnd,
							shiftAmount: cutDuration,
						});
						return { ...track, elements: shifted } as typeof track;
					}),
					main: {
						...afterDelete.main,
						elements: rippleShiftElements({
							elements: afterDelete.main.elements,
							afterTime: cutEnd,
							shiftAmount: cutDuration,
						}),
					},
					audio: afterDelete.audio.map((track) => ({
						...track,
						elements: rippleShiftElements({
							elements: track.elements,
							afterTime: cutEnd,
							shiftAmount: cutDuration,
						}),
					})),
				};
				editor.timeline.updateTracks(rippleTracks);

				// Shift subsequent word timestamps too
				const duration = (cutEnd - cutStart) / TICKS_PER_SECOND;
				dispatch({
					type: "done",
					words: words
						.filter((_, i) => !selectedIndices.has(i))
						.map((w) => {
							if (w.timelineStart >= word.timelineEnd) {
								return {
									...w,
									timelineStart: w.timelineStart - duration,
									timelineEnd: w.timelineEnd - duration,
								};
							}
							return w;
						}),
				});
				setSelectedIndices(new Set());
				return; // re-render with updated words; user can delete more selections
			}
		}

		// If multiple selections, re-dispatch after loop (handled inside above)
		setSelectedIndices(new Set());
	}, [editor, state, selectedIndices]);

	// ---- render ----

	const isLoading =
		state.status === "extracting" || state.status === "transcribing";

	return (
		<PanelView>
			<Section>
				<SectionContent>
					{state.status !== "done" && (
						<div className="space-y-3">
							<p className="text-muted-foreground text-sm">
								Transcribe your timeline audio to edit by selecting and deleting
								words — cuts are applied automatically.
							</p>
							<Button
								className="w-full"
								onClick={handleTranscribe}
								disabled={isLoading}
							>
								{isLoading && <Spinner className="mr-2 h-4 w-4" />}
								{state.status === "extracting"
									? "Extracting audio…"
									: state.status === "transcribing"
										? "Transcribing…"
										: "Transcribe Timeline"}
							</Button>
							{state.status === "idle" && state.error && (
								<p className="text-destructive text-xs">{state.error}</p>
							)}
						</div>
					)}

					{state.status === "done" && (
						<div className="space-y-3">
							<div className="flex items-center justify-between">
								<span className="text-muted-foreground text-xs">
									{selectedIndices.size > 0
										? `${selectedIndices.size} word${selectedIndices.size !== 1 ? "s" : ""} selected`
										: `${state.words.length} words`}
								</span>
								<div className="flex gap-2">
									{selectedIndices.size > 0 && (
										<Button
											size="sm"
											variant="destructive"
											onClick={handleDeleteSelected}
										>
											Delete selection
										</Button>
									)}
									<Button
										size="sm"
										variant="outline"
										onClick={() => {
											dispatch({ type: "reset" });
											setSelectedIndices(new Set());
										}}
									>
										Re-transcribe
									</Button>
								</div>
							</div>

							<TranscriptText
								words={state.words}
								selectedIndices={selectedIndices}
								activeWordIndex={activeWordIndex}
								onWordClick={handleWordClick}
							/>
						</div>
					)}
				</SectionContent>
			</Section>
		</PanelView>
	);
}

// ---- TranscriptText sub-component ----

interface TranscriptTextProps {
	words: WordWithTimeline[];
	selectedIndices: Set<number>;
	activeWordIndex: number;
	onWordClick: (index: number, shiftKey: boolean, ctrlKey: boolean) => void;
}

function TranscriptText({
	words,
	selectedIndices,
	activeWordIndex,
	onWordClick,
}: TranscriptTextProps) {
	const activeRef = useRef<HTMLSpanElement | null>(null);

	// Scroll active word into view during playback
	useEffect(() => {
		if (activeRef.current) {
			activeRef.current.scrollIntoView({ block: "nearest", behavior: "smooth" });
		}
	}, [activeWordIndex]);

	return (
		<div
			className="text-sm leading-7 select-none max-h-[60vh] overflow-y-auto pr-1"
			style={{ wordBreak: "break-word" }}
		>
			{words.map((word, i) => {
				const isSelected = selectedIndices.has(i);
				const isActive = i === activeWordIndex;
				return (
					<span
						key={`${i}-${word.word}`}
						ref={isActive ? activeRef : undefined}
						onClick={(e) => onWordClick(i, e.shiftKey, e.ctrlKey || e.metaKey)}
						className={[
							"cursor-pointer rounded px-0.5 transition-colors",
							isSelected
								? "bg-destructive/80 text-destructive-foreground"
								: isActive
									? "bg-primary/20 text-primary"
									: "hover:bg-muted",
						].join(" ")}
					>
						{word.word}
					</span>
				);
			})}
		</div>
	);
}
