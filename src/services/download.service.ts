import axios, { AxiosRequestConfig } from 'axios';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { Track, TrackStatus } from '../models/track.model';
import { RateLimiter } from '../utils/rate-limiter';
import { FileService } from './file.service';
import { Logger } from './logger.service';
import { StateManager } from './state.service';

export interface DownloadProgress {
  track: Track;
  bytesDownloaded: number;
  totalBytes: number;
  percentage: number;
}

export interface DownloadManagerOptions {
  maxConcurrent: number;
  requestsPerMinute: number;
  retryDelayMs: number;
  maxRetries: number;
  chunkSize?: number;
}

export class DownloadManager extends EventEmitter {
  private queue: Track[] = [];
  private inProgress: Map<string, { 
    track: Track, 
    abortController: AbortController,
    progress: { 
      bytesDownloaded: number, 
      totalBytes: number, 
      percentage: number 
    } 
  }> = new Map();
  private rateLimiter: RateLimiter;
  private isProcessing: boolean = false;
  private paused: boolean = false;
  
  constructor(
    private logger: Logger,
    private stateManager: StateManager,
    private fileService: FileService,
    private options: DownloadManagerOptions = {
      maxConcurrent: 3,
      requestsPerMinute: 30,
      retryDelayMs: 1000,
      maxRetries: 5
    }
  ) {
    super();
    
    // Set up rate limiter to avoid hitting server limits
    this.rateLimiter = new RateLimiter({
      tokensPerInterval: options.requestsPerMinute,
      interval: 60 * 1000, // 1 minute
    });
  }

  /**
   * Add tracks to the download queue
   */
  public addToQueue(tracks: Track[]): void {
    // Filter out tracks that are already in progress
    const newTracks = tracks.filter(track => 
      !this.inProgress.has(track.id) && 
      !this.queue.some(t => t.id === track.id)
    );
    
    this.queue.push(...newTracks);
    this.logger.info(`Added ${newTracks.length} tracks to download queue. Queue size: ${this.queue.length}`);
    
    // Start processing if not already processing
    if (!this.isProcessing && !this.paused) {
      this.processQueue();
    }
  }

  /**
   * Process the download queue, respecting concurrency limits
   */
  private async processQueue(): Promise<void> {
    if (this.paused) {
      this.logger.info('Download queue processing is paused');
      return;
    }
    
    this.isProcessing = true;
    
    while (this.queue.length > 0 && this.inProgress.size < this.options.maxConcurrent) {
      // Wait for rate limiting token
      await this.rateLimiter.removeTokens(1);
      
      // Get next track from queue with highest priority
      const track = this.getNextTrack();
      if (!track) break;
      
      // Start download and remove from queue
      this.startDownload(track);
      
      // Remove track from queue
      const index = this.queue.findIndex(t => t.id === track.id);
      if (index !== -1) {
        this.queue.splice(index, 1);
      }
    }
    
    if (this.queue.length === 0 && this.inProgress.size === 0) {
      this.isProcessing = false;
      this.emit('queue-empty');
      this.logger.info('Download queue is empty');
    } else if (this.inProgress.size < this.options.maxConcurrent && this.queue.length > 0) {
      // Continue processing after a short delay
      setTimeout(() => this.processQueue(), 500);
    }
  }

  /**
   * Get the next track to download, prioritizing:
   * 1. Previously failed tracks with lower retry counts
   * 2. Regular pending tracks
   */
  private getNextTrack(): Track | undefined {
    // First try to find a failed track with retries left
    const failedTrack = this.queue.find(track => 
      track.status === TrackStatus.FAILED && 
      (track.retryCount || 0) < this.options.maxRetries
    );
    
    if (failedTrack) return failedTrack;
    
    // Otherwise just take the first pending track
    return this.queue.find(track => 
      track.status === TrackStatus.PENDING
    );
  }

  /**
   * Start downloading a track with resume capability
   */
  private async startDownload(track: Track): Promise<void> {
    // Create abort controller for cancellation
    const abortController = new AbortController();
    
    // Mark track as in progress
    this.inProgress.set(track.id, { 
      track, 
      abortController,
      progress: {
        bytesDownloaded: track.bytesDownloaded || 0,
        totalBytes: track.totalBytes || 0,
        percentage: 0
      }
    });
    
    // Update track status
    this.stateManager.updateTrackStatus(
      track.playlistName,
      track.id,
      TrackStatus.IN_PROGRESS,
      track.bytesDownloaded || 0
    );
    
    // Emit start event
    this.emit('start', track);
    
    try {
      // Check if file already exists and is complete
      const fileInfo = await this.fileService.getFileInfo(track.filePath);
      if (fileInfo.exists && track.totalBytes && fileInfo.size === track.totalBytes) {
        this.logger.info(`File ${track.fileName} already exists and is complete, skipping`);
        
        this.stateManager.updateTrackStatus(
          track.playlistName,
          track.id,
          TrackStatus.COMPLETED,
          track.totalBytes
        );
        
        this.emit('skip', track, 'already exists and is complete');
        return;
      }
      
      // Create directory if it doesn't exist
      const dir = path.dirname(track.filePath);
      await fs.promises.mkdir(dir, { recursive: true });
      
      // Set up temporary file path for download
      const tempFilePath = `${track.filePath}.download`;
      
      // Check if we can resume a partial download
      let startByte = 0;
      if (track.bytesDownloaded && track.bytesDownloaded > 0) {
        try {
          const stats = await fs.promises.stat(tempFilePath);
          if (stats.size === track.bytesDownloaded) {
            startByte = stats.size;
            this.logger.debug(`Resuming download for ${track.fileName} from byte ${startByte}`);
          } else {
            this.logger.debug(`Temp file size (${stats.size}) doesn't match recorded bytes downloaded (${track.bytesDownloaded}), starting from 0`);
            track.bytesDownloaded = 0;
          }
        } catch (err) {
          // File doesn't exist or can't be accessed, start from beginning
          this.logger.debug(`No temp file found for ${track.fileName}, starting from beginning`);
          track.bytesDownloaded = 0;
        }
      }
      
      // Set up request with resume headers if needed
      const config: AxiosRequestConfig = {
        responseType: 'stream',
        signal: abortController.signal, // Use AbortSignal
        headers: {}
      };
      
      if (startByte > 0) {
        config.headers!['Range'] = `bytes=${startByte}-`;
        this.logger.info(`Resuming download for ${track.fileName} from byte ${startByte}`);
      }
      
      // Download the file
      const response = await axios.get(track.downloadUrl, config);
      
      // Get total size
      const totalBytes = parseInt(response.headers['content-length'] || '0', 10) + startByte;
      track.totalBytes = totalBytes;
      
      // Create or open the file for writing
      const fileMode = startByte > 0 ? 'a' : 'w';
      const writer = fs.createWriteStream(tempFilePath, { flags: fileMode });
      
      // Set up progress tracking
      let downloadedBytes = startByte;
      response.data.on('data', (chunk: Buffer) => {
        downloadedBytes += chunk.length;
        
        // Update progress more frequently
        if (downloadedBytes % 51200 === 0 || downloadedBytes === totalBytes) { // Every 50KB
          // Update track state
          this.stateManager.updateTrackStatus(
            track.playlistName,
            track.id,
            TrackStatus.IN_PROGRESS,
            downloadedBytes
          );
          
          // Calculate percentage properly
          const percentage = totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0;
          
          // Update progress in memory
          const progress = {
            track,
            bytesDownloaded: downloadedBytes,
            totalBytes,
            percentage
          };
          
          // Update in-progress map
          const inProgressEntry = this.inProgress.get(track.id);
          if (inProgressEntry) {
            inProgressEntry.progress = {
              bytesDownloaded: downloadedBytes,
              totalBytes,
              percentage
            };
          }
          
          // Emit progress event
          this.emit('progress', progress);
          
          // Log progress for debugging
          this.logger.debug(`Download progress: ${track.fileName} - ${percentage}% (${downloadedBytes}/${totalBytes} bytes)`);
        }
      });
      
      // Wait for download to complete
      await new Promise<void>((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
        response.data.pipe(writer);
      });
      
      // Move temp file to final location
      await fs.promises.rename(tempFilePath, track.filePath);
      
      // Set track metadata
      await this.fileService.setMetadata(track.filePath, track.metadata);
      
      // Mark download as complete
      this.stateManager.updateTrackStatus(
        track.playlistName,
        track.id,
        TrackStatus.COMPLETED,
        downloadedBytes
      );
      
      this.logger.info(`Successfully downloaded: ${track.fileName}`);
      this.emit('complete', track);
      
    } catch (error: any) {
      // Check if the error is due to cancellation
      if (error.name === 'AbortError' || error.code === 'ERR_CANCELED') {
        this.logger.info(`Download cancelled for ${track.fileName}`);
        return;
      }
      
      const errorMessage = error.message || 'Unknown error';
      
      // Determine whether to retry based on error type
      const shouldRetry = this.shouldRetryError(error) &&
                         (track.retryCount || 0) < this.options.maxRetries;
      
      this.logger.error(
        `Download failed for ${track.fileName}: ${errorMessage}. ` + 
        `Retry ${track.retryCount || 0}/${this.options.maxRetries}`
      );
      
      // Update track status
      this.stateManager.updateTrackStatus(
        track.playlistName,
        track.id,
        TrackStatus.FAILED,
        track.bytesDownloaded,
        errorMessage
      );
      
      // Re-queue for retry with exponential backoff if appropriate
      if (shouldRetry) {
        const retryDelay = this.calculateRetryDelay(track.retryCount || 0);
        this.logger.info(`Retrying ${track.fileName} in ${retryDelay}ms`);
        
        setTimeout(() => {
          this.queue.push(track);
          this.emit('retry', track, errorMessage);
        }, retryDelay);
      } else {
        this.emit('fail', track, errorMessage);
      }
    } finally {
      // Remove from in-progress map
      this.inProgress.delete(track.id);
      
      // Continue processing queue
      this.processQueue();
    }
  }

  /**
   * Check if an error is retryable
   */
  private shouldRetryError(error: any): boolean {
    // Network errors are retryable
    if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
      return true;
    }
    
    // Server errors (5xx) are retryable
    if (error.response && error.response.status >= 500 && error.response.status < 600) {
      return true;
    }
    
    // Too many requests (429) is retryable
    if (error.response && error.response.status === 429) {
      return true;
    }
    
    // Abort errors are not retryable
    if (error.name === 'AbortError' || error.code === 'ERR_CANCELED') {
      return false;
    }
    
    return false;
  }

  /**
   * Calculate retry delay with exponential backoff
   */
  private calculateRetryDelay(retryCount: number): number {
    return Math.min(
      this.options.retryDelayMs * Math.pow(2, retryCount),
      60000 // Max 1 minute
    );
  }

  /**
   * Pause download processing
   */
  public pause(): void {
    this.paused = true;
    this.logger.info('Download queue processing paused');
    this.emit('pause');
  }

  /**
   * Resume download processing
   */
  public resume(): void {
    this.paused = false;
    this.logger.info('Download queue processing resumed');
    this.emit('resume');
    
    if (!this.isProcessing) {
      this.processQueue();
    }
  }

  /**
   * Cancel a specific download
   */
  public cancel(trackId: string): boolean {
    const download = this.inProgress.get(trackId);
    if (download) {
      download.abortController.abort(); // Use abort() instead of cancel()
      this.inProgress.delete(trackId);
      return true;
    }
    
    // Check if it's in the queue
    const queueIndex = this.queue.findIndex(t => t.id === trackId);
    if (queueIndex !== -1) {
      this.queue.splice(queueIndex, 1);
      return true;
    }
    
    return false;
  }

  /**
   * Cancel all downloads
   */
  public cancelAll(): void {
    // Cancel all in-progress downloads
    for (const [, download] of this.inProgress) {
      download.abortController.abort(); // Use abort() instead of cancel()
    }
    
    this.inProgress.clear();
    this.queue = [];
    
    this.logger.info('All downloads canceled');
    this.emit('cancel-all');
  }

  /**
   * Clear the download queue without canceling in-progress downloads
   */
  public clearQueue(): void {
    const queueSize = this.queue.length;
    this.queue = [];
    this.logger.info(`Cleared download queue (${queueSize} tracks removed)`);
  }

  /**
   * Get current download statistics
   */
  public getStats() {
    return {
      queued: this.queue.length,
      active: this.inProgress.size,
      paused: this.paused
    };
  }

  /**
   * Get active downloads with progress information
   */
  public getActiveDownloadsForPlaylist(playlistName: string): Array<{track: Track, progress: any}> {
    const result = [];
    
    for (const [, data] of this.inProgress) {
      if (data.track.playlistName === playlistName) {
        result.push({
          track: data.track,
          progress: data.progress
        });
      }
    }
    
    return result;
  }
}