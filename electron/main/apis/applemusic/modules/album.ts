/**
 * Apple Music 专辑模块
 */

import type { Album, Track } from "@shared/types/player";
import { formatAMOriginalArtworkUrl } from "../core/artwork";
import { requestCatalog } from "../core/request";
import type { AMAlbum } from "../core/types";
import { transformAMAlbum, transformAMSong } from "./search";

interface AlbumResponse {
  data?: AMAlbum[];
}

export interface AlbumDetailResult {
  album: Album;
  songs: Track[];
}

export const getAlbumDetail = async (id: string): Promise<AlbumDetailResult | null> => {
  if (!id) return null;
  const res = await requestCatalog<AlbumResponse>(`/albums/${id}`);
  const item = res.data?.[0];
  if (!item) return null;

  const album = transformAMAlbum(item);
  const albumCoverOriginal = formatAMOriginalArtworkUrl(item.attributes.artwork?.url);
  const trackItems = item.relationships?.tracks?.data || [];
  const songs = trackItems.map((trackItem) => {
    const track = transformAMSong(trackItem);
    // 补齐所属专辑
    track.album = {
      id: album.id,
      name: album.name,
      cover: album.cover,
      artist: album.artist,
    };
    if (!track.coverOriginal && albumCoverOriginal) {
      track.coverOriginal = albumCoverOriginal;
    }
    return track;
  });

  return {
    album,
    songs,
  };
};
