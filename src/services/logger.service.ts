import * as fs from 'fs';
import * as path from 'path';

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3
}

export interface LoggerOptions {
  level: LogLevel;
  logToConsole: boolean;
  logToFile: boolean;
  logFilePath?: string;
}

export class Logger {
  private options: LoggerOptions;
  private logFile: fs.WriteStream | null = null;
  
  constructor(options: Partial<LoggerOptions> = {}) {
    this.options = {
      level: options.level ?? LogLevel.INFO,
      logToConsole: options.logToConsole ?? true,
      logToFile: options.logToFile ?? false,
      logFilePath: options.logFilePath
    };
    
    this.initLogFile();
  }

  private initLogFile(): void {
    if (this.options.logToFile && this.options.logFilePath) {
      try {
        const logDir = path.dirname(this.options.logFilePath);
        if (!fs.existsSync(logDir)) {
          fs.mkdirSync(logDir, { recursive: true });
        }
        
        this.logFile = fs.createWriteStream(this.options.logFilePath, { flags: 'a' });
        
        // Write header for new log file
        const startTime = new Date().toISOString();
        this.logFile.write(`\n--- Log started at ${startTime} ---\n`);
      } catch (error) {
        console.error(`Error creating log file at ${this.options.logFilePath}:`, error);
        this.options.logToFile = false;
      }
    }
  }

  public debug(message: string): void {
    this.log(LogLevel.DEBUG, message);
  }

  public info(message: string): void {
    this.log(LogLevel.INFO, message);
  }

  public warn(message: string): void {
    this.log(LogLevel.WARN, message);
  }

  public error(message: string): void {
    this.log(LogLevel.ERROR, message);
  }

  private log(level: LogLevel, message: string): void {
    if (level < this.options.level) return;
    
    const timestamp = new Date().toISOString();
    const levelStr = LogLevel[level].padEnd(5);
    const formattedMessage = `[${timestamp}] ${levelStr} - ${message}`;
    
    if (this.options.logToConsole) {
      const consoleMethod = this.getConsoleMethod(level);
      consoleMethod(formattedMessage);
    }
    
    if (this.options.logToFile && this.logFile) {
      this.logFile.write(formattedMessage + '\n');
    }
  }

  private getConsoleMethod(level: LogLevel): (message: string) => void {
    switch(level) {
      case LogLevel.DEBUG: return console.debug;
      case LogLevel.INFO: return console.info;
      case LogLevel.WARN: return console.warn;
      case LogLevel.ERROR: return console.error;
      default: return console.log;
    }
  }

  public setLevel(level: LogLevel): void {
    this.options.level = level;
  }

  public close(): void {
    if (this.logFile) {
      const endTime = new Date().toISOString();
      this.logFile.write(`--- Log ended at ${endTime} ---\n\n`);
      this.logFile.end();
      this.logFile = null;
    }
  }
}