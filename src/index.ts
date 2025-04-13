#!/usr/bin/env node
import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { getPlaylistInfo, loadConfig } from './config/config';
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
  .option('--resume', 'Resume previous download session')
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
  
  // Setup logger
  const logLevel = getLogLevel(options.logLevel);
  const logger = new Logger({
    level: logLevel,
    logToConsole: true,
    logToFile: !!options.logFile,
    logFilePath: options.logFile
  });
  
  // Ensure output directory exists
  if (!fs.existsSync(config.outputDir)) {
    fs.mkdirSync(config.outputDir, { recursive: true });
  }
  
  // Initialize services
  const stateManager = new StateManager(config.baseDir);
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
  
  // Setup progress tracker
  let progressTracker: ProgressTracker | null = null;
  if (options.progress !== false) {
    progressTracker = new ProgressTracker(
      downloadManager,
      stateManager,
      config.progressUpdateIntervalMs
    );
    progressTracker.start();
  }
  
  // Handle termination signals
  setupSignalHandlers(logger, downloadManager, progressTracker);
  
  // Initialize playlist service
  const playlistService = new PlaylistService(logger, config);
  
  try {
    // Show resume information if available
    if (options.resume) {
      logger.info(stateManager.getResumeInfo());
    }
    
    // Determine which playlists to download
    const { newPlaylists, oldPlaylists } = getPlaylistInfo(config);
    let playlistsToDownload = [...newPlaylists, ...oldPlaylists];
    
    if (options.playlists) {
      const requestedPlaylists = options.playlists.split(',').map((p: string) => p.trim());
      playlistsToDownload = playlistsToDownload.filter(([name]) => 
        requestedPlaylists.includes(name)
      );
    }
    
    if (playlistsToDownload.length === 0) {
      logger.error('No playlists selected for download');
      process.exit(1);
    }
    
    logger.info(`Starting download for playlists: ${playlistsToDownload.map(([name]) => name).join(', ')}`);
    
    // Process each playlist
    for (const [name, url] of playlistsToDownload) {
      logger.info(`Processing playlist: ${name}`);
      stateManager.setCurrentPlaylist(name);
      
      try {
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
        
        // Get pending tracks (not downloaded or failed with retries left)
        const pendingTracks = stateManager.getPendingTracks(name);
        
        if (pendingTracks.length === 0) {
          logger.info(`All tracks in playlist ${name} are already downloaded`);
          continue;
        }
        
        logger.info(`Adding ${pendingTracks.length} tracks to download queue`);
        
        // Add tracks to download queue
        downloadManager.addToQueue(pendingTracks);
        
        // Wait for all downloads to complete
        await new Promise<void>((resolve) => {
          const checkComplete = () => {
            const pendingCount = stateManager.getPendingTracks(name).length;
            if (pendingCount === 0) {
              resolve();
            } else {
              setTimeout(checkComplete, 1000);
            }
          };
          
          checkComplete();
        });
        
        logger.info(`Completed playlist: ${name}`);
      } catch (error) {
        logger.error(`Error processing playlist ${name}: ${error}`);
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
  } catch (error) {
    logger.error(`Unexpected error: ${error}`);
    
    if (progressTracker) {
      progressTracker.stop();
    }
    
    stateManager.cleanup();
    logger.close();
    
    process.exit(1);
  }
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
  progressTracker: ProgressTracker | null
) {
  const cleanup = () => {
    logger.info('Gracefully shutting down...');
    downloadManager.pause();
    
    if (progressTracker) {
      progressTracker.stop();
    }
    
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