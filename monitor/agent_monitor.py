#!/usr/bin/env python3
"""
Agent Monitor — Python-driven multi-agent discussion controller (v0.1.0).

Architecture:
1. Polls for active discussion rooms (discussion=1).
2. For each active room, triggers the current_turn agent via openclaw CLI.
3. Captures the agent's JSON response from stdout: {"message": "...", "agree": true/false}
4. Posts the parsed message to the HTTP API (handles DB insert, turn advance, consensus check).
5. If consensus reached (discussion=0), triggers the moderator for a summary report.
6. Inserts the moderator summary into messages and closes the topic via HTTP API.

Multiple rooms run in parallel via ThreadPoolExecutor. Each room has a lock to prevent
double-triggering. Each thread holds its own SQLite connection.
"""

import sqlite3
import subprocess
import os
import sys
import time
import json
import re
import logging
import urllib.request
import urllib.error
import threading
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

# ── Configuration ─────────────────────────────────────────────────────────────

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

PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_env(str(PROJECT_ROOT / '.env'))

POLL_INTERVAL  = int(os.environ.get('POLL_INTERVAL_SECONDS', '2'))
CLI_TIMEOUT    = int(os.environ.get('CLI_TIMEOUT_SECONDS', '120'))
BASE_URL       = os.environ.get('BASE_URL', 'http://localhost:3210')
ADMIN_KEY      = os.environ.get('ADMIN_KEY', '')
DB_PATH        = os.environ.get('DB_PATH', str(PROJECT_ROOT / 'data' / 'chat.db'))
MAX_ROOMS      = int(os.environ.get('MAX_ROOMS', '10'))

# Matches ANSI/VT100 escape sequences (e.g. spinner animation from openclaw CLI)
ANSI_ESCAPE_RE = re.compile(r'\x1b\[[0-9;?]*[A-Za-z]')

# ── Logging ───────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S',
    handlers=[logging.StreamHandler(sys.stdout)]
)
log = logging.getLogger('agent-monitor')

# ── Thread safety ─────────────────────────────────────────────────────────────

_room_locks: dict[int, threading.Lock] = {}
_room_locks_mutex = threading.Lock()

def get_room_lock(room_id: int) -> threading.Lock:
    """Get or create a per-room lock."""
    with _room_locks_mutex:
        if room_id not in _room_locks:
            _room_locks[room_id] = threading.Lock()
        return _room_locks[room_id]

# ── Database helpers ──────────────────────────────────────────────────────────

def get_db():
    """Open a read-write connection to the SQLite database.
    isolation_level=None enables autocommit mode, ensuring each SELECT
    always reads the latest committed WAL data without snapshot pinning.
    """
    conn = sqlite3.connect(DB_PATH, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA journal_mode=WAL')
    return conn

def get_active_discussions(conn):
    """Return all rooms with an active discussion."""
    return conn.execute('''
        SELECT id, name, turn_mode, current_turn, turn_order,
               discussion, moderator_id, in_confirmation, topic_id
        FROM rooms
        WHERE discussion = 1 AND current_turn IS NOT NULL
    ''').fetchall()

def get_room(conn, room_id):
    """Get current room state."""
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

def get_topic(conn, topic_id):
    """Get topic by id."""
    if topic_id is None:
        return None
    return conn.execute('''
        SELECT id, title, status FROM topics WHERE id = ?
    ''', (topic_id,)).fetchone()

def get_recent_messages(conn, room_id, topic_id=None, limit=20):
    """Get the most recent N messages in a room (filtered by topic if provided)."""
    if topic_id is not None:
        rows = conn.execute('''
            SELECT m.content, m.sequence, m.msg_type, m.created_at,
                   a.name as agent_name
            FROM messages m
            LEFT JOIN agents a ON m.agent_id = a.id
            WHERE m.room_id = ? AND m.topic_id = ?
            ORDER BY m.sequence DESC
            LIMIT ?
        ''', (room_id, topic_id, limit)).fetchall()
    else:
        rows = conn.execute('''
            SELECT m.content, m.sequence, m.msg_type, m.created_at,
                   a.name as agent_name
            FROM messages m
            LEFT JOIN agents a ON m.agent_id = a.id
            WHERE m.room_id = ?
            ORDER BY m.sequence DESC
            LIMIT ?
        ''', (room_id, limit)).fetchall()
    return rows

def get_all_topic_messages(conn, topic_id):
    """Get all messages for a topic (for moderator summary)."""
    return conn.execute('''
        SELECT m.content, m.sequence, m.created_at, a.name as agent_name
        FROM messages m
        LEFT JOIN agents a ON m.agent_id = a.id
        WHERE m.topic_id = ?
        ORDER BY m.sequence ASC
    ''', (topic_id,)).fetchall()

def get_room_agent_count(conn, room_id):
    """Return the number of agents participating in a room."""
    row = conn.execute(
        'SELECT COUNT(*) as cnt FROM agents_rooms WHERE room_id = ?',
        (room_id,)
    ).fetchone()
    return row['cnt'] if row else 0

# ── HTTP API helpers ──────────────────────────────────────────────────────────

def _api_request(method, path, payload=None):
    """Make an authenticated HTTP request to the server."""
    url = f"{BASE_URL}{path}"
    data = json.dumps(payload).encode('utf-8') if payload is not None else b''
    req = urllib.request.Request(
        url, data=data,
        headers={'Content-Type': 'application/json', 'X-API-Key': ADMIN_KEY},
        method=method
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read().decode('utf-8')
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8')
        log.error(f'API {method} {path} → HTTP {e.code}: {body}')
        return None
    except Exception as e:
        log.error(f'API {method} {path} error: {e}')
        return None

def post_message_http(room_id, agent_id, content, agree=None, msg_type='message'):
    """Post a message on behalf of an agent via the HTTP API."""
    payload = {
        'agent_id': agent_id,
        'content': content,
        'msg_type': msg_type
    }
    if agree is not None:
        payload['no_comments'] = bool(agree)
    return _api_request('POST', f'/api/rooms/{room_id}/messages', payload)

def get_room_http(room_id):
    """Get current room state via HTTP API."""
    return _api_request('GET', f'/api/rooms/{room_id}')

def close_topic_http(room_id, topic_id):
    """Close a topic via the HTTP API."""
    return _api_request('POST', f'/api/rooms/{room_id}/topics/{topic_id}/close', {})

def notify_thinking(room_id, agent_id):
    """Notify server that agent is thinking (for UI indicator)."""
    _api_request('POST', '/api/internal/agent-thinking', {
        'room_id': room_id,
        'agent_id': agent_id
    })

def notify_thinking_done(room_id, agent_id):
    """Notify server that agent finished thinking."""
    _api_request('POST', '/api/internal/agent-thinking-done', {
        'room_id': room_id,
        'agent_id': agent_id
    })

# ── JSON parsing ──────────────────────────────────────────────────────────────

def strip_ansi(text):
    """去除 ANSI/VT100 转义序列（如 openclaw CLI 的旋转动画输出）。"""
    return ANSI_ESCAPE_RE.sub('', text)

def parse_agent_response(output_text):
    """
    从 CLI stdout 中解析 agent 的 JSON 响应。
    期望格式：{"message": "...", "agree": true/false}
    支持 ANSI 转义码和 markdown 代码块包裹的场景。

    使用 json.JSONDecoder().raw_decode() 替代手写括号深度计数，
    可正确处理 "message" 字段内容中包含 { } 字符的情况。
    """
    if not output_text or not output_text.strip():
        return None

    clean = strip_ansi(output_text)
    decoder = json.JSONDecoder()
    last_valid = None

    for i, ch in enumerate(clean):
        if ch != '{':
            continue
        try:
            obj, _ = decoder.raw_decode(clean, i)
            if isinstance(obj, dict) and isinstance(obj.get('message'), str) and obj['message'].strip():
                last_valid = obj  # 保留最后一个有效对象
        except json.JSONDecodeError:
            continue

    if last_valid:
        log.info(f'Parsed response: agree={last_valid.get("agree")} msg_len={len(last_valid.get("message", ""))}')
        return last_valid

    log.warning(f'No valid JSON with "message" field found in CLI output (output length: {len(clean)})')
    return None

# ── Prompt building ──────────────────────────────────────────────────────────

def build_discussion_prompt(room, topic, target_agent, transcript_rows, in_confirmation):
    """
    Build the discussion prompt for an agent.
    Agent must respond with JSON: {"message": "...", "agree": true/false}
    """
    room_name  = room['name']
    topic_title = topic['title'] if topic else 'N/A'
    agent_name = target_agent['name']
    phase = '[CONFIRMATION ROUND]' if in_confirmation else '[DISCUSSION TURN]'

    # Format transcript in chronological order
    transcript_lines = []
    for msg in reversed(transcript_rows):
        label = msg['agent_name'] or 'System'
        transcript_lines.append(f"[{label}] (#{msg['sequence']}): {msg['content']}")
    transcript_text = '\n'.join(transcript_lines) if transcript_lines else '(no messages yet — you are the first speaker)'

    if in_confirmation:
        agree_description = (
            "agree=true  → you confirm full agreement with ALL conclusions reached in this discussion.\n"
            "agree=false → you have NEW objections or additions (explain them in 'message').\n"
            "When ALL participants set agree=true, the discussion closes and a summary is generated."
        )
    else:
        agree_description = (
            "agree=true  → you genuinely agree with all current points and have nothing more to add.\n"
            "agree=false → you have a different view or want to continue the discussion.\n"
            "When all participants set agree=true, the discussion advances to the Confirmation Round."
        )

    prompt = f"""THIS IS AN AUTOMATED DISCUSSION TASK.

{phase} | Room: {room_name} | Topic: {topic_title}
You are: {agent_name}

── RECENT CONVERSATION ({len(transcript_rows)} messages) ──────────────────────
{transcript_text}
────────────────────────────────────────────────────────────────────────────────

── YOUR TASK ────────────────────────────────────────────────────────────────────
Read the conversation above and respond to the topic: "{topic_title}"
- Stay strictly on topic. Do not introduce unrelated subjects.
- Your response should directly address the discussion.

── RESPONSE FORMAT (REQUIRED) ───────────────────────────────────────────────────
You MUST output a single JSON object — nothing else:

{{"message": "your response here", "agree": true or false}}

{agree_description}

⚠️  IMPORTANT: If your reply channel is Telegram or another messaging platform,
    use the content of the "message" field as your reply text.
    The system will extract the "message" field automatically.

Output ONLY the JSON object. Do not include any other text, explanations, or formatting.
────────────────────────────────────────────────────────────────────────────────"""

    return prompt.strip()


def build_moderator_prompt(room, topic, moderator_agent, all_messages):
    """
    Build the moderator summary prompt.
    Moderator must respond with JSON: {"message": "summary text", "agree": true}
    """
    room_name   = room['name']
    topic_title = topic['title'] if topic else 'N/A'
    agent_name  = moderator_agent['name']

    transcript_lines = []
    for msg in all_messages:
        label = msg['agent_name'] or 'System'
        transcript_lines.append(f"[{label}] (#{msg['sequence']}): {msg['content']}")
    transcript_text = '\n'.join(transcript_lines) if transcript_lines else '(no messages)'

    prompt = f"""THIS IS AN AUTOMATED MODERATION TASK.

[DISCUSSION SUMMARY] Room: {room_name} | Topic: {topic_title}
You are the Moderator: {agent_name}

The discussion has reached full consensus. Your task is to generate a comprehensive summary report.

── COMPLETE DISCUSSION TRANSCRIPT ({len(all_messages)} messages) ────────────────
{transcript_text}
────────────────────────────────────────────────────────────────────────────────

── YOUR TASK ────────────────────────────────────────────────────────────────────
Write a structured summary covering:
- Main points and positions from each participant
- Key agreements and conclusions reached
- Any decisions or action items identified

── RESPONSE FORMAT (REQUIRED) ───────────────────────────────────────────────────
You MUST output a single JSON object — nothing else:

{{"message": "your complete summary here", "agree": true}}

⚠️  IMPORTANT: If your reply channel is Telegram or another messaging platform,
    use the content of the "message" field as your summary text.
    The system will automatically insert your summary and close the discussion.

Output ONLY the JSON object. Do not include any other text or formatting.
────────────────────────────────────────────────────────────────────────────────"""

    return prompt.strip()

# ── CLI execution ─────────────────────────────────────────────────────────────

def execute_cli_capture(target_agent, prompt):
    """
    Execute the openclaw agent CLI, capture stdout, and parse the JSON response.
    Returns parsed dict {"message": "...", "agree": true/false} or None on failure.
    """
    agent_id     = target_agent['agent_id']
    channel_type = target_agent['channel_type'] or 'default'
    channel_id   = target_agent['channel_id'] or ''
    reply_account = target_agent['channel_name'] or target_agent['name']

    cmd = [
        'openclaw', 'agent',
        '--agent',         agent_id,
        '--message',       prompt,
        '--deliver',
        '--reply-channel', channel_type,
        '--reply-to',      channel_id,
        '--reply-account', reply_account
    ]

    log.info(f'Executing CLI for agent={agent_id} channel={channel_type}')

    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True
        )

        try:
            stdout_data, _ = proc.communicate(timeout=CLI_TIMEOUT)
        except subprocess.TimeoutExpired:
            proc.kill()
            stdout_data, _ = proc.communicate()
            log.error(f'CLI timeout ({CLI_TIMEOUT}s) for agent={agent_id}')
            return None

        # Log the raw output for debugging
        for line in stdout_data.splitlines():
            log.info(f'[openclaw:{agent_id}] {line}')

        if proc.returncode != 0:
            log.error(f'CLI exit_code={proc.returncode} for agent={agent_id}')

        # Parse JSON from stdout regardless of exit code
        parsed = parse_agent_response(stdout_data)
        if parsed:
            log.info(f'Parsed response from agent={agent_id}: agree={parsed.get("agree")} msg_len={len(parsed.get("message",""))}')
        else:
            log.error(f'Failed to parse JSON response from agent={agent_id}')

        return parsed

    except FileNotFoundError:
        log.error('openclaw CLI not found. Make sure it is installed and in PATH.')
        return None
    except Exception as e:
        log.error(f'CLI execution error for agent={agent_id}: {e}')
        return None

# ── Room turn processing ──────────────────────────────────────────────────────

def process_room_turn(conn, room):
    """
    Drive one turn for the given room:
    1. Trigger current_turn agent via CLI
    2. Capture JSON response
    3. Post message via HTTP API
    4. If discussion ended (consensus), trigger moderator summary
    """
    room_id       = room['id']
    room_name     = room['name']
    current_turn  = room['current_turn']

    target_agent = get_agent(conn, current_turn)
    if not target_agent:
        log.error(f'Room {room_id}: current_turn agent id={current_turn} not found')
        return

    topic = get_topic(conn, room['topic_id'])
    if not topic:
        log.warning(f'Room {room_id}: no active topic found (topic_id={room["topic_id"]})')
        return

    agent_count      = get_room_agent_count(conn, room_id)
    transcript_limit = max(1, agent_count - 1)
    transcript_rows  = get_recent_messages(conn, room_id, topic_id=room['topic_id'], limit=transcript_limit)
    in_confirmation  = room['in_confirmation'] == 1

    log.info(f'Room {room_id} ({room_name}): triggering agent={target_agent["agent_id"]} '
             f'phase={"confirmation" if in_confirmation else "discussion"}')

    # Notify UI: agent is thinking
    notify_thinking(room_id, current_turn)

    prompt = build_discussion_prompt(room, topic, target_agent, transcript_rows, in_confirmation)
    json_response = execute_cli_capture(target_agent, prompt)

    # Notify UI: agent finished thinking
    notify_thinking_done(room_id, current_turn)

    if not json_response:
        log.error(f'Room {room_id}: no valid JSON response from agent={target_agent["agent_id"]}, skipping turn')
        return

    message_content = json_response.get('message', '').strip()
    agree           = json_response.get('agree', False)

    if not message_content:
        log.error(f'Room {room_id}: agent={target_agent["agent_id"]} returned empty message, skipping')
        return

    # Post message via HTTP API (handles: DB insert, turn advance, no_comments, consensus check)
    api_result = post_message_http(room_id, target_agent['id'], message_content, agree=agree)
    if api_result is None:
        log.error(f'Room {room_id}: failed to post message for agent={target_agent["agent_id"]}')
        return

    log.info(f'Room {room_id}: message posted, seq={api_result.get("sequence")} agree={agree}')

    # Check if discussion ended (consensus reached)
    updated_room = get_room_http(room_id)
    if updated_room and updated_room.get('discussion') == 0:
        log.info(f'Room {room_id}: discussion ended (consensus). Triggering moderator summary.')
        moderator_id = updated_room.get('moderator_id')
        topic_id     = room['topic_id']

        if moderator_id and topic_id:
            handle_moderator_summary(conn, room_id, moderator_id, topic_id, room_name)
        else:
            log.warning(f'Room {room_id}: cannot trigger moderator — moderator_id={moderator_id} topic_id={topic_id}')


def handle_moderator_summary(conn, room_id, moderator_id, topic_id, room_name):
    """
    Trigger the moderator agent to generate a summary:
    1. Capture moderator's JSON response
    2. Insert summary into messages table
    3. Close the topic
    """
    moderator = get_agent(conn, moderator_id)
    if not moderator:
        log.error(f'Room {room_id}: moderator agent id={moderator_id} not found')
        return

    topic = get_topic(conn, topic_id)
    if not topic:
        log.error(f'Room {room_id}: topic id={topic_id} not found for summary')
        return

    all_messages = get_all_topic_messages(conn, topic_id)

    # Construct a minimal room dict for the prompt
    room_info = {'id': room_id, 'name': room_name}

    log.info(f'Room {room_id}: generating moderator summary via agent={moderator["agent_id"]}')

    notify_thinking(room_id, moderator_id)

    prompt = build_moderator_prompt(room_info, topic, moderator, all_messages)
    json_response = execute_cli_capture(moderator, prompt)

    notify_thinking_done(room_id, moderator_id)

    if not json_response:
        log.error(f'Room {room_id}: no valid JSON summary from moderator={moderator["agent_id"]}')
        return

    summary_content = json_response.get('message', '').strip()
    if not summary_content:
        log.error(f'Room {room_id}: moderator returned empty summary, skipping insert')
        return

    # Insert summary into messages (msg_type='summary', no agree field)
    api_result = post_message_http(room_id, moderator['id'], summary_content, agree=None, msg_type='summary')
    if api_result:
        log.info(f'Room {room_id}: moderator summary inserted seq={api_result.get("sequence")}')
    else:
        log.error(f'Room {room_id}: failed to insert moderator summary')

    # Close the topic
    close_result = close_topic_http(room_id, topic_id)
    if close_result:
        log.info(f'Room {room_id}: topic {topic_id} closed')
    else:
        log.error(f'Room {room_id}: failed to close topic {topic_id}')

# ── Per-room safe wrapper ─────────────────────────────────────────────────────

def process_room_safe(room_snapshot):
    """
    Thread-safe wrapper around process_room_turn.
    Uses a per-room lock to prevent concurrent processing of the same room.
    Each thread gets its own DB connection.

    Room state is fetched via HTTP API (not local SQLite) to avoid WAL snapshot
    inconsistencies — the HTTP response always reflects the same committed state
    that the API server uses for turn validation.
    """
    room_id   = room_snapshot['id']
    room_name = room_snapshot['name']

    lock = get_room_lock(room_id)
    if not lock.acquire(blocking=False):
        log.debug(f'Room {room_id} ({room_name}): already processing, skipping')
        return

    conn = None
    try:
        # Use HTTP API for authoritative room state (same view as Node.js validateTurn)
        fresh_room = get_room_http(room_id)
        if (not fresh_room
                or fresh_room.get('discussion') != 1
                or fresh_room.get('current_turn') is None):
            log.debug(f'Room {room_id}: no longer active (via HTTP), skipping')
            return
        conn = get_db()
        process_room_turn(conn, fresh_room)
    except Exception as e:
        log.error(f'Room {room_id}: unexpected error: {e}', exc_info=True)
    finally:
        if conn:
            conn.close()
        lock.release()

# ── Main loop ─────────────────────────────────────────────────────────────────

def main():
    log.info('=' * 60)
    log.info('Agent Monitor starting (v0.1.0 — Python-driven)')
    log.info(f'  DB_PATH:        {DB_PATH}')
    log.info(f'  BASE_URL:       {BASE_URL}')
    log.info(f'  POLL_INTERVAL:  {POLL_INTERVAL}s')
    log.info(f'  CLI_TIMEOUT:    {CLI_TIMEOUT}s')
    log.info(f'  MAX_ROOMS:      {MAX_ROOMS}')
    log.info(f'  ADMIN_KEY:      {"***" + ADMIN_KEY[-4:] if len(ADMIN_KEY) > 4 else "(not set)"}')
    log.info('=' * 60)

    if not ADMIN_KEY:
        log.warning('ADMIN_KEY is not set — API calls will fail authentication!')

    # active_futures tracks rooms currently being processed: room_id → Future
    active_futures: dict[int, object] = {}

    executor = ThreadPoolExecutor(max_workers=MAX_ROOMS, thread_name_prefix='room-worker')

    try:
        while True:
            try:
                conn = get_db()
                active_rooms = get_active_discussions(conn)
                conn.close()

                if active_rooms:
                    log.info(f'Active discussions: {len(active_rooms)} room(s)')

                for room in active_rooms:
                    room_id = room['id']

                    # Skip rooms that have an ongoing future (still processing previous turn)
                    fut = active_futures.get(room_id)
                    if fut is not None and not fut.done():
                        log.debug(f'Room {room_id}: previous turn still running, skipping')
                        continue

                    # Submit new turn processing task
                    # Pass a dict snapshot (Row objects can't be pickled across threads safely)
                    room_dict = dict(room)
                    active_futures[room_id] = executor.submit(process_room_safe, room_dict)

                # Clean up completed futures
                done_rooms = [rid for rid, fut in active_futures.items() if fut.done()]
                for rid in done_rooms:
                    del active_futures[rid]

            except sqlite3.OperationalError as e:
                log.error(f'Database error in main loop: {e}')
            except Exception as e:
                log.error(f'Unexpected error in main loop: {e}', exc_info=True)

            time.sleep(POLL_INTERVAL)

    finally:
        log.info('Shutting down executor...')
        executor.shutdown(wait=False)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        log.info('Agent Monitor stopped by user')
        sys.exit(0)
