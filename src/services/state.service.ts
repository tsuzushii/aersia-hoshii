import * as fs from 'fs';
import * as path from 'path';
import { Track, TrackStatus } from '../models/track.model';
import { Logger } from './logger.service';

export interface DownloadState {
  playlists: {
    [playlistName: string]: {
      tracks: Track[];
      completed: boolean;
      lastUpdated: Date;
      totalCount: number;      // Added total count from source
      completedCount: number;  // Added completed count
      pendingCount: number;    // Added pending count
      failedCount: number;     // Added failed count
    }
  };
  currentPlaylist: string;
  overallProgress: {
    total: number;
    completed: number;
    failed: number;
    pending: number;
  };
  startTime: Date;
  resumeData?: {
    timestamp: Date;
    reason: string;
  };
}

export class StateManager {
  private state: DownloadState;
  private stateFilePath: string;
  private autoSaveInterval: NodeJS.Timeout | null = null;
  private stateLogInterval: NodeJS.Timeout | null = null;
  
  constructor(baseDir: string = './', private logger: Logger) {
    this.stateFilePath = path.join(baseDir, '.aersia-state.json');
    this.state = this.loadState() || this.createInitialState();
    this.setupAutoSave();
  }

  private createInitialState(): DownloadState {
    return {
      playlists: {},
      currentPlaylist: '',
      overallProgress: {
        total: 0,
        completed: 0,
        failed: 0,
        pending: 0
      },
      startTime: new Date()
    };
  }

  private loadState(): DownloadState | null {
    try {
      if (fs.existsSync(this.stateFilePath)) {
        const stateData = fs.readFileSync(this.stateFilePath, 'utf8');
        const state = JSON.parse(stateData) as DownloadState;
        
        // Convert string dates back to Date objects
        state.startTime = new Date(state.startTime);
        if (state.resumeData) {
          state.resumeData.timestamp = new Date(state.resumeData.timestamp);
        }
        
        Object.values(state.playlists).forEach(playlist => {
          playlist.lastUpdated = new Date(playlist.lastUpdated);
          
          // Initialize count fields if they don't exist
          if (playlist.totalCount === undefined) playlist.totalCount = playlist.tracks.length || 0;
          if (playlist.completedCount === undefined) playlist.completedCount = 0;
          if (playlist.pendingCount === undefined) playlist.pendingCount = 0;
          if (playlist.failedCount === undefined) playlist.failedCount = 0;
        });
        
        this.logger.info(`Loaded existing state file: ${this.stateFilePath}`);
        return state;
      }
    } catch (error) {
      this.logger.error(`Error loading state: ${error}`);
    }
    return null;
  }

  private setupAutoSave(intervalMs: number = 5000): void {
    this.autoSaveInterval = setInterval(() => {
      this.saveState();
    }, intervalMs);
  }

  public saveState(): void {
    try {
      const stateDir = path.dirname(this.stateFilePath);
      if (!fs.existsSync(stateDir)) {
        fs.mkdirSync(stateDir, { recursive: true });
      }
      
      fs.writeFileSync(
        this.stateFilePath, 
        JSON.stringify(this.state, null, 2)
      );
    } catch (error) {
      this.logger.error(`Error saving state: ${error}`);
    }
  }

  public initPlaylist(name: string, tracks: Track[]): void {
    if (!this.state.playlists[name]) {
      this.state.playlists[name] = {
        tracks: [],
        completed: false,
        lastUpdated: new Date(),
        totalCount: 0,
        completedCount: 0,
        pendingCount: 0,
        failedCount: 0
      };
      this.logger.info(`Initialized new playlist: ${name}`);
    } else {
      this.logger.info(`Updating existing playlist: ${name}`);
    }
    
    // Check and fix malformed IDs in existing state
    if (this.state.playlists[name].tracks.some(t => t.id === `${name}-undefined`)) {
      this.logger.warn(`Found tracks with malformed IDs in ${name} playlist, fixing...`);
      this.state.playlists[name].tracks.forEach(track => {
        if (track.id === `${name}-undefined`) {
          // Generate a new unique ID for this track
          track.id = `${name}-${Math.random().toString(36).substring(2, 10)}`;
        }
      });
    }
    
    // Add new tracks that don't exist in the current state
    // Use filePath for comparison since IDs might have been regenerated
    const existingFilePaths = new Set(this.state.playlists[name].tracks.map(t => t.filePath));
    let newTracksCount = 0;
    
    tracks.forEach(track => {
      if (!existingFilePaths.has(track.filePath)) {
        // Track is new, add it to state
        this.state.playlists[name].tracks.push({
          ...track,
          status: track.status || TrackStatus.PENDING,
          retryCount: track.retryCount || 0,
          bytesDownloaded: track.bytesDownloaded || 0
        });
        newTracksCount++;
      } else {
        // Update existing track status based on input track if needed
        const existingTrack = this.state.playlists[name].tracks.find(t => t.filePath === track.filePath);
        if (existingTrack && track.status === TrackStatus.COMPLETED && existingTrack.status !== TrackStatus.COMPLETED) {
          existingTrack.status = TrackStatus.COMPLETED;
          existingTrack.bytesDownloaded = 1; // Just a placeholder for completed
          this.logger.debug(`Updated track status to COMPLETED: ${track.fileName}`);
        }
      }
    });
    
    this.logger.info(`Added ${newTracksCount} new tracks to playlist ${name}`);
    
    // Update total count to reflect the actual number of tracks for this playlist
    this.state.playlists[name].totalCount = tracks.length;
    
    // Recalculate counts for this playlist
    this.recalculatePlaylistCounts(name);
    
    // Recalculate overall progress
    this.recalculateProgress();
    
    // Save state
    this.saveState();
  }

  /**
   * Recalculate count statistics for a specific playlist
   */
  private recalculatePlaylistCounts(playlistName: string): void {
    const playlist = this.state.playlists[playlistName];
    if (!playlist) return;
    
    let completed = 0;
    let failed = 0;
    let pending = 0;
    
    playlist.tracks.forEach(track => {
      switch (track.status) {
        case TrackStatus.COMPLETED:
        case TrackStatus.SKIPPED:
          completed++;
          break;
        case TrackStatus.FAILED:
          failed++;
          break;
        case TrackStatus.PENDING:
        case TrackStatus.IN_PROGRESS:
          pending++;
          break;
      }
    });
    
    playlist.completedCount = completed;
    playlist.failedCount = failed;
    playlist.pendingCount = pending;
    
    // Check if playlist is completed
    const allCompleted = playlist.tracks.every(
      t => t.status === TrackStatus.COMPLETED || t.status === TrackStatus.SKIPPED
    );
    
    if (allCompleted && !playlist.completed) {
      this.logger.info(`Playlist ${playlistName} is now complete!`);
    }
    
    playlist.completed = allCompleted;
  }

  public updateTrackStatus(
    playlistName: string, 
    trackId: string, 
    status: TrackStatus, 
    bytesDownloaded?: number,
    error?: string
  ): void {
    const playlist = this.state.playlists[playlistName];
    if (!playlist) {
      this.logger.warn(`Attempted to update track in non-existent playlist: ${playlistName}`);
      return;
    }
    
    const trackIndex = playlist.tracks.findIndex(t => t.id === trackId);
    if (trackIndex === -1) {
      this.logger.warn(`Attempted to update non-existent track: ${trackId} in playlist ${playlistName}`);
      return;
    }
    
    const track = playlist.tracks[trackIndex];
    const oldStatus = track.status;
    
    // Update track status
    track.status = status;
    if (bytesDownloaded !== undefined) {
      track.bytesDownloaded = bytesDownloaded;
    }
    
    if (status === TrackStatus.FAILED) {
      track.retryCount = (track.retryCount || 0) + 1;
      track.lastError = error;
      this.logger.debug(`Track ${track.fileName} failed: ${error} (Retry #${track.retryCount})`);
    }
    
    // If status has changed, log it
    if (oldStatus !== status) {
      this.logger.debug(`Track status changed: ${track.fileName} - ${oldStatus} -> ${status}`);
    }
    
    // Update playlist lastUpdated timestamp
    playlist.lastUpdated = new Date();
    
    // Recalculate counts for this playlist
    this.recalculatePlaylistCounts(playlistName);
    
    // Recalculate overall progress
    this.recalculateProgress();
    
    // Save state
    this.saveState();
  }

  public getCurrentPlaylist(): string {
    return this.state.currentPlaylist;
  }

  public setCurrentPlaylist(playlistName: string): void {
    this.state.currentPlaylist = playlistName;
    this.saveState();
  }

  private recalculateProgress(): void {
    let total = 0;
    let completed = 0;
    let failed = 0;
    let pending = 0;
    
    Object.values(this.state.playlists).forEach(playlist => {
      total += playlist.totalCount;
      completed += playlist.completedCount;
      failed += playlist.failedCount;
      pending += playlist.pendingCount;
    });
    
    this.state.overallProgress = {
      total,
      completed,
      failed,
      pending
    };
  }

  public getPlaylistState(playlistName: string) {
    return this.state.playlists[playlistName];
  }

  public getOverallProgress() {
    return this.state.overallProgress;
  }

  public getPendingTracks(playlistName: string): Track[] {
    const playlist = this.state.playlists[playlistName];
    if (!playlist) {
      this.logger.warn(`Attempted to get pending tracks for non-existent playlist: ${playlistName}`);
      return [];
    }
    
    // Create a map of all files that actually exist in the playlist directory
    const existingFiles = new Map<string, boolean>();
    try {
      const playlistDir = path.join(process.cwd(), 'Aersia Playlists', playlistName);
      if (fs.existsSync(playlistDir)) {
        const files = fs.readdirSync(playlistDir);
        files.forEach(file => {
          existingFiles.set(file.toLowerCase(), true);
        });
        this.logger.debug(`Found ${files.length} files in ${playlistName} directory`);
      }
    } catch (error) {
      this.logger.error(`Error checking playlist directory: ${error}`);
    }
    
    // For each track, verify if file exists on disk
    let updatedTracks = 0;
    playlist.tracks.forEach(track => {
      const fileName = path.basename(track.filePath);
      const fileExists = existingFiles.has(fileName.toLowerCase());
      
      if (track.status === TrackStatus.COMPLETED && !fileExists) {
        track.status = TrackStatus.PENDING;
        track.bytesDownloaded = 0;
        updatedTracks++;
        this.logger.debug(`File missing for completed track, reverted to PENDING: ${track.fileName}`);
      } else if (track.status !== TrackStatus.COMPLETED && fileExists) {
        track.status = TrackStatus.COMPLETED;
        track.bytesDownloaded = 1; // Just a placeholder
        updatedTracks++;
        this.logger.debug(`File exists for non-completed track, updated to COMPLETED: ${track.fileName}`);
      }
    });
    
    if (updatedTracks > 0) {
      this.logger.info(`Updated status for ${updatedTracks} tracks in ${playlistName} based on file existence check`);
      // Recalculate counts
      this.recalculatePlaylistCounts(playlistName);
      this.recalculateProgress();
      this.saveState();
    }
    
    // After verification, get pending tracks
    const pendingTracks = playlist.tracks.filter(
      t => t.status === TrackStatus.PENDING || 
         (t.status === TrackStatus.FAILED && (t.retryCount || 0) < 5)
    );
    
    this.logger.info(`Found ${pendingTracks.length} pending tracks in playlist ${playlistName}`);
    return pendingTracks;
  }

  public getPlaylistStats(playlistName: string): { 
    total: number, 
    completed: number, 
    failed: number, 
    pending: number 
  } {
    const playlist = this.state.playlists[playlistName];
    if (!playlist) {
      return { total: 0, completed: 0, failed: 0, pending: 0 };
    }
    
    return {
      total: playlist.totalCount,
      completed: playlist.completedCount,
      failed: playlist.failedCount,
      pending: playlist.pendingCount
    };
  }

  public getAllPlaylists(): Array<{name: string, completed: boolean}> {
    return Object.entries(this.state.playlists).map(([name, playlist]) => ({
      name,
      completed: playlist.completed
    }));
  }

  public getPlaylistDetailedState(playlistName: string): any {
    const playlist = this.state.playlists[playlistName];
    if (!playlist) return null;
    
    // Count tracks by status
    const statusCounts = {
      completed: playlist.completedCount,
      skipped: playlist.tracks.filter(t => t.status === TrackStatus.SKIPPED).length,
      pending: playlist.pendingCount,
      in_progress: playlist.tracks.filter(t => t.status === TrackStatus.IN_PROGRESS).length,
      failed: playlist.failedCount
    };
    
    return {
      name: playlistName,
      completed: playlist.completed,
      lastUpdated: playlist.lastUpdated,
      trackCount: playlist.totalCount,
      statusCounts,
      // Include sample of tracks in each state for debugging
      sampleTracks: {
        completed: this.getSampleTracks(playlist.tracks, TrackStatus.COMPLETED, 3),
        skipped: this.getSampleTracks(playlist.tracks, TrackStatus.SKIPPED, 3),
        pending: this.getSampleTracks(playlist.tracks, TrackStatus.PENDING, 3),
        in_progress: this.getSampleTracks(playlist.tracks, TrackStatus.IN_PROGRESS, 3),
        failed: this.getSampleTracks(playlist.tracks, TrackStatus.FAILED, 3)
      }
    };
  }

  private getSampleTracks(tracks: Track[], status: TrackStatus, count: number): any[] {
    return tracks
      .filter(track => track.status === status)
      .slice(0, count)
      .map(track => ({
        id: track.id,
        fileName: track.fileName,
        bytesDownloaded: track.bytesDownloaded,
        totalBytes: track.totalBytes,
        retryCount: track.retryCount,
        lastError: track.lastError
      }));
  }

  public startPeriodicStateLogging(intervalMs: number = 60000): void {
    // Log state every minute by default
    this.stateLogInterval = setInterval(() => {
      const currentPlaylist = this.getCurrentPlaylist();
      if (currentPlaylist) {
        const state = this.getPlaylistDetailedState(currentPlaylist);
        this.logger.debug(`Playlist state for ${currentPlaylist}: ${JSON.stringify(state.statusCounts)}`);
      }
      
      // Also log overall progress
      const overall = this.getOverallProgress();
      this.logger.debug(`Overall progress: ${overall.completed}/${overall.total} completed, ${overall.failed} failed, ${overall.pending} pending`);
      
      // Log progress for each playlist in a simple format
      this.logSimplePlaylistProgress();
    }, intervalMs);
  }

  /**
   * Log a simple progress summary for all playlists
   */
  public logSimplePlaylistProgress(): void {
    const playlistProgress = Object.entries(this.state.playlists)
      .map(([name, playlist]) => `${name} ${playlist.completedCount}/${playlist.totalCount}`)
      .join(' ');
    
    this.logger.info(`Playlist Progress: ${playlistProgress}`);
  }

  public stopPeriodicStateLogging(): void {
    if (this.stateLogInterval) {
      clearInterval(this.stateLogInterval);
      this.stateLogInterval = null;
    }
  }

  public getResumeInfo(): string {
    const { completed, total, failed } = this.state.overallProgress;
    
    // Get progress for each playlist
    const playlistProgress = Object.entries(this.state.playlists)
      .map(([name, playlist]) => `${name}: ${playlist.completedCount}/${playlist.totalCount}`)
      .join(', ');
    
    return `Resume information:
  - Started: ${this.state.startTime.toLocaleString()}
  - Overall Progress: ${completed}/${total} (${failed} failed)
  - Playlist Progress: ${playlistProgress}`;
  }

  public cleanup(): void {
    if (this.autoSaveInterval) {
      clearInterval(this.autoSaveInterval);
      this.autoSaveInterval = null;
    }
    
    if (this.stateLogInterval) {
      clearInterval(this.stateLogInterval);
      this.stateLogInterval = null;
    }
    
    // Final save
    this.saveState();
  }
}