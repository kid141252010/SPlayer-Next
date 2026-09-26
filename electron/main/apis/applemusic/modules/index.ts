/**
 * Apple Music 模块统一导出
 */

import { search, type SearchParams } from "./search";
import { getSongAlbums, getSongArtists, getSongDetail, getSongsDetail } from "./song";
import { getAlbumDetail } from "./album";
import { getArtistDetail } from "./artist";
import { getPlaylistDetail } from "./playlist";

export const modules = {
  search: (params: SearchParams) => search(params),
  song: (params: { id: string }) => getSongDetail(params.id),
  songs: (params: { ids: string[] }) => getSongsDetail(params.ids),
  songAlbums: (params: { id: string }) => getSongAlbums(params.id),
  songArtists: (params: { id: string }) => getSongArtists(params.id),
  album: (params: { id: string }) => getAlbumDetail(params.id),
  artist: (params: { id: string }) => getArtistDetail(params.id),
  playlist: (params: { id: string }) => getPlaylistDetail(params.id),
};

export type AppleMusicModuleName = keyof typeof modules;
