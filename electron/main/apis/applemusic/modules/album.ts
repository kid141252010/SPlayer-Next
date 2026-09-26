/**
 * Apple Music 专辑模块
 */

import type { Album, Artist, Track } from "@shared/types/player";
import { formatAMOriginalArtworkUrl } from "../core/artwork";
import { requestAppleMusic, requestCatalog } from "../core/request";
import type { AMAlbum, AMSong } from "../core/types";
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
    include: "artists",
    "relate[songs]": "artists",
    extend: "artistUrl",
  });
  const item = res.data?.[0];
  if (!item) return null;

  const album = transformAMAlbum(item);
  const albumArtistId = item.relationships?.artists?.data?.[0]?.id;
  const albumCoverOriginal = formatAMOriginalArtworkUrl(item.attributes.artwork?.url);

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
      name: (a as any).attributes?.name || artistName,
    })) || (albumArtistId ? [{ id: albumArtistId, name: artistName }] : []);

  return {
    album,
    songs,
    artists,
  };
};
