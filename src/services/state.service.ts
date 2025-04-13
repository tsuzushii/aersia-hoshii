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
        lastUpdated: new Date()
      };
      this.logger.info(`Initialized new playlist: ${name}`);
    } else {
      this.logger.info(`Updating existing playlist: ${name}`);
    }
    
    // Add new tracks that don't exist in the current state
    const existingIds = new Set(this.state.playlists[name].tracks.map(t => t.id));
    let newTracksCount = 0;
    
    tracks.forEach(track => {
      if (!existingIds.has(track.id)) {
        // If track is new, add it with PENDING status
        this.state.playlists[name].tracks.push({
          ...track,
          status: track.status || TrackStatus.PENDING,
          retryCount: track.retryCount || 0,
          bytesDownloaded: track.bytesDownloaded || 0
        });
        newTracksCount++;
      }
    });
    
    this.logger.info(`Added ${newTracksCount} new tracks to playlist ${name}`);
    
    // Verify if any tracks marked as completed actually exist
    this.validateCompletedTracks(name);
    
    this.recalculateProgress();
    this.saveState();
  }

  /**
   * Verify that tracks marked as completed actually have files on disk
   */
  private validateCompletedTracks(playlistName: string): void {
    const playlist = this.state.playlists[playlistName];
    if (!playlist) return;
    
    let revertedTracks = 0;
    
    playlist.tracks.forEach(track => {
      if (track.status === TrackStatus.COMPLETED) {
        // Check if the file actually exists
        try {
          if (!fs.existsSync(track.filePath)) {
            // File doesn't exist despite being marked as completed
            track.status = TrackStatus.PENDING;
            track.bytesDownloaded = 0;
            revertedTracks++;
            this.logger.warn(`Track marked completed but file not found, reverting to pending: ${track.fileName}`);
          }
        } catch (error) {
          // If there's an error checking, assume file doesn't exist
          track.status = TrackStatus.PENDING;
          track.bytesDownloaded = 0;
          revertedTracks++;
        }
      }
    });
    
    if (revertedTracks > 0) {
      this.logger.info(`Reverted ${revertedTracks} tracks from completed to pending in playlist ${playlistName}`);
    }
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
    
    // Check if playlist is completed
    const allCompleted = playlist.tracks.every(
      t => t.status === TrackStatus.COMPLETED || t.status === TrackStatus.SKIPPED
    );
    
    if (allCompleted && !playlist.completed) {
      this.logger.info(`Playlist ${playlistName} is now complete!`);
    }
    
    playlist.completed = allCompleted;
    
    this.recalculateProgress();
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
      playlist.tracks.forEach(track => {
        total++;
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
    
    return {
      total: playlist.tracks.length,
      completed,
      failed,
      pending
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
      completed: 0,
      skipped: 0,
      pending: 0,
      in_progress: 0,
      failed: 0
    };
    
    playlist.tracks.forEach(track => {
      switch (track.status) {
        case TrackStatus.COMPLETED:
          statusCounts.completed++;
          break;
        case TrackStatus.SKIPPED:
          statusCounts.skipped++;
          break;
        case TrackStatus.PENDING:
          statusCounts.pending++;
          break;
        case TrackStatus.IN_PROGRESS:
          statusCounts.in_progress++;
          break;
        case TrackStatus.FAILED:
          statusCounts.failed++;
          break;
      }
    });
    
    return {
      name: playlistName,
      completed: playlist.completed,
      lastUpdated: playlist.lastUpdated,
      trackCount: playlist.tracks.length,
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
    }, intervalMs);
  }

  public stopPeriodicStateLogging(): void {
    if (this.stateLogInterval) {
      clearInterval(this.stateLogInterval);
      this.stateLogInterval = null;
    }
  }

  public getResumeInfo(): string {
    const { completed, total, failed } = this.state.overallProgress;
    return `Resume information:
  - Started: ${this.state.startTime.toLocaleString()}
  - Progress: ${completed}/${total} (${failed} failed)
  - Playlists: ${Object.keys(this.state.playlists).join(', ')}`;
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