import { describe, expect, it } from "vitest";
import { isDolbyAtmosQuality, isEAC3Codec, isLosslessCodec, getQualityLevel } from "./quality";
import type { AudioQuality } from "@shared/types/player";

describe("quality utilities", () => {
  describe("isDolbyAtmosQuality", () => {
    it("正确识别明确标记为 isSpatial 的音质", () => {
      const q: AudioQuality = {
        sampleRate: 48000,
        channels: 2,
        bitsPerSample: 16,
        bitRate: 768000,
        codec: "eac3",
        isSpatial: true,
        spatialObjects: 12,
      };
      expect(isDolbyAtmosQuality(q)).toBe(true);
    });

    it("正确识别带有空间对象的 EAC-3 杜比音质", () => {
      const q: AudioQuality = {
        sampleRate: 48000,
        channels: 6,
        bitsPerSample: 16,
        bitRate: 448000,
        codec: "eac3",
        spatialObjects: 16,
      };
      expect(isDolbyAtmosQuality(q)).toBe(true);
    });

    it("普通双声道无损或压缩音乐不应识别为全景声", () => {
      const flac: AudioQuality = {
        sampleRate: 96000,
        channels: 2,
        bitsPerSample: 24,
        bitRate: 2500000,
        codec: "flac",
      };
      const mp3: AudioQuality = {
        sampleRate: 44100,
        channels: 2,
        bitsPerSample: 16,
        bitRate: 320000,
        codec: "mp3",
      };
      expect(isDolbyAtmosQuality(flac)).toBe(false);
      expect(isDolbyAtmosQuality(mp3)).toBe(false);
      expect(isDolbyAtmosQuality(undefined)).toBe(false);
    });
  });

  describe("codec checkers", () => {
    it("isEAC3Codec 正确匹配各种杜比编码名称", () => {
      expect(isEAC3Codec("eac3")).toBe(true);
      expect(isEAC3Codec("E-AC-3")).toBe(true);
      expect(isEAC3Codec("ec-3")).toBe(true);
      expect(isEAC3Codec("atmos")).toBe(true);
      expect(isEAC3Codec("flac")).toBe(false);
    });

    it("isLosslessCodec 正确匹配主流无损格式", () => {
      expect(isLosslessCodec("flac")).toBe(true);
      expect(isLosslessCodec("alac")).toBe(true);
      expect(isLosslessCodec("wav")).toBe(true);
      expect(isLosslessCodec("mp3")).toBe(false);
      expect(isLosslessCodec("aac")).toBe(false);
    });
  });

  describe("getQualityLevel", () => {
    it("正确评定 Hi-Res 与 Lossless 等级", () => {
      const hires: AudioQuality = {
        sampleRate: 96000,
        channels: 2,
        bitsPerSample: 24,
        bitRate: 2000000,
        codec: "flac",
      };
      const cd: AudioQuality = {
        sampleRate: 44100,
        channels: 2,
        bitsPerSample: 16,
        bitRate: 800000,
        codec: "flac",
      };
      expect(getQualityLevel(hires)).toBe("hi-res");
      expect(getQualityLevel(cd)).toBe("lossless");
    });
  });
});
