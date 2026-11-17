# pi-websession

Watch a running pi session, and its subagents, live from your phone or a browser over Tailscale. You can also drive it from there if you say so.

- Opt in per session with `/web`. Nothing is shared until you do.
- Shows the main thread and every subagent (foreground and background) as a tree, live: streaming text, thinking, tool calls with args, streaming tool output, and results.
- Control is a separate opt-in (`/web control`, with a confirm prompt): send prompts, steer or queue follow-ups while it's working, and abort.

## Install

```sh
pi install /home/scottjab/code/js/pi-websession
```

or add the path to `extensions` in `~/.pi/agent/settings.json` (or your home-manager config). Try it once without installing:

```sh
pi -e /home/scottjab/code/js/pi-websession/src/index.ts
```

## Use

| Command | What it does |
|---|---|
| `/web` or `/web on` | Share this session (view only) and print the URL |
| `/web control` | Also allow control from the browser (asks to confirm) |
| `/web nocontrol` | Back to view only |
| `/web off` | Stop sharing. Subagents stop within a few seconds |
| `/web url` | Print the URL again |
| `/web status` | Hub/connection info |
| `/web rotate` | New access token (restart other sharing pi processes) |

`pi --web` shares from startup.

The URL looks like `http://<host>.<tailnet>.ts.net:7878/?t=<token>`. Opening it once stores the token in a cookie, so you can bookmark `http://<host>.<tailnet>.ts.net:7878/` afterwards (or add it to your home screen).

The opt-in is remembered per session file, so a resumed session comes back shared, and background subagents keep showing up after you close the terminal. `/web off` clears it.

## How it works

- **Hub.** The first sharing pi process on the machine binds port 7878 on 127.0.0.1 and your Tailscale IP, and serves the web UI. Other sharing pi processes, like background subagent runners or another terminal, connect to it on loopback. If the hub's pi exits, another one takes over and everything resyncs. The browser reconnects on its own.
- **Subagents.** When a session is shared, the extension registers itself with pi-subagents (`registerRequiredChildExtensions`), so child sessions load it too. A child publishes when its `parentSession` chain leads to a shared session. Finished subagents stay listed as "done" for 30 minutes, or until their parent goes away.
- **Consent** lives in `~/.pi/agent/websession/shared-sessions.json`. Publishers re-read it every few seconds and again right before acting on any web command, so `/web nocontrol` and `/web off` take effect right away.
- **Auth.** A random token in `~/.pi/agent/websession/token` (mode 600), checked with a constant-time compare. It's sent as an HttpOnly SameSite=Strict cookie. Control POSTs also need a custom header, which blocks cross-site form posts.
- Big payloads are trimmed: text over 60k chars, tool args over 30k, and images are dropped (the UI shows a placeholder). Streaming text goes as deltas, throttled to about 8 updates a second.

## Config (env vars)

| Var | Default | |
|---|---|---|
| `PI_WEBSESSION_PORT` | `7878` | |
| `PI_WEBSESSION_HOST` | `tailscale` | `tailscale` (100.64/10 address + loopback), `local`, `all` (0.0.0.0), or an IP |
| `PI_WEBSESSION_TOKEN` | generated | fixed token instead of the token file |
| `PI_WEBSESSION_DIR` | `~/.pi/agent/websession` | state dir |
| `PI_WEBSESSION_SUBAGENTS_PATH` | auto | pi-subagents package dir, if it isn't found from settings |
| `PI_WEBSESSION_DEBUG` | off | log to `<dir>/debug.log` |

## Limits

- Dialogs pi shows in the terminal (confirm/select from extensions) can't be answered from the web. The session shows "waiting on terminal".
- No QR code. Type the short URL once and bookmark it.
- If the hub process exits, the new hub only knows about live sessions. Ended subagents from the old hub drop off.

## Dev

`npm run typecheck`. `tsconfig.json` points at the pi install in the nix store for types, so update the path when pi upgrades.
