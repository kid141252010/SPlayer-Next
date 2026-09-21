import { describe, expect, it } from "vitest";
import { isEAC3Codec } from "../quality";
import { applySpatialLyricOffset, extractTTMLSpatialOffset } from "./spatialOffset";
import type { LyricLine } from "@shared/types/lyrics";

describe("杜比全景声与空间音频歌词时间轴偏移", () => {
  it("正确识别杜比全景声编码", () => {
    expect(isEAC3Codec("eac3")).toBe(true);
    expect(isEAC3Codec("EAC3")).toBe(true);
    expect(isEAC3Codec("e-ac-3")).toBe(true);
    expect(isEAC3Codec("ec-3")).toBe(true);
    expect(isEAC3Codec("eac3_atmos")).toBe(true);
    expect(isEAC3Codec("atmos")).toBe(true);

    expect(isEAC3Codec("flac")).toBe(false);
    expect(isEAC3Codec("mp3")).toBe(false);
    expect(isEAC3Codec("aac")).toBe(false);
    expect(isEAC3Codec(undefined)).toBe(false);
  });

  it("正确提取 TTML 空间音频歌词延迟元数据", () => {
    const ttmlStandard = `
      <tt xmlns="http://www.w3.org/ns/ttml">
        <head>
          <metadata>
            <iTunesMetadata xmlns="http://music.apple.com/lyric-ttml-internal">
              <audio lyricOffset="0.960" role="spatial"/>
            </iTunesMetadata>
          </metadata>
        </head>
      </tt>
    `;
    expect(extractTTMLSpatialOffset(ttmlStandard)).toBe(960);

    const ttmlWithUnits = `
      <tt xmlns="http://www.w3.org/ns/ttml" xmlns:itunes="http://music.apple.com/lyric-ttml-internal">
        <head>
          <metadata>
            <itunes:iTunesMetadata>
              <itunes:audio itunes:lyricOffset="1.25s" itunes:role="spatial"/>
            </itunes:iTunesMetadata>
          </metadata>
        </head>
      </tt>
    `;
    expect(extractTTMLSpatialOffset(ttmlWithUnits)).toBe(1250);

    const ttmlMs = `
      <tt xmlns="http://www.w3.org/ns/ttml">
        <head><metadata><audio lyricOffset="500ms" role="spatial"/></metadata></head>
      </tt>
    `;
    expect(extractTTMLSpatialOffset(ttmlMs)).toBe(500);

    const ttmlStereoOnly = `
      <tt xmlns="http://www.w3.org/ns/ttml">
        <head><metadata><audio lyricOffset="0.500" role="stereo"/></metadata></head>
      </tt>
    `;
    expect(extractTTMLSpatialOffset(ttmlStereoOnly)).toBe(0);
  });

  it("当应用杜比空间音频偏移时，行与字时间轴同步平移", () => {
    const lines: LyricLine[] = [
      {
        startTime: 3000,
        endTime: 5000,
        words: [
          { word: "Hello ", startTime: 3000, endTime: 4000 },
          { word: "World", startTime: 4000, endTime: 5000 },
        ],
        translatedLyric: "你好 世界",
        romanLyric: "",
        isBG: false,
        isDuet: false,
      },
    ];

    applySpatialLyricOffset(lines, 960);

    expect(lines[0].startTime).toBe(3960);
    expect(lines[0].endTime).toBe(5960);
    expect(lines[0].words?.[0].startTime).toBe(3960);
    expect(lines[0].words?.[0].endTime).toBe(4960);
    expect(lines[0].words?.[1].startTime).toBe(4960);
    expect(lines[0].words?.[1].endTime).toBe(5960);
    expect(lines[0].translatedLyric).toBe("你好 世界");
  });
});
