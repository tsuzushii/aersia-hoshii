export enum TrackStatus {
    PENDING = 'pending',
    IN_PROGRESS = 'in_progress',
    COMPLETED = 'completed',
    FAILED = 'failed',
    SKIPPED = 'skipped'
  }
  
  export interface TrackMetadata {
    title: string;
    artist: string;
    album?: string;
    year?: string;
  }
  
  export interface Track {
    id: string;             // Unique identifier for the track
    playlistName: string;   // Name of the playlist this track belongs to
    game?: string;          // Game name (for new playlists)
    title: string;          // Track title
    artist?: string;        // Artist/composer
    downloadUrl: string;    // URL to download the track
    fileName: string;       // Target filename (sanitized)
    filePath: string;       // Full path where track will be saved
    fileExt: string;        // File extension (usually m4a)
    metadata: TrackMetadata; // Metadata to be written to the file
    
    // For state tracking
    status?: TrackStatus;
    bytesDownloaded?: number;
    totalBytes?: number;
    retryCount?: number;
    lastError?: string;
    
    // Source track properties (for reference)
    sourceTrack: any;      // Original track object from playlist
  }
  
  export interface NewPlaylistTrack {
    id: number;
    game: string;
    title: string;
    comp: string;
    arr: string;
    file: string;
    s_id?: number;
    s_title?: string;
    s_file?: string;
  }
  
  export interface OldPlaylistTrack {
    creator: string[];
    title: string[];
    location: string[];
  }
  
  export interface PlaylistMetadata {
    changelog: string;
    url: string;
    ext: string;
    new_id?: string;
  }