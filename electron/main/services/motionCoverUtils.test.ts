import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isRelatedAlbum, selectMotionCoverVideo } from "./motionCoverUtils";

describe("isRelatedAlbum", () => {
  it("rejects unrelated names but accepts editions and missing metadata", () => {
    assert.equal(isRelatedAlbum("目标专辑", "完全无关的专辑"), false);
    assert.equal(isRelatedAlbum("目标专辑", "目标专辑 豪华版"), true);
    assert.equal(isRelatedAlbum("目标专辑", ""), true);
  });
});

describe("selectMotionCoverVideo", () => {
  it("prefers Apple's tall artwork for the tall layout", () => {
    assert.deepEqual(
      selectMotionCoverVideo(
        {
          dictionary: {
            motionDetailSquare: { video: "square.m3u8" },
            motionDetailTall: { video: "tall.m3u8" },
          },
        },
        "tall",
      ),
      { url: "tall.m3u8", variant: "tall" },
    );
  });

  it("uses square artwork for square layouts and as a tall fallback", () => {
    const artwork = { dictionary: { motionDetailSquare: { video: "square.m3u8" } } };
    assert.deepEqual(selectMotionCoverVideo(artwork, "square"), {
      url: "square.m3u8",
      variant: "square",
    });
    assert.deepEqual(selectMotionCoverVideo(artwork, "tall"), {
      url: "square.m3u8",
      variant: "square",
    });
  });
});
