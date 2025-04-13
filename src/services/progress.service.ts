import * as readline from 'readline';
import { Track } from '../models/track.model';
import { formatSize, formatTime, truncate } from '../utils/formatter';
import { DownloadManager, DownloadProgress } from './download.service';
import { Logger } from './logger.service';
import { StateManager } from './state.service';

interface TrackEvent {
  time: string;
  type: string;
  message: string;
  playlistName: string;
}

export class ProgressTracker {
  private startTime: number;
  private progressBars: Map<string, number> = new Map();
  private updateInterval: NodeJS.Timeout | null = null;
  private lastOutputLines: number = 0;
  private events: TrackEvent[] = [];
  
  constructor(
    private downloadManager: DownloadManager,
    private stateManager: StateManager,
    private logger: Logger,
    private updateFrequencyMs: number = 200
  ) {
    this.startTime = Date.now();
    
    // Listen for download progress events
    this.downloadManager.on('progress', this.handleProgress.bind(this));
    this.downloadManager.on('complete', this.handleComplete.bind(this));
    this.downloadManager.on('fail', this.handleFail.bind(this));
    this.downloadManager.on('skip', this.handleSkip.bind(this));
    this.downloadManager.on('retry', this.handleRetry.bind(this));
    this.downloadManager.on('start', this.handleStart.bind(this));
  }

  /**
   * Start displaying progress in the console
   */
  public start(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
    }
    
    this.updateInterval = setInterval(() => {
      this.render();
    }, this.updateFrequencyMs);
    
    // Initial render
    this.render();
  }

  /**
   * Stop displaying progress
   */
  public stop(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    
    // Clear previous output
    this.clearOutput();
  }

  /**
   * Log an event for a track
   */
  public logEvent(type: string, message: string, track?: Track): void {
    const time = new Date().toLocaleTimeString();
    const playlistName = track ? track.playlistName : this.stateManager.getCurrentPlaylist();
    
    this.events.push({ time, type, message, playlistName });
    
    // Keep only the most recent 100 events
    if (this.events.length > 100) {
      this.events.shift();
    }
    
    // Also log to logger if it's a significant event
    if (type === 'COMPLETE' || type === 'FAIL' || type === 'SKIP') {
      this.logger.info(`[${type}] ${message}`);
    }
  }

  /**
   * Handle progress update events
   */
  private handleProgress(progress: DownloadProgress): void {
    this.progressBars.set(progress.track.id, progress.percentage);
  }

  /**
   * Handle download completion events
   */
  private handleComplete(track: Track): void {
    this.progressBars.delete(track.id);
    this.logEvent('COMPLETE', `Downloaded: ${track.fileName}`, track);
  }

  /**
   * Handle download failure events
   */
  private handleFail(track: Track, error: string): void {
    this.progressBars.delete(track.id);
    this.logEvent('FAIL', `Failed: ${track.fileName} (${error})`, track);
  }

  /**
   * Handle download skip events
   */
  private handleSkip(track: Track, reason: string): void {
    this.logEvent('SKIP', `Skipped: ${track.fileName} (${reason})`, track);
  }

  /**
   * Handle download retry events
   */
  private handleRetry(track: Track, reason: string): void {
    this.logEvent('RETRY', `Retrying: ${track.fileName} (${reason})`, track);
  }

  /**
   * Handle download start events
   */
  private handleStart(track: Track): void {
    this.logEvent('START', `Started: ${track.fileName}`, track);
  }

  /**
   * Get recent events, optionally filtered by playlist
   */
  private getRecentEvents(count: number, playlistName?: string): TrackEvent[] {
    if (playlistName) {
      return this.events
        .filter(event => event.playlistName === playlistName)
        .slice(-count);
    }
    return this.events.slice(-count);
  }

  /**
   * Clear previous console output
   */
  private clearOutput(): void {
    if (this.lastOutputLines > 0) {
      readline.moveCursor(process.stdout, 0, -this.lastOutputLines);
      readline.clearScreenDown(process.stdout);
    }
  }

  /**
   * Render the progress display
   */
  private render(): void {
    this.clearOutput();
    
    const stats = this.downloadManager.getStats();
    const progress = this.stateManager.getOverallProgress();
    const elapsedTime = Date.now() - this.startTime;
    
    // Build output
    const lines: string[] = [];
    
    // Summary line
    lines.push(`[Aersia Downloader] Overall Progress: ${progress.completed}/${progress.total} | Failed: ${progress.failed} | Elapsed: ${formatTime(elapsedTime)}`);
    
    // Show progress per playlist
    const playlists = this.stateManager.getAllPlaylists();
    if (playlists.length > 0) {
      lines.push('\nProgress by Playlist:');
      
      playlists.forEach(playlist => {
        const playlistStats = this.stateManager.getPlaylistStats(playlist.name);
        const total = playlistStats.total;
        const completed = playlistStats.completed;
        
        // Skip empty playlists
        if (total === 0) return;
        
        const completionPercentage = Math.round((completed / total) * 100);
        
        // Make progress bar clearer with exact numbers
        const progressBar = this.createProgressBar(completionPercentage);
        lines.push(`  ${playlist.name.padEnd(10)} ${progressBar} ${completed}/${total} (${completionPercentage}%)`);
      });
    }
    
    // Current playlist
    const currentPlaylist = this.stateManager.getCurrentPlaylist();
    if (currentPlaylist) {
      lines.push(`\nCurrent Playlist: ${currentPlaylist}`);
      
      // Show breakdown of current playlist status
      const playlistStats = this.stateManager.getPlaylistStats(currentPlaylist);
      lines.push(`  Completed: ${playlistStats.completed}, Pending: ${playlistStats.pending}, Failed: ${playlistStats.failed}`);
    }
    
    // Active downloads with more details
    const activeDownloads = this.downloadManager.getActiveDownloadsForPlaylist(currentPlaylist);
    if (activeDownloads.length > 0) {
      lines.push('\nActive Downloads:');
      
      activeDownloads.forEach(download => {
        const { track, progress } = download;
        const progressBar = this.createProgressBar(progress.percentage);
        const speedInfo = this.calculateSpeed(track);
        const fileInfo = truncate(track.fileName, 40).padEnd(40);
        
        lines.push(`  ${fileInfo} ${progressBar} ${progress.percentage}% ${formatSize(progress.bytesDownloaded)}/${formatSize(progress.totalBytes)} ${speedInfo}`);
      });
    }
    
    // Recent activity (last 5 events)
    lines.push('\nRecent Activity:');
    const recentEvents = currentPlaylist 
      ? this.getRecentEvents(5, currentPlaylist) 
      : this.getRecentEvents(5);
    
    if (recentEvents.length === 0) {
      lines.push('  No activity yet');
    } else {
      recentEvents.forEach(event => {
        lines.push(`  ${event.time} - ${event.type}: ${event.message}`);
      });
    }
    
    // Queue status
    lines.push(`\nQueue: ${stats.queued} tracks${stats.paused ? ' (PAUSED)' : ''}`);
    
    // Print output
    process.stdout.write(lines.join('\n') + '\n');
    this.lastOutputLines = lines.length;
  }

  /**
   * Create a visual progress bar
   */
  private createProgressBar(percentage: number, width: number = 20): string {
    const filledWidth = Math.floor((percentage / 100) * width);
    const emptyWidth = width - filledWidth;
    
    return `[${'='.repeat(filledWidth)}${' '.repeat(emptyWidth)}]`;
  }

  /**
   * Calculate download speed
   */
  private calculateSpeed(track: Track): string {
    if (!track.bytesDownloaded || !track.totalBytes) {
      return '';
    }
    
    // Very simple speed calculation based on elapsed time
    // In a real implementation, you'd want to track chunks over time for more accuracy
    const elapsed = Date.now() - this.startTime;
    const bytesPerSecond = (track.bytesDownloaded / elapsed) * 1000;
    
    const remainingBytes = track.totalBytes - track.bytesDownloaded;
    const remainingTime = bytesPerSecond > 0 ? (remainingBytes / bytesPerSecond) * 1000 : 0;
    
    return `${formatSize(bytesPerSecond)}/s - ${formatTime(remainingTime)} remaining`;
  }
}