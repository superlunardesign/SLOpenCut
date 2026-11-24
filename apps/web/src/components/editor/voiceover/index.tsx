"use client";

import {
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { EditorCore } from "@/core";
import { buildLibraryAudioElement } from "@/timeline/element-utils";
import { mediaTimeFromSeconds } from "@/wasm";
import {
	VoiceIcon,
	StopIcon,
	CameraMicrophone01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

type RecordingState = "idle" | "recording" | "done";

export function VoiceoverButton() {
	const [open, setOpen] = useState(false);

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button
					variant="text"
					size="icon"
					className="rounded-sm"
					title="Record voiceover"
				>
					<HugeiconsIcon icon={CameraMicrophone01Icon} className="size-4" />
				</Button>
			</PopoverTrigger>
			<PopoverContent
				side="top"
				align="end"
				sideOffset={8}
				className="w-72 p-0"
			>
				<VoiceoverPanel onClose={() => setOpen(false)} />
			</PopoverContent>
		</Popover>
	);
}

function VoiceoverPanel({ onClose }: { onClose: () => void }) {
	const [state, setState] = useState<RecordingState>("idle");
	const [elapsed, setElapsed] = useState(0);
	const [name, setName] = useState("");
	const [saving, setSaving] = useState(false);
	const [level, setLevel] = useState(0);

	const mediaRecorderRef = useRef<MediaRecorder | null>(null);
	const chunksRef = useRef<Blob[]>([]);
	const streamRef = useRef<MediaStream | null>(null);
	const analyserRef = useRef<AnalyserNode | null>(null);
	const animFrameRef = useRef<number>(0);
	const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const blobRef = useRef<Blob | null>(null);

	const stopTimer = () => {
		if (timerRef.current) {
			clearInterval(timerRef.current);
			timerRef.current = null;
		}
	};

	const stopLevelMeter = () => {
		cancelAnimationFrame(animFrameRef.current);
		setLevel(0);
	};

	const cleanup = useCallback(() => {
		stopTimer();
		stopLevelMeter();
		streamRef.current?.getTracks().forEach((t) => t.stop());
		streamRef.current = null;
		analyserRef.current = null;
	}, []);

	useEffect(() => {
		return () => {
			cleanup();
			mediaRecorderRef.current?.stop();
		};
	}, [cleanup]);

	const startLevelMeter = (stream: MediaStream) => {
		const ctx = new AudioContext();
		const source = ctx.createMediaStreamSource(stream);
		const analyser = ctx.createAnalyser();
		analyser.fftSize = 256;
		source.connect(analyser);
		analyserRef.current = analyser;

		const data = new Uint8Array(analyser.frequencyBinCount);
		const tick = () => {
			analyser.getByteFrequencyData(data);
			const avg = data.reduce((a, b) => a + b, 0) / data.length;
			setLevel(Math.min(100, (avg / 128) * 100 * 2));
			animFrameRef.current = requestAnimationFrame(tick);
		};
		animFrameRef.current = requestAnimationFrame(tick);
	};

	const handleRecord = async () => {
		try {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			streamRef.current = stream;
			startLevelMeter(stream);

			chunksRef.current = [];
			const recorder = new MediaRecorder(stream, {
				mimeType: MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
					? "audio/webm;codecs=opus"
					: "audio/webm",
			});

			recorder.ondataavailable = (e) => {
				if (e.data.size > 0) chunksRef.current.push(e.data);
			};

			recorder.onstop = () => {
				const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
				blobRef.current = blob;
				stopLevelMeter();
				setState("done");
				const now = new Date();
				setName(
					`Voiceover ${now.toLocaleDateString()} ${now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
				);
			};

			recorder.start();
			mediaRecorderRef.current = recorder;

			// Play the timeline muted while recording
			const editor = EditorCore.getInstance();
			editor.playback.play();

			setElapsed(0);
			timerRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);
			setState("recording");
		} catch (err) {
			console.error(err);
			toast.error("Microphone access denied");
		}
	};

	const handleStop = () => {
		mediaRecorderRef.current?.stop();
		stopTimer();
		const editor = EditorCore.getInstance();
		editor.playback.pause();
		cleanup();
	};

	const handleSave = async () => {
		if (!blobRef.current || !name.trim()) return;
		setSaving(true);

		try {
			const filename = `${name.trim()}.webm`;
			const file = new File([blobRef.current], filename, {
				type: blobRef.current.type,
			});

			// Get presigned URL and upload to R2
			const presignRes = await fetch("/api/library/presign", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ filename, mimeType: file.type }),
			});
			const { uploadUrl, key, publicUrl } = (await presignRes.json()) as {
				uploadUrl: string;
				key: string;
				publicUrl: string;
			};

			const uploadRes = await fetch(uploadUrl, {
				method: "PUT",
				headers: { "Content-Type": file.type },
				body: file,
			});
			if (!uploadRes.ok) throw new Error("Upload failed");

			// Decode to get real duration
			const arrayBuf = await blobRef.current.arrayBuffer();
			const audioCtx = new AudioContext();
			const audioBuffer = await audioCtx.decodeAudioData(arrayBuf);
			const durationSeconds = audioBuffer.duration;

			// Save metadata to library
			await fetch("/api/library/assets", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: name.trim(),
					folder: "Voiceovers",
					type: "audio",
					mime_type: file.type,
					size_bytes: file.size,
					r2_key: key,
					url: publicUrl,
					duration_seconds: durationSeconds,
				}),
			});

			// Add to timeline
			const editor = EditorCore.getInstance();
			const element = buildLibraryAudioElement({
				sourceUrl: publicUrl,
				name: name.trim(),
				duration: mediaTimeFromSeconds({ seconds: durationSeconds }),
				startTime: editor.playback.getCurrentTime(),
				buffer: audioBuffer,
			});

			editor.timeline.insertElement({
				placement: { mode: "auto", trackType: "audio" },
				element,
			});

			toast.success(`"${name.trim()}" added to timeline`);
			onClose();
		} catch (err) {
			console.error(err);
			toast.error("Failed to save recording");
		} finally {
			setSaving(false);
		}
	};

	const handleDiscard = () => {
		blobRef.current = null;
		chunksRef.current = [];
		setState("idle");
		setElapsed(0);
		setName("");
	};

	const formatTime = (s: number) => {
		const m = Math.floor(s / 60);
		const sec = s % 60;
		return `${m}:${sec.toString().padStart(2, "0")}`;
	};

	return (
		<div className="flex flex-col gap-0">
			{/* Header */}
			<div className="border-b px-4 py-3">
				<p className="text-sm font-medium">Record Voiceover</p>
				{state === "recording" && (
					<p className="text-muted-foreground text-xs">
						Video is playing — use headphones to avoid feedback
					</p>
				)}
			</div>

			<div className="flex flex-col gap-4 p-4">
				{/* Timer */}
				<div className="flex flex-col items-center gap-3">
					<div
						className={`text-3xl font-mono font-semibold tabular-nums transition-colors ${
							state === "recording" ? "text-red-500" : "text-foreground"
						}`}
					>
						{formatTime(elapsed)}
					</div>

					{/* Level meter */}
					{state === "recording" && (
						<div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
							<div
								className="h-full rounded-full bg-red-500 transition-all duration-75"
								style={{ width: `${level}%` }}
							/>
						</div>
					)}

					{state === "done" && (
						<div className="text-muted-foreground text-xs">
							Recording complete — {formatTime(elapsed)}
						</div>
					)}
				</div>

				{/* Name input (shown after recording) */}
				{state === "done" && (
					<Input
						value={name}
						onChange={(e) => setName(e.currentTarget.value)}
						placeholder="Name your recording"
						className="w-full"
						containerClassName="w-full"
						autoFocus
					/>
				)}

				{/* Actions */}
				{state === "idle" && (
					<Button
						onClick={handleRecord}
						className="w-full gap-2"
						variant="default"
					>
						<HugeiconsIcon icon={VoiceIcon} className="size-4 text-red-400" />
						Start Recording
					</Button>
				)}

				{state === "recording" && (
					<Button
						onClick={handleStop}
						className="w-full gap-2"
						variant="secondary"
					>
						<HugeiconsIcon icon={StopIcon} className="size-4" />
						Stop Recording
					</Button>
				)}

				{state === "done" && (
					<div className="flex gap-2">
						<Button
							variant="text"
							className="flex-1"
							onClick={handleDiscard}
							disabled={saving}
						>
							Discard
						</Button>
						<Button
							className="flex-1"
							onClick={handleSave}
							disabled={saving || !name.trim()}
						>
							{saving ? "Saving…" : "Save & Add"}
						</Button>
					</div>
				)}
			</div>
		</div>
	);
}
