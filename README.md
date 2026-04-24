# Polar Flow CLI

A command-line tool for syncing and analyzing running data from Polar watches. Tracks training metrics, classifies workouts, recommends next sessions, and monitors progress over time.

## Requirements

- Node.js 18+
- A Polar watch that syncs to Polar Flow
- A Polar AccessLink API app (free)

## Setup

1. Register an API app at https://admin.polaraccesslink.com
   - Set the redirect URI to `http://localhost:8080/callback`
   - Note your Client ID and Client Secret

2. Create a `.api_creds` file in the project root:
   ```
   Client ID
   <your-client-id>
   Client Secret
   <your-client-secret>
   ```

3. Install and link:
   ```
   npm install
   npm link
   ```

4. Authenticate with your Polar account:
   ```
   polar auth
   ```

## Usage

```
polar sync                    Fetch new exercises from Polar API
polar exercises [--limit N]   List recent exercises
polar exercise <id>           Show exercise detail (prefix match supported)
polar stats [--days N]        Training metrics summary (default: 14 days)
polar snapshot                Create a progress checkpoint
polar review [id]             Compare current vs last checkpoint
polar recommend               Get next workout recommendation
polar backup <path>           Backup database
polar import <path>           Import Polar Flow export (zip or folder)
polar help                    Show help
```

## Importing historical data

If you have a Polar Flow data export (Settings → Account → Download my data), you can import it:

```
polar import ~/Downloads/polar-user-data-export.zip
```

This imports all running and hiking sessions with HR samples, routes, and zones.

## How it works

- Data is stored locally in a SQLite database (`polar_data.db`)
- Workouts are classified by HR zone distribution and pace variance (easy, tempo, interval, long)
- The recommendation engine uses Acute:Chronic Workload Ratio to balance training load
- Snapshots let you track progress over time against specific goals

## Tech stack

- Node.js
- SQLite via better-sqlite3
- Polar AccessLink API v3
