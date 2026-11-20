import { describe, it, expect } from "vitest";
import { PlaybackRecorder, transcodeReasonsOf } from "../src/journal";

describe("le décompte d'une lecture", () => {
  it("la première image est l'ouverture, les suivantes des changements de flux", () => {
    const recorder = new PlaybackRecorder("a", "Film");
    expect(recorder.opened).toBe(false);
    recorder.frame(812.4);
    recorder.frame(1530);
    recorder.frame(940);
    const entry = recorder.finish();
    expect(entry.firstFrameMs).toBe(812);
    expect(entry.streamChangesMs).toEqual([1530, 940]);
  });

  it("ne compte comme attente que ce qui se voit", () => {
    const recorder = new PlaybackRecorder("a", "Film");
    recorder.wait(40);
    recorder.wait(249);
    recorder.wait(1200);
    recorder.wait(300);
    expect(recorder.finish()).toMatchObject({ waits: 2, waitsMs: 1500 });
  });

  it("ne prend pas un saut pour du film regardé", () => {
    const recorder = new PlaybackRecorder("a", "Film");
    for (let i = 0; i < 40; i++) recorder.watched(0.25);
    recorder.watched(1800);
    recorder.watched(-600);
    expect(recorder.finish().watchedSeconds).toBe(10);
  });

  it("garde le dernier flux servi, et le motif d'un refus", () => {
    const recorder = new PlaybackRecorder("a", "Film");
    recorder.stream({ player: "lumen", playMethod: "DirectPlay", transcodeReasons: null, audio: "copié tel quel" });
    recorder.stream({ player: "jellyfin", playMethod: "Transcode", transcodeReasons: "AudioCodecNotSupported", audio: null });
    recorder.refused("audio A_MPEG/L2 : aucun décodeur");
    recorder.error();
    expect(recorder.finish()).toMatchObject({ player: "jellyfin", playMethod: "Transcode", transcodeReasons: "AudioCodecNotSupported", refusal: "audio A_MPEG/L2 : aucun décodeur", errors: 1 });
  });

  it("borne le nombre de sauts gardés", () => {
    const recorder = new PlaybackRecorder("a", "Film");
    for (let i = 0; i < 80; i++) recorder.seek(100 + i);
    expect(recorder.finish().seeksMs).toHaveLength(50);
  });
});

describe("les raisons du transcodage", () => {
  it("se lisent dans l'adresse du flux", () => {
    expect(transcodeReasonsOf("/videos/a/master.m3u8?DeviceId=x&TranscodeReasons=AudioCodecNotSupported,%20ContainerNotSupported&x=1")).toBe("AudioCodecNotSupported, ContainerNotSupported");
    expect(transcodeReasonsOf("/Videos/a/stream.mkv?Static=true")).toBeNull();
    expect(transcodeReasonsOf(undefined)).toBeNull();
  });
});
