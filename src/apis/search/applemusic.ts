import type { Album, Artist, Playlist, Track } from "@shared/types/player";
import type { CoverItem } from "@/types/artist";
import { applemusic } from "@/apis/applemusic";
import type { SearchResult } from "./index";

/** Apple Music catalog search 最大支持 25 条每页 */
const clampLimit = (limit: number): number => Math.min(Math.max(1, limit), 25);

export const songs = async (
  keyword: string,
  offset: number,
  limit: number,
): Promise<SearchResult<Track>> => {
  return applemusic.search<SearchResult<Track>>({
    keyword,
    type: "song",
    offset,
    limit: clampLimit(limit),
  });
};

export const albums = async (
  keyword: string,
  offset: number,
  limit: number,
): Promise<SearchResult<CoverItem>> => {
  const res = await applemusic.search<SearchResult<Album>>({
    keyword,
    type: "album",
    offset,
    limit: clampLimit(limit),
  });
  const items: CoverItem[] = res.items.map((item) => ({
    id: item.id || "",
    title: item.name,
    cover: item.cover,
    subtitle: item.artist,
    trackCount: item.trackCount ?? 0,
  }));
  return {
    items,
    total: res.total,
    hasMore: res.hasMore,
  };
};

export const artists = async (
  keyword: string,
  offset: number,
  limit: number,
): Promise<SearchResult<CoverItem>> => {
  const res = await applemusic.search<SearchResult<Artist>>({
    keyword,
    type: "artist",
    offset,
    limit: clampLimit(limit),
  });
  const items: CoverItem[] = res.items.map((item) => ({
    id: item.id || "",
    title: item.name,
    cover: item.avatar,
    subtitle: "",
    trackCount: 0,
  }));
  return {
    items,
    total: res.total,
    hasMore: res.hasMore,
  };
};

export const playlists = async (
  keyword: string,
  offset: number,
  limit: number,
): Promise<SearchResult<CoverItem>> => {
  const res = await applemusic.search<SearchResult<Playlist>>({
    keyword,
    type: "playlist",
    offset,
    limit: clampLimit(limit),
  });
  const items: CoverItem[] = res.items.map((item) => ({
    id: item.id || "",
    title: item.name,
    cover: item.cover,
    subtitle: item.owner || item.description,
    trackCount: item.trackCount ?? 0,
  }));
  return {
    items,
    total: res.total,
    hasMore: res.hasMore,
  };
};
