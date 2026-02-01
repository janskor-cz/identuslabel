/**
 * API Route: /api/logs
 *
 * Receives browser console logs from the frontend and writes them to
 * timestamped log files on the server.
 *
 * POST /api/logs
 * Body: { logs: LogEntry[] }
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import fs from 'fs';
import path from 'path';

interface LogEntry {
  timestamp: number;
  walletId: string;
  level: 'log' | 'error' | 'warn' | 'info';
  messages: any[];
  stack?: string;
  url: string;
  userAgent: string;
}

interface ApiResponse {
  success: boolean;
  message?: string;
  logsWritten?: number;
  logFilePath?: string;
}

const LOG_DIR = '/root/logs';
const MAX_LOG_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_LOG_FILES = 50;

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ApiResponse>
) {
  // Only accept POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  try {
    const { logs } = req.body;

    if (!Array.isArray(logs) || logs.length === 0) {
      return res.status(400).json({ success: false, message: 'Invalid logs format' });
    }

    // Validate logs structure
    for (const log of logs) {
      if (!log.timestamp || !log.walletId || !log.level || !log.messages) {
        return res.status(400).json({ success: false, message: 'Invalid log entry format' });
      }
    }

    // Get or create log file for current session
    const logFile = getLogFilePath(logs[0].walletId);

    // Format and write logs
    const formattedLogs = logs.map(entry => formatLogEntry(entry)).join('\n') + '\n';

    // Append to log file
    fs.appendFileSync(logFile, formattedLogs, 'utf-8');

    // Perform log rotation if needed
    rotateLogsIfNeeded(logs[0].walletId);

    return res.status(200).json({
      success: true,
      message: `Wrote ${logs.length} log entries`,
      logsWritten: logs.length,
      logFilePath: logFile
    });
  } catch (error) {
    console.error('[API /logs] Error writing logs:', error);
    return res.status(500).json({
      success: false,
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}

/**
 * Get the log file path for the current session
 */
function getLogFilePath(walletId: string): string {
  // Check if we have an active log file for today
  const files = getWalletLogFiles(walletId);

  if (files.length > 0) {
    // Use the most recent file if it's not too large
    const latestFile = files[0];
    const stats = fs.statSync(latestFile);

    if (stats.size < MAX_LOG_FILE_SIZE) {
      return latestFile;
    }
  }

  // Create a new log file with timestamp
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T').join('-').slice(0, 19);
  const filename = `wallet-debug-${walletId}-${timestamp}.log`;
  const filepath = path.join(LOG_DIR, filename);

  // Create file with header
  const header = `==========================================================
Wallet Debug Log - ${walletId}
Session started: ${new Date().toISOString()}
==========================================================

`;
  fs.writeFileSync(filepath, header, 'utf-8');

  return filepath;
}

/**
 * Get all log files for a wallet, sorted by modification time (newest first)
 */
function getWalletLogFiles(walletId: string): string[] {
  try {
    const files = fs.readdirSync(LOG_DIR);
    const walletFiles = files
      .filter(file => file.startsWith(`wallet-debug-${walletId}-`) && file.endsWith('.log'))
      .map(file => path.join(LOG_DIR, file))
      .map(filepath => ({ filepath, mtime: fs.statSync(filepath).mtime.getTime() }))
      .sort((a, b) => b.mtime - a.mtime)
      .map(item => item.filepath);

    return walletFiles;
  } catch (error) {
    console.error('[API /logs] Error reading log files:', error);
    return [];
  }
}

/**
 * Rotate logs if we have too many files
 */
function rotateLogsIfNeeded(walletId: string): void {
  const files = getWalletLogFiles(walletId);

  if (files.length > MAX_LOG_FILES) {
    // Delete oldest files
    const filesToDelete = files.slice(MAX_LOG_FILES);

    for (const file of filesToDelete) {
      try {
        fs.unlinkSync(file);
        console.log(`[API /logs] Deleted old log file: ${path.basename(file)}`);
      } catch (error) {
        console.error(`[API /logs] Error deleting file ${file}:`, error);
      }
    }
  }
}

/**
 * Format a log entry for file writing
 */
function formatLogEntry(entry: LogEntry): string {
  const timestamp = new Date(entry.timestamp).toISOString();
  const level = entry.level.toUpperCase().padEnd(5);

  // Format messages
  const messages = entry.messages.map(msg => {
    if (typeof msg === 'string') return msg;
    if (typeof msg === 'object') {
      try {
        return JSON.stringify(msg, null, 2);
      } catch (e) {
        return String(msg);
      }
    }
    return String(msg);
  }).join(' ');

  let formatted = `[${timestamp}] [${entry.walletId}] [${level}] ${messages}`;

  // Add URL if different from previous (to reduce noise)
  if (entry.url) {
    formatted += `\n  URL: ${entry.url}`;
  }

  // Add stack trace for errors
  if (entry.stack) {
    formatted += `\n  Stack: ${entry.stack.split('\n').join('\n    ')}`;
  }

  return formatted;
}
