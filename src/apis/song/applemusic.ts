import type { Track } from "@shared/types/player";
import { applemusic } from "@/apis/applemusic";

/**
 * 获取 Apple Music 歌曲详情
 * @param id - Apple Music 歌曲 ID
 */
export const songDetail = async (id: string): Promise<Track | null> => {
  return applemusic.song<Track | null>({ id });
};

/**
 * 批量获取 Apple Music 歌曲详情
 * @param ids - 歌曲 ID 列表
 */
export const songsDetail = async (ids: string[]): Promise<Track[]> => {
  return applemusic.songs<Track[]>({ ids });
};
