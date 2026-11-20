import type { MotionCoverResult, MotionCoverVariant } from "@shared/types/player";
import { bothContains, normalize } from "../apis/common/lyric/utils";

export interface MotionCoverArtwork {
  dictionary?: {
    motionDetailSquare?: { video?: string };
    motionDetailTall?: { video?: string };
  };
}

/** 专辑资料缺失时不据此误杀；双方都有资料时要求归一化名称存在包含关系。 */
export const isRelatedAlbum = (trackAlbum: string, candidateAlbum: string): boolean => {
  const normalizedTrackAlbum = normalize(trackAlbum);
  const normalizedCandidateAlbum = normalize(candidateAlbum);
  return (
    !normalizedTrackAlbum ||
    !normalizedCandidateAlbum ||
    bothContains(normalizedTrackAlbum, normalizedCandidateAlbum)
  );
};

/** 纵向布局优先取 Apple Tall，没有时回退到 Square。 */
export const selectMotionCoverVideo = (
  artwork: MotionCoverArtwork | undefined,
  preferred: MotionCoverVariant,
): MotionCoverResult | null => {
  const tall = preferred === "tall" ? artwork?.dictionary?.motionDetailTall?.video : undefined;
  if (tall) return { url: tall, variant: "tall" };
  const square = artwork?.dictionary?.motionDetailSquare?.video;
  return square ? { url: square, variant: "square" } : null;
};
