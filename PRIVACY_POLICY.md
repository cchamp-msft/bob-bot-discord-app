# Privacy Policy

**Last Updated:** February 6, 2026

## Overview

Bob Bot Discord App ("the Bot") collects minimal user data for operational and debugging purposes. This Privacy Policy explains our data practices.

## What Data is Collected

The Bot **logs the following information**:
- **Discord username** of users who interact with the bot
- **Discord user ID**
- **Channel type** (DM or Guild text channel)
- **Guild/server name** (if in a server, null if DM)
- **Message content preview** (up to 100 characters of user messages)
- **Interaction timestamps**
- **Request status** (success, error, busy, timeout)

## How Data is Used

This data is logged for:
- **Operational tracking** — monitoring bot activity and request processing
- **Debugging** — diagnosing API failures, timeouts, and errors
- **Audit trail** — maintaining a record of bot interactions

## Data Retention

Log files are stored indefinitely in the `outputs/logs/` directory as daily log files (`YYYY-MM-DD.log`). There is **no automatic purging or retention policy**. Logs persist for an indeterminate period unless manually deleted.

## Activity Monitor

The Bot includes a real-time activity page (`/activity`) that displays a stream of recent interactions. The activity monitor:

- **Shows** incoming message content and outgoing bot responses
- **Does not show** usernames, user IDs, guild/server names, or channel IDs
- **Automatically redacts** URLs, Discord snowflake IDs, and API-key-like tokens from all displayed text
- **Is not persisted to disk** — events are held in an in-memory ring buffer (maximum 100 events) and are lost when the bot restarts
- **Is served on the public outputs server** without authentication — anyone with network access to the outputs port can view it

This is separate from the file-based logger described above, which collects more detailed information including usernames, user IDs, and message content previews.

## Data Storage Location

All logs are stored locally on the server running the Bot:
- **Path:** `outputs/logs/`
- **Format:** Plain text daily log files
- **Accessibility:** Local file system only (HTTP access to logs directory is blocked)

## Who Has Access

Log files are accessible to:
- Anyone with direct file system access to the server
- Server administrators who can access the `outputs/logs/` directory

Logs are **not transmitted** to external services unless you explicitly configure third-party integrations.

## Third-Party Services

The Bot may interact with third-party APIs (ComfyUI, Ollama, AccuWeather, SportsData.io, etc.). These interactions:
- Include your username and message content (as needed for the request)
- Are made directly from your request
- Are subject to the privacy policies of those third-party services
- May be logged by those services according to their own terms

We are not responsible for third-party data practices.

## Your Rights

You have the right to:
- **Request deletion** of your logged data by asking the server administrator
- **Opt out** by not using the Bot
- **Access your data** by requesting log files from the server administrator

We do not have a centralized system for data subject access requests; you must contact the server administrator directly.

## Changes to This Policy

We may update this Privacy Policy at any time. Your continued use of the Bot constitutes acceptance of any changes.

## Contact

For questions about this Privacy Policy or to request data deletion, please contact the server administrator or the repository owner.

---

**Note:** While we log usernames and minimal interaction data, your Discord account and message history are subject to [Discord's Privacy Policy](https://discord.com/privacy).