/**
 * Apple Music 歌曲详情模块
 */

import type { Track } from "@shared/types/player";
import { requestCatalog } from "../core/request";
import type { AMSong } from "../core/types";
import { transformAMSong } from "./search";

interface SongsResponse {
  data?: AMSong[];
}

export const getSongDetail = async (id: string): Promise<Track | null> => {
  if (!id) return null;
  const res = await requestCatalog<SongsResponse>(`/songs/${id}`);
  const item = res.data?.[0];
  return item ? transformAMSong(item) : null;
};

export const getSongsDetail = async (ids: string[]): Promise<Track[]> => {
  if (!ids || ids.length === 0) return [];
  const res = await requestCatalog<SongsResponse>("/songs", {
    ids: ids.join(","),
  });
  return (res.data || []).map(transformAMSong);
};
