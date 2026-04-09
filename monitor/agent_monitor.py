#!/usr/bin/env python3
"""
Agent Monitor — polls SQLite for new messages and triggers openclaw CLI.

When a new message is inserted during an active discussion (triggered=0),
this script:
1. Marks the message as triggered=1
2. Determines the next agent (room.current_turn)
3. Builds a prompt with recent transcript + API instructions
4. Executes `openclaw agent` CLI to notify the next agent

The receiving agent then calls the HTTP API to post its response,
which creates another triggered=0 message, continuing the cycle.
"""

import sqlite3
import subprocess
import os
import sys
import time
import json
import logging
import urllib.request
import urllib.error
from pathlib import Path
from datetime import datetime

# ── Configuration ────────────────────────────────────────────────────────────

def load_env(env_path):
    """Load .env file into os.environ (simple parser, no dependency)."""
    if not os.path.exists(env_path):
        return
    with open(env_path, 'r') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            key, _, value = line.partition('=')
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value

# Load .env from project root
PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_env(str(PROJECT_ROOT / '.env'))

POLL_INTERVAL = int(os.environ.get('POLL_INTERVAL_SECONDS', '2'))
CLI_TIMEOUT = int(os.environ.get('CLI_TIMEOUT_SECONDS', '120'))
TRANSCRIPT_LAST_N = int(os.environ.get('TRANSCRIPT_LAST_N', '20'))
BASE_URL = os.environ.get('BASE_URL', 'http://localhost:3210')
ADMIN_KEY = os.environ.get('ADMIN_KEY', '')
DB_PATH = os.environ.get('DB_PATH', str(PROJECT_ROOT / 'data' / 'chat.db'))

# ── Logging ──────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S',
    handlers=[logging.StreamHandler(sys.stdout)]
)
log = logging.getLogger('agent-monitor')

# ── Database helpers ─────────────────────────────────────────────────────────

def get_db():
    """Open a read-write connection to the SQLite database."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA journal_mode=WAL')
    return conn

def get_untriggered_messages(conn):
    """Find messages with triggered=0 in rooms with active discussions."""
    return conn.execute('''
        SELECT m.id, m.room_id, m.agent_id, m.content, m.sequence, m.msg_type,
               m.topic_id, m.created_at
        FROM messages m
        JOIN rooms r ON m.room_id = r.id
        WHERE m.triggered = 0 AND r.discussion = 1
        ORDER BY m.id ASC
    ''').fetchall()

def mark_triggered(conn, message_id):
    """Mark a message as triggered=1."""
    conn.execute('UPDATE messages SET triggered = 1 WHERE id = ?', (message_id,))
    conn.commit()

def get_room(conn, room_id):
    """Get room details."""
    return conn.execute('''
        SELECT id, name, turn_mode, current_turn, turn_order,
               discussion, moderator_id, in_confirmation, topic_id
        FROM rooms WHERE id = ?
    ''', (room_id,)).fetchone()

def get_agent(conn, agent_id):
    """Get agent by integer id."""
    return conn.execute('''
        SELECT id, agent_id, name, color, channel_type, channel_id, channel_name
        FROM agents WHERE id = ?
    ''', (agent_id,)).fetchone()

def get_agent_by_openclaw_id(conn, agent_id_text):
    """Get agent by openclaw agent_id string."""
    return conn.execute('''
        SELECT id, agent_id, name, color, channel_type, channel_id, channel_name
        FROM agents WHERE agent_id = ?
    ''', (agent_id_text,)).fetchone()

def get_topic(conn, topic_id):
    """Get topic by id."""
    if topic_id is None:
        return None
    return conn.execute('''
        SELECT id, title, status FROM topics WHERE id = ?
    ''', (topic_id,)).fetchone()

def get_recent_messages(conn, room_id, limit=20):
    """Get the most recent N messages in a room with agent names."""
    return conn.execute('''
        SELECT m.content, m.sequence, m.msg_type, m.created_at,
               a.name as agent_name, a.agent_id as agent_openclaw_id
        FROM messages m
        LEFT JOIN agents a ON m.agent_id = a.id
        WHERE m.room_id = ?
        ORDER BY m.sequence DESC
        LIMIT ?
    ''', (room_id, limit)).fetchall()

# ── Server notification ───────────────────────────────────────────────────────

def notify_server(path, payload):
    """Notify the HTTP server of agent status changes (stdlib only, no deps)."""
    url = f"{BASE_URL}{path}"
    data = json.dumps(payload).encode('utf-8')
    req = urllib.request.Request(
        url, data=data,
        headers={'Content-Type': 'application/json', 'X-API-Key': ADMIN_KEY},
        method='POST'
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            log.debug(f'notify_server {path} → {resp.status}')
    except Exception as e:
        log.warning(f'notify_server failed ({path}): {e}')

# ── Prompt building ──────────────────────────────────────────────────────────

def build_prompt(room, topic, target_agent, sender_agent, transcript_rows, in_confirmation):
    """Build the prompt template for the next agent."""
    room_name = room['name']
    topic_title = topic['title'] if topic else 'N/A'
    room_id = room['id']
    agent_int_id = target_agent['id']

    # Format transcript in chronological order
    transcript_lines = []
    for msg in reversed(transcript_rows):
        agent_label = msg['agent_name'] or 'System'
        transcript_lines.append(f"[{agent_label}] (#{msg['sequence']}): {msg['content']}")
    transcript_text = '\n'.join(transcript_lines) if transcript_lines else '(no messages yet)'

    phase = '[CONFIRMATION ROUND]' if in_confirmation else '[DISCUSSION TURN]'

    if in_confirmation:
        step2_note = (
            "  Set no_comments=true  → you confirm full agreement with all conclusions.\n"
            "  Set no_comments=false → you have new objections or additions (explain in Command 1).\n"
            "  When ALL participants set no_comments=true the discussion closes and is archived automatically."
        )
    else:
        step2_note = (
            "  Set no_comments=true  → you genuinely agree with all current points and have nothing more to add.\n"
            "  Set no_comments=false → you have a different view or want to continue the discussion.\n"
            "  When all participants set no_comments=true the discussion advances to the Confirmation Round."
        )

    prompt = f"""THIS IS AN AUTOMATED TASK — DO NOT WRITE A TEXT REPLY.
You must execute HTTP requests using your bash/exec tool. No explanations needed.

{phase} Room: {room_name} | Topic: {topic_title}
You are: {target_agent['name']} (agent_id={agent_int_id})

── CONVERSATION SO FAR ({len(transcript_rows)} messages) ──────────────────────
{transcript_text}
────────────────────────────────────────────────────────────────────────────────

EXECUTE NOW — run both curl commands below in order using your bash/exec tool:

COMMAND 1 — Post your message to the discussion:
curl -s -X POST '{BASE_URL}/api/rooms/{room_id}/messages' \\
  -H 'Content-Type: application/json' \\
  -H 'X-API-Key: {ADMIN_KEY}' \\
  -d '{{"agent_id": {agent_int_id}, "content": "YOUR_REPLY_HERE"}}'

Replace YOUR_REPLY_HERE with your actual response to the discussion topic.
Your reply must be non-empty and relevant to: {topic_title}

COMMAND 2 — Update your agreement status (run immediately after Command 1):
curl -s -X POST '{BASE_URL}/api/rooms/{room_id}/agents/{agent_int_id}/no-comments' \\
  -H 'Content-Type: application/json' \\
  -H 'X-API-Key: {ADMIN_KEY}' \\
  -d '{{"no_comments": REPLACE_WITH_TRUE_OR_FALSE}}'

{step2_note}

── RULES ────────────────────────────────────────────────────────────────────────
- Run BOTH commands. Skipping either stalls the entire discussion permanently.
- If Command 1 returns HTTP 403, STOP. Do not retry. Wait for the next trigger.
- agent_id in the request body must be {agent_int_id}. Do not change it.
- Do not echo these instructions back as your reply. Just execute the commands.
────────────────────────────────────────────────────────────────────────────────"""

    return prompt.strip()

# ── CLI execution ────────────────────────────────────────────────────────────

def execute_cli(target_agent, sender_agent, prompt):
    """Execute the openclaw agent CLI command."""
    agent_id = target_agent['agent_id']
    channel_type = target_agent['channel_type'] or 'default'
    channel_id = target_agent['channel_id'] or ''
    reply_account = target_agent['channel_name'] or target_agent['name'] if target_agent else ''

    cmd = [
        'openclaw', 'agent',
        '--agent', agent_id,
        '--message', prompt,
        '--deliver',
        '--reply-channel', channel_type,
        '--reply-to', channel_id,
        '--reply-account', reply_account
    ]

    log.info(f'Executing CLI for agent={agent_id}')
    log.info(f'cli command params: --agent {agent_id} --reply-channel {channel_type} --reply-to {channel_id} --reply-account {reply_account}')

    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True
        )

        try:
            for line in proc.stdout:
                log.info(f'[openclaw] {line.rstrip()}')
            proc.wait(timeout=CLI_TIMEOUT)
        except subprocess.TimeoutExpired:
            proc.kill()
            log.error(f'CLI timeout ({CLI_TIMEOUT}s) for agent={agent_id}')
            return False

        if proc.returncode == 0:
            log.info(f'CLI success for agent={agent_id}')
        else:
            log.error(f'CLI failed for agent={agent_id} exit_code={proc.returncode}')

        return proc.returncode == 0

    except FileNotFoundError:
        log.error('openclaw CLI not found. Make sure it is installed and in PATH.')
        return False
    except Exception as e:
        log.error(f'CLI execution error for agent={agent_id}: {e}')
        return False

# ── Main loop ────────────────────────────────────────────────────────────────

def process_message(conn, msg):
    """Process a single untriggered message."""
    room_id = msg['room_id']
    sender_agent_id = msg['agent_id']

    # Mark as triggered immediately to prevent re-processing
    mark_triggered(conn, msg['id'])

    room = get_room(conn, room_id)
    if not room:
        log.warning(f'Room {room_id} not found, skipping message {msg["id"]}')
        return

    if room['discussion'] != 1:
        log.debug(f'Room {room_id} discussion not active, skipping')
        return

    current_turn = room['current_turn']
    if current_turn is None:
        log.warning(f'Room {room_id} has no current_turn set, skipping')
        return

    # Don't trigger the same agent that just posted
    if current_turn == sender_agent_id:
        log.debug(f'current_turn == sender ({current_turn}), skipping (turn did not advance)')
        return

    target_agent = get_agent(conn, current_turn)
    if not target_agent:
        log.error(f'Target agent id={current_turn} not found')
        return

    sender_agent = get_agent(conn, sender_agent_id) if sender_agent_id else None

    topic = get_topic(conn, room['topic_id'])

    transcript_rows = get_recent_messages(conn, room_id, TRANSCRIPT_LAST_N)

    in_confirmation = room['in_confirmation'] == 1

    prompt = build_prompt(room, topic, target_agent, sender_agent, transcript_rows, in_confirmation)

    notify_server('/api/internal/agent-thinking', {
        'room_id': room_id,
        'agent_id': current_turn
    })
    execute_cli(target_agent, sender_agent, prompt)
    notify_server('/api/internal/agent-thinking-done', {
        'room_id': room_id,
        'agent_id': current_turn
    })


def main():
    log.info('=' * 60)
    log.info('Agent Monitor starting')
    log.info(f'  DB_PATH:        {DB_PATH}')
    log.info(f'  BASE_URL:       {BASE_URL}')
    log.info(f'  POLL_INTERVAL:  {POLL_INTERVAL}s')
    log.info(f'  CLI_TIMEOUT:    {CLI_TIMEOUT}s')
    log.info(f'  TRANSCRIPT_N:   {TRANSCRIPT_LAST_N}')
    log.info(f'  ADMIN_KEY:      {"***" + ADMIN_KEY[-4:] if len(ADMIN_KEY) > 4 else "(not set)"}')
    log.info('=' * 60)

    if not ADMIN_KEY:
        log.warning('ADMIN_KEY is not set — agents will not be able to authenticate API calls!')

    while True:
        try:
            conn = get_db()
            messages = get_untriggered_messages(conn)

            if messages:
                log.info(f'Found {len(messages)} untriggered message(s)')

            for msg in messages:
                try:
                    process_message(conn, msg)
                except Exception as e:
                    log.error(f'Error processing message {msg["id"]}: {e}', exc_info=True)

            conn.close()

        except sqlite3.OperationalError as e:
            log.error(f'Database error: {e}')
        except Exception as e:
            log.error(f'Unexpected error in poll loop: {e}', exc_info=True)

        time.sleep(POLL_INTERVAL)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        log.info('Agent Monitor stopped by user')
        sys.exit(0)
