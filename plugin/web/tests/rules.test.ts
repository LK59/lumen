import { describe, it, expect } from "vitest";
import { audioTrackFor, eligible, lumenProfile, streamAddress } from "../src/rules";

describe("ce que Lumen se propose de lire", () => {
  const film = { Id: "a", MediaType: "Video", Type: "Movie", LocationType: "FileSystem", VideoType: "VideoFile" };
  it("un fichier vidéo de la bibliothèque", () => {
    expect(eligible(film)).toBe(true);
    expect(eligible({ Id: "a", MediaType: "Video", Type: "Episode" })).toBe(true);
  });
  it("ni le direct, ni un disque, ni un élément sans fichier, ni autre chose que de la vidéo", () => {
    expect(eligible({ ...film, Type: "TvChannel" })).toBe(false);
    expect(eligible({ ...film, Type: "Recording" })).toBe(false);
    expect(eligible({ ...film, VideoType: "Dvd" })).toBe(false);
    expect(eligible({ ...film, VideoType: "Iso" })).toBe(false);
    expect(eligible({ ...film, LocationType: "Virtual" })).toBe(false);
    expect(eligible({ ...film, IsPlaceHolder: true })).toBe(false);
    expect(eligible({ ...film, MediaType: "Audio" })).toBe(false);
    expect(eligible(null)).toBe(false);
  });
});

describe("l'adresse du fichier", () => {
  it("ne porte ni jeton ni appareil, et ne dépend que du serveur et du fichier", () => {
    const address = streamAddress("https://exemple.test/jf/", "abc", "abc");
    expect(address).toBe("https://exemple.test/jf/Videos/abc/stream?static=true&mediaSourceId=abc");
    expect(address).not.toMatch(/api_?key|token|deviceId/i);
  });
});

describe("le profil d'un fichier accepté", () => {
  it("autorise la lecture directe de tout, et garde le débit maximal et les profils de repli", () => {
    const base = {
      MaxStreamingBitrate: 8_000_000,
      DirectPlayProfiles: [{ Container: "mp4", Type: "Video", VideoCodec: "h264", AudioCodec: "aac" }],
      CodecProfiles: [{ Type: "Video", Codec: "h264", Conditions: [{ Property: "VideoLevel", Value: "52" }] }],
      ContainerProfiles: [{ Type: "Video" }],
      TranscodingProfiles: [{ Container: "mp4", Protocol: "hls" }],
      SubtitleProfiles: [{ Format: "vtt", Method: "External" }],
    };
    const profile = lumenProfile(base);
    expect(profile.DirectPlayProfiles).toEqual([{ Type: "Video" }]);
    expect(profile.CodecProfiles).toEqual([]);
    expect(profile.ContainerProfiles).toEqual([]);
    expect(profile.MaxStreamingBitrate).toBe(8_000_000);
    expect(profile.TranscodingProfiles).toBe(base.TranscodingProfiles);
    expect(profile.SubtitleProfiles).toBe(base.SubtitleProfiles);
    expect(base.DirectPlayProfiles).toHaveLength(1);
  });
});

describe("la piste son que Jellyfin désigne", () => {
  // Un fichier dont le son précède l'image : index 0 et 2 pour Jellyfin, pistes 1 et 3 dans le conteneur.
  const audioFirst = [
    { Type: "Audio", Index: 0 },
    { Type: "Video", Index: 1 },
    { Type: "Audio", Index: 2 },
    { Type: "Subtitle", Index: 3 },
  ];
  it("se retrouve par son rang parmi les flux son, pas par son index", () => {
    expect(audioTrackFor(audioFirst, 0, [1, 3])).toBe(1);
    expect(audioTrackFor(audioFirst, 2, [1, 3])).toBe(3);
  });
  it("un son dans un fichier à part ne compte pas dans le rang", () => {
    const streams = [{ Type: "Video", Index: 0 }, { Type: "Audio", Index: 1 }, { Type: "Audio", Index: 2 }, { Type: "Audio", Index: 3, IsExternal: true }];
    expect(audioTrackFor(streams, 2, [2, 3])).toBe(3);
    expect(audioTrackFor(streams, 3, [2, 3])).toBeNull();
  });
  it("laisse le moteur choisir quand les deux listes ne se recouvrent pas", () => {
    expect(audioTrackFor(audioFirst, 2, [1])).toBeNull();
    expect(audioTrackFor(audioFirst, 7, [1, 3])).toBeNull();
    expect(audioTrackFor(audioFirst, null, [1, 3])).toBeNull();
    expect(audioTrackFor(undefined, 0, [1])).toBeNull();
  });
});
