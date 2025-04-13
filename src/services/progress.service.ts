import * as readline from 'readline';
import { Track } from '../models/track.model';
import { DownloadManager, DownloadProgress } from './download.service';
import { StateManager } from './state.service';
import { formatTime, formatSize } from '../utils/formatter';

export class ProgressTracker {
  private startTime: number;
  private progressBars: Map<string, number> = new Map();
  private updateInterval: NodeJS.Timeout | null = null;
  private lastOutputLines: number = 0;
  
  constructor(
    private downloadManager: DownloadManager,
    private stateManager: StateManager,
    private updateFrequencyMs: number = 200
  ) {
    this.startTime = Date.now();
    
    // Listen for download progress events
    this.downloadManager.on('progress', this.handleProgress.bind(this));
    this.downloadManager.on('complete', this.handleComplete.bind(this));
    this.downloadManager.on('fail', this.handleFail.bind(this));
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
  }

  /**
   * Handle download failure events
   */
  private handleFail(track: Track): void {
    this.progressBars.delete(track.id);
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
    lines.push(`[Aersia Downloader] Progress: ${progress.completed}/${progress.total} | Failed: ${progress.failed} | Elapsed: ${formatTime(elapsedTime)}`);
    
    // Current playlist
    const currentPlaylist = this.stateManager.getCurrentPlaylist();
    if (currentPlaylist) {
      lines.push(`\nCurrent Playlist: ${currentPlaylist}`);
    }
    
    // Active downloads
    if (stats.active > 0) {
      lines.push('\nActive Downloads:');
      
      // Get active downloads
      const activeDownloads = Array.from(this.progressBars.entries());
      for (const [trackId, percentage] of activeDownloads) {
        const progressBar = this.createProgressBar(percentage);
        const playlistState = this.stateManager.getPlaylistState(currentPlaylist);
        
        if (playlistState) {
          const track = playlistState.tracks.find(t => t.id === trackId);
          if (track) {
            const speedInfo = this.calculateSpeed(track);
            lines.push(`  ${track.title.substring(0, 30).padEnd(30, ' ')} ${progressBar} ${percentage}% ${speedInfo}`);
          }
        }
      }
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