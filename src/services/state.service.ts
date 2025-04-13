import * as fs from 'fs';
import * as path from 'path';
import { Track, TrackStatus } from '../models/track.model';
 

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
  
  constructor(baseDir: string = './') {
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
        
        return state;
      }
    } catch (error) {
      console.error('Error loading state:', error);
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
      console.error('Error saving state:', error);
    }
  }

  public initPlaylist(name: string, tracks: Track[]): void {
    if (!this.state.playlists[name]) {
      this.state.playlists[name] = {
        tracks: [],
        completed: false,
        lastUpdated: new Date()
      };
    }
    
    // Add new tracks that don't exist in the current state
    const existingIds = new Set(this.state.playlists[name].tracks.map(t => t.id));
    tracks.forEach(track => {
      if (!existingIds.has(track.id)) {
        // If track is new, add it with PENDING status
        this.state.playlists[name].tracks.push({
          ...track,
          status: TrackStatus.PENDING,
          retryCount: 0,
          bytesDownloaded: 0
        });
      }
    });
    
    this.recalculateProgress();
    this.saveState();
  }

  public updateTrackStatus(
    playlistName: string, 
    trackId: string, 
    status: TrackStatus, 
    bytesDownloaded?: number,
    error?: string
  ): void {
    const playlist = this.state.playlists[playlistName];
    if (!playlist) return;
    
    const trackIndex = playlist.tracks.findIndex(t => t.id === trackId);
    if (trackIndex === -1) return;
    
    const track = playlist.tracks[trackIndex];
    
    // Update track status
    track.status = status;
    if (bytesDownloaded !== undefined) {
      track.bytesDownloaded = bytesDownloaded;
    }
    
    if (status === TrackStatus.FAILED) {
      track.retryCount = (track.retryCount || 0) + 1;
      track.lastError = error;
    }
    
    // Update playlist lastUpdated timestamp
    playlist.lastUpdated = new Date();
    
    // Check if playlist is completed
    const allCompleted = playlist.tracks.every(
      t => t.status === TrackStatus.COMPLETED || t.status === TrackStatus.SKIPPED
    );
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
    if (!playlist) return [];
    
    return playlist.tracks.filter(
      t => t.status === TrackStatus.PENDING || 
           (t.status === TrackStatus.FAILED && (t.retryCount || 0) < 5)
    );
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
    }
  }
}