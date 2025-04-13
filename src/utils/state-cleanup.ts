#!/usr/bin/env node
/**
 * State File Cleanup Utility
 * 
 * This script will clean up and repair the Aersia-Hoshii state file.
 * It handles issues like malformed track IDs and inaccurate file status tracking.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Track, TrackStatus } from '../models/track.model';

// Define the path to the state file
const stateFilePath = path.join(process.cwd(), '.aersia-state.json');

// Define playlist information
const playlists = ['VIP', 'Source', 'Mellow', 'Exiled', 'WAP', 'CPP'];

async function cleanupState() {
  console.log('Aersia-Hoshii State File Cleanup Utility');
  console.log('---------------------------------------');
  
  // Check if state file exists
  if (!fs.existsSync(stateFilePath)) {
    console.log('No state file found at:', stateFilePath);
    console.log('Nothing to clean up.');
    return;
  }
  
  try {
    // Read and parse the state file
    console.log('Reading state file...');
    const stateData = fs.readFileSync(stateFilePath, 'utf8');
    const state = JSON.parse(stateData);
    
    let totalFixedTracks = 0;
    let totalRemovedTracks = 0;
    
    // Check each playlist
    for (const playlistName of playlists) {
      if (!state.playlists[playlistName]) {
        console.log(`Playlist ${playlistName} not found in state file.`);
        continue;
      }
      
      const playlist = state.playlists[playlistName];
      console.log(`\nProcessing playlist: ${playlistName} (${playlist.tracks.length} tracks)`);
      
      // Create a set of tracks with malformed IDs
      const malformedIDs = playlist.tracks.filter((t: Track) => t.id === `${playlistName}-undefined`).length;
      if (malformedIDs > 0) {
        console.log(`Found ${malformedIDs} tracks with malformed IDs in ${playlistName} playlist`);
        
        // Fix malformed IDs
        playlist.tracks.forEach((track : Track) => {
          if (track.id === `${playlistName}-undefined`) {
            track.id = `${playlistName}-${Math.random().toString(36).substring(2, 10)}`;
            totalFixedTracks++;
          }
        });
      }
      
      // Check for duplicate tracks (same file path)
      const filePaths = new Map();
      const duplicates: Array<Track> = [];
      
      playlist.tracks.forEach((track: Track) => {
        if (filePaths.has(track.filePath)) {
          duplicates.push(track);
        } else {
          filePaths.set(track.filePath, track);
        }
      });
      
      if (duplicates.length > 0) {
        console.log(`Found ${duplicates.length} duplicate tracks in ${playlistName} playlist`);
        // Remove duplicates
        playlist.tracks = playlist.tracks.filter((track: Track) => !duplicates.includes(track));
        totalRemovedTracks += duplicates.length;
      }
      
      // Verify file existence and update statuses
      const playlistDir = path.join(process.cwd(), 'Aersia Playlists', playlistName);
      let existingFiles = new Map();
      
      try {
        if (fs.existsSync(playlistDir)) {
          const files = fs.readdirSync(playlistDir);
          files.forEach(file => {
            existingFiles.set(file.toLowerCase(), true);
          });
          console.log(`Found ${files.length} actual files in ${playlistName} directory`);
        }
      } catch (error) {
        console.error(`Error checking playlist directory: ${error}`);
      }
      
      // Update track statuses based on file existence
      let updatedStatuses = 0;
      
      playlist.tracks.forEach((track : Track) => {
        const fileName = path.basename(track.filePath);
        const fileExists = existingFiles.has(fileName.toLowerCase());
        
        if (track.status === TrackStatus.COMPLETED && !fileExists) {
          track.status = TrackStatus.PENDING;
          track.bytesDownloaded = 0;
          updatedStatuses++;
        } else if (track.status !== TrackStatus.COMPLETED && fileExists) {
          track.status = TrackStatus.COMPLETED;
          track.bytesDownloaded = 1;
          updatedStatuses++;
        }
      });
      
      console.log(`Updated status for ${updatedStatuses} tracks based on file existence`);
      
      // Add or update count properties
      playlist.totalCount = playlist.tracks.length;
      playlist.completedCount = playlist.tracks.filter((t: Track) => 
        t.status === 'completed' || t.status === 'skipped'
      ).length;
      playlist.pendingCount = playlist.tracks.filter((t: Track) => 
        t.status === 'pending' || t.status === 'in_progress'
      ).length;
      playlist.failedCount = playlist.tracks.filter((t: Track) => t.status === 'failed').length;
      
      console.log(`Updated ${playlistName} playlist: ${playlist.completedCount} completed, ${playlist.pendingCount} pending, ${playlist.failedCount} failed`);
    }
    
    // Recalculate overall progress
    let total = 0;
    let completed = 0;
    let failed = 0;
    let pending = 0;
    
    Object.values(state.playlists).forEach((playlist: any) => {
      total += playlist.totalCount || 0;
      completed += playlist.completedCount || 0;
      failed += playlist.failedCount || 0;
      pending += playlist.pendingCount || 0;
    });
    
    state.overallProgress = {
      total,
      completed,
      failed,
      pending
    };
    
    // Create backup of original state file
    const backupPath = `${stateFilePath}.backup`;
    fs.copyFileSync(stateFilePath, backupPath);
    console.log(`\nBackup of original state file created at: ${backupPath}`);
    
    // Write updated state
    fs.writeFileSync(stateFilePath, JSON.stringify(state, null, 2));
    console.log(`\nState file has been cleaned up and updated:`);
    console.log(`- Fixed ${totalFixedTracks} tracks with malformed IDs`);
    console.log(`- Removed ${totalRemovedTracks} duplicate tracks`);
    console.log(`- Overall progress: ${completed}/${total} completed, ${failed} failed, ${pending} pending`);
    
    // Update playlist count properties
    for (const playlistName of playlists) {
      if (state.playlists[playlistName]) {
        const playlist = state.playlists[playlistName];
        playlist.completedCount = playlist.tracks.filter((t: Track) => 
          t.status === TrackStatus.COMPLETED || t.status === TrackStatus.SKIPPED
        ).length;
        playlist.pendingCount = playlist.tracks.filter((t: Track) => 
          t.status === TrackStatus.PENDING || t.status === TrackStatus.IN_PROGRESS
        ).length;
        playlist.failedCount = playlist.tracks.filter((t: Track) => t.status === TrackStatus.FAILED).length;
      }
    }
    
    console.log('\nCleanup completed successfully!');
    console.log('You should now be able to run Aersia-Hoshii with the updated state file.');
    
  } catch (error) {
    console.error('Error processing state file:', error);
    console.log('Consider deleting the state file and starting a fresh download.');
  }
}

// Run the cleanup
cleanupState().catch(console.error);