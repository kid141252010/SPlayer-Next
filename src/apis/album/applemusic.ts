import type { Album, Artist, Track } from "@shared/types/player";
import { applemusic } from "@/apis/applemusic";

export interface AppleMusicAlbumDetailResponse {
  album: Album;
  songs: Track[];
  artists?: Artist[];
}

/**
 * 获取 Apple Music 专辑详情与歌曲列表
 * @param id - 专辑 ID
 * @param fallbackName - 兜底名称
 */
export const fetchAppleMusicAlbum = async (
  id: string,
  fallbackName: string,
): Promise<{ album: Album; tracks: Track[]; artists?: Artist[]; description?: string }> => {
  const res = await applemusic.album<AppleMusicAlbumDetailResponse>({ id });
  return {
    album: {
      ...res.album,
      name: res.album.name || fallbackName,
    },
    tracks: res.songs || [],
    artists: res.artists,
  };
};
