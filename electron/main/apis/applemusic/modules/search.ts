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

  // 解析专辑 ID：优先 relationships.albums.data[0].id，兜底从 url 中正则提取
  const albumId =
    item.relationships?.albums?.data?.[0]?.id || attr.url?.match(/\/album\/(?:[^/]+\/)?(\d+)/)?.[1];

  // 解析歌手 ID：优先 relationships.artists.data[0].id，兜底从 artistUrl 中正则提取
  const artistId =
    item.relationships?.artists?.data?.[0]?.id ||
    attr.artistUrl?.match(/\/artist\/(?:[^/]+\/)?(\d+)/)?.[1];

  return {
    id: item.id,
    title: attr.name || "",
    artists: attr.artistName ? [{ id: artistId, name: attr.artistName }] : [],
    album: attr.albumName
      ? {
          id: albumId,
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

  // Apple Music catalog search limit 参数最大为 25
  const safeLimit = Math.min(Math.max(1, limit), 25);

  const searchParams: Record<string, string | number | boolean | undefined> = {
    term: keyword.trim(),
    types: amType,
    offset,
    limit: safeLimit,
  };
  if (type === "song") {
    searchParams["relate[songs]"] = "albums,artists";
  }

  const res = await requestCatalog<AMSearchResponse>("/search", searchParams);

  if (type === "song") {
    const songData = res.results?.songs;
    const items = (songData?.data || []).map(transformAMSong);
    const hasMore =
      !!songData?.next ||
      (typeof songData?.total === "number" && offset + items.length < songData.total);
    const total = songData?.total ?? (hasMore ? offset + items.length + 1 : offset + items.length);
    return {
      items,
      total,
      hasMore,
    };
  }

  if (type === "album") {
    const albumData = res.results?.albums;
    const items = (albumData?.data || []).map(transformAMAlbum);
    const hasMore =
      !!albumData?.next ||
      (typeof albumData?.total === "number" && offset + items.length < albumData.total);
    const total = albumData?.total ?? (hasMore ? offset + items.length + 1 : offset + items.length);
    return {
      items,
      total,
      hasMore,
    };
  }

  if (type === "artist") {
    const artistData = res.results?.artists;
    const items = (artistData?.data || []).map(transformAMArtist);
    const hasMore =
      !!artistData?.next ||
      (typeof artistData?.total === "number" && offset + items.length < artistData.total);
    const total =
      artistData?.total ?? (hasMore ? offset + items.length + 1 : offset + items.length);
    return {
      items,
      total,
      hasMore,
    };
  }

  if (type === "playlist") {
    const playlistData = res.results?.playlists;
    const items = (playlistData?.data || []).map(transformAMPlaylist);
    const hasMore =
      !!playlistData?.next ||
      (typeof playlistData?.total === "number" && offset + items.length < playlistData.total);
    const total =
      playlistData?.total ?? (hasMore ? offset + items.length + 1 : offset + items.length);
    return {
      items,
      total,
      hasMore,
    };
  }

  return { items: [], total: 0, hasMore: false };
};
