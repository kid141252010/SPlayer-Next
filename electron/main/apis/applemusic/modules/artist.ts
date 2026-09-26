/**
 * Apple Music 歌手模块
 */

import type { Album, Artist, Track } from "@shared/types/player";
import { requestCatalog } from "../core/request";
import type { AMAlbum, AMArtist, AMSong } from "../core/types";
import { transformAMAlbum, transformAMArtist, transformAMSong } from "./search";

interface ArtistResponse {
  data?: Array<
    AMArtist & {
      views?: {
        "top-songs"?: { data?: AMSong[]; next?: string };
        "full-albums"?: { data?: AMAlbum[]; next?: string };
        singles?: { data?: AMAlbum[]; next?: string };
        "live-albums"?: { data?: AMAlbum[]; next?: string };
        "compilation-albums"?: { data?: AMAlbum[]; next?: string };
      };
    }
  >;
}

export interface ArtistDetailResult {
  artist: Artist;
  songs: Track[];
  albums: Album[];
  singles: Album[];
  liveAlbums: Album[];
  compilations: Album[];
  hasMore: {
    songs: boolean;
    albums: boolean;
    singles: boolean;
    liveAlbums: boolean;
    compilations: boolean;
  };
  description?: string;
}

export const getArtistDetail = async (id: string): Promise<ArtistDetailResult | null> => {
  if (!id) return null;
  const res = await requestCatalog<ArtistResponse>(`/artists/${id}`, {
    views: "top-songs,full-albums,singles,live-albums,compilation-albums",
    "limit[view.top-songs]": 25,
    "limit[view.full-albums]": 25,
    "limit[view.singles]": 25,
    "limit[view.live-albums]": 25,
    "limit[view.compilation-albums]": 25,
    "relate[songs]": "albums,artists",
    extend: "artistUrl",
  });
  const item = res.data?.[0];
  if (!item) return null;

  const artist = transformAMArtist(item);
  const songItems = item.views?.["top-songs"]?.data || [];
  const albumItems = item.views?.["full-albums"]?.data || item.relationships?.albums?.data || [];
  const singleItems = item.views?.singles?.data || [];
  const liveAlbumItems = item.views?.["live-albums"]?.data || [];
  const compilationItems = item.views?.["compilation-albums"]?.data || [];

  return {
    artist,
    songs: songItems.map((s) => {
      const track = transformAMSong(s);
      if (track.artists.length > 0 && !track.artists[0].id) {
        track.artists[0].id = artist.id;
      }
      return track;
    }),
    albums: albumItems.map(transformAMAlbum),
    singles: singleItems.map(transformAMAlbum),
    liveAlbums: liveAlbumItems.map(transformAMAlbum),
    compilations: compilationItems.map(transformAMAlbum),
    hasMore: {
      songs: !!item.views?.["top-songs"]?.next,
      albums: !!item.views?.["full-albums"]?.next,
      singles: !!item.views?.singles?.next,
      liveAlbums: !!item.views?.["live-albums"]?.next,
      compilations: !!item.views?.["compilation-albums"]?.next,
    },
    description: item.attributes.editorialNotes?.standard || item.attributes.editorialNotes?.short,
  };
};

export type AMArtistViewName =
  "top-songs" | "full-albums" | "singles" | "live-albums" | "compilation-albums";

export interface ArtistViewParams {
  id: string;
  view: AMArtistViewName;
  offset?: number;
  limit?: number;
}

export interface ArtistViewResult {
  items: Track[] | Album[];
  hasMore: boolean;
}

/**
 * 分页拉取 Apple Music 歌手指定视图资源（支持 offset 与 limit）
 * @param params - 包含歌手 ID、视图名称、偏移量 offset 和每页上限 limit
 */
export const getArtistView = async (params: ArtistViewParams): Promise<ArtistViewResult> => {
  const { id, view, offset = 0, limit = 25 } = params;
  if (!id) return { items: [], hasMore: false };

  try {
    const res = await requestCatalog<{ data?: unknown[]; next?: string }>(
      `/artists/${id}/view/${view}`,
      {
        offset,
        limit,
        ...(view === "top-songs" ? { "relate[songs]": "albums,artists", extend: "artistUrl" } : {}),
      },
    );
    const data = res.data || [];
    const hasMore = !!res.next;

    if (view === "top-songs") {
      const items = (data as AMSong[]).map((s) => {
        const track = transformAMSong(s);
        if (track.artists.length > 0 && !track.artists[0].id) {
          track.artists[0].id = id;
        }
        return track;
      });
      return { items, hasMore };
    }

    const items = (data as AMAlbum[]).map(transformAMAlbum);
    return { items, hasMore };
  } catch (err: unknown) {
    const errText = err instanceof Error ? err.message : String(err);
    if (errText.includes("404")) {
      return { items: [], hasMore: false };
    }
    throw err;
  }
};
