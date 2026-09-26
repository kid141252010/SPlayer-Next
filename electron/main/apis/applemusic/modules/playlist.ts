/**
 * Apple Music 歌单模块
 */

import type { Playlist, Track } from "@shared/types/player";
import { requestCatalog } from "../core/request";
import type { AMPlaylist } from "../core/types";
import { transformAMPlaylist, transformAMSong } from "./search";

interface PlaylistResponse {
  data?: AMPlaylist[];
}

export interface PlaylistDetailResult {
  playlist: Playlist;
  songs: Track[];
}

export const getPlaylistDetail = async (id: string): Promise<PlaylistDetailResult | null> => {
  if (!id) return null;
  const res = await requestCatalog<PlaylistResponse>(`/playlists/${id}`, {
    "relate[songs]": "albums,artists",
  });
  const item = res.data?.[0];
  if (!item) return null;

  const playlist = transformAMPlaylist(item);
  const trackItems = item.relationships?.tracks?.data || [];
  const songs = trackItems.map(transformAMSong);

  return {
    playlist,
    songs,
  };
};
