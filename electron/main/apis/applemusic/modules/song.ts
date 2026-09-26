/**
 * Apple Music 歌曲详情模块
 */

import type { Album, Artist, Track } from "@shared/types/player";
import { requestCatalog } from "../core/request";
import type { AMAlbum, AMArtist, AMSong } from "../core/types";
import { transformAMAlbum, transformAMArtist, transformAMSong } from "./search";

interface SongsResponse {
  data?: AMSong[];
}

interface AlbumsResponse {
  data?: AMAlbum[];
}

interface ArtistsResponse {
  data?: AMArtist[];
}

export const getSongDetail = async (id: string): Promise<Track | null> => {
  if (!id) return null;
  const res = await requestCatalog<SongsResponse>(`/songs/${id}`, {
    include: "albums,artists",
    extend: "artistUrl",
  });
  const item = res.data?.[0];
  return item ? transformAMSong(item) : null;
};

export const getSongsDetail = async (ids: string[]): Promise<Track[]> => {
  if (!ids || ids.length === 0) return [];
  const res = await requestCatalog<SongsResponse>("/songs", {
    ids: ids.join(","),
    include: "albums,artists",
    extend: "artistUrl",
  });
  return (res.data || []).map(transformAMSong);
};

/**
 * 获取歌曲所属专辑列表
 * @param id - 歌曲 ID
 */
export const getSongAlbums = async (id: string): Promise<Album[]> => {
  if (!id) return [];
  const res = await requestCatalog<AlbumsResponse>(`/songs/${id}/albums`);
  return (res.data || []).map(transformAMAlbum);
};

/**
 * 获取歌曲歌手列表
 * @param id - 歌曲 ID
 */
export const getSongArtists = async (id: string): Promise<Artist[]> => {
  if (!id) return [];
  const res = await requestCatalog<ArtistsResponse>(`/songs/${id}/artists`);
  return (res.data || []).map(transformAMArtist);
};
