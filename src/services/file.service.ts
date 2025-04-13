import * as fs from 'fs';
import { promisify } from 'util';
import { TrackMetadata } from '../models/track.model';
import { Logger } from './logger.service';

// Use taglib3 for metadata operations
const taglib = require('taglib3');
const writeTagsAsync = promisify(taglib.writeTags);

export class FileService {
  constructor(private logger: Logger) {}

  /**
   * Check if a file exists and get its size
   */
  public async getFileInfo(filePath: string): Promise<{ exists: boolean, size: number }> {
    try {
      const stats = await fs.promises.stat(filePath);
      return {
        exists: true,
        size: stats.size
      };
    } catch (error) {
      return {
        exists: false,
        size: 0
      };
    }
  }

  /**
   * Ensure a directory exists
   */
  public async ensureDirectory(dirPath: string): Promise<void> {
    try {
      await fs.promises.mkdir(dirPath, { recursive: true });
    } catch (error: any) {
      this.logger.error(`Error creating directory ${dirPath}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Set metadata tags on a file
   */
  public async setMetadata(filePath: string, metadata: TrackMetadata): Promise<void> {
    try {
      // Convert metadata to format expected by taglib
      const taglibMetadata: any = {};
      
      if (metadata.title) {
        taglibMetadata.title = [metadata.title];
      }
      
      if (metadata.artist) {
        taglibMetadata.artist = [metadata.artist];
      }
      
      if (metadata.album) {
        taglibMetadata.album = [metadata.album];
      }
      
      if (metadata.year) {
        taglibMetadata.year = [metadata.year];
      }
      
      await writeTagsAsync(filePath, taglibMetadata);
    } catch (error: any) {
      this.logger.error(`Error setting metadata for ${filePath}: ${error.message}`);
      // Don't throw here - we don't want to fail the download because of metadata
    }
  }

  /**
   * Delete a file if it exists
   */
  public async deleteFile(filePath: string): Promise<boolean> {
    try {
      await fs.promises.unlink(filePath);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Move a file from source to destination
   */
  public async moveFile(sourcePath: string, destPath: string): Promise<void> {
    try {
      await fs.promises.rename(sourcePath, destPath);
    } catch (error: any) {
      // If rename fails due to cross-device link, try copy + delete
      if (error.code === 'EXDEV') {
        await this.copyFile(sourcePath, destPath);
        await this.deleteFile(sourcePath);
      } else {
        throw error;
      }
    }
  }

  /**
   * Copy a file from source to destination
   */
  private async copyFile(sourcePath: string, destPath: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const readStream = fs.createReadStream(sourcePath);
      const writeStream = fs.createWriteStream(destPath);
      
      readStream.on('error', reject);
      writeStream.on('error', reject);
      writeStream.on('finish', resolve);
      
      readStream.pipe(writeStream);
    });
  }

  /**
   * Calculate the hash of a file (for integrity verification)
   */
  public async calculateFileHash(filePath: string): Promise<string> {
    try {
      const crypto = await import('crypto');
      const hash = crypto.createHash('md5');
      const stream = fs.createReadStream(filePath);
      
      return new Promise<string>((resolve, reject) => {
        stream.on('data', (data) => {
          hash.update(data);
        });
        
        stream.on('end', () => {
          resolve(hash.digest('hex'));
        });
        
        stream.on('error', reject);
      });
    } catch (error: any) {
      this.logger.error(`Error calculating hash for ${filePath}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Check if a directory is empty
   */
  public async isDirectoryEmpty(dirPath: string): Promise<boolean> {
    try {
      const files = await fs.promises.readdir(dirPath);
      return files.length === 0;
    } catch (error) {
      return false;
    }
  }
}