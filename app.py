# app.py
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

BASE_DIR = Path(__file__).parent
DB_PATH = BASE_DIR / "data.db"
VIDEOS_DIR = BASE_DIR / "static" / "videos"
THUMBS_DIR = VIDEOS_DIR / "thumbnails"
VIDEOS_DIR.mkdir(parents=True, exist_ok=True)
THUMBS_DIR.mkdir(parents=True, exist_ok=True)

app = Flask(__name__, static_folder="static", template_folder="templates")
# set a secret key for sessions (in production set FLASK_SECRET env var)
app.secret_key = os.environ.get("FLASK_SECRET") or secrets.token_urlsafe(32)

# ----- upload limits (adjust as needed) -----
app.config["MAX_CONTENT_LENGTH"] = 500 * 1024 * 1024


# ---------- DB initialization + safe migrations ----------
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
            print("Could not add password_hash column:", e)

    # ensure routines has thumbnail_url column (older DBs might not)
    rcols = [r[1] for r in conn.execute("PRAGMA table_info(routines)").fetchall()]
    if "thumbnail_url" not in rcols:
        try:
            conn.execute("ALTER TABLE routines ADD COLUMN thumbnail_url TEXT")
            conn.commit()
        except Exception as e:
            print("Could not add thumbnail_url column:", e)

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
        print("dedupe error:", e)

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
        # run but don't raise on non-zero exit, we'll check file existence
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False, timeout=20)
        return thumb_path.exists()
    except Exception as e:
        print("thumbnail generation failed:", e)
        return False


# ---------- admin auth helpers ----------
def admin_exists():
    db = get_db()
    cur = db.execute("SELECT COUNT(1) AS cnt FROM users WHERE admin = 1")
    return cur.fetchone()["cnt"] > 0


def require_admin():
    """
    Require admin auth. Accepts:
      - session['admin_id'] (preferred) OR
      - X-Admin-Key header (legacy)
    """
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
    # Serve the manifest from static with the application/manifest+json mimetype
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
    """
    Normal app user registration (index flow). Unchanged.
    """
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

    # upsert behaviour: if user exists, update and increment visits
    cur = db.execute("SELECT * FROM users WHERE username = ? AND country = ?", (username, country))
    user = cur.fetchone()

    if user:
        db.execute(
            "UPDATE users SET age = ?, occupation = ?, last_seen = ?, visits = visits + 1 WHERE id = ?",
            (age, occupation, now, user["id"]),
        )
        db.commit()
        cur = db.execute("SELECT * FROM users WHERE id = ?", (user["id"],))
        user = cur.fetchone()
        resp = row_to_dict(user)
        # do not return admin secrets
        resp.pop("password_hash", None)
        if resp.get("admin"):
            resp["admin_api_key"] = resp.get("api_key")
        return jsonify(resp)

    # create new normal user
    cur = db.execute("SELECT COUNT(1) AS cnt FROM users WHERE admin = 1")
    _ = cur.fetchone()  # check only; we do NOT make normal user admin here

    cur = db.execute(
        "INSERT INTO users (username, age, country, occupation, admin, api_key, visits, last_seen) VALUES (?,?,?,?,?,?,?,?)",
        (username, age, country, occupation, 0, None, 1, now),
    )
    db.commit()
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
    return jsonify({"ok": True})


# ---------- admin registration & login (username + password) ----------
@app.route("/api/admin/exists")
def api_admin_exists():
    """Return whether an admin user already exists (used by admin UI)."""
    db = get_db()
    cur = db.execute("SELECT COUNT(1) AS cnt FROM users WHERE admin = 1")
    exists = cur.fetchone()["cnt"] > 0
    return jsonify({"admin_exists": exists})


@app.route("/api/admin/register", methods=["POST"])
def api_admin_register():
    """
    Register the first admin using username + password only.
    This is only allowed when no admin exists.
    """
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
    # store admin using special country marker so normal users won't collide
    cur = db.execute(
        "INSERT INTO users (username, age, country, occupation, admin, api_key, password_hash, visits, last_seen) VALUES (?,?,?,?,?,?,?,?,?)",
        (username, 0, "__admin__", "", 1, api_key, password_hash, 0, now),
    )
    db.commit()
    admin_id = cur.lastrowid
    # create session
    session['admin_id'] = admin_id
    return jsonify({"ok": True, "admin_id": admin_id})


@app.route("/api/admin/login", methods=["POST"])
def api_admin_login():
    """
    Login admin with username+password. Sets a session cookie on success.
    """
    data = request.get_json() or request.form
    username = (data.get("username") or "").strip()
    password = (data.get("password") or "").strip()
    if not username or not password:
        return jsonify({"error": "username and password required"}), 400

    db = get_db()
    # find admin user — prefer "__admin__" country for primary admin accounts
    cur = db.execute("SELECT * FROM users WHERE username = ? AND admin = 1", (username,))
    user = cur.fetchone()
    if not user:
        return jsonify({"error": "admin not found"}), 404

    # sqlite3.Row doesn't have .get, so convert to dict for safe access
    u = row_to_dict(user) or {}
    ph = u.get("password_hash") or ""
    if not ph:
        # this admin account doesn't have a password (maybe promoted via api); ask to use admin key
        return jsonify({"error": "this admin account does not support password login; use admin key"}), 400

    if not check_password_hash(ph, password):
        return jsonify({"error": "invalid password"}), 403

    # success: set session
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
    """Return all routines for admin UI (including thumbnail_url)."""
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
    return jsonify({"ok": True})


@app.route("/api/admin/upload_file", methods=["POST"])
def api_admin_upload_file():
    """
    Accepts multiple files under 'video_files' OR a single legacy 'video_file'.
    Generates thumbnails (if ffmpeg present) and inserts routines rows with thumbnail_url.
    """
    admin = require_admin()

    files = request.files.getlist('video_files') or []
    if not files or all(f.filename == '' for f in files):
        single = request.files.get('video_file')
        if single and single.filename:
            files = [single]

    if not files or all(f.filename == '' for f in files):
        return jsonify({"error": "no video files provided"}), 400

    # form-level metadata
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
        except Exception as e:
            print(f"failed saving {filename}: {e}")
            continue

        # generate thumbnail
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
    if not saved_urls:
        return jsonify({"error": "no files were saved"}), 500

    return jsonify({"ok": True, "video_urls": saved_urls})


@app.route("/api/admin/delete_video", methods=["POST"])
def api_admin_delete_video():
    """Delete a routine + files"""
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
    # delete files on disk if present
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
        print("delete file error:", e)

    db.execute("DELETE FROM routines WHERE id = ?", (routine_id,))
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/admin/replace_video", methods=["POST"])
def api_admin_replace_video():
    """
    Replace the video file for a given routine_id with an uploaded 'video_file'.
    Regenerates thumbnail and updates DB. Old files are removed.
    """
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
        print("replace save failed:", e)
        return jsonify({"error": "could not save uploaded file"}), 500

    # generate new thumbnail
    thumb_name = f"{save_name}.jpg"
    thumb_path = THUMBS_DIR / thumb_name
    thumb_created = generate_thumbnail(save_path, thumb_path)
    thumbnail_url = f"/static/videos/thumbnails/{thumb_name}" if thumb_created else None
    video_url = f"/static/videos/{save_name}"

    # update DB (optionally update title/description if passed)
    new_title = (request.form.get("title") or r.get("title") or filename).strip()
    new_desc = (request.form.get("description") or r.get("description") or "").strip()
    try:
        db.execute(
            "UPDATE routines SET title=?, video_url=?, thumbnail_url=?, description=? WHERE id=?",
            (new_title, video_url, thumbnail_url, new_desc, routine_id),
        )
        db.commit()
    except Exception as e:
        print("db update error:", e)
        return jsonify({"error": "could not update DB"}), 500

    # remove old files
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
        print("old-file deletion failed:", e)

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
    return jsonify({"ok": True, "new_admin_key": new_key})


if __name__ == "__main__":
    app.run(debug=True)
