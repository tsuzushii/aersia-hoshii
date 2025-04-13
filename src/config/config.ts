import * as path from 'path';
import * as fs from 'fs';

export interface AppConfig {
  // Base directories
  baseDir: string;
  outputDir: string;
  
  // Download settings
  maxConcurrentDownloads: number;
  requestsPerMinute: number;
  maxRetries: number;
  retryDelayMs: number;
  
  // Progress display settings
  progressUpdateIntervalMs: number;
  
  // Playlist URLs
  playlists: {
    [name: string]: string;
  };
}

// Default configuration
const defaultConfig: AppConfig = {
  baseDir: process.cwd(),
  outputDir: path.join(process.cwd(), 'Aersia Playlists'),
  
  maxConcurrentDownloads: 3,
  requestsPerMinute: 30,
  maxRetries: 5,
  retryDelayMs: 1000,
  
  progressUpdateIntervalMs: 200,
  
  playlists: {
    VIP: "https://www.vipvgm.net/roster.min.json",
    Source: "",
    Mellow: "https://www.vipvgm.net/roster-mellow.min.json",
    Exiled: "https://www.vipvgm.net/roster-exiled.min.json",
    WAP: "https://wap.aersia.net/roster.xml",
    CPP: "https://cpp.aersia.net/roster.xml",
  }
};

/**
 * Load config from file if exists, otherwise use defaults
 */
export function loadConfig(configPath?: string): AppConfig {
  const configFilePath = configPath || path.join(process.cwd(), 'aersia-config.json');
  
  try {
    if (fs.existsSync(configFilePath)) {
      const fileConfig = JSON.parse(fs.readFileSync(configFilePath, 'utf8'));
      return { ...defaultConfig, ...fileConfig };
    }
  } catch (error) {
    console.warn(`Error loading config from ${configFilePath}, using defaults`);
  }
  
  return { ...defaultConfig };
}

/**
 * Save config to file
 */
export function saveConfig(config: AppConfig, configPath?: string): void {
  const configFilePath = configPath || path.join(process.cwd(), 'aersia-config.json');
  
  try {
    fs.writeFileSync(configFilePath, JSON.stringify(config, null, 2));
  } catch (error) {
    console.error(`Error saving config to ${configFilePath}`);
  }
}

/**
 * Get playlist information
 */
export function getPlaylistInfo(config: AppConfig) {
  const newPlaylists = Object.entries(config.playlists)
    .filter(([name]) => ['VIP', 'Source', 'Mellow', 'Exiled'].includes(name))
    .filter(([_, url]) => url !== '');
  
  const oldPlaylists = Object.entries(config.playlists)
    .filter(([name]) => ['WAP', 'CPP'].includes(name))
    .filter(([_, url]) => url !== '');
  
  return { newPlaylists, oldPlaylists };
}