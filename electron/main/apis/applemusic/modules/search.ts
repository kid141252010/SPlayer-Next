/**
 * Apple Music 搜索模块
 */

import type { Track, Album, Artist, Playlist } from "@shared/types/player";
import { formatAMArtworkUrl, formatAMOriginalArtworkUrl } from "../core/artwork";
import { requestCatalog } from "../core/request";
import type { AMSearchResponse, AMSong, AMAlbum, AMArtist, AMPlaylist } from "../core/types";

export interface SearchResult<T> {
  items: T[];
  total: number;
  hasMore: boolean;
}

/** 歌曲数据转换 */
export const transformAMSong = (item: AMSong): Track => {
  const attr = item.attributes;
  const cover = formatAMArtworkUrl(attr.artwork?.url, 300);
  const coverOriginal = formatAMOriginalArtworkUrl(attr.artwork?.url);

  return {
    id: item.id,
    title: attr.name || "",
    artists: attr.artistName ? [{ name: attr.artistName }] : [],
    album: attr.albumName
      ? {
          name: attr.albumName,
          cover,
          artist: attr.artistName,
        }
      : undefined,
    duration: attr.durationInMillis || 0,
    cover,
    coverOriginal,
    source: "applemusic",
    track: attr.trackNumber,
    isrc: attr.isrc,
  };
};

/** 专辑数据转换 */
export const transformAMAlbum = (item: AMAlbum): Album => {
  const attr = item.attributes;
  const year = attr.releaseDate ? parseInt(attr.releaseDate.slice(0, 4), 10) : undefined;

  return {
    id: item.id,
    name: attr.name || "",
    artist: attr.artistName || "",
    cover: formatAMArtworkUrl(attr.artwork?.url, 300),
    trackCount: attr.trackCount,
    year: Number.isFinite(year) ? year : undefined,
  };
};

/** 歌手数据转换 */
export const transformAMArtist = (item: AMArtist): Artist => {
  const attr = item.attributes;
  return {
    id: item.id,
    name: attr.name || "",
    avatar: formatAMArtworkUrl(attr.artwork?.url, 300),
  };
};

/** 歌单数据转换 */
export const transformAMPlaylist = (item: AMPlaylist): Playlist => {
  const attr = item.attributes;
  return {
    id: item.id,
    name: attr.name || "",
    cover: formatAMArtworkUrl(attr.artwork?.url, 300),
    description: attr.description?.standard || attr.description?.short || "",
    trackCount: attr.trackCount,
    owner: attr.curatorName,
  };
};

export interface SearchParams {
  keyword: string;
  type?: "song" | "album" | "artist" | "playlist";
  offset?: number;
  limit?: number;
}

export const search = async (params: SearchParams): Promise<SearchResult<unknown>> => {
  const { keyword, type = "song", offset = 0, limit = 20 } = params;
  if (!keyword?.trim()) {
    return { items: [], total: 0, hasMore: false };
  }

  // 映射类型
  const typeMap: Record<string, string> = {
    song: "songs",
    album: "albums",
    artist: "artists",
    playlist: "playlists",
  };
  const amType = typeMap[type] || "songs";

  const res = await requestCatalog<AMSearchResponse>("/search", {
    term: keyword.trim(),
    types: amType,
    offset,
    limit,
  });

  if (type === "song") {
    const songData = res.results?.songs;
    const items = (songData?.data || []).map(transformAMSong);
    const total = songData?.total ?? items.length;
    return {
      items,
      total,
      hasMore: !!songData?.next || offset + items.length < total,
    };
  }

  if (type === "album") {
    const albumData = res.results?.albums;
    const items = (albumData?.data || []).map(transformAMAlbum);
    const total = albumData?.total ?? items.length;
    return {
      items,
      total,
      hasMore: !!albumData?.next || offset + items.length < total,
    };
  }

  if (type === "artist") {
    const artistData = res.results?.artists;
    const items = (artistData?.data || []).map(transformAMArtist);
    const total = artistData?.total ?? items.length;
    return {
      items,
      total,
      hasMore: !!artistData?.next || offset + items.length < total,
    };
  }

  if (type === "playlist") {
    const playlistData = res.results?.playlists;
    const items = (playlistData?.data || []).map(transformAMPlaylist);
    const total = playlistData?.total ?? items.length;
    return {
      items,
      total,
      hasMore: !!playlistData?.next || offset + items.length < total,
    };
  }

  return { items: [], total: 0, hasMore: false };
};
