/**
 * Format file size in bytes to a human-readable string
 */
export function formatSize(bytes: number): string {
    if (bytes === 0) return '0 B';
    
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    
    return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
  }
  
  /**
   * Format milliseconds to a human-readable time string
   */
  export function formatTime(ms: number): string {
    if (ms === 0) return '0s';
    
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    
    if (hours > 0) {
      return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }
  
  /**
   * Truncate a string with ellipsis if it exceeds maxLength
   */
  export function truncate(str: string, maxLength: number): string {
    if (str.length <= maxLength) return str;
    return str.substring(0, maxLength - 3) + '...';
  }
  
  /**
   * Pad a string to a fixed length
   */
  export function padString(str: string, length: number, padChar: string = ' '): string {
    if (str.length >= length) return str;
    return str + padChar.repeat(length - str.length);
  }
  
  /**
   * Center a string within a fixed width
   */
  export function centerString(str: string, width: number): string {
    if (str.length >= width) return str;
    
    const leftPad = Math.floor((width - str.length) / 2);
    const rightPad = width - str.length - leftPad;
    
    return ' '.repeat(leftPad) + str + ' '.repeat(rightPad);
  }