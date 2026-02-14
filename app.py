# app_with_github_sync.py
# Modified from user's original app.py to snapshot DB data and (optionally) uploaded media
# to a git repository inside the project directory. This file attempts to commit JSON
# snapshots after key operations (user register, admin uploads, metric updates, etc.)
#
# Added endpoint:
#   POST /api/admin/git_push
#   - requires admin auth (same as other admin endpoints)
#   - body params:
#       - include_media: "1"/"true"/"yes" to include media in commit (optional)
#       - message: commit message override (optional)
#   - returns JSON with success boolean and gathered git command outputs

from pathlib import Path
import sqlite3
import os
import secrets
import subprocess
from datetime import datetime
from flask import (
    Flask, render_template, request, jsonify, g, abort, url_for, session, send_from_directory
)
from werkzeug.utils import secure_filename
from werkzeug.security import generate_password_hash, check_password_hash
import json
import logging
import time

# --- basic logging ---
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).parent
DB_PATH = BASE_DIR / "data.db"
VIDEOS_DIR = BASE_DIR / "static" / "videos"
THUMBS_DIR = VIDEOS_DIR / "thumbnails"
SNAPSHOT_DIR = BASE_DIR / "data_snapshot"
VIDEOS_DIR.mkdir(parents=True, exist_ok=True)
THUMBS_DIR.mkdir(parents=True, exist_ok=True)
SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)

app = Flask(__name__, static_folder="static", template_folder="templates")
# set a secret key for sessions (in production set FLASK_SECRET env var)
app.secret_key = os.environ.get("FLASK_SECRET") or secrets.token_urlsafe(32)

# Environment flags (customize via environment variables)
# If you want uploaded video files to be committed into git, set GIT_COMMIT_MEDIA=1
GIT_COMMIT_MEDIA = os.environ.get("GIT_COMMIT_MEDIA", "0") == "1"
# Optionally set git author details used for automated commits
GIT_AUTHOR_NAME = os.environ.get("GIT_AUTHOR_NAME")
GIT_AUTHOR_EMAIL = os.environ.get("GIT_AUTHOR_EMAIL")
# If you want to skip trying to use git altogether, set GIT_SYNC=0
GIT_SYNC = os.environ.get("GIT_SYNC", "1") != "0"
# Maximum time for git operations (seconds)
try:
    GIT_TIMEOUT = int(os.environ.get("GIT_TIMEOUT", "15"))
except Exception:
    GIT_TIMEOUT = 15

# Git destination (required for runtime pushes)
# Example: https://username:ghp_xxx...@github.com/username/repo.git
GITHUB_REPO_URL = os.environ.get("GITHUB_REPO_URL")
GITHUB_REMOTE_NAME = os.environ.get("GITHUB_REMOTE_NAME", "origin")
GIT_BRANCH = os.environ.get("GIT_BRANCH", "main")

# ----- upload limits (adjust as needed) -----
app.config["MAX_CONTENT_LENGTH"] = 500 * 1024 * 1024


# ---------- helper: Snapshot DB to JSON files that are safe to commit ----------
def snapshot_data_to_json(conn):
    """
    Dump important tables to JSON files in data_snapshot/ and return list of file paths
    This avoids committing large binaries (videos) unless explicitly enabled.
    """
    try:
        out_files = []
        cur = conn.execute("SELECT id,username,age,country,occupation,admin,api_key,visits,reminders_set,last_seen,created_at FROM users ORDER BY id")
        users = [dict(zip([c[0] for c in cur.description], row)) for row in cur.fetchall()]
        ufile = SNAPSHOT_DIR / "users.json"
        ufile.write_text(json.dumps(users, default=str, indent=2), encoding="utf-8")
        out_files.append(str(ufile.relative_to(BASE_DIR)))

        cur = conn.execute(
            "SELECT id,title,category,difficulty,duration,video_url,thumbnail_url,description,uploaded_by,uploaded_at,views FROM routines ORDER BY id"
        )
        routines = [dict(zip([c[0] for c in cur.description], row)) for row in cur.fetchall()]
        rfile = SNAPSHOT_DIR / "routines.json"
        rfile.write_text(json.dumps(routines, default=str, indent=2), encoding="utf-8")
        out_files.append(str(rfile.relative_to(BASE_DIR)))

        cur = conn.execute("SELECT id,user_id,routine_id,played_at FROM plays ORDER BY id")
        plays = [dict(zip([c[0] for c in cur.description], row)) for row in cur.fetchall()]
        pfile = SNAPSHOT_DIR / "plays.json"
        pfile.write_text(json.dumps(plays, default=str, indent=2), encoding="utf-8")
        out_files.append(str(pfile.relative_to(BASE_DIR)))

        # Optionally snapshot the DB file itself (NOTE: this commits a binary sqlite DB)
        dbfile = DB_PATH
        if dbfile.exists():
            out_files.append(str(dbfile.relative_to(BASE_DIR)))

        return out_files
    except Exception as e:
        logger.exception("snapshot failed: %s", e)
        return []


# ---------- helper: git operations (add/commit/push) ----------
def git_repo_present():
    return (BASE_DIR / ".git").exists()


def run_git_cmd(args, timeout=GIT_TIMEOUT, env=None):
    try:
        logger.info("git %s", " ".join(args))
        r = subprocess.run(["git"] + args, cwd=str(BASE_DIR), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout, env=env)
        out = r.stdout.decode("utf-8", errors="replace").strip()
        err = r.stderr.decode("utf-8", errors="replace").strip()
        return r.returncode, out, err
    except subprocess.TimeoutExpired:
        return 1, "", "git command timed out"
    except FileNotFoundError:
        return 1, "", "git not installed"
    except Exception as e:
        return 1, "", str(e)


def ensure_git_identity():
    """
    Ensure local repo has user.name and user.email configured (local config).
    Use GIT_AUTHOR_NAME and GIT_AUTHOR_EMAIL env vars when present.
    """
    name = GIT_AUTHOR_NAME or os.environ.get("GIT_COMMITTER_NAME") or "auto-committer"
    email = GIT_AUTHOR_EMAIL or os.environ.get("GIT_COMMITTER_EMAIL") or "noreply@localhost"
    # set repo-local config (won't affect global)
    run_git_cmd(["config", "user.name", name])
    run_git_cmd(["config", "user.email", email])
    logger.info("git identity set: %s <%s>", name, email)


def ensure_remote_configured():
    """
    Ensure the remote (GITHUB_REMOTE_NAME) is set to GITHUB_REPO_URL.
    If not, add or set it.
    Returns True if remote is now configured, False otherwise.
    """
    if not GITHUB_REPO_URL:
        logger.info("No GITHUB_REPO_URL provided; skipping remote configuration")
        return False

    rc, out, err = run_git_cmd(["remote", "get-url", GITHUB_REMOTE_NAME])
    if rc == 0:
        if out.strip() == GITHUB_REPO_URL.strip():
            logger.info("Remote %s already configured", GITHUB_REMOTE_NAME)
            return True
        else:
            # remote exists but different URL — update it
            rc2, o2, e2 = run_git_cmd(["remote", "set-url", GITHUB_REMOTE_NAME, GITHUB_REPO_URL])
            if rc2 == 0:
                logger.info("Remote %s url updated", GITHUB_REMOTE_NAME)
                return True
            else:
                logger.warning("Failed to set remote url: %s", e2 or o2)
                return False
    else:
        # add remote
        rc2, o2, e2 = run_git_cmd(["remote", "add", GITHUB_REMOTE_NAME, GITHUB_REPO_URL])
        if rc2 == 0:
            logger.info("Remote %s added", GITHUB_REMOTE_NAME)
            return True
        else:
            logger.warning("Failed to add remote: %s", e2 or o2)
            return False


def push_to_git(paths=None, message=None, include_media=False):
    """
    paths: list of relative paths (strings) to add to git. If None the function will snapshot the DB
    and add the snapshot files (and DB if present).

    This function is best-effort: it logs errors but doesn't raise so app requests won't fail
    if git is unavailable or push fails.
    """
    if not GIT_SYNC:
        logger.info("GIT_SYNC disabled via env; skipping git push")
        return False

    # Initialize git if missing and GITHUB_REPO_URL is set
    if not git_repo_present():
        logger.info(".git not present. Initializing git repository.")
        rc, out, err = run_git_cmd(["init"])
        if rc != 0:
            logger.warning("git init failed: %s", err or out)
            # continue; maybe subsequent operations will still work
        # ensure remote if URL provided
        if GITHUB_REPO_URL:
            rc2, o2, e2 = run_git_cmd(["remote", "add", GITHUB_REMOTE_NAME, GITHUB_REPO_URL])
            if rc2 != 0:
                logger.warning("git remote add failed: %s", e2 or o2)

    # If remote not configured, try to configure it
    if GITHUB_REPO_URL:
        ensure_remote_configured()

    if not git_repo_present():
        logger.info("No .git repo found under %s — skipping git operations", BASE_DIR)
        return False

    # Create snapshot paths if not provided
    if paths is None:
        try:
            conn = sqlite3.connect(DB_PATH, detect_types=sqlite3.PARSE_DECLTYPES)
            paths = snapshot_data_to_json(conn)
            conn.close()
        except Exception as e:
            logger.exception("could not snapshot DB for git push: %s", e)
            paths = []

    # optionally add uploaded media files (only when explicitly enabled)
    if include_media and GIT_COMMIT_MEDIA:
        paths.append(str(Path("static") / "videos"))

    # normalize paths and ensure there is something to add
    paths = [str(Path(p)) for p in paths if p]
    if not paths:
        logger.info("no paths to commit")
        return True

    try:
        # ensure local git identity exists
        ensure_git_identity()

        # run git add for each path
        add_args = ["add", "--"] + paths
        rc, out, err = run_git_cmd(add_args)
        if rc != 0:
            logger.warning("git add returned non-zero: %s", err or out)

        # check for staged changes
        rc, status_out, status_err = run_git_cmd(["status", "--porcelain"])
        if rc != 0:
            logger.warning("git status failed: %s", status_err or status_out)

        if not status_out.strip():
            logger.info("no changes to commit")
            return True

        # commit
        commit_message = message or f"autosave: snapshot {datetime.utcnow().isoformat()}"
        # also set GIT_AUTHOR_* env values for subprocess commit if provided
        env = os.environ.copy()
        if GIT_AUTHOR_NAME:
            env["GIT_AUTHOR_NAME"] = GIT_AUTHOR_NAME
            env["GIT_COMMITTER_NAME"] = GIT_AUTHOR_NAME
        if GIT_AUTHOR_EMAIL:
            env["GIT_AUTHOR_EMAIL"] = GIT_AUTHOR_EMAIL
            env["GIT_COMMITTER_EMAIL"] = GIT_AUTHOR_EMAIL

        logger.info("Committing with message: %s", commit_message)
        p = subprocess.run(["git", "commit", "-m", commit_message], cwd=str(BASE_DIR), stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, timeout=GIT_TIMEOUT)
        pout = p.stdout.decode("utf-8", errors="replace").strip()
        perr = p.stderr.decode("utf-8", errors="replace").strip()
        if p.returncode != 0:
            logger.warning("git commit failed (non-fatal): %s", perr or pout)
            # continue anyway to attempt push

        # If remote exists, push to the configured branch
        rc_remote, remote_out, remote_err = run_git_cmd(["remote", "get-url", GITHUB_REMOTE_NAME])
        if rc_remote != 0:
            logger.warning("No configured remote '%s' - cannot push", GITHUB_REMOTE_NAME)
            return False

        # attempt push with upstream set (push -u origin <branch>)
        push_args = ["push", GITHUB_REMOTE_NAME, f"{GIT_BRANCH}", "--set-upstream"]
        rc_push, out_push, err_push = run_git_cmd(push_args, timeout=GIT_TIMEOUT * 2, env=env)
        if rc_push != 0:
            # fallback: try plain git push (maybe upstream already set)
            rc2, out2, err2 = run_git_cmd(["push"], timeout=GIT_TIMEOUT * 2, env=env)
            if rc2 != 0:
                logger.warning("git push failed: %s", err2 or out2)
                return False
            else:
                logger.info("git push OK (fallback): %s", out2)
                return True
        else:
            logger.info("git push OK: %s", out_push)
            return True

    except Exception as e:
        logger.exception("git push exception: %s", e)
        return False


# ---------- DB initialization + safe migrations (unchanged) ----------
def init_db():
    conn = sqlite3.connect(DB_PATH, detect_types=sqlite3.PARSE_DECLTYPES)
    c = conn.cursor()

    # create base tables (password_hash may be added later)
    c.execute(
        """
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            age INTEGER,
            country TEXT NOT NULL,
            occupation TEXT,
            admin INTEGER DEFAULT 0,
            api_key TEXT,
            visits INTEGER DEFAULT 0,
            reminders_set INTEGER DEFAULT 0,
            last_seen TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(username, country)
        )
        """
    )

    c.execute(
        """
        CREATE TABLE IF NOT EXISTS routines (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT,
            category TEXT,
            difficulty TEXT,
            duration INTEGER,
            video_url TEXT,
            thumbnail_url TEXT,
            description TEXT,
            uploaded_by INTEGER,
            uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            views INTEGER DEFAULT 0
        )
        """
    )

    c.execute(
        """
        CREATE TABLE IF NOT EXISTS plays (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            routine_id INTEGER,
            played_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """
    )

    conn.commit()

    # safe migration: add password_hash column if missing (for admin username+password)
    cols = [r[1] for r in conn.execute("PRAGMA table_info(users)").fetchall()]
    if "password_hash" not in cols:
        try:
            conn.execute("ALTER TABLE users ADD COLUMN password_hash TEXT")
            conn.commit()
        except Exception as e:
            logger.info("Could not add password_hash column: %s", e)

    # ensure routines has thumbnail_url column (older DBs might not)
    rcols = [r[1] for r in conn.execute("PRAGMA table_info(routines)").fetchall()]
    if "thumbnail_url" not in rcols:
        try:
            conn.execute("ALTER TABLE routines ADD COLUMN thumbnail_url TEXT")
            conn.commit()
        except Exception as e:
            logger.info("Could not add thumbnail_url column: %s", e)

    # Deduplicate legacy duplicates (if any): aggregate visits, reminders, keep earliest created
    try:
        cur = conn.execute(
            "SELECT username, country, COUNT(1) as cnt FROM users GROUP BY username, country HAVING cnt > 1"
        )
        groups = cur.fetchall()
        for (username, country, cnt) in groups:
            rows = list(
                conn.execute(
                    "SELECT id, visits, reminders_set, created_at FROM users WHERE username = ? AND country = ? ORDER BY created_at ASC",
                    (username, country),
                )
            )
            if len(rows) <= 1:
                continue
            keep_id = rows[0][0]
            total_visits = sum(r[1] or 0 for r in rows)
            any_reminders = 1 if any((r[2] or 0) for r in rows) else 0
            earliest_created = rows[0][3]
            conn.execute(
                "UPDATE users SET visits = ?, reminders_set = ?, created_at = ? WHERE id = ?",
                (total_visits, any_reminders, earliest_created, keep_id),
            )
            other_ids = [r[0] for r in rows[1:]]
            conn.executemany("DELETE FROM users WHERE id = ?", [(i,) for i in other_ids])
        conn.commit()
    except Exception as e:
        logger.info("dedupe error: %s", e)

    conn.close()


init_db()


# ---------- DB helpers ----------
def get_db():
    db = getattr(g, "_db", None)
    if db is None:
        db = g._db = sqlite3.connect(DB_PATH, detect_types=sqlite3.PARSE_DECLTYPES)
        db.row_factory = sqlite3.Row
    return db


@app.teardown_appcontext
def close_db(exc):
    db = getattr(g, "_db", None)
    if db is not None:
        db.close()


def row_to_dict(r):
    """Convert sqlite3.Row to plain dict (safe)."""
    if r is None:
        return None
    return dict(zip(r.keys(), [r[k] for k in r.keys()]))


# ---------- thumbnail helper ----------
def generate_thumbnail(video_path: Path, thumb_path: Path):
    """
    Generate a JPEG thumbnail for video_path and save to thumb_path.
    Uses ffmpeg if available. Returns True if thumbnail created.
    """
    try:
        # Use ffmpeg to grab a frame at 1 second; tolerate failures
        cmd = [
            "ffmpeg",
            "-y",
            "-ss", "00:00:01",
            "-i", str(video_path),
            "-vframes", "1",
            "-q:v", "2",
            str(thumb_path),
        ]
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False, timeout=20)
        return thumb_path.exists()
    except Exception as e:
        logger.info("thumbnail generation failed: %s", e)
        return False


# ---------- admin auth helpers ----------
def admin_exists():
    db = get_db()
    cur = db.execute("SELECT COUNT(1) AS cnt FROM users WHERE admin = 1")
    return cur.fetchone()["cnt"] > 0


def require_admin():
    db = get_db()
    admin_id = session.get("admin_id")
    if admin_id:
        cur = db.execute("SELECT * FROM users WHERE id = ? AND admin = 1", (admin_id,))
        user = cur.fetchone()
        if user:
            return user

    # legacy header fallback
    key = request.headers.get("X-Admin-Key") or request.args.get("admin_key")
    if key:
        cur = db.execute("SELECT * FROM users WHERE api_key = ? AND admin = 1", (key,))
        user = cur.fetchone()
        if user:
            return user

    abort(401, description="admin authentication required")


# ---------- serve manifest explicitly (helps with correct MIME) ----------
@app.route('/manifest.json')
def manifest():
    return send_from_directory('static', 'manifest.json', mimetype='application/manifest+json')


# ---------- frontend routes ----------
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/category/<name>")
def category(name):
    return render_template("category.html", category=name)


@app.route("/routine/<int:routine_id>")
def routine(routine_id):
    return render_template("routine.html", routine_id=routine_id)


@app.route("/admin")
def admin_page():
    return render_template("54.html")


@app.route("/54")
def admin_path_54():
    return render_template("54.html")


# ---------- public APIs (users, routines, tracking) ----------
@app.route("/api/routines")
def api_routines():
    db = get_db()
    cur = db.execute(
        "SELECT id, title, category, difficulty, duration, video_url, thumbnail_url, description, uploaded_at, views FROM routines ORDER BY uploaded_at DESC"
    )
    rows = [row_to_dict(r) for r in cur.fetchall()]
    return jsonify(rows)


@app.route("/api/register", methods=["POST"])
def api_register():
    data = request.get_json() or request.form
    username = (data.get("username") or "").strip()
    try:
        age = int(data.get("age") or 0)
    except Exception:
        age = 0
    country = (data.get("country") or "").strip()
    occupation = (data.get("occupation") or "").strip()

    if not username or not country:
        return jsonify({"error": "username and country required"}), 400

    db = get_db()
    now = datetime.utcnow()

    cur = db.execute("SELECT * FROM users WHERE username = ? AND country = ?", (username, country))
    user = cur.fetchone()

    if user:
        db.execute(
            "UPDATE users SET age = ?, occupation = ?, last_seen = ?, visits = visits + 1 WHERE id = ?",
            (age, occupation, now, user["id"]),
        )
        db.commit()
        # snapshot & push
        try:
            push_to_git(paths=None, message=f"user update: {username} ({country})", include_media=False)
        except Exception:
            logger.exception("git push failed after user update")

        cur = db.execute("SELECT * FROM users WHERE id = ?", (user["id"],))
        user = cur.fetchone()
        resp = row_to_dict(user)
        resp.pop("password_hash", None)
        if resp.get("admin"):
            resp["admin_api_key"] = resp.get("api_key")
        return jsonify(resp)

    # create new normal user
    cur = db.execute("SELECT COUNT(1) AS cnt FROM users WHERE admin = 1")
    _ = cur.fetchone()

    cur = db.execute(
        "INSERT INTO users (username, age, country, occupation, admin, api_key, visits, last_seen) VALUES (?,?,?,?,?,?,?,?)",
        (username, age, country, occupation, 0, None, 1, now),
    )
    db.commit()

    # snapshot & push (best-effort)
    try:
        push_to_git(paths=None, message=f"user register: {username} ({country})", include_media=False)
    except Exception:
        logger.exception("git push failed after user register")

    user_id = cur.lastrowid
    new_user = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    resp = row_to_dict(new_user)
    resp.pop("password_hash", None)
    return jsonify(resp)


@app.route("/api/visit", methods=["POST"])
def api_visit():
    data = request.get_json() or request.form
    username = (data.get("username") or "").strip()
    country = (data.get("country") or "").strip()
    if not username or not country:
        return jsonify({"error": "username+country required"}), 400
    db = get_db()
    now = datetime.utcnow()
    db.execute(
        "UPDATE users SET visits = visits + 1, last_seen = ? WHERE username = ? AND country = ?",
        (now, username, country),
    )
    db.commit()

    try:
        push_to_git(paths=None, message=f"visit: {username} ({country})", include_media=False)
    except Exception:
        logger.exception("git push failed after visit")

    return jsonify({"ok": True})


@app.route("/api/track_play", methods=["POST"])
def api_track_play():
    data = request.get_json() or request.form
    username = (data.get("username") or "").strip()
    country = (data.get("country") or "").strip()
    routine_id = data.get("routine_id")
    if not username or not country or not routine_id:
        return jsonify({"error": "username,country,routine_id required"}), 400

    db = get_db()
    cur = db.execute("SELECT id FROM users WHERE username = ? AND country = ?", (username, country))
    row = cur.fetchone()
    if not row:
        return jsonify({"error": "user not found"}), 404
    user_id = row["id"]

    db.execute("UPDATE routines SET views = views + 1 WHERE id = ?", (routine_id,))
    db.execute("INSERT INTO plays (user_id, routine_id) VALUES (?,?)", (user_id, routine_id))
    db.commit()

    try:
        push_to_git(paths=None, message=f"play: user {username} played {routine_id}", include_media=False)
    except Exception:
        logger.exception("git push failed after track_play")

    return jsonify({"ok": True})


@app.route("/api/set_reminder", methods=["POST"])
def api_set_reminder():
    data = request.get_json() or request.form
    username = (data.get("username") or "").strip()
    country = (data.get("country") or "").strip()
    enabled = int(data.get("enabled", 1))
    if not username or not country:
        return jsonify({"error": "username+country required"}), 400
    db = get_db()
    db.execute("UPDATE users SET reminders_set = ? WHERE username = ? AND country = ?", (1 if enabled else 0, username, country))
    db.commit()

    try:
        push_to_git(paths=None, message=f"reminder: {username} ({country}) => {enabled}", include_media=False)
    except Exception:
        logger.exception("git push failed after set_reminder")

    return jsonify({"ok": True})


# ---------- admin registration & login (username + password) ----------
@app.route("/api/admin/exists")
def api_admin_exists():
    db = get_db()
    cur = db.execute("SELECT COUNT(1) AS cnt FROM users WHERE admin = 1")
    exists = cur.fetchone()["cnt"] > 0
    return jsonify({"admin_exists": exists})


@app.route("/api/admin/register", methods=["POST"])
def api_admin_register():
    if admin_exists():
        return jsonify({"error": "admin already exists"}), 403

    data = request.get_json() or request.form
    username = (data.get("username") or "").strip()
    password = (data.get("password") or "").strip()
    if not username or not password:
        return jsonify({"error": "username and password required"}), 400

    password_hash = generate_password_hash(password)
    api_key = secrets.token_urlsafe(28)
    now = datetime.utcnow()

    db = get_db()
    cur = db.execute(
        "INSERT INTO users (username, age, country, occupation, admin, api_key, password_hash, visits, last_seen) VALUES (?,?,?,?,?,?,?,?,?)",
        (username, 0, "__admin__", "", 1, api_key, password_hash, 0, now),
    )
    db.commit()
    admin_id = cur.lastrowid
    session['admin_id'] = admin_id

    # snapshot & push admin creation
    try:
        push_to_git(paths=None, message=f"admin created: {username}", include_media=False)
    except Exception:
        logger.exception("git push failed after admin register")

    return jsonify({"ok": True, "admin_id": admin_id})


@app.route("/api/admin/login", methods=["POST"])
def api_admin_login():
    data = request.get_json() or request.form
    username = (data.get("username") or "").strip()
    password = (data.get("password") or "").strip()
    if not username or not password:
        return jsonify({"error": "username and password required"}), 400

    db = get_db()
    cur = db.execute("SELECT * FROM users WHERE username = ? AND admin = 1", (username,))
    user = cur.fetchone()
    if not user:
        return jsonify({"error": "admin not found"}), 404

    u = row_to_dict(user) or {}
    ph = u.get("password_hash") or ""
    if not ph:
        return jsonify({"error": "this admin account does not support password login; use admin key"}), 400

    if not check_password_hash(ph, password):
        return jsonify({"error": "invalid password"}), 403

    session['admin_id'] = user["id"]
    return jsonify({"ok": True, "admin_id": user["id"]})


@app.route("/api/admin/logout", methods=["POST"])
def api_admin_logout():
    session.pop('admin_id', None)
    return jsonify({"ok": True})


# ---------- admin-protected APIs (use require_admin()) ----------
@app.route("/api/admin/users")
def api_admin_users():
    admin = require_admin()
    db = get_db()
    cur = db.execute("SELECT id,username,age,country,occupation,admin,visits,reminders_set,last_seen,created_at FROM users ORDER BY created_at DESC")
    users = [row_to_dict(r) for r in cur.fetchall()]
    return jsonify(users)


@app.route("/api/admin/videos")
def api_admin_videos():
    admin = require_admin()
    db = get_db()
    cur = db.execute("SELECT id,title,category,difficulty,duration,video_url,thumbnail_url,description,uploaded_at,views FROM routines ORDER BY uploaded_at DESC")
    rows = [row_to_dict(r) for r in cur.fetchall()]
    return jsonify(rows)


@app.route("/api/admin/upload_video", methods=["POST"])
def api_admin_upload_video():
    admin = require_admin()
    db = get_db()
    data = request.get_json() or request.form
    title = data.get("title", "Untitled")
    category = data.get("category", "Special")
    difficulty = data.get("difficulty", "medium")
    try:
        duration = int(data.get("duration") or 0)
    except Exception:
        duration = 0
    video_url = data.get("video_url")
    description = data.get("description", "")

    if not video_url:
        return jsonify({"error": "video_url required"}), 400

    db.execute(
        "INSERT INTO routines (title,category,difficulty,duration,video_url,description,uploaded_by) VALUES (?,?,?,?,?,?,?)",
        (title, category, difficulty, duration, video_url, description, admin["id"]),
    )
    db.commit()

    try:
        push_to_git(paths=None, message=f"video metadata added: {title}", include_media=False)
    except Exception:
        logger.exception("git push failed after upload_video")

    return jsonify({"ok": True})


@app.route("/api/admin/upload_file", methods=["POST"])
def api_admin_upload_file():
    admin = require_admin()

    files = request.files.getlist('video_files') or []
    if not files or all(f.filename == '' for f in files):
        single = request.files.get('video_file')
        if single and single.filename:
            files = [single]

    if not files or all(f.filename == '' for f in files):
        return jsonify({"error": "no video files provided"}), 400

    title_form = (request.form.get("title") or "").strip()
    category = (request.form.get("category") or "Special").strip()
    difficulty = (request.form.get("difficulty") or "medium").strip()
    try:
        duration = int(request.form.get("duration") or 0)
    except Exception:
        duration = 0
    description = (request.form.get("description") or "").strip()

    db = get_db()
    saved_urls = []
    media_paths = []

    for f in files:
        if not f or f.filename == '':
            continue

        filename = secure_filename(f.filename)
        stamp = datetime.utcnow().strftime("%Y%m%d%H%M%S")
        rnd = secrets.token_hex(6)
        save_name = f"{stamp}_{rnd}_{filename}"
        save_path = VIDEOS_DIR / save_name

        try:
            f.save(save_path)
            media_paths.append(str(save_path.relative_to(BASE_DIR)))
        except Exception as e:
            logger.info(f"failed saving {filename}: {e}")
            continue

        thumb_name = f"{save_name}.jpg"
        thumb_path = THUMBS_DIR / thumb_name
        thumb_created = generate_thumbnail(save_path, thumb_path)
        thumbnail_url = f"/static/videos/thumbnails/{thumb_name}" if thumb_created else None

        title = title_form or filename or "Untitled"
        video_url = f"/static/videos/{save_name}"

        db.execute(
            "INSERT INTO routines (title,category,difficulty,duration,video_url,thumbnail_url,description,uploaded_by) VALUES (?,?,?,?,?,?,?,?)",
            (title, category, difficulty, duration, video_url, thumbnail_url, description, admin["id"]),
        )
        saved_urls.append(video_url)

    db.commit()

    # snapshot & push; include media only when explicitly enabled
    try:
        push_to_git(paths=None, message=f"files uploaded by admin {admin['username'] if admin and 'username' in admin else admin['id']}", include_media=True)
    except Exception:
        logger.exception("git push failed after upload_file")

    if not saved_urls:
        return jsonify({"error": "no files were saved"}), 500

    return jsonify({"ok": True, "video_urls": saved_urls})


@app.route("/api/admin/delete_video", methods=["POST"])
def api_admin_delete_video():
    admin = require_admin()
    data = request.get_json() or request.form
    routine_id = data.get("routine_id")
    if not routine_id:
        return jsonify({"error": "routine_id required"}), 400

    db = get_db()
    cur = db.execute("SELECT * FROM routines WHERE id = ?", (routine_id,))
    row = cur.fetchone()
    if not row:
        return jsonify({"error": "routine not found"}), 404

    r = row_to_dict(row)
    try:
        if r.get("video_url"):
            video_path = BASE_DIR / r["video_url"].lstrip("/")
            if video_path.exists():
                video_path.unlink()
        if r.get("thumbnail_url"):
            thumb_path = BASE_DIR / r["thumbnail_url"].lstrip("/")
            if thumb_path.exists():
                thumb_path.unlink()
    except Exception as e:
        logger.info("delete file error: %s", e)

    db.execute("DELETE FROM routines WHERE id = ?", (routine_id,))
    db.commit()

    try:
        # after deleting a routine, snapshot and push; media will not be included by default
        push_to_git(paths=None, message=f"deleted routine {routine_id}", include_media=False)
    except Exception:
        logger.exception("git push failed after delete_video")

    return jsonify({"ok": True})


@app.route("/api/admin/replace_video", methods=["POST"])
def api_admin_replace_video():
    admin = require_admin()
    routine_id = request.form.get("routine_id") or (request.args.get("routine_id") if request.args else None)
    if not routine_id:
        return jsonify({"error": "routine_id required"}), 400

    file = request.files.get("video_file")
    if not file or file.filename == "":
        return jsonify({"error": "video_file required"}), 400

    db = get_db()
    cur = db.execute("SELECT * FROM routines WHERE id = ?", (routine_id,))
    row = cur.fetchone()
    if not row:
        return jsonify({"error": "routine not found"}), 404

    r = row_to_dict(row)
    old_video = r.get("video_url")
    old_thumb = r.get("thumbnail_url")

    filename = secure_filename(file.filename)
    stamp = datetime.utcnow().strftime("%Y%m%d%H%M%S")
    rnd = secrets.token_hex(6)
    save_name = f"{stamp}_{rnd}_{filename}"
    save_path = VIDEOS_DIR / save_name

    try:
        file.save(save_path)
    except Exception as e:
        logger.info("replace save failed: %s", e)
        return jsonify({"error": "could not save uploaded file"}), 500

    thumb_name = f"{save_name}.jpg"
    thumb_path = THUMBS_DIR / thumb_name
    thumb_created = generate_thumbnail(save_path, thumb_path)
    thumbnail_url = f"/static/videos/thumbnails/{thumb_name}" if thumb_created else None
    video_url = f"/static/videos/{save_name}"

    new_title = (request.form.get("title") or r.get("title") or filename).strip()
    new_desc = (request.form.get("description") or r.get("description") or "").strip()
    try:
        db.execute(
            "UPDATE routines SET title=?, video_url=?, thumbnail_url=?, description=? WHERE id=?",
            (new_title, video_url, thumbnail_url, new_desc, routine_id),
        )
        db.commit()
    except Exception as e:
        logger.info("db update error: %s", e)
        return jsonify({"error": "could not update DB"}), 500

    try:
        if old_video:
            old_video_path = BASE_DIR / old_video.lstrip("/")
            if old_video_path.exists():
                old_video_path.unlink()
        if old_thumb:
            old_thumb_path = BASE_DIR / old_thumb.lstrip("/")
            if old_thumb_path.exists():
                old_thumb_path.unlink()
    except Exception as e:
        logger.info("old-file deletion failed: %s", e)

    try:
        push_to_git(paths=None, message=f"replaced video for routine {routine_id}", include_media=True)
    except Exception:
        logger.exception("git push failed after replace_video")

    return jsonify({"ok": True, "video_url": video_url, "thumbnail_url": thumbnail_url})


@app.route("/api/admin/metrics")
def api_admin_metrics():
    admin = require_admin()
    db = get_db()
    cur = db.execute("SELECT COUNT(1) AS total_users FROM users")
    total_users = cur.fetchone()["total_users"]
    cur = db.execute("SELECT SUM(visits) AS total_visits FROM users")
    total_visits = db.execute("SELECT SUM(visits) AS total_visits FROM users").fetchone()["total_visits"] or 0
    cur = db.execute("SELECT COUNT(1) AS total_videos FROM routines")
    total_videos = cur.fetchone()["total_videos"]
    cur = db.execute("SELECT SUM(views) AS total_plays FROM routines")
    total_plays = cur.fetchone()["total_plays"] or 0
    cur = db.execute("SELECT COUNT(1) AS reminders FROM users WHERE reminders_set = 1")
    reminders = cur.fetchone()["reminders"]

    return jsonify(
        {
            "total_users": total_users,
            "total_visits": total_visits,
            "total_videos": total_videos,
            "total_plays": total_plays,
            "reminders_set": reminders,
        }
    )


@app.route("/api/admin/promote", methods=["POST"])
def api_admin_promote():
    admin = require_admin()
    data = request.get_json() or request.form
    user_id = data.get("user_id")
    if not user_id:
        return jsonify({"error": "user_id required"}), 400
    db = get_db()
    new_key = secrets.token_urlsafe(28)
    db.execute("UPDATE users SET admin = 1, api_key = ? WHERE id = ?", (new_key, user_id))
    db.commit()

    try:
        push_to_git(paths=None, message=f"promote user {user_id} to admin", include_media=False)
    except Exception:
        logger.exception("git push failed after promote")

    return jsonify({"ok": True, "new_admin_key": new_key})


# --------- pulse receiver (accept pings from breathe / other pingers) ----------
@app.route("/pulse_receiver", methods=["POST", "GET"])
def pulse_receiver():
    """
    Lightweight endpoint that accepts pulses from an external pinger (e.g. breathe).
    - If FORWARD_TOKEN or PULSE_TOKEN env var is set, require X-PULSE-TOKEN header to match.
    - Append a short line to data_snapshot/heartbeats.log for inspection and snapshotting.
    - Always return 200 OK (unless token check fails) so external pingers see success.
    """
    # token protection (optional)
    expected_token = os.environ.get("FORWARD_TOKEN") or os.environ.get("PULSE_TOKEN")
    if expected_token:
        incoming = request.headers.get("X-PULSE-TOKEN")
        if incoming != expected_token:
            logger.info("pulse_receiver: forbidden (bad token) from %s", request.remote_addr)
            return jsonify({"status": "forbidden"}), 403

    # read payload (JSON preferred, otherwise form data or fallback ping)
    payload = request.get_json(silent=True)
    if payload is None:
        try:
            payload = request.form.to_dict() or {"message": "pulse"}
        except Exception:
            payload = {"message": "pulse"}

    # write a tiny heartbeat log (best-effort)
    try:
        hb_file = SNAPSHOT_DIR / "heartbeats.log"
        hb_line = f"{datetime.utcnow().isoformat()} {request.remote_addr} {json.dumps(payload, default=str)}\n"
        with hb_file.open("a", encoding="utf-8") as f:
            f.write(hb_line)
    except Exception as e:
        logger.info("pulse_receiver: could not write heartbeat log: %s", e)

    # reply 200 so pingers know we're alive
    return jsonify({"status": "ok", "received": True}), 200


# ---------- Manual git-push test endpoint (admin-protected) ----------
@app.route("/api/admin/git_push", methods=["POST"])
def api_admin_git_push():
    """
    Trigger a manual git push and return useful git outputs for debugging.
    Protected by require_admin().
    Body (json or form):
      - include_media: optional boolean-like value ("1","true","yes")
      - message: optional commit message
    """
    admin = require_admin()

    data = request.get_json(silent=True) or request.form or {}
    inc = str(data.get("include_media", "")).lower()
    include_media = inc in ("1", "true", "yes", "on")
    message = data.get("message") or f"manual push by admin {admin.get('username', admin.get('id'))} at {datetime.utcnow().isoformat()}"

    details = {}
    try:
        # Ensure repo is present / configured first
        details["git_repo_present_before"] = git_repo_present()

        # Try to push using the app helper
        pushed = push_to_git(paths=None, message=message, include_media=include_media)
        details["push_result"] = bool(pushed)

        # Gather some git diagnostics to return
        rc, out, err = run_git_cmd(["status", "--porcelain"])
        details["status_porcelain_rc"] = rc
        details["status_porcelain_out"] = out if out else None
        details["status_porcelain_err"] = err if err else None

        rc, out, err = run_git_cmd(["remote", "get-url", GITHUB_REMOTE_NAME])
        details["remote_get_url_rc"] = rc
        details["remote_get_url_out"] = out if out else None
        details["remote_get_url_err"] = err if err else None

        rc, out, err = run_git_cmd(["log", "-1", "--pretty=format:%H %s"])
        details["last_commit_rc"] = rc
        details["last_commit_out"] = out if out else None
        details["last_commit_err"] = err if err else None

        # tail the snapshot dir heartbeat and snapshot files if present
        try:
            hb_file = SNAPSHOT_DIR / "heartbeats.log"
            if hb_file.exists():
                with hb_file.open("r", encoding="utf-8") as f:
                    lines = f.readlines()[-10:]
                details["heartbeats_tail"] = [l.strip() for l in lines]
            else:
                details["heartbeats_tail"] = None
        except Exception as e:
            details["heartbeats_tail_error"] = str(e)

        return jsonify({"ok": True, "details": details}), 200
    except Exception as e:
        logger.exception("manual git push endpoint failed: %s", e)
        details["exception"] = str(e)
        return jsonify({"ok": False, "details": details}), 500


if __name__ == "__main__":
    app.run(debug=True)
