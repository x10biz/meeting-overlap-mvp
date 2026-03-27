from __future__ import annotations

import json
import os
import sqlite3
from datetime import UTC, date, datetime, time, timedelta
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse
from uuid import uuid4
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


BASE_DIR = Path(__file__).resolve().parent
PUBLIC_DIR = BASE_DIR / "public"
DB_PATH = Path(os.environ.get("DB_PATH", str(BASE_DIR / "data.sqlite3")))
SLOT_MINUTES = 30


def utc_now_iso() -> str:
    return datetime.now(UTC).isoformat()


def create_id(prefix: str) -> str:
    return f"{prefix}_{uuid4().hex[:10]}"


def json_response(handler: BaseHTTPRequestHandler, status: int, payload: Any) -> None:
    body = json.dumps(payload).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def read_json(handler: BaseHTTPRequestHandler) -> dict[str, Any]:
    content_length = int(handler.headers.get("Content-Length", "0"))
    raw_body = handler.rfile.read(content_length) if content_length else b"{}"
    if not raw_body:
        return {}
    return json.loads(raw_body.decode("utf-8"))


def ensure_db() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.executescript(
        """
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS events (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            start_date TEXT NOT NULL,
            end_date TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS participants (
            id TEXT PRIMARY KEY,
            event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            timezone TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS availability_slots (
            id TEXT PRIMARY KEY,
            participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
            start_utc TEXT NOT NULL,
            end_utc TEXT NOT NULL
        );
        """
    )
    conn.commit()
    conn.close()


def get_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def parse_event_dates(start_date_str: str, end_date_str: str) -> tuple[date, date]:
    start_date = date.fromisoformat(start_date_str)
    end_date = date.fromisoformat(end_date_str)
    if end_date < start_date:
        raise ValueError("End date must be on or after start date.")
    if (end_date - start_date).days > 30:
        raise ValueError("For MVP, event range must be 31 days or less.")
    return start_date, end_date


def parse_local_slot(local_value: str, timezone_name: str) -> datetime:
    try:
        tz = ZoneInfo(timezone_name)
    except ZoneInfoNotFoundError as exc:
        raise ValueError("Unknown timezone.") from exc

    try:
        local_dt = datetime.fromisoformat(local_value)
    except ValueError as exc:
        raise ValueError("Invalid local date/time format.") from exc

    if local_dt.tzinfo is not None:
        raise ValueError("Local slot value must not include timezone info.")

    return local_dt.replace(tzinfo=tz).astimezone(UTC)


def serialize_event(conn: sqlite3.Connection, event_id: str) -> dict[str, Any] | None:
    event_row = conn.execute(
        "SELECT id, title, start_date, end_date, created_at FROM events WHERE id = ?",
        (event_id,),
    ).fetchone()
    if not event_row:
        return None

    participant_rows = conn.execute(
        """
        SELECT id, name, timezone, created_at
        FROM participants
        WHERE event_id = ?
        ORDER BY created_at ASC
        """,
        (event_id,),
    ).fetchall()

    participants: list[dict[str, Any]] = []
    for participant_row in participant_rows:
        slot_rows = conn.execute(
            """
            SELECT id, start_utc, end_utc
            FROM availability_slots
            WHERE participant_id = ?
            ORDER BY start_utc ASC
            """,
            (participant_row["id"],),
        ).fetchall()
        participants.append(
            {
                "id": participant_row["id"],
                "name": participant_row["name"],
                "timezone": participant_row["timezone"],
                "createdAt": participant_row["created_at"],
                "slots": [
                    {
                        "id": slot_row["id"],
                        "startUtc": slot_row["start_utc"],
                        "endUtc": slot_row["end_utc"],
                    }
                    for slot_row in slot_rows
                ],
            }
        )

    summary = build_overlap_summary(
        start_date=date.fromisoformat(event_row["start_date"]),
        end_date=date.fromisoformat(event_row["end_date"]),
        participants=participants,
    )

    return {
        "id": event_row["id"],
        "title": event_row["title"],
        "startDate": event_row["start_date"],
        "endDate": event_row["end_date"],
        "createdAt": event_row["created_at"],
        "participants": participants,
        "summary": summary,
    }


def build_overlap_summary(
    start_date: date, end_date: date, participants: list[dict[str, Any]]
) -> dict[str, Any]:
    range_start = datetime.combine(start_date, time.min, tzinfo=UTC)
    range_end = datetime.combine(end_date + timedelta(days=1), time.min, tzinfo=UTC)
    slot_delta = timedelta(minutes=SLOT_MINUTES)

    slots: list[dict[str, Any]] = []
    cursor = range_start
    total_participants = len(participants)

    while cursor < range_end:
        slot_end = cursor + slot_delta
        available_names: list[str] = []
        available_ids: list[str] = []

        for participant in participants:
            for participant_slot in participant["slots"]:
                participant_start = datetime.fromisoformat(participant_slot["startUtc"])
                participant_end = datetime.fromisoformat(participant_slot["endUtc"])
                if participant_start <= cursor and participant_end >= slot_end:
                    available_names.append(participant["name"])
                    available_ids.append(participant["id"])
                    break

        slots.append(
            {
                "startUtc": cursor.isoformat(),
                "endUtc": slot_end.isoformat(),
                "availableCount": len(available_ids),
                "participantIds": available_ids,
                "participantNames": available_names,
            }
        )
        cursor = slot_end

    best_slots = sorted(
        [slot for slot in slots if slot["availableCount"] > 0],
        key=lambda item: (-item["availableCount"], item["startUtc"]),
    )[:10]

    return {
        "slotMinutes": SLOT_MINUTES,
        "totalParticipants": total_participants,
        "grid": slots,
        "bestSlots": best_slots,
    }


def get_event_window(start_date: str, end_date: str) -> tuple[datetime, datetime]:
    event_start = datetime.combine(date.fromisoformat(start_date), time.min, tzinfo=UTC)
    event_end = datetime.combine(
        date.fromisoformat(end_date) + timedelta(days=1),
        time.min,
        tzinfo=UTC,
    )
    return event_start, event_end


def serve_file(handler: BaseHTTPRequestHandler, file_path: Path, content_type: str) -> None:
    if not file_path.exists():
        json_response(handler, HTTPStatus.NOT_FOUND, {"error": "Not found"})
        return

    content = file_path.read_bytes()
    handler.send_response(HTTPStatus.OK)
    handler.send_header("Content-Type", content_type)
    handler.send_header("Content-Length", str(len(content)))
    handler.end_headers()
    handler.wfile.write(content)


class AppHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args: Any) -> None:
        return

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/health":
            json_response(self, HTTPStatus.OK, {"ok": True})
            return

        if path.startswith("/api/events/"):
            event_id = path.removeprefix("/api/events/")
            with get_connection() as conn:
                event_payload = serialize_event(conn, event_id)
            if not event_payload:
                json_response(self, HTTPStatus.NOT_FOUND, {"error": "Event not found"})
                return
            json_response(self, HTTPStatus.OK, {"event": event_payload})
            return

        if path == "/":
            serve_file(self, PUBLIC_DIR / "index.html", "text/html; charset=utf-8")
            return

        if path.startswith("/events/"):
            serve_file(self, PUBLIC_DIR / "index.html", "text/html; charset=utf-8")
            return

        if path == "/styles.css":
            serve_file(self, PUBLIC_DIR / "styles.css", "text/css; charset=utf-8")
            return

        if path == "/app.js":
            serve_file(self, PUBLIC_DIR / "app.js", "application/javascript; charset=utf-8")
            return

        json_response(self, HTTPStatus.NOT_FOUND, {"error": "Not found"})

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path

        try:
            payload = read_json(self)
        except json.JSONDecodeError:
            json_response(self, HTTPStatus.BAD_REQUEST, {"error": "Invalid JSON"})
            return

        if path == "/api/events":
            self.handle_create_event(payload)
            return

        if path.startswith("/api/events/") and path.endswith("/participants"):
            event_id = path.split("/")[3]
            self.handle_add_participant(event_id, payload)
            return

        json_response(self, HTTPStatus.NOT_FOUND, {"error": "Not found"})

    def handle_create_event(self, payload: dict[str, Any]) -> None:
        title = str(payload.get("title", "")).strip() or "Untitled event"
        start_date_str = str(payload.get("startDate", "")).strip()
        end_date_str = str(payload.get("endDate", "")).strip()

        try:
            parse_event_dates(start_date_str, end_date_str)
        except ValueError as exc:
            json_response(self, HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            return

        event_id = create_id("evt")
        created_at = utc_now_iso()

        with get_connection() as conn:
            conn.execute(
                """
                INSERT INTO events (id, title, start_date, end_date, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (event_id, title, start_date_str, end_date_str, created_at),
            )
            conn.commit()
            event_payload = serialize_event(conn, event_id)

        json_response(
            self,
            HTTPStatus.CREATED,
            {"event": event_payload, "shareUrl": f"/events/{event_id}"},
        )

    def handle_add_participant(self, event_id: str, payload: dict[str, Any]) -> None:
        name = str(payload.get("name", "")).strip()
        timezone_name = str(payload.get("timezone", "")).strip()
        slots = payload.get("slots", [])

        if not name:
            json_response(self, HTTPStatus.BAD_REQUEST, {"error": "Name is required."})
            return
        if not isinstance(slots, list) or not slots:
            json_response(
                self,
                HTTPStatus.BAD_REQUEST,
                {"error": "At least one availability slot is required."},
            )
            return

        converted_slots: list[tuple[str, str]] = []
        try:
            for slot in slots:
                start_local = str(slot.get("startLocal", "")).strip()
                end_local = str(slot.get("endLocal", "")).strip()
                start_utc = parse_local_slot(start_local, timezone_name)
                end_utc = parse_local_slot(end_local, timezone_name)
                if end_utc <= start_utc:
                    raise ValueError("Each slot end must be after start.")
                converted_slots.append((start_utc.isoformat(), end_utc.isoformat()))
        except ValueError as exc:
            json_response(self, HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            return

        participant_id = create_id("par")
        created_at = utc_now_iso()

        with get_connection() as conn:
            event_row = conn.execute(
                "SELECT start_date, end_date FROM events WHERE id = ?",
                (event_id,),
            ).fetchone()
            if not event_row:
                json_response(self, HTTPStatus.NOT_FOUND, {"error": "Event not found"})
                return

            event_start, event_end = get_event_window(
                event_row["start_date"],
                event_row["end_date"],
            )
            for start_utc_raw, end_utc_raw in converted_slots:
                start_utc = datetime.fromisoformat(start_utc_raw)
                end_utc = datetime.fromisoformat(end_utc_raw)
                if start_utc < event_start or end_utc > event_end:
                    json_response(
                        self,
                        HTTPStatus.BAD_REQUEST,
                        {
                            "error": (
                                "Availability must stay within the event date range."
                            )
                        },
                    )
                    return

            conn.execute(
                """
                INSERT INTO participants (id, event_id, name, timezone, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (participant_id, event_id, name, timezone_name, created_at),
            )
            conn.executemany(
                """
                INSERT INTO availability_slots (id, participant_id, start_utc, end_utc)
                VALUES (?, ?, ?, ?)
                """,
                [
                    (create_id("slt"), participant_id, start_utc, end_utc)
                    for start_utc, end_utc in converted_slots
                ],
            )
            conn.commit()
            event_payload = serialize_event(conn, event_id)

        json_response(self, HTTPStatus.CREATED, {"event": event_payload})


def run() -> None:
    ensure_db()
    port = int(os.environ.get("PORT", "8000"))
    server = ThreadingHTTPServer(("0.0.0.0", port), AppHandler)
    print(f"Server running on http://0.0.0.0:{port}")
    server.serve_forever()


if __name__ == "__main__":
    run()
