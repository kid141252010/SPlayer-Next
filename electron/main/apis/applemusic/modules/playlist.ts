/**
 * Apple Music 歌单模块
 */

import type { Playlist, Track } from "@shared/types/player";
import { requestAppleMusic, requestCatalog } from "../core/request";
import type { AMPlaylist, AMSong } from "../core/types";
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
    extend: "artistUrl",
  });
  const item = res.data?.[0];
  if (!item) return null;

  const playlist = transformAMPlaylist(item);
  const trackItems = [...(item.relationships?.tracks?.data || [])];
  let nextTracksUrl = item.relationships?.tracks?.next;
  while (nextTracksUrl) {
    try {
      const nextRes = await requestAppleMusic<{ data?: AMSong[]; next?: string }>({
        path: nextTracksUrl,
      });
      if (nextRes.data?.length) {
        trackItems.push(...nextRes.data);
      }
      nextTracksUrl = nextRes.next;
    } catch {
      break;
    }
  }

  const songs = trackItems.map(transformAMSong);

  return {
    playlist,
    songs,
  };
};
