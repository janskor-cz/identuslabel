#!/usr/bin/env node
/**
 * Claude Code Bridge Tool
 * 
 * MCP-compatible tool that enables direct Claude Code task execution
 * and response capture from web-based Claude instances.
 * 
 * Installation: Add to mcp-server.js tool exposure list
 * Usage: Call as MCP tool "ClaudeCode" with task JSON
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

const WORKDIR = '/opt/project_identuslabel';
const TASKS_DIR = path.join(WORKDIR, '.claude-tasks');
const RESULTS_DIR = path.join(WORKDIR, '.claude-results');

// Ensure directories exist
[TASKS_DIR, RESULTS_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

/**
 * Execute a Claude Code task and return results
 * 
 * @param {Object} params - Task parameters
 * @param {string} params.task - Task description/prompt for Claude Code
 * @param {string} [params.taskId] - Optional task ID (generated if not provided)
 * @param {number} [params.timeout] - Timeout in ms (default: 300000 = 5 min)
 * @param {boolean} [params.background] - Run in background (default: false)
 * @returns {Promise<Object>} - Task result with status, output, errors
 */
async function executeClaudeCodeTask(params) {
    const {
        task,
        taskId = randomUUID().slice(0, 8),
        timeout = 300000, // 5 min default
        background = false,
        memoryContext = null
    } = params;

    if (!task || typeof task !== 'string') {
        throw new Error('Task must be a non-empty string');
    }

    // Create task file
    const taskFile = path.join(TASKS_DIR, `${taskId}.task.md`);
    const resultFile = path.join(RESULTS_DIR, `${taskId}.result.json`);
    const logFile = path.join(RESULTS_DIR, `${taskId}.log`);

    // Write task description with context
    const taskContent = memoryContext 
        ? `# Task: ${taskId}\n\n## Context\n${memoryContext}\n\n## Task\n${task}`
        : `# Task: ${taskId}\n\n## Task\n${task}`;

    fs.writeFileSync(taskFile, taskContent, 'utf8');

    // Build Claude Code command
    const claudeCmd = `cd ${WORKDIR} && claude --code << 'CLAUDE_TASK_END'
${task}

When complete, write final status to /dev/stdout as JSON:
{"status": "complete", "taskId": "${taskId}", "message": "Task completed successfully"}
CLAUDE_TASK_END`;

    return new Promise((resolve, reject) => {
        const startTime = Date.now();
        const timeoutHandle = setTimeout(() => {
            reject(new Error(`Claude Code task timeout after ${timeout}ms`));
        }, timeout);

        try {
            const proc = spawn('bash', ['-c', claudeCmd], {
                cwd: WORKDIR,
                detached: false,
                stdio: ['pipe', 'pipe', 'pipe']
            });

            let stdout = '';
            let stderr = '';
            let outputFile = null;

            proc.stdout.on('data', (data) => {
                const chunk = data.toString('utf8');
                stdout += chunk;
                
                // Detect if task created output files
                if (chunk.includes('IMPLEMENTATION_ROADMAP.md') || 
                    chunk.includes('output file') ||
                    chunk.includes('created at')) {
                    console.log(`[ClaudeCode] Detected output: ${chunk.slice(0, 100)}`);
                }
            });

            proc.stderr.on('data', (data) => {
                stderr += data.toString('utf8');
            });

            proc.on('close', (code) => {
                clearTimeout(timeoutHandle);
                const duration = Date.now() - startTime;
