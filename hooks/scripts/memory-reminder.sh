#!/bin/bash
# memory-reminder.sh — Stop hook
# Reminds the agent to save session learnings to memory.
# This is advisory output that the agent sees before finalizing.

# Check if we're in a project directory with significant work done
if [ -d ".git" ]; then
  # Count commits made in this session (last hour as proxy)
  RECENT_COMMITS=$(git log --since="1 hour ago" --oneline 2>/dev/null | wc -l | tr -d ' ')
  
  if [ "$RECENT_COMMITS" -gt 0 ]; then
    echo "📝 memory-reminder: $RECENT_COMMITS commit(s) made this session."
    echo "   Remember to save key decisions, patterns, and lessons to agent memory."
    echo "   If a correction was made by the owner, write a memory entry capturing the lesson."
  fi
fi

exit 0
