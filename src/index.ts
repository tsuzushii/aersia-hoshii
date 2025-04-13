#!/usr/bin/env node
import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { loadConfig } from './config/config';
import { Track } from './models/track.model';
import { DownloadManager } from './services/download.service';
import { FileService } from './services/file.service';
import { Logger, LogLevel } from './services/logger.service';
import { PlaylistService } from './services/playlist.service';
import { ProgressTracker } from './services/progress.service';
import { StateManager } from './services/state.service';

// Setup command line interface
const program = new Command();
program
  .name('aersia-hoshii')
  .description('Download tracks from Aersia playlists with resume capability')
  .version('2.0.0')
  .option('-p, --playlists <playlists>', 'Comma-separated list of playlists to download (default: all)')
  .option('-c, --concurrent <number>', 'Maximum concurrent downloads', '3')
  .option('-r, --rate <number>', 'Requests per minute', '30')
  .option('-o, --output <path>', 'Output directory')
  .option('-l, --log-level <level>', 'Log level (debug, info, warn, error)', 'info')
  .option('--no-resume', 'Disable auto-resume (not recommended)')
  .option('--log-file <path>', 'Log to file')
  .option('--no-progress', 'Disable progress bar')
  .option('--config <path>', 'Path to config file');

program.parse(process.argv);
const options = program.opts();

// Main application function
async function main() {
  // Load config
  const config = loadConfig(options.config);
  
  // Override config with command line options
  if (options.output) {
    config.outputDir = path.resolve(options.output);
  }
  if (options.concurrent) {
    config.maxConcurrentDownloads = parseInt(options.concurrent, 10);
  }
  if (options.rate) {
    config.requestsPerMinute = parseInt(options.rate, 10);
  }
  
  // Check if state file exists to determine if we're resuming
  const stateFilePath = path.join(config.baseDir || './', '.aersia-state.json');
  const isResuming = fs.existsSync(stateFilePath) && options.resume !== false;
  
  // Setup logger
  const logLevel = getLogLevel(options.logLevel);
  const logger = new Logger({
    level: logLevel,
    logToConsole: true,
    logToFile: !!options.logFile,
    logFilePath: options.logFile || path.join(config.outputDir, 'aersia-downloader.log')
  });
  
  logger.info(`Aersia Downloader v2.0.0 starting`);
  logger.info(`Output directory: ${config.outputDir}`);
  logger.info(`Max concurrent downloads: ${config.maxConcurrentDownloads}`);
  logger.info(`Rate limit: ${config.requestsPerMinute} requests/minute`);
  
  // Ensure output directory exists
  if (!fs.existsSync(config.outputDir)) {
    fs.mkdirSync(config.outputDir, { recursive: true });
  }
  
  // Initialize services
  const stateManager = new StateManager(config.baseDir, logger);
  const fileService = new FileService(logger);
  
  const downloadManager = new DownloadManager(
    logger,
    stateManager,
    fileService,
    {
      maxConcurrent: config.maxConcurrentDownloads,
      requestsPerMinute: config.requestsPerMinute,
      retryDelayMs: config.retryDelayMs,
      maxRetries: config.maxRetries
    }
  );
  
  // Start periodic state logging
  stateManager.startPeriodicStateLogging(60000); // Log every minute
  
  // Setup progress tracker
  let progressTracker: ProgressTracker | null = null;
  if (options.progress !== false) {
    progressTracker = new ProgressTracker(
      downloadManager,
      stateManager,
      logger,
      config.progressUpdateIntervalMs
    );
    progressTracker.start();
  }
  
  // Handle termination signals
  setupSignalHandlers(logger, downloadManager, progressTracker, stateManager);
  
  // Initialize playlist service
  const playlistService = new PlaylistService(logger, config, fileService);
  
  try {
    // Show resume information if resuming
    if (isResuming) {
      logger.info('Resuming previous download session');
      logger.info(stateManager.getResumeInfo());
    } else {
      logger.info('Starting new download session');
    }
    
    // Determine which playlists to download
    let requestedPlaylists: string[] | undefined;
    if (options.playlists) {
      requestedPlaylists = options.playlists.split(',').map((p: string) => p.trim());
    }
    
    const playlistsToDownload = playlistService.getPlaylistsToDownload(requestedPlaylists);
    
    if (playlistsToDownload.length === 0) {
      logger.error('No playlists selected for download');
      process.exit(1);
    }
    
    logger.info(`Starting download for playlists: ${playlistsToDownload.map(([name]) => name).join(', ')}`);
    
    // Process each playlist one by one
    for (const [name, url] of playlistsToDownload) {
      logger.info(`Processing playlist: ${name}`);
      stateManager.setCurrentPlaylist(name);
      
      try {
        // Create playlist directory
        await playlistService.createPlaylistDirectory(name);
        
        // Clear previous queue - important when processing playlists one by one
        downloadManager.clearQueue();
        
        // Fetch and parse playlist
        let tracks: Track[];
        
        if (['WAP', 'CPP'].includes(name)) {
          tracks = await playlistService.getOldPlaylistTracks(name, url);
        } else {
          tracks = await playlistService.getNewPlaylistTracks(name, url);
        }
        
        logger.info(`Found ${tracks.length} tracks in playlist ${name}`);
        
        // Update state with new tracks
        stateManager.initPlaylist(name, tracks);
        
        // Log detailed playlist state
        const initialState = stateManager.getPlaylistDetailedState(name);
        logger.debug(`Initial playlist state for ${name}: ${JSON.stringify(initialState.statusCounts)}`);
        
        // Get pending tracks (not downloaded or failed with retries left)
        const pendingTracks = stateManager.getPendingTracks(name);
        
        if (pendingTracks.length === 0) {
          logger.info(`All tracks in playlist ${name} are already downloaded`);
          continue;
        }
        
        logger.info(`Adding ${pendingTracks.length} tracks to download queue`);
        
        // Add tracks to download queue
        downloadManager.addToQueue(pendingTracks);
        
        // Wait for all downloads to complete for this playlist
        await waitForPlaylistCompletion(name, stateManager, logger, 1000, downloadManager);
        
        // Log final playlist state
        const finalState = stateManager.getPlaylistDetailedState(name);
        logger.debug(`Final playlist state for ${name}: ${JSON.stringify(finalState.statusCounts)}`);
        
        logger.info(`Completed playlist: ${name}`);
      } catch (error: any) {
        logger.error(`Error processing playlist ${name}: ${error.message}`);
      }
    }
    
    logger.info('All playlists processed');
    
    // Clean up
    if (progressTracker) {
      progressTracker.stop();
    }
    
    stateManager.cleanup();
    logger.close();
    
    process.exit(0);
  } catch (error: any) {
    logger.error(`Unexpected error: ${error.message}`);
    
    if (progressTracker) {
      progressTracker.stop();
    }
    
    stateManager.cleanup();
    logger.close();
    
    process.exit(1);
  }
}

/**
 * Wait for all tracks in a playlist to complete downloading
 */
async function waitForPlaylistCompletion(
  playlistName: string, 
  stateManager: StateManager,
  logger: Logger,
  checkIntervalMs: number = 1000,
  downloadManager: DownloadManager
): Promise<void> {
  return new Promise<void>((resolve) => {
    const checkComplete = () => {
      const playlistStats = stateManager.getPlaylistStats(playlistName);
      
      // Check if there are no more pending tracks or active downloads
      const pendingTracks = stateManager.getPendingTracks(playlistName);
      const activeDownloads = downloadManager.getActiveDownloadsForPlaylist(playlistName);
      
      if (pendingTracks.length === 0 && activeDownloads.length === 0) {
        logger.info(`All tracks in playlist ${playlistName} are processed (${playlistStats.completed}/${playlistStats.total} completed, ${playlistStats.failed} failed)`);
        resolve();
        return;
      }
      
      logger.debug(`Waiting for playlist ${playlistName} completion: ${pendingTracks.length} pending, ${activeDownloads.length} active`);
      
      // Continue checking
      setTimeout(checkComplete, checkIntervalMs);
    };
    
    checkComplete();
  });
}

function getLogLevel(level: string): LogLevel {
  switch (level.toLowerCase()) {
    case 'debug': return LogLevel.DEBUG;
    case 'info': return LogLevel.INFO;
    case 'warn': return LogLevel.WARN;
    case 'error': return LogLevel.ERROR;
    default: return LogLevel.INFO;
  }
}

function setupSignalHandlers(
  logger: Logger,
  downloadManager: DownloadManager,
  progressTracker: ProgressTracker | null,
  stateManager: StateManager
) {
  const cleanup = () => {
    logger.info('Gracefully shutting down...');
    downloadManager.pause();
    
    if (progressTracker) {
      progressTracker.stop();
    }
    
    stateManager.cleanup();
    logger.close();
    
    process.exit(0);
  };
  
  // Handle Ctrl+C
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  
  // Handle unhandled rejections
  process.on('unhandledRejection', (reason) => {
    logger.error(`Unhandled Promise Rejection: ${reason}`);
  });
  
  // Handle uncaught exceptions
  process.on('uncaughtException', (error) => {
    logger.error(`Uncaught Exception: ${error}`);
    cleanup();
  });
}

// Start the application
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});