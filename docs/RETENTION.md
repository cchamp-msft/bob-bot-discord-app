# Retention & Grooming

### How the Retention Scheduler Works

The `RetentionScheduler` runs as a background process within the bot lifecycle.

- **Startup Delay:** The first grooming pass initiates 10 seconds after boot to ensure all servers are initialized.
- **Frequency:** Passes repeat every 24 hours.
- **Scope:** Each pass grooms both log files and media output directories.
- **Shutdown:** The scheduler is cleanly destroyed on bot shutdown (`SIGINT`/`SIGTERM`).
- **Manual Trigger:** Grooming can be forced via the configurator's "Rotate & Groom" button or by calling `POST /api/config/log/rotate`.

### Configuration

Retention periods are controlled via environment variables. Both support a value of `0` to disable the feature entirely.

| Variable | Default | Description |
| :--- | :--- | :--- |
| `LOG_RETENTION_DAYS` | 7 | Days to retain log files. |
| `MEDIA_RETENTION_DAYS` | 30 | Days to retain media output folders. |

These can be set in `.env` or modified via the web configurator under **Logs and Media Retention**.

### What Gets Deleted

**Log Grooming**

- Scans the `outputs/logs/` directory.
- Targets files matching `YYYY-MM-DD.log` or `YYYY-MM-DD_N.log`.
- Deletes files where the date prefix is older than the retention cutoff.
- **Safety:** The active log file for the current day is never deleted.

**Media Grooming**

- Walks the `outputs/YYYY/MM/DDThh-mm-ss/` directory tree.
- Deletes leaf directories (e.g., `15T10-30-00`) where the timestamp is older than the cutoff.
- **Cleanup:** If a parent month (`MM/`) or year (`YYYY/`) directory becomes empty after deletion, it is removed.
- **Safety:** The `outputs/logs/` directory is skipped during media grooming.

**Non-Matching Files**

Files or directories that do not match the expected naming conventions are ignored and will **not** be deleted. Manually placed files are safe.

### Example: Log File Lifecycle

1. Bot starts, creating `2026-03-14.log`.
2. Rotation occurs (manual or scheduled), archiving it as `2026-03-14_0.log` and starting a fresh `2026-03-14.log`.
3. Over the next week, new daily logs accumulate.
4. After 7 days (with default `LOG_RETENTION_DAYS=7`), the scheduler removes the archived files on its next pass.

**Directory listing before grooming:**

```text
outputs/logs/
  2026-03-14_0.log  (archived, > 7 days old)
  2026-03-14.log    (old daily log, > 7 days old)
  2026-03-15.log    (> 7 days old)
  ...
  2026-03-21.log    (today's active log)
```

**Directory listing after grooming:**

```text
outputs/logs/
  2026-03-21.log    (today's active log — preserved)
```

### Example: Media File Lifecycle

1. User generates an image on 2026-01-15 at 10:30:00 — file saved to `outputs/2026/01/15T10-30-00/img.png`.
2. More files accumulate over subsequent weeks.
3. After 30 days (with default `MEDIA_RETENTION_DAYS=30`), the scheduler deletes the `15T10-30-00/` directory.
4. If `01/` is now empty, it is removed. If `2026/` is now empty, it is also removed.

**Directory tree before grooming:**

```text
outputs/
  2026/
    01/
      15T10-30-00/       (older than 30-day cutoff)
        img.png
    02/
      10T08-00-00/       (newer, kept)
        gif.gif
```

**Directory tree after grooming:**

```text
outputs/
  2026/
    02/
      10T08-00-00/       (kept)
        gif.gif
```

The `2026/01/` directory and its contents are removed because the only leaf was past the cutoff, leaving the month directory empty.

### Disabling Grooming

To disable retention logic entirely, set the corresponding variable to `0`. Both types can be disabled independently.

- To disable log grooming: Set `LOG_RETENTION_DAYS=0`.
- To disable media grooming: Set `MEDIA_RETENTION_DAYS=0`.
