import type React from "react";
import { enablePitchPreservingPlayback } from "@/lib/mediaTiming";
import type { SpeedRegion, TrimRegion } from "../types";

interface VideoEventHandlersParams {
	video: HTMLVideoElement;
	isSeekingRef: React.MutableRefObject<boolean>;
	isPlayingRef: React.MutableRefObject<boolean>;
	allowPlaybackRef: React.MutableRefObject<boolean>;
	currentTimeRef: React.MutableRefObject<number>;
	timeUpdateAnimationRef: React.MutableRefObject<number | null>;
	onPlayStateChange: (playing: boolean) => void;
	onTimeUpdate: (time: number) => void;
	trimRegionsRef: React.MutableRefObject<TrimRegion[]>;
	speedRegionsRef: React.MutableRefObject<SpeedRegion[]>;
}

export function createVideoEventHandlers(params: VideoEventHandlersParams) {
	const {
		video,
		isSeekingRef,
		isPlayingRef,
		allowPlaybackRef,
		currentTimeRef,
		timeUpdateAnimationRef,
		onPlayStateChange,
		onTimeUpdate,
		trimRegionsRef,
		speedRegionsRef,
	} = params;
	enablePitchPreservingPlayback(video);

	const emitTime = (timeValue: number) => {
		currentTimeRef.current = timeValue * 1000;
		onTimeUpdate(timeValue);
	};

	const isTrailingTrim = (region: TrimRegion) =>
		Number.isFinite(video.duration) && region.endMs >= Math.round(video.duration * 1000);

	const lastRetainedTime = (region: TrimRegion) => Math.max(0, (region.startMs - 1) / 1000);

	// Helper function to check if current time is within a trim region
	const findActiveTrimRegion = (currentTimeMs: number): TrimRegion | null => {
		const trimRegions = trimRegionsRef.current;
		return (
			trimRegions.find(
				(region) =>
					currentTimeMs >= region.startMs &&
					(currentTimeMs < region.endMs || isTrailingTrim(region)),
			) || null
		);
	};

	// Helper function to find the active speed region at the current time
	const findActiveSpeedRegion = (currentTimeMs: number): SpeedRegion | null => {
		return (
			speedRegionsRef.current.find(
				(region) => currentTimeMs >= region.startMs && currentTimeMs < region.endMs,
			) || null
		);
	};

	const skipPastTrimRegion = (trimRegion: TrimRegion) => {
		const atEnd = isTrailingTrim(trimRegion);
		const targetTime = atEnd
			? lastRetainedTime(trimRegion)
			: Math.min(trimRegion.endMs / 1000, video.duration);

		// A removed tail has no following kept frame. Pause on the retained side
		// of the cut instead of exposing the final frame of the source video.
		if (atEnd && !video.paused) video.pause();
		// Avoid repeated seeked events, including microsecond media rounding.
		if (Math.abs(video.currentTime - targetTime) > 0.000001) {
			video.currentTime = targetTime;
		}
		emitTime(targetTime);
	};

	const cancelScheduledUpdate = () => {
		if (timeUpdateAnimationRef.current !== null) {
			cancelAnimationFrame(timeUpdateAnimationRef.current);
			timeUpdateAnimationRef.current = null;
		}
	};

	const scheduleNextUpdate = () => {
		if (video.paused || video.ended) {
			return;
		}

		// Sparse/VFR screen recordings can hold a decoded frame while the media
		// clock advances. Keep cursor, zoom, and timeline motion independent of
		// video-frame delivery; texture refresh remains in the rendering pipeline.
		timeUpdateAnimationRef.current = requestAnimationFrame(() => {
			timeUpdateAnimationRef.current = null;
			updateTime();
		});
	};

	function updateTime() {
		const playbackTime = video.currentTime;
		const currentTimeMs = playbackTime * 1000;
		const activeTrimRegion = findActiveTrimRegion(currentTimeMs);

		// If we're in a trim region during playback, skip to the end of it
		if (activeTrimRegion && !video.paused && !video.ended) {
			skipPastTrimRegion(activeTrimRegion);
		} else {
			// Apply playback speed from active speed region
			const activeSpeedRegion = findActiveSpeedRegion(currentTimeMs);
			enablePitchPreservingPlayback(video);
			video.playbackRate = activeSpeedRegion ? activeSpeedRegion.speed : 1;
			emitTime(playbackTime);
		}

		scheduleNextUpdate();
	}

	const handlePlay = () => {
		if (!allowPlaybackRef.current) {
			video.pause();
			return;
		}

		const trailingTrim = trimRegionsRef.current.find(isTrailingTrim);
		if (trailingTrim && video.currentTime >= lastRetainedTime(trailingTrim)) {
			// Replay after reaching the edited end, respecting any removed intro.
			let restartMs = 0;
			for (const trim of [...trimRegionsRef.current].sort((a, b) => a.startMs - b.startMs)) {
				if (trim.startMs > restartMs) break;
				restartMs = Math.max(restartMs, trim.endMs);
			}
			if (restartMs >= video.duration * 1000) {
				video.pause();
				return;
			}
			video.currentTime = restartMs / 1000;
			emitTime(video.currentTime);
		}

		isPlayingRef.current = true;
		onPlayStateChange(true);
		cancelScheduledUpdate();
		scheduleNextUpdate();
	};

	const handlePause = () => {
		isPlayingRef.current = false;
		onPlayStateChange(false);
		cancelScheduledUpdate();
		const trim = findActiveTrimRegion(video.currentTime * 1000);
		if (trim && isTrailingTrim(trim)) skipPastTrimRegion(trim);
		else emitTime(video.currentTime);
	};

	const handleSeeked = () => {
		isSeekingRef.current = false;

		const currentTimeMs = video.currentTime * 1000;
		const activeTrimRegion = findActiveTrimRegion(currentTimeMs);

		// Never leave the preview parked on removed footage after a seek.
		if (activeTrimRegion) {
			skipPastTrimRegion(activeTrimRegion);
		} else {
			emitTime(video.currentTime);
		}
	};

	const handleSeeking = () => {
		isSeekingRef.current = true;
		emitTime(video.currentTime);
	};

	return {
		dispose: cancelScheduledUpdate,
		handlePlay,
		handlePause,
		handleSeeked,
		handleSeeking,
	};
}
