import type { Album, Artist, Track } from "@shared/types/player";
import type { ArtistProfile, CoverItem } from "@/types/artist";
import { applemusic } from "@/apis/applemusic";

export interface AppleMusicArtistDetailResponse {
  artist: Artist;
  songs: Track[];
  albums: Album[];
  description?: string;
}

/**
 * 获取 Apple Music 歌手详情、代表作单曲与专辑
 * @param id - 歌手 ID
 * @param fallbackName - 兜底名称
 */
export const fetchAppleMusicArtist = async (
  id: string,
  fallbackName: string,
): Promise<ArtistProfile> => {
  const res = await applemusic.artist<AppleMusicArtistDetailResponse>({ id });
  const albums: CoverItem[] = (res.albums || []).map((album) => ({
    id: album.id || "",
    title: album.name,
    cover: album.cover,
    subtitle: album.artist,
    trackCount: album.trackCount ?? 0,
  }));

  return {
    id,
    name: res.artist.name || fallbackName,
    avatar: res.artist.avatar,
    source: "applemusic",
    tracks: res.songs || [],
    albums,
    trackCount: res.songs?.length ?? 0,
    albumCount: albums.length,
  };
};
