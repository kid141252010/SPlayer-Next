import type { Album, Artist, Track } from "@shared/types/player";
import type { ArtistProfile, CoverItem } from "@/types/artist";
import { applemusic } from "@/apis/applemusic";

export interface AppleMusicArtistDetailResponse {
  artist: Artist;
  songs: Track[];
  albums: Album[];
  singles?: Album[];
  liveAlbums?: Album[];
  compilations?: Album[];
  hasMore?: {
    songs: boolean;
    albums: boolean;
    singles: boolean;
    liveAlbums: boolean;
    compilations: boolean;
  };
  description?: string;
}

const toCoverItems = (albums?: Album[]): CoverItem[] =>
  (albums || []).map((album) => ({
    id: album.id || "",
    title: album.name,
    cover: album.cover,
    subtitle: album.artist,
    trackCount: album.trackCount ?? 0,
  }));

/**
 * 获取 Apple Music 歌手详情、代表作单曲与各类型专辑（专辑、单曲/EP、现场专辑、合辑）
 * @param id - 歌手 ID
 * @param fallbackName - 兜底名称
 */
export const fetchAppleMusicArtist = async (
  id: string,
  fallbackName: string,
): Promise<ArtistProfile> => {
  const res = await applemusic.artist<AppleMusicArtistDetailResponse>({ id });
  const albums = toCoverItems(res.albums);
  const singles = toCoverItems(res.singles);
  const liveAlbums = toCoverItems(res.liveAlbums);
  const compilations = toCoverItems(res.compilations);

  return {
    id,
    name: res.artist.name || fallbackName,
    avatar: res.artist.avatar,
    source: "applemusic",
    tracks: res.songs || [],
    albums,
    singles,
    liveAlbums,
    compilations,
    hasMore: res.hasMore,
    trackCount: res.songs?.length ?? 0,
    albumCount: albums.length,
  };
};

/**
 * 触底加载更多 Apple Music 歌手歌曲
 * @param id - 歌手 ID
 * @param offset - 已加载歌曲数
 * @param limit - 单页数量，默认 25
 */
export const fetchAppleMusicArtistSongs = async (
  id: string,
  offset: number,
  limit = 25,
): Promise<{ tracks: Track[]; more: boolean }> => {
  const res = await applemusic.artistView<{ items: Track[]; hasMore: boolean }>({
    id,
    view: "top-songs",
    offset,
    limit,
  });
  return {
    tracks: res.items || [],
    more: res.hasMore,
  };
};

/**
 * 触底加载更多 Apple Music 歌手唱片（专辑/单曲/Live/合辑）
 * @param id - 歌手 ID
 * @param view - 视图类型
 * @param offset - 已加载数量
 * @param limit - 单页数量，默认 25
 */
export const fetchAppleMusicArtistReleases = async (
  id: string,
  view: "full-albums" | "singles" | "live-albums" | "compilation-albums",
  offset: number,
  limit = 25,
): Promise<{ items: CoverItem[]; more: boolean }> => {
  const res = await applemusic.artistView<{ items: Album[]; hasMore: boolean }>({
    id,
    view,
    offset,
    limit,
  });
  return {
    items: toCoverItems(res.items),
    more: res.hasMore,
  };
};
