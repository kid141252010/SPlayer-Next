/**
 * Apple Music Catalog API 类型定义
 */

export interface AMArtwork {
  width?: number;
  height?: number;
  url: string;
  bgColor?: string;
  textColor1?: string;
  textColor2?: string;
  textColor3?: string;
  textColor4?: string;
}

export interface AMPreview {
  url: string;
  hlsUrl?: string;
}

export interface AMSongAttributes {
  name: string;
  artistName: string;
  albumName?: string;
  artwork?: AMArtwork;
  durationInMillis?: number;
  trackNumber?: number;
  discNumber?: number;
  isrc?: string;
  releaseDate?: string;
  genreNames?: string[];
  url?: string;
  artistUrl?: string;
  previews?: AMPreview[];
}

export interface AMResource<T> {
  id: string;
  type: string;
  href?: string;
  attributes: T;
  relationships?: Record<
    string,
    { data?: Array<{ id: string; type: string }>; href?: string; next?: string }
  >;
}

export type AMSong = AMResource<AMSongAttributes> & {
  relationships?: {
    albums?: {
      data?: Array<AMResource<AMAlbumAttributes>>;
      href?: string;
    };
    artists?: {
      data?: Array<AMResource<AMArtistAttributes>>;
      href?: string;
    };
  };
};

export interface AMAlbumAttributes {
  name: string;
  artistName: string;
  artwork?: AMArtwork;
  trackCount?: number;
  releaseDate?: string;
  genreNames?: string[];
  recordLabel?: string;
  copyright?: string;
  url?: string;
}

export type AMAlbum = AMResource<AMAlbumAttributes> & {
  relationships?: {
    artists?: {
      data?: Array<AMResource<AMArtistAttributes>>;
      href?: string;
    };
    tracks?: {
      data?: AMSong[];
      href?: string;
      next?: string;
    };
  };
};

export interface AMArtistAttributes {
  name: string;
  artwork?: AMArtwork;
  genreNames?: string[];
  url?: string;
  editorialNotes?: {
    standard?: string;
    short?: string;
  };
}

export type AMArtist = AMResource<AMArtistAttributes> & {
  relationships?: {
    albums?: {
      data?: AMAlbum[];
    };
  };
};

export interface AMPlaylistAttributes {
  name: string;
  curatorName?: string;
  description?: {
    standard?: string;
    short?: string;
  };
  artwork?: AMArtwork;
  lastModifiedDate?: string;
  url?: string;
  trackCount?: number;
}

export type AMPlaylist = AMResource<AMPlaylistAttributes> & {
  relationships?: {
    tracks?: {
      data?: AMSong[];
      href?: string;
      next?: string;
    };
  };
};

export interface AMSearchResults {
  songs?: {
    data?: AMSong[];
    total?: number;
    next?: string;
  };
  albums?: {
    data?: AMAlbum[];
    total?: number;
    next?: string;
  };
  artists?: {
    data?: AMArtist[];
    total?: number;
    next?: string;
  };
  playlists?: {
    data?: AMPlaylist[];
    total?: number;
    next?: string;
  };
}

export interface AMSearchResponse {
  results?: AMSearchResults;
}
