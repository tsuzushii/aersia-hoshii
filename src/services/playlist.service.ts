import axios from 'axios';
import * as parser from 'xml2js';
import * as path from 'path';
import * as fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { sanitize } from 'sanitize-filename-ts';
import { Logger } from './logger.service';
import { AppConfig } from '../config/config';
import { 
  Track, 
  TrackStatus, 
  NewPlaylistTrack, 
  OldPlaylistTrack,
  PlaylistMetadata 
} from '../models/track.model';
import { FileService } from './file.service';

export class PlaylistService {
  constructor(
    private logger: Logger,
    private config: AppConfig,
    private fileService?: FileService
  ) {}

  /**
   * Get tracks from a new playlist (VIP, Source, Mellow, Exiled)
   */
  public async getNewPlaylistTracks(playlistName: string, url: string): Promise<Track[]> {
    try {
      this.logger.info(`Fetching playlist ${playlistName} from ${url}`);
      const response = await axios.get(url);
      
      const metadata: PlaylistMetadata = {
        changelog: response.data.changelog,
        url: response.data.url,
        ext: response.data.ext,
        new_id: response.data.new_id
      };
      
      const tracks: NewPlaylistTrack[] = response.data.tracks;
      this.logger.info(`Found ${tracks.length} tracks in ${playlistName} playlist`);
      
      // Convert to unified Track model
      return this.convertNewPlaylistTracks(playlistName, tracks, metadata);
    } catch (error: any) {
      this.logger.error(`Error fetching new playlist ${playlistName}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get tracks from an old playlist format (WAP, CPP)
   */
  public async getOldPlaylistTracks(playlistName: string, url: string): Promise<Track[]> {
    try {
      this.logger.info(`Fetching playlist ${playlistName} from ${url}`);
      const response = await axios.get(url);
      const xml: string = response.data;
      
      // Parse XML
      const result = await this.parseXml(xml);
      if (!result.playlist || !result.playlist.trackList || !result.playlist.trackList[0].track) {
        throw new Error(`Invalid playlist format for ${playlistName}`);
      }
      
      const tracks: OldPlaylistTrack[] = result.playlist.trackList[0].track;
      this.logger.info(`Found ${tracks.length} tracks in ${playlistName} playlist`);
      
      // Convert to unified Track model
      return this.convertOldPlaylistTracks(playlistName, tracks);
    } catch (error: any) {
      this.logger.error(`Error fetching old playlist ${playlistName}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Parse XML using xml2js
   */
  private parseXml(xml: string): Promise<any> {
    return new Promise((resolve, reject) => {
      parser.parseString(xml, { trim: true }, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
  }

  /**
   * Convert new playlist tracks to unified format
   */
  private convertNewPlaylistTracks(
    playlistName: string, 
    tracks: NewPlaylistTrack[], 
    metadata: PlaylistMetadata
  ): Track[] {
    const result: Track[] = [];
    
    // For VIP playlist that has Source tracks
    if (playlistName === 'VIP') {
      // Process normal tracks
      tracks.forEach(track => {
        const id = `${playlistName}-${track.id}`;
        const downloadUrl = `${metadata.url}${track.file}.${metadata.ext}`;
        const fileName = sanitize(`${track.game} - ${track.title}`);
        const filePath = path.join(this.config.outputDir, playlistName, `${fileName}.${metadata.ext}`);
        
        // Check if file already exists
        const trackStatus = this.fileExistsSync(filePath) ? TrackStatus.COMPLETED : TrackStatus.PENDING;
        
        result.push({
          id,
          playlistName,
          game: track.game,
          title: track.title,
          artist: track.comp,
          downloadUrl,
          fileName: `${fileName}.${metadata.ext}`,
          filePath,
          fileExt: metadata.ext,
          metadata: {
            title: track.title,
            artist: track.comp,
            album: track.game
          },
          status: trackStatus,
          bytesDownloaded: trackStatus === TrackStatus.COMPLETED ? 1 : 0, // Just a placeholder
          retryCount: 0,
          sourceTrack: track
        });
        
        // If track has a source version, add it too
        if ('s_id' in track && track.s_id !== undefined && track.s_title && track.s_file) {
          const sourceId = `Source-${track.s_id}`;
          const sourceDownloadUrl = `${metadata.url}source/${track.s_file}.${metadata.ext}`;
          const sourceFileName = sanitize(`${track.game} - ${track.s_title}`);
          const sourceFilePath = path.join(
            this.config.outputDir, 
            'Source', 
            `${sourceFileName}.${metadata.ext}`
          );
          
          // Check if source file already exists
          const sourceTrackStatus = this.fileExistsSync(sourceFilePath) ? TrackStatus.COMPLETED : TrackStatus.PENDING;
          
          result.push({
            id: sourceId,
            playlistName: 'Source',
            game: track.game,
            title: track.s_title,
            artist: track.comp,
            downloadUrl: sourceDownloadUrl,
            fileName: `${sourceFileName}.${metadata.ext}`,
            filePath: sourceFilePath,
            fileExt: metadata.ext,
            metadata: {
              title: track.s_title,
              artist: track.comp,
              album: track.game
            },
            status: sourceTrackStatus,
            bytesDownloaded: sourceTrackStatus === TrackStatus.COMPLETED ? 1 : 0,
            retryCount: 0,
            sourceTrack: track
          });
        }
      });
    } else {
      // Process Mellow and Exiled tracks
      tracks.forEach(track => {
        const id = `${playlistName}-${track.id}`;
        const downloadUrl = `${metadata.url}${track.file}.${metadata.ext}`;
        const fileName = sanitize(`${track.game} - ${track.title}`);
        const filePath = path.join(this.config.outputDir, playlistName, `${fileName}.${metadata.ext}`);
        
        // Check if this is a reference to VIP playlist (skip)
        if (track.file.includes('../')) {
          const vipFilePath = track.file.replace('../', '');
          this.logger.debug(`Track ${track.title} from ${playlistName} references VIP track: ${vipFilePath}`);
          
          result.push({
            id,
            playlistName,
            game: track.game,
            title: track.title,
            artist: track.comp,
            downloadUrl,
            fileName: `${fileName}.${metadata.ext}`,
            filePath,
            fileExt: metadata.ext,
            metadata: {
              title: track.title,
              artist: track.comp,
              album: track.game
            },
            status: TrackStatus.SKIPPED,
            bytesDownloaded: 0,
            retryCount: 0,
            sourceTrack: track
          });
          return;
        }
        
        // Check if file already exists
        const trackStatus = this.fileExistsSync(filePath) ? TrackStatus.COMPLETED : TrackStatus.PENDING;
        
        // Parse special format tracks with "Game - Title" format
        const titleParts = track.title.split(' - ');
        if (titleParts.length === 2) {
          result.push({
            id,
            playlistName,
            game: track.game,
            title: track.title,
            artist: track.comp,
            downloadUrl,
            fileName: `${fileName}.${metadata.ext}`,
            filePath,
            fileExt: metadata.ext,
            metadata: {
              title: titleParts[1],
              artist: titleParts[0],
              album: track.game
            },
            status: trackStatus,
            bytesDownloaded: trackStatus === TrackStatus.COMPLETED ? 1 : 0,
            retryCount: 0,
            sourceTrack: track
          });
        } else {
          result.push({
            id,
            playlistName,
            game: track.game,
            title: track.title,
            artist: track.comp,
            downloadUrl,
            fileName: `${fileName}.${metadata.ext}`,
            filePath,
            fileExt: metadata.ext,
            metadata: {
              title: track.title,
              artist: track.comp,
              album: track.game
            },
            status: trackStatus,
            bytesDownloaded: trackStatus === TrackStatus.COMPLETED ? 1 : 0,
            retryCount: 0,
            sourceTrack: track
          });
        }
      });
    }
    
    return result;
  }

  /**
   * Convert old playlist tracks to unified format
   */
  private convertOldPlaylistTracks(
    playlistName: string,
    tracks: OldPlaylistTrack[]
  ): Track[] {
    const result: Track[] = [];
    
    tracks.forEach(track => {
      const id = uuidv4(); // Generate unique ID
      const downloadUrl = track.location[0];
      
      // Handle different metadata formats
      let fileName: string;
      let title: string;
      let artist: string;
      let album: string;
      
      if (track.creator[0] === "Independence Day") {
        // Special case
        fileName = sanitize(`${track.creator[0]} - ${track.title[0]}`);
        title = track.title[0];
        artist = "";
        album = track.creator[0];
      } else {
        const fullName = `${track.creator[0]} - ${track.title[0]}`;
        const parts = fullName.split(' - ');
        
        if (parts.length === 2) {
          // Simple case: Game - Title
          fileName = sanitize(fullName);
          title = parts[1];
          artist = "";
          album = parts[0];
        } else if (parts.length === 3) {
          // Game - Artist - Title
          fileName = sanitize(`${parts[0]} - ${parts[2]}`);
          title = parts[2];
          artist = parts[1];
          album = parts[0];
        } else if (parts.length >= 4) {
          // Complex case: Game - Series - Artist - Title
          fileName = sanitize(`${parts[0]} - ${parts[3]}`);
          title = parts[3];
          artist = parts[2];
          album = parts[1];
        } else {
          // Fallback
          fileName = sanitize(fullName);
          title = track.title[0];
          artist = "";
          album = track.creator[0];
        }
      }
      
      const filePath = path.join(this.config.outputDir, playlistName, `${fileName}.m4a`);
      
      // Check if file already exists
      const trackStatus = this.fileExistsSync(filePath) ? TrackStatus.COMPLETED : TrackStatus.PENDING;
      
      result.push({
        id,
        playlistName,
        title,
        artist,
        downloadUrl,
        fileName: `${fileName}.m4a`,
        filePath,
        fileExt: 'm4a',
        metadata: {
          title,
          artist,
          album
        },
        status: trackStatus,
        bytesDownloaded: trackStatus === TrackStatus.COMPLETED ? 1 : 0,
        retryCount: 0,
        sourceTrack: track
      });
    });
    
    return result;
  }

  /**
   * Check if a file exists synchronously
   * This is used during initial track scanning to quickly identify files that have already been downloaded
   */
  private fileExistsSync(filePath: string): boolean {
    try {
      return fs.existsSync(filePath);
    } catch (error) {
      return false;
    }
  }

  /**
   * Create output directories for a playlist
   */
  public async createPlaylistDirectory(playlistName: string): Promise<void> {
    if (!this.fileService) {
      throw new Error('FileService is required for creating directories');
    }
    
    const playlistDir = path.join(this.config.outputDir, playlistName);
    await this.fileService.ensureDirectory(playlistDir);
    this.logger.info(`Created directory for playlist ${playlistName}: ${playlistDir}`);
  }

  /**
   * Get all playlists to download based on config and filters
   */
  public getPlaylistsToDownload(requestedPlaylists?: string[]): Array<[string, string]> {
    const { newPlaylists, oldPlaylists } = this.getPlaylistsFromConfig();
    let allPlaylists = [...newPlaylists, ...oldPlaylists];
    
    // Filter by requested playlists if provided
    if (requestedPlaylists && requestedPlaylists.length > 0) {
      allPlaylists = allPlaylists.filter(([name]) => 
        requestedPlaylists.includes(name)
      );
    }
    
    return allPlaylists;
  }

  /**
   * Extract playlists from config
   */
  private getPlaylistsFromConfig(): { 
    newPlaylists: Array<[string, string]>; 
    oldPlaylists: Array<[string, string]>;
  } {
    const newPlaylists = Object.entries(this.config.playlists)
      .filter(([name]) => ['VIP', 'Source', 'Mellow', 'Exiled'].includes(name))
      .filter(([_, url]) => url !== '');
    
    const oldPlaylists = Object.entries(this.config.playlists)
      .filter(([name]) => ['WAP', 'CPP'].includes(name))
      .filter(([_, url]) => url !== '');
    
    return { newPlaylists, oldPlaylists };
  }
}