import type { Playlist, Track } from "@shared/types/player";
import { applemusic } from "@/apis/applemusic";

export interface AppleMusicPlaylistDetailResponse {
  playlist: Playlist;
  songs: Track[];
}

/**
 * 获取 Apple Music 歌单详情与歌曲列表
 * @param id - 歌单 ID (如 pl.xxx)
 * @param fallbackName - 兜底名称
 */
export const fetchAppleMusicPlaylist = async (
  id: string,
  fallbackName: string,
): Promise<{ playlist: Playlist; tracks: Track[] }> => {
  const res = await applemusic.playlist<AppleMusicPlaylistDetailResponse>({ id });
  return {
    playlist: {
      ...res.playlist,
      name: res.playlist.name || fallbackName,
    },
    tracks: res.songs || [],
  };
};
