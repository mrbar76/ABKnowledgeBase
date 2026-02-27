#!/bin/bash
# ============================================================
# Bee → AB Brain Sync Script
#
# Pulls data from your Bee wearable (via Bee CLI) and pushes
# it into your AB Brain knowledge base.
#
# Prerequisites:
#   - Bee CLI installed: npm install -g @beeai/cli
#   - Bee CLI authenticated: bee login
#   - Developer Mode enabled in Bee iOS app
#   - jq installed: brew install jq
#
# Usage:
#   ./bee-to-brain-sync.sh                  # Sync everything
#   ./bee-to-brain-sync.sh --only facts     # Sync only facts
#   ./bee-to-brain-sync.sh --only todos     # Sync only todos
#   ./bee-to-brain-sync.sh --only convos    # Sync only conversations
#   ./bee-to-brain-sync.sh --recent-days 7  # Sync last 7 days of convos
#
# Schedule with cron (daily at 8am):
#   0 8 * * * /path/to/bee-to-brain-sync.sh >> /path/to/sync.log 2>&1
# ============================================================
set -euo pipefail

# --- Configuration ---
BRAIN_API="${BRAIN_API:-https://ab-brain.up.railway.app/api}"
BRAIN_API_KEY="${BRAIN_API_KEY:-ab-brain-x7kP9mQ2wR4tY8}"
RECENT_DAYS="${RECENT_DAYS:-3}"
ONLY=""
LOG_PREFIX="[bee-sync]"

# --- Parse Arguments ---
while [[ $# -gt 0 ]]; do
  case "$1" in
    --only)
      ONLY="$2"
      shift 2
      ;;
    --recent-days)
      RECENT_DAYS="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

# --- Helper Functions ---
log() {
  echo "$LOG_PREFIX $(date '+%Y-%m-%d %H:%M:%S') $1"
}

brain_search() {
  local query="$1"
  curl -s -H "X-Api-Key: $BRAIN_API_KEY" "$BRAIN_API/knowledge?q=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$query'))")"
}

brain_save() {
  local title="$1"
  local content="$2"
  local category="${3:-general}"
  local tags="$4"

  curl -s -X POST \
    -H "X-Api-Key: $BRAIN_API_KEY" \
    -H "Content-Type: application/json" \
    -d "$(jq -n \
      --arg title "$title" \
      --arg content "$content" \
      --arg category "$category" \
      --argjson tags "$tags" \
      '{title: $title, content: $content, category: $category, tags: $tags, ai_source: "bee-sync"}'
    )" \
    "$BRAIN_API/knowledge"
}

brain_update() {
  local id="$1"
  local title="$2"
  local content="$3"
  local category="${4:-general}"

  curl -s -X PUT \
    -H "X-Api-Key: $BRAIN_API_KEY" \
    -H "Content-Type: application/json" \
    -d "$(jq -n \
      --arg title "$title" \
      --arg content "$content" \
      --arg category "$category" \
      '{title: $title, content: $content, category: $category, ai_source: "bee-sync"}'
    )" \
    "$BRAIN_API/knowledge/$id"
}

# --- Check Prerequisites ---
if ! command -v bee &> /dev/null; then
  log "ERROR: Bee CLI not found. Install with: npm install -g @beeai/cli"
  exit 1
fi

if ! command -v jq &> /dev/null; then
  log "ERROR: jq not found. Install with: brew install jq"
  exit 1
fi

# Verify Bee is authenticated
if ! bee status &> /dev/null; then
  log "ERROR: Bee CLI not authenticated. Run: bee login"
  exit 1
fi

log "Starting Bee → AB Brain sync..."

# ============================================================
# SYNC FACTS
# ============================================================
if [[ -z "$ONLY" || "$ONLY" == "facts" ]]; then
  log "Syncing facts..."

  FACTS_JSON=$(bee facts list --json 2>/dev/null || echo '[]')
  FACT_COUNT=$(echo "$FACTS_JSON" | jq 'length')

  log "Found $FACT_COUNT facts in Bee"

  echo "$FACTS_JSON" | jq -c '.[]' | while read -r fact; do
    FACT_ID=$(echo "$fact" | jq -r '.id')
    FACT_TEXT=$(echo "$fact" | jq -r '.text')
    FACT_CONFIRMED=$(echo "$fact" | jq -r '.confirmed // false')
    FACT_CREATED=$(echo "$fact" | jq -r '.createdAt // .created_at // "unknown"')
    FACT_TAGS=$(echo "$fact" | jq -c '.tags // []')

    # Skip empty facts
    if [[ -z "$FACT_TEXT" || "$FACT_TEXT" == "null" ]]; then
      continue
    fi

    TITLE="Bee Fact: $(echo "$FACT_TEXT" | head -c 80)"
    CONTENT="$FACT_TEXT

Source: Bee wearable
Bee Fact ID: $FACT_ID
Confirmed: $FACT_CONFIRMED
Captured: $FACT_CREATED"

    # Check if this fact already exists in the brain
    EXISTING=$(curl -s -H "X-Api-Key: $BRAIN_API_KEY" "$BRAIN_API/knowledge?q=Bee+Fact+ID:+$FACT_ID" | jq '.count')

    if [[ "$EXISTING" -gt 0 ]]; then
      # Update existing entry
      EXISTING_ID=$(curl -s -H "X-Api-Key: $BRAIN_API_KEY" "$BRAIN_API/knowledge?q=Bee+Fact+ID:+$FACT_ID" | jq -r '.entries[0].id')
      brain_update "$EXISTING_ID" "$TITLE" "$CONTENT" "personal" > /dev/null
      log "  Updated fact: $FACT_ID"
    else
      # Create new entry
      brain_save "$TITLE" "$CONTENT" "personal" "$FACT_TAGS" > /dev/null
      log "  Saved fact: $FACT_ID"
    fi
  done

  log "Facts sync complete."
fi

# ============================================================
# SYNC TODOS
# ============================================================
if [[ -z "$ONLY" || "$ONLY" == "todos" ]]; then
  log "Syncing todos..."

  TODOS_JSON=$(bee todos list --json 2>/dev/null || echo '[]')
  TODO_COUNT=$(echo "$TODOS_JSON" | jq 'length')

  log "Found $TODO_COUNT todos in Bee"

  echo "$TODOS_JSON" | jq -c '.[]' | while read -r todo; do
    TODO_ID=$(echo "$todo" | jq -r '.id')
    TODO_TEXT=$(echo "$todo" | jq -r '.text')
    TODO_COMPLETED=$(echo "$todo" | jq -r '.completed // false')
    TODO_ALARM=$(echo "$todo" | jq -r '.alarmAt // "none"')
    TODO_CREATED=$(echo "$todo" | jq -r '.createdAt // .created_at // "unknown"')

    # Skip empty todos
    if [[ -z "$TODO_TEXT" || "$TODO_TEXT" == "null" ]]; then
      continue
    fi

    # Only sync incomplete todos as tasks
    if [[ "$TODO_COMPLETED" == "false" ]]; then
      # Check if task already exists
      EXISTING_TASK=$(curl -s -H "X-Api-Key: $BRAIN_API_KEY" "$BRAIN_API/tasks" | jq --arg text "$TODO_TEXT" '[.tasks[] | select(.title == $text)] | length')

      if [[ "$EXISTING_TASK" -eq 0 ]]; then
        TASK_BODY=$(jq -n \
          --arg title "$TODO_TEXT" \
          --arg next_steps "Synced from Bee wearable. Bee Todo ID: $TODO_ID" \
          '{
            title: $title,
            status: "todo",
            ai_agent: "bee-sync",
            priority: "medium",
            next_steps: $next_steps
          }')

        curl -s -X POST \
          -H "X-Api-Key: $BRAIN_API_KEY" \
          -H "Content-Type: application/json" \
          -d "$TASK_BODY" \
          "$BRAIN_API/tasks" > /dev/null

        log "  Created task: $TODO_TEXT"
      else
        log "  Skipped (already exists): $TODO_TEXT"
      fi
    fi
  done

  log "Todos sync complete."
fi

# ============================================================
# SYNC CONVERSATIONS
# ============================================================
if [[ -z "$ONLY" || "$ONLY" == "convos" ]]; then
  log "Syncing conversations (last $RECENT_DAYS days)..."

  # Use bee sync to get conversations as markdown, then parse
  SYNC_DIR=$(mktemp -d)
  bee sync --output "$SYNC_DIR" --recent-days "$RECENT_DAYS" --only conversations 2>/dev/null

  # Process each conversation file
  find "$SYNC_DIR" -name "*.md" -path "*/conversations/*" | while read -r conv_file; do
    # Extract conversation ID from filename
    CONV_ID=$(basename "$conv_file" .md)
    CONV_CONTENT=$(cat "$conv_file")

    # Extract title from the first heading or short summary
    CONV_TITLE=$(grep -m1 "^# " "$conv_file" | sed 's/^# //' || echo "Conversation $CONV_ID")

    # Extract date from the directory path
    CONV_DATE=$(echo "$conv_file" | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}' | head -1 || echo "unknown")

    TITLE="Bee Conversation ($CONV_DATE): $CONV_TITLE"
    # Truncate title if too long
    TITLE=$(echo "$TITLE" | head -c 200)

    CONTENT="$CONV_CONTENT

---
Source: Bee wearable
Bee Conversation ID: $CONV_ID
Date: $CONV_DATE"

    # Check if this conversation already exists in the brain
    EXISTING=$(curl -s -H "X-Api-Key: $BRAIN_API_KEY" "$BRAIN_API/knowledge?q=Bee+Conversation+ID:+$CONV_ID" | jq '.count')

    if [[ "$EXISTING" -gt 0 ]]; then
      EXISTING_ID=$(curl -s -H "X-Api-Key: $BRAIN_API_KEY" "$BRAIN_API/knowledge?q=Bee+Conversation+ID:+$CONV_ID" | jq -r '.entries[0].id')
      brain_update "$EXISTING_ID" "$TITLE" "$CONTENT" "meeting" > /dev/null
      log "  Updated conversation: $CONV_ID ($CONV_DATE)"
    else
      brain_save "$TITLE" "$CONTENT" "meeting" '["bee", "conversation"]' > /dev/null
      log "  Saved conversation: $CONV_ID ($CONV_DATE)"
    fi
  done

  # Clean up temp directory
  rm -rf "$SYNC_DIR"

  log "Conversations sync complete."
fi

log "Bee → AB Brain sync finished!"
