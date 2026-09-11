import { describe, expect, it } from "vitest";
import { bestExternalIndex, detectFormat, extractTTMLSpatialOffset, parseLyric } from "./parse";
import { isEAC3Codec } from "../quality";

describe("lyric parse", () => {
  it("根据内容识别常见歌词格式", () => {
    expect(detectFormat("[00:01.00]歌词")).toBe("lrc");
    expect(detectFormat("1\n00:00:01,000 --> 00:00:02,000\n歌词")).toBe("srt");
    expect(detectFormat('<tt xmlns="http://www.w3.org/ns/ttml"></tt>')).toBe("ttml");
    expect(detectFormat("[1000,500](1000,500,0)歌词")).toBe("yrc");
    expect(detectFormat("[1000,500]歌词(1000,500)")).toBe("qrc");
  });

  it("按照指定优先级选择外部歌词", () => {
    const lyrics = [{ format: "lrc" as const }, { format: "ttml" as const }];

    expect(bestExternalIndex(lyrics, ["ttml", "lrc"])).toBe(1);
    expect(bestExternalIndex([], ["ttml", "lrc"])).toBe(-1);
  });

  it("LRC 会忽略元数据、按时间排序并展开多时间戳", () => {
    const lines = parseLyric(
      { content: "[ar:歌手]\n[00:02.00]第二行\n[00:01.00][00:03.00]重复行" },
      "lrc",
    );

    expect(lines.map(({ startTime }) => startTime)).toEqual([1_000, 2_000, 3_000]);
    expect(lines.map(({ words }) => words.map(({ word }) => word).join(""))).toEqual([
      "重复行",
      "第二行",
      "重复行",
    ]);
  });

  it("在容差内配对翻译和音译，超过容差时不误配", () => {
    const lines = parseLyric(
      {
        content: "[00:01.00]Hello\n[00:02.00]World",
        translation: "[00:01.20]你好\n[00:02.40]世界",
        translationFormat: "lrc",
        romaji: "[00:01.10]Harō\n[00:02.10]Wārudo",
        romajiFormat: "lrc",
      },
      "lrc",
    );

    expect(lines[0].translatedLyric).toBe("你好");
    expect(lines[1].translatedLyric).toBe("");
    expect(lines[0].romanLyric).toBe("Harō");
    expect(lines[1].romanLyric).toBe("Wārudo");
  });

  it("过滤无意义的翻译占位内容", () => {
    const lines = parseLyric(
      {
        content: "[00:01.00]Hello\n[00:02.00]World",
        translation: "[00:01.00]//\n[00:02.00]作品的著作权由原作者所有",
        translationFormat: "lrc",
      },
      "lrc",
    );

    expect(lines.every(({ translatedLyric }) => translatedLyric === "")).toBe(true);
  });

  it("将空时间标签保留为结束上一行的空白时间节点", () => {
    const lines = parseLyric({ content: "[00:00.00]A\n[00:01.00]\n[00:02.00]B" }, "lrc");

    expect(lines).toHaveLength(2);
    expect(lines[0].endTime).toBe(1_000);
    expect(lines[1].startTime).toBe(2_000);
  });

  it("使用 ESLRC 末尾时间标签结束最后一个字", () => {
    const [line] = parseLyric({ content: "[00:00.00]<00:00.00>A<00:01.00>B<00:02.00>" }, "lrc");

    expect(line.words).toEqual([
      { startTime: 0, endTime: 1_000, word: "A" },
      { startTime: 1_000, endTime: 2_000, word: "B" },
    ]);
    expect(line.endTime).toBe(2_000);
  });

  it("识别 EAC3 杜比全景声编码", () => {
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

  it("当启用杜比空间音频偏移时，行与字时间轴以及外部翻译同步补偿", () => {
    const ttml = `
      <tt xmlns="http://www.w3.org/ns/ttml" xmlns:itunes="http://music.apple.com/lyric-ttml-internal">
        <head>
          <metadata>
            <iTunesMetadata xmlns="http://music.apple.com/lyric-ttml-internal">
              <audio lyricOffset="0.960" role="spatial"/>
            </iTunesMetadata>
          </metadata>
        </head>
        <body>
          <div>
            <p begin="00:03.000" end="00:05.000">
              <span begin="00:03.000" end="00:04.000">Hello </span>
              <span begin="00:04.000" end="00:05.000">World</span>
            </p>
          </div>
        </body>
      </tt>
    `;

    // 立体声模式：未开启杜比偏移
    const stereoLines = parseLyric({ content: ttml }, "ttml", "", {
      applySpatialOffset: false,
    });
    expect(stereoLines[0].startTime).toBe(3000);
    expect(stereoLines[0].endTime).toBe(5000);
    expect(stereoLines[0].words[0].startTime).toBe(3000);
    expect(stereoLines[0].words[0].endTime).toBe(4000);

    // 杜比模式：开启杜比偏移，行与字时间轴推迟 960ms，外部立体声翻译成功补偿对齐
    let offsetResult = 0;
    const dolbyLines = parseLyric(
      {
        content: ttml,
        translation: "[00:03.00]你好 世界",
        translationFormat: "lrc",
      },
      "ttml",
      "",
      {
        applySpatialOffset: true,
        onSpatialOffset: (ms) => {
          offsetResult = ms;
        },
      },
    );

    expect(offsetResult).toBe(960);
    expect(dolbyLines[0].startTime).toBe(3960);
    expect(dolbyLines[0].endTime).toBe(5960);
    expect(dolbyLines[0].words[0].startTime).toBe(3960);
    expect(dolbyLines[0].words[0].endTime).toBe(4960);
    expect(dolbyLines[0].translatedLyric).toBe("你好 世界");
  });
});
