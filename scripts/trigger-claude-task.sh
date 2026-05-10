#!/bin/bash
# Trigger Claude Code to execute implementation roadmap task
# Usage: ./trigger-claude-task.sh

WORKDIR="/opt/project_identuslabel"
CLAUDE_OUTPUT_LOG="${WORKDIR}/claude-task-output.log"
TASK_FILE="${WORKDIR}/.claude/projects/-opt-project-identuslabel/memory/TASK_IMPLEMENTATION_ROADMAP.md"

echo "[$(date)] Starting Claude Code task execution..." | tee "$CLAUDE_OUTPUT_LOG"
echo "Task file: $TASK_FILE" | tee -a "$CLAUDE_OUTPUT_LOG"
echo "Working directory: $WORKDIR" | tee -a "$CLAUDE_OUTPUT_LOG"
echo "---" | tee -a "$CLAUDE_OUTPUT_LOG"

cd "$WORKDIR" || exit 1

# Run Claude Code with the task
# Note: This requires claude CLI to be installed on the server
claude --code << 'CLAUDE_INPUT'
I have a task file at: /opt/project_identuslabel/.claude/projects/-opt-project-identuslabel/memory/TASK_IMPLEMENTATION_ROADMAP.md

Please:
1. Read that task file
2. Analyze it
3. Execute the full task: Generate a comprehensive IMPLEMENTATION_ROADMAP.md with all the specifications

Output the roadmap to: /opt/project_identuslabel/IMPLEMENTATION_ROADMAP.md

Let me know when complete.
CLAUDE_INPUT

RESULT=$?
echo "[$(date)] Claude Code task completed with exit code: $RESULT" | tee -a "$CLAUDE_OUTPUT_LOG"
