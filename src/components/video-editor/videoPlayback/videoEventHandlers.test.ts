import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createVideoEventHandlers } from "./videoEventHandlers";

type PresentedFrameCallback = (now: DOMHighResTimeStamp, metadata: { mediaTime?: number }) => void;

type MockVideo = HTMLVideoElement & {
	requestVideoFrameCallback?: (callback: PresentedFrameCallback) => number;
	cancelVideoFrameCallback?: (handle: number) => void;
};

function createMutableRef<T>(value: T) {
	return { current: value };
}

function createMockVideo(overrides: Partial<MockVideo> = {}): MockVideo {
	const video = {
		currentTime: 0.5,
		duration: 10,
		paused: false,
		ended: false,
		playbackRate: 1,
		pause: vi.fn(),
	} as unknown as MockVideo;

	return Object.assign(video, overrides);
}

describe("createVideoEventHandlers", () => {
	let requestAnimationFrameMock: ReturnType<typeof vi.fn>;
	let cancelAnimationFrameMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		requestAnimationFrameMock = vi.fn(() => 11);
		cancelAnimationFrameMock = vi.fn();
		vi.stubGlobal("requestAnimationFrame", requestAnimationFrameMock);
		vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrameMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("advances effects through a held video frame using the media playback clock", () => {
		let animationFrameCallback: FrameRequestCallback | null = null;
		requestAnimationFrameMock.mockImplementation((callback: FrameRequestCallback) => {
			animationFrameCallback = callback;
			return 19;
		});
		const video = createMockVideo({
			requestVideoFrameCallback: vi.fn(() => 7),
			cancelVideoFrameCallback: vi.fn(),
		});
		const onPlayStateChange = vi.fn();
		const onTimeUpdate = vi.fn();
		const currentTimeRef = createMutableRef(0);
		const timeUpdateAnimationRef = createMutableRef<number | null>(null);

		const handlers = createVideoEventHandlers({
			video,
			isSeekingRef: createMutableRef(false),
			isPlayingRef: createMutableRef(false),
			allowPlaybackRef: createMutableRef(true),
			currentTimeRef,
			timeUpdateAnimationRef,
			onPlayStateChange,
			onTimeUpdate,
			trimRegionsRef: createMutableRef([]),
			speedRegionsRef: createMutableRef([]),
		});

		handlers.handlePlay();
		expect(onPlayStateChange).toHaveBeenCalledWith(true);
		// ScreenCaptureKit may hold the same decoded frame for several seconds.
		// No video-frame callbacks fire, but audio and currentTime keep advancing.
		for (const time of [0.75, 1.25, 2.5, 4.5]) {
			video.currentTime = time;
			animationFrameCallback?.(time * 1000);
			expect(onTimeUpdate).toHaveBeenLastCalledWith(time);
			expect(currentTimeRef.current).toBe(time * 1000);
		}
		expect(video.requestVideoFrameCallback).not.toHaveBeenCalled();
		handlers.dispose();
	});

	it("advances the playback clock without video-frame callback support", () => {
		let animationFrameCallback: FrameRequestCallback | null = null;
		requestAnimationFrameMock.mockImplementation((callback: FrameRequestCallback) => {
			animationFrameCallback = callback;
			return 19;
		});
		const video = createMockVideo({ currentTime: 0.75 });
		const onTimeUpdate = vi.fn();

		const handlers = createVideoEventHandlers({
			video,
			isSeekingRef: createMutableRef(false),
			isPlayingRef: createMutableRef(false),
			allowPlaybackRef: createMutableRef(true),
			currentTimeRef: createMutableRef(0),
			timeUpdateAnimationRef: createMutableRef<number | null>(null),
			onPlayStateChange: vi.fn(),
			onTimeUpdate,
			trimRegionsRef: createMutableRef([]),
			speedRegionsRef: createMutableRef([]),
		});

		handlers.handlePlay();
		expect(requestAnimationFrameMock).toHaveBeenCalledTimes(1);

		video.paused = true;
		animationFrameCallback?.(0);

		expect(onTimeUpdate).toHaveBeenCalledWith(0.75);
	});

	it("skips removed footage when playback reaches a cut region", () => {
		let animationFrameCallback: FrameRequestCallback | null = null;
		requestAnimationFrameMock.mockImplementation((callback: FrameRequestCallback) => {
			animationFrameCallback = callback;
			return 29;
		});
		const video = createMockVideo({ currentTime: 1.25, duration: 10 });
		const onTimeUpdate = vi.fn();
		const handlers = createVideoEventHandlers({
			video,
			isSeekingRef: createMutableRef(false),
			isPlayingRef: createMutableRef(false),
			allowPlaybackRef: createMutableRef(true),
			currentTimeRef: createMutableRef(0),
			timeUpdateAnimationRef: createMutableRef<number | null>(null),
			onPlayStateChange: vi.fn(),
			onTimeUpdate,
			trimRegionsRef: createMutableRef([{ id: "trim-1", startMs: 1000, endMs: 2000 }]),
			speedRegionsRef: createMutableRef([]),
		});

		handlers.handlePlay();
		animationFrameCallback?.(0);

		expect(video.currentTime).toBe(2);
		expect(video.pause).not.toHaveBeenCalled();
		expect(onTimeUpdate).toHaveBeenLastCalledWith(2);
	});

	it("cancels the playback clock on pause and dispose", () => {
		const cancelVideoFrameCallback = vi.fn();
		const video = createMockVideo({
			requestVideoFrameCallback: vi.fn(() => 23),
			cancelVideoFrameCallback,
		});
		const handlers = createVideoEventHandlers({
			video,
			isSeekingRef: createMutableRef(false),
			isPlayingRef: createMutableRef(false),
			allowPlaybackRef: createMutableRef(true),
			currentTimeRef: createMutableRef(0),
			timeUpdateAnimationRef: createMutableRef<number | null>(null),
			onPlayStateChange: vi.fn(),
			onTimeUpdate: vi.fn(),
			trimRegionsRef: createMutableRef([]),
			speedRegionsRef: createMutableRef([]),
		});

		handlers.handlePlay();
		handlers.handlePause();
		expect(cancelAnimationFrameMock).toHaveBeenCalledWith(11);
		expect(cancelVideoFrameCallback).not.toHaveBeenCalled();

		cancelAnimationFrameMock.mockClear();
		handlers.handlePlay();
		handlers.dispose();
		expect(cancelAnimationFrameMock).toHaveBeenCalledWith(11);
		expect(cancelVideoFrameCallback).not.toHaveBeenCalled();
	});

	it("updates speed regions during held frames without advancing a stalled media clock", () => {
		let tick: FrameRequestCallback = () => {};
		requestAnimationFrameMock.mockImplementation((callback: FrameRequestCallback) => {
			tick = callback;
			return 31;
		});
		const video = createMockVideo({ requestVideoFrameCallback: vi.fn(() => 23) });
		const onTimeUpdate = vi.fn();
		const handlers = createVideoEventHandlers({
			video,
			isSeekingRef: createMutableRef(false),
			isPlayingRef: createMutableRef(false),
			allowPlaybackRef: createMutableRef(true),
			currentTimeRef: createMutableRef(0),
			timeUpdateAnimationRef: createMutableRef<number | null>(null),
			onPlayStateChange: vi.fn(),
			onTimeUpdate,
			trimRegionsRef: createMutableRef([]),
			speedRegionsRef: createMutableRef([
				{ id: "speed-1", startMs: 1000, endMs: 2000, speed: 2 },
			]),
		});
		handlers.handlePlay();
		video.currentTime = 1.25;
		tick(100);
		expect(video.playbackRate).toBe(2);
		// Buffering must not make the effect clock run ahead of the video/audio.
		tick(5000);
		expect(onTimeUpdate).toHaveBeenLastCalledWith(1.25);
		video.currentTime = 2.5;
		tick(6000);
		expect(video.playbackRate).toBe(1);
		expect(onTimeUpdate).toHaveBeenLastCalledWith(2.5);
		handlers.dispose();
	});

	it("holds the last retained frame instead of revealing the untrimmed video end", () => {
		const duration = 7378 / 600;
		let position = 10.3;
		const seek = vi.fn((value: number) => {
			position = value;
		});
		const video = createMockVideo({ duration });
		Object.defineProperty(video, "currentTime", { get: () => position, set: seek });
		const onTimeUpdate = vi.fn();
		const handlers = createVideoEventHandlers({
			video,
			isSeekingRef: createMutableRef(false),
			isPlayingRef: createMutableRef(false),
			allowPlaybackRef: createMutableRef(true),
			currentTimeRef: createMutableRef(0),
			timeUpdateAnimationRef: createMutableRef<number | null>(null),
			onPlayStateChange: vi.fn(),
			onTimeUpdate,
			trimRegionsRef: createMutableRef([{ id: "tail", startMs: 10275, endMs: 12297 }]),
			speedRegionsRef: createMutableRef([]),
		});
		handlers.handleSeeked();
		expect(seek).toHaveBeenCalledTimes(1);
		expect(position).toBeCloseTo(10.274, 6);
		// Completing the corrective seek must settle without another seek.
		video.paused = true;
		handlers.handleSeeked();
		handlers.handleSeeked();
		expect(seek).toHaveBeenCalledTimes(1);
		expect(onTimeUpdate).toHaveBeenLastCalledWith(10.274);
		// Seeking back into the retained clip must remain responsive.
		position = 1;
		handlers.handleSeeked();
		expect(seek).toHaveBeenCalledTimes(1);
		expect(onTimeUpdate).toHaveBeenLastCalledWith(1);
	});

	it.each([
		1, 1.5, 2,
	])("holds the kept frame at %sx and replays from the first retained frame", (speed) => {
		let tick: FrameRequestCallback = () => {};
		requestAnimationFrameMock.mockImplementation((callback: FrameRequestCallback) => {
			tick = callback;
			return 42;
		});
		const video = createMockVideo({ currentTime: 1, duration: 12.296667 });
		video.pause = vi.fn(() => {
			video.paused = true;
		});
		const onTimeUpdate = vi.fn();
		const handlers = createVideoEventHandlers({
			video,
			isSeekingRef: createMutableRef(false),
			isPlayingRef: createMutableRef(false),
			allowPlaybackRef: createMutableRef(true),
			currentTimeRef: createMutableRef(0),
			timeUpdateAnimationRef: createMutableRef<number | null>(null),
			onPlayStateChange: vi.fn(),
			onTimeUpdate,
			trimRegionsRef: createMutableRef([
				{ id: "intro", startMs: 0, endMs: 500 },
				{ id: "tail", startMs: 8735, endMs: 12297 },
			]),
			speedRegionsRef: createMutableRef([{ id: "speed", startMs: 500, endMs: 8735, speed }]),
		});
		handlers.handlePlay();
		tick(0);
		expect(video.playbackRate).toBe(speed);
		video.currentTime = 8.75;
		tick(16);
		expect(video.paused).toBe(true);
		expect(video.currentTime).toBe(8.734);
		handlers.handleSeeked();
		expect(onTimeUpdate).toHaveBeenLastCalledWith(8.734);
		video.paused = false;
		handlers.handlePlay();
		expect(video.currentTime).toBe(0.5);
		tick(32);
		expect(video.playbackRate).toBe(speed);
		handlers.dispose();
	});

	it("skips removed footage after a paused seek", () => {
		const video = createMockVideo({
			currentTime: 1.25,
			paused: true,
		});
		const onTimeUpdate = vi.fn();
		const handlers = createVideoEventHandlers({
			video,
			isSeekingRef: createMutableRef(true),
			isPlayingRef: createMutableRef(false),
			allowPlaybackRef: createMutableRef(true),
			currentTimeRef: createMutableRef(0),
			timeUpdateAnimationRef: createMutableRef<number | null>(null),
			onPlayStateChange: vi.fn(),
			onTimeUpdate,
			trimRegionsRef: createMutableRef([{ id: "trim-1", startMs: 1000, endMs: 2000 }]),
			speedRegionsRef: createMutableRef([]),
		});

		handlers.handleSeeked();

		expect(video.currentTime).toBe(2);
		expect(onTimeUpdate).toHaveBeenLastCalledWith(2);
	});
});
