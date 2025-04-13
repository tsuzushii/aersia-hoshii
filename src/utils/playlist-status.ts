// improved-playlist-status.ts
import * as fs from 'fs';
import * as path from 'path';
 
import { loadConfig } from '../config/config';
import { Track, TrackStatus } from '../models/track.model';
import { Logger, LogLevel } from '../services/logger.service';

interface PlaylistStatusReport {
  name: string;
  total: number;
  completed: number;
  pending: number;
  failed: number;
  inProgress: number;
  skipped: number;
  fileSystemStatus: {
    expectedFiles: number;
    actualFiles: number;
    missingFiles: string[];
    extraFiles: string[];
  };
}

/**
 * Generate a detailed report on the status of all playlists
 */
async function generatePlaylistStatus(): Promise<void> {
  // Load config
  const config = loadConfig();
  
  // Setup logger
  const logger = new Logger({
    level: LogLevel.INFO,
    logToConsole: true,
    logToFile: false
  });
  
  logger.info(`Aersia Playlist Status Checker (Improved)`);
  
  // Load state file
  const stateFilePath = path.join(config.baseDir || './', '.aersia-state.json');
  if (!fs.existsSync(stateFilePath)) {
    logger.error(`No state file found at ${stateFilePath}. Run the downloader first.`);
    return;
  }
  
  try {
    // Parse state file
    const stateData = fs.readFileSync(stateFilePath, 'utf8');
    const state = JSON.parse(stateData);
    
    // First, check what playlists should exist according to config
    logger.info("\n===== CONFIG PLAYLIST INFO =====\n");
    const config = loadConfig();
    logger.info(`Playlists defined in config.ts:`);
    for (const [name, url] of Object.entries(config.playlists)) {
      logger.info(`  ${name}: ${url ? 'Enabled' : 'Disabled'}`);
    }
    
    // Now check what playlists exist in the state file
    const playlistsInState = Object.keys(state.playlists || {});
    logger.info(`\nPlaylists in state file: ${playlistsInState.join(', ') || 'None'}`);
    
    // Check if any playlists are missing from the state file
    const playlistsInConfig = Object.keys(config.playlists).filter(name => config.playlists[name]);
    const missingPlaylists = playlistsInConfig.filter(name => !playlistsInState.includes(name));
    
    if (missingPlaylists.length > 0) {
      logger.info(`\nPlaylists missing from state file: ${missingPlaylists.join(', ')}`);
      logger.info(`This indicates these playlists were never initialized or processed.`);
    }
    
    // Check which folders exist on disk
    logger.info("\n===== PLAYLIST DIRECTORIES =====\n");
    for (const name of playlistsInConfig) {
      const playlistDir = path.join(config.outputDir, name);
      const exists = fs.existsSync(playlistDir);
      const fileCount = exists ? 
        fs.readdirSync(playlistDir).filter(f => !f.endsWith('.download')).length : 0;
      
      logger.info(`${name}: ${exists ? 'Directory exists' : 'Directory missing'} (${fileCount} files)`);
    }
    
    // Generate reports for each playlist (both in state and config)
    logger.info("\n===== DETAILED PLAYLIST STATUS REPORT =====\n");
    const reports: PlaylistStatusReport[] = [];
    
    // First process playlists that exist in the state
    for (const [playlistName, playlist] of Object.entries(state.playlists || {})) {
      const report = generatePlaylistReport(playlistName, playlist, config);
      reports.push(report);
      
      // Log the report
      logPlaylistReport(report, logger);
    }
    
    // Check for playlists in config but not in state
    for (const name of missingPlaylists) {
      const playlistDir = path.join(config.outputDir, name);
      
      if (fs.existsSync(playlistDir)) {
        const files = fs.readdirSync(playlistDir)
          .filter(file => !file.endsWith('.download'));
        
        logger.info(`Playlist: ${name} (Not in state file)`);
        logger.info(`  Files on disk: ${files.length}`);
        logger.info(`  Note: This playlist exists in the config but wasn't processed yet`);
        logger.info('');
      }
    }
    
    // Analyze potential issues
    const issueReport = analyzeIssues(reports, state, missingPlaylists, config);
    logger.info("\n===== ISSUE ANALYSIS =====\n");
    logger.info(issueReport);
    
    // Recommendations
    logger.info("\n===== RECOMMENDATIONS =====\n");
    if (missingPlaylists.length > 0) {
      logger.info(`1. The following playlists are missing from the state file: ${missingPlaylists.join(', ')}`);
      logger.info(`   It looks like the download process got stuck on VIP and didn't move to other playlists.`);
      logger.info(`   Try fixing the state file or restarting with only the missing playlists enabled.`);
      
      // Check if waitForPlaylistCompletion might be the issue
      if (state.currentPlaylist === 'VIP' && state.playlists?.VIP?.tracks?.some((t : Track) => 
          t.status === TrackStatus.PENDING || t.status === TrackStatus.IN_PROGRESS)) {
        logger.info(`\n   Possible Fix: The downloader is stuck waiting for VIP playlist to complete.`);
        logger.info(`   The issue is likely in the waitForPlaylistCompletion function in index.ts.`);
        logger.info(`   Try modifying it to add timeout detection or manually edit the state file.`);
      }
    }
    
    // Check download.service.ts for issues
    const pendingTracks = reports.reduce((sum, r) => sum + r.pending, 0);
    const inProgressTracks = reports.reduce((sum, r) => sum + r.inProgress, 0);
    
    if (pendingTracks > 0 && inProgressTracks === 0) {
      logger.info(`\n2. There are ${pendingTracks} pending tracks but no tracks in progress.`);
      logger.info(`   This suggests a problem with the download queue processing in download.service.ts.`);
      logger.info(`   Check the processQueue method for issues that might prevent it from starting new downloads.`);
    }
    
  } catch (error) {
    logger.error(`Error analyzing state: ${error}`);
  }
}

/**
 * Generate detailed report for a playlist
 */
function generatePlaylistReport(
  playlistName: string, 
  playlist: any, 
  config: any
): PlaylistStatusReport {
  const playlistDir = path.join(config.outputDir, playlistName);
  
  // Count tracks by status
  const statusCounts = {
    completed: 0,
    pending: 0,
    failed: 0,
    inProgress: 0,
    skipped: 0
  };
  
  const tracks = playlist.tracks || [];
  
  // Keep track of expected files and missing files
  const expectedFiles = new Set<string>();
  const missingFiles: string[] = [];
  
  // Process each track
  tracks.forEach((track : Track) => {
    switch (track.status) {
      case TrackStatus.COMPLETED:
        statusCounts.completed++;
        expectedFiles.add(track.filePath);
        if (!fs.existsSync(track.filePath)) {
          missingFiles.push(track.fileName);
        }
        break;
      case TrackStatus.PENDING:
        statusCounts.pending++;
        break;
      case TrackStatus.FAILED:
        statusCounts.failed++;
        break;
      case TrackStatus.IN_PROGRESS:
        statusCounts.inProgress++;
        break;
      case TrackStatus.SKIPPED:
        statusCounts.skipped++;
        break;
    }
  });
  
  // Check for extra files in the playlist directory
  let extraFiles: string[] = [];
  let actualFiles: string[] = [];
  
  if (fs.existsSync(playlistDir)) {
    actualFiles = fs.readdirSync(playlistDir)
      .filter(file => !file.endsWith('.download')) // Ignore temporary files
      .map(file => path.join(playlistDir, file));
    
    extraFiles = actualFiles.filter(file => !expectedFiles.has(file))
      .map(file => path.basename(file));
  }
  
  return {
    name: playlistName,
    total: tracks.length,
    completed: statusCounts.completed,
    pending: statusCounts.pending,
    failed: statusCounts.failed,
    inProgress: statusCounts.inProgress,
    skipped: statusCounts.skipped,
    fileSystemStatus: {
      expectedFiles: expectedFiles.size,
      actualFiles: actualFiles.length,
      missingFiles,
      extraFiles
    }
  };
}

/**
 * Log detailed report for a playlist
 */
function logPlaylistReport(report: PlaylistStatusReport, logger: Logger): void {
  logger.info(`Playlist: ${report.name}`);
  logger.info(`  Total Tracks: ${report.total}`);
  logger.info(`  Completed: ${report.completed} (${Math.round((report.completed / report.total) * 100)}%)`);
  logger.info(`  Pending: ${report.pending}`);
  logger.info(`  Failed: ${report.failed}`);
  logger.info(`  In Progress: ${report.inProgress}`);
  logger.info(`  Skipped: ${report.skipped}`);
  logger.info(`  File System Status:`);
  logger.info(`    Expected Files: ${report.fileSystemStatus.expectedFiles}`);
  logger.info(`    Actual Files: ${report.fileSystemStatus.actualFiles}`);
  
  if (report.fileSystemStatus.missingFiles.length > 0) {
    logger.info(`    Missing Files: ${report.fileSystemStatus.missingFiles.length}`);
    logger.info(`      First 5: ${report.fileSystemStatus.missingFiles.slice(0, 5).join(', ')}`);
  }
  
  if (report.fileSystemStatus.extraFiles.length > 0) {
    logger.info(`    Extra Files: ${report.fileSystemStatus.extraFiles.length}`);
    logger.info(`      First 5: ${report.fileSystemStatus.extraFiles.slice(0, 5).join(', ')}`);
  }
  
  logger.info('');
}

/**
 * Analyze the reports to identify potential issues
 */
function analyzeIssues(
  reports: PlaylistStatusReport[], 
  state: any, 
  missingPlaylists: string[],
  config: any
): string {
  const issues: string[] = [];
  
  // Check if there are missing playlists from the state
  if (missingPlaylists.length > 0) {
    issues.push(`- Several playlists defined in config are missing from the state file: ${missingPlaylists.join(', ')}`);
    issues.push(`  This suggests the downloader is stuck on the VIP playlist and hasn't moved to other playlists.`);
    issues.push(`  Look for issues in the waitForPlaylistCompletion function in index.ts.`);
  }
  
  // Check for stuck tracks
  const stuckTracks = reports.reduce((sum, report) => sum + report.inProgress, 0);
  if (stuckTracks > 0) {
    issues.push(`- There are ${stuckTracks} tracks stuck in "In Progress" state.`);
    issues.push(`  Solution: Restart the downloader or manually fix the state file.`);
  }
  
  // Check for failed downloads
  const failedTracks = reports.reduce((sum, report) => sum + report.failed, 0);
  if (failedTracks > 0) {
    issues.push(`- There are ${failedTracks} tracks in "Failed" state.`);
    issues.push(`  Solution: Check logs for errors or retry the download.`);
  }
  
  // Check for missing files
  const missingFiles = reports.reduce(
    (sum, report) => sum + report.fileSystemStatus.missingFiles.length, 
    0
  );
  if (missingFiles > 0) {
    issues.push(`- There are ${missingFiles} files marked as completed but missing from disk.`);
    issues.push(`  Solution: Reset these tracks to "pending" in the state file or delete and recreate the state file.`);
  }
  
  // Check playlist completion status
  for (const report of reports) {
    if (report.name === state.currentPlaylist && report.pending > 0 && report.inProgress === 0) {
      issues.push(`- Current playlist "${report.name}" has ${report.pending} pending tracks but 0 in progress.`);
      issues.push(`  This indicates the download manager might be stuck.`);
    }
  }
  
  // Check for incomplete playlists
  if (state.currentPlaylist && state.currentPlaylist !== reports[reports.length - 1]?.name) {
    const currentPlaylistIndex = reports.findIndex(r => r.name === state.currentPlaylist);
    if (currentPlaylistIndex >= 0 && currentPlaylistIndex < reports.length - 1) {
      issues.push(`- The current playlist is ${state.currentPlaylist} but there are other playlists after it.`);
      issues.push(`  This suggests a problem with moving between playlists.`);
    }
  }
  
  // Check the overall progress
  if (state.overallProgress) {
    
    // Calculate expected total from all playlists in config
    const expectedTotalPlaylists = Object.keys(config.playlists).filter(name => config.playlists[name]).length;
    
    if (expectedTotalPlaylists > reports.length) {
      issues.push(`- Expected to process ${expectedTotalPlaylists} playlists but only ${reports.length} are in the state file.`);
      issues.push(`  This confirms the downloader didn't progress through all playlists.`);
    }
  }
  
  if (issues.length === 0) {
    return "No issues detected. Everything looks good!";
  }
  
  return "Detected Issues:\n" + issues.join('\n');
}

// Execute the report
generatePlaylistStatus()
  .catch(error => {
    console.error('Error generating playlist status report:', error);
  });