/**
 * Apple Music 专辑模块
 */

import type { Album, Artist, Track } from "@shared/types/player";
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
  artists?: Artist[];
}

export const getAlbumDetail = async (id: string): Promise<AlbumDetailResult | null> => {
  if (!id) return null;
  const res = await requestCatalog<AlbumResponse>(`/albums/${id}`, {
    "relate[songs]": "artists",
  });
  const item = res.data?.[0];
  if (!item) return null;

  const album = transformAMAlbum(item);
  const albumArtistId = item.relationships?.artists?.data?.[0]?.id;
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
    // 若曲目缺歌手 ID，补齐专辑主歌手 ID
    if (albumArtistId && track.artists.length > 0 && !track.artists[0].id) {
      track.artists[0].id = albumArtistId;
    }
    if (!track.coverOriginal && albumCoverOriginal) {
      track.coverOriginal = albumCoverOriginal;
    }
    return track;
  });

  const artistName = album.artist || "";
  const artists: Artist[] =
    item.relationships?.artists?.data?.map((a) => ({
      id: a.id,
      name: artistName,
    })) || (albumArtistId ? [{ id: albumArtistId, name: artistName }] : []);

  return {
    album,
    songs,
    artists,
  };
};
