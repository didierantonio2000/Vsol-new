# ConectaQ OLT NMS

Local web panel for managing VSOL 8-port PON OLTs. Shows ONTs per PON port, optical power, VLANs, and events. Connects to OLT hardware via Telnet.

## Stack

- **Backend**: Node.js + Express 5, telnet-client, net-snmp
- **Frontend**: Vanilla HTML/JS in `public/index.html`
- **Data**: JSON files (`olts.json`, `customers.json`, `power_history.json`)

## How to run

```bash
npm start
```

The workflow `Start application` runs `PORT=5000 node server.js`. The app is available in the Replit preview pane.

## Configuration

OLT connection settings can be managed via the UI (Dashboard → OLTs). They are persisted in `olts.json`.

To override via environment variables:

| Variable | Default | Description |
|---|---|---|
| `PORT` | 3000 | HTTP server port (set to 5000 in workflow) |
| `OLT_HOST` | — | OLT IP address |
| `OLT_PORT` | 23 | Telnet port |
| `OLT_USER` | — | Telnet username |
| `OLT_PASS` | — | Telnet password |
| `OLT_ENABLE_PASS` | — | Enable mode password |
| `OLT_COMMAND_TIMEOUT` | 7000 | Command timeout (ms) |

## User preferences

- Keep existing project structure and stack.
