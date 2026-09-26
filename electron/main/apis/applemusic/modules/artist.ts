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
        "top-songs"?: { data?: AMSong[] };
        "full-albums"?: { data?: AMAlbum[] };
      };
    }
  >;
}

export interface ArtistDetailResult {
  artist: Artist;
  songs: Track[];
  albums: Album[];
  description?: string;
}

export const getArtistDetail = async (id: string): Promise<ArtistDetailResult | null> => {
  if (!id) return null;
  const res = await requestCatalog<ArtistResponse>(`/artists/${id}`, {
    views: "top-songs,full-albums",
    "relate[songs]": "albums,artists",
  });
  const item = res.data?.[0];
  if (!item) return null;

  const artist = transformAMArtist(item);
  const songItems = item.views?.["top-songs"]?.data || [];
  const albumItems = item.views?.["full-albums"]?.data || item.relationships?.albums?.data || [];

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
    description: item.attributes.editorialNotes?.standard || item.attributes.editorialNotes?.short,
  };
};
