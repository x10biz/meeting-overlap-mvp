# Meeting Overlap MVP

Simple self-hosted MVP for finding the best meeting time across time zones.

## What it does

- Creates a shareable event page with no authentication
- Lets each participant add their name, timezone, and multiple availability slots
- Stores events forever in SQLite
- Builds a 30-minute overlap grid and top matching time suggestions

## Run locally

```bash
python3 app.py
```

Then open [http://localhost:8000](http://localhost:8000).

## Deploy later on a virtual server

This MVP is intentionally simple:

- `app.py` runs the HTTP server and API
- `data.sqlite3` is created automatically in the project root
- `public/` contains the frontend

For a VPS you can:

1. Copy the project to the server.
2. Run `python3 app.py` behind `nginx` or `caddy`.
3. Keep it alive with `systemd`, `pm2`, or `supervisord`.

## Railway note

Set `DB_PATH` to a file inside a mounted volume, for example:

```bash
DB_PATH=/data/data.sqlite3
```

## API shape

- `POST /api/events`
- `GET /api/events/:id`
- `POST /api/events/:id/participants`
