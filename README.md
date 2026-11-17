# pi-websession

Watch a running pi session, and its subagents, live from your phone or a browser over Tailscale or your local network. You can also drive it from there if you say so.

- Opt in per session with `/web`. Nothing is shared until you do.
- Shows the main thread and every subagent (foreground and background) as a tree, live: streaming text, thinking, tool calls with args, streaming tool output, and results.
- Readable on a phone: edits show as diffs, writes and reads as highlighted files with line numbers, bash output keeps its colors, exit codes and durations sit in the card header, and long output is folded. Code blocks get syntax highlighting and copy buttons. Images show up (screenshots, pasted images). A finished subagent's answer shows inside the parent's card. The **MD/TXT** button switches between rendered markdown and raw text.
- Tap a file path (in a tool card, or `like/this.ts:42` in a message) to open it in a viewer, scrolled to that line. Only files inside that session's working directory, never `.env`, keys, `.git` or `.ssh`.
- Control is a separate opt-in (`/web control`, with a confirm prompt): send prompts, steer or queue follow-ups while it's working, and abort.

## Install

```sh
pi install git:github.com/scottjab/pi-websession
```

or clone it and add the path to `extensions` in `~/.pi/agent/settings.json`. Try it once without installing:

```sh
pi -e ./pi-websession/src/index.ts
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

The URL looks like `http://<host>.<tailnet>.ts.net:7878/?t=<token>`, plus a LAN one like `http://192.168.1.20:7878/?t=<token>`. Opening one once stores the token in a cookie, so you can bookmark `http://<host>.<tailnet>.ts.net:7878/` afterwards (or add it to your home screen).

The opt-in is remembered per session file, so a resumed session comes back shared, and background subagents keep showing up after you close the terminal. `/web off` clears it.

## How it works

- **Hub.** The first sharing pi process on the machine binds port 7878 on 127.0.0.1, your Tailscale IP, and your LAN IPs (wifi/ethernet, not docker/VM bridges), and serves the web UI. Other sharing pi processes, like background subagent runners or another terminal, connect to it on loopback. If the hub's pi exits, another one takes over and everything resyncs. The browser reconnects on its own.
- **Subagents.** When a session is shared, the extension registers itself with pi-subagents (`registerRequiredChildExtensions`), so child sessions load it too. A child publishes when its `parentSession` chain leads to a shared session. Finished subagents stay listed as "done" for 30 minutes, or until their parent goes away.
- **Consent** lives in `~/.pi/agent/websession/shared-sessions.json`. Publishers re-read it every few seconds and again right before acting on any web command, so `/web nocontrol` and `/web off` take effect right away.
- **Auth.** A random token in `~/.pi/agent/websession/token` (mode 600), checked with a constant-time compare. It's sent as an HttpOnly SameSite=Strict cookie. Control POSTs also need a custom header, which blocks cross-site form posts.
- Big payloads are trimmed: text over 60k chars, tool args over 30k. Images are sent to the hub once and messages only carry a hash. Streaming text goes as deltas, throttled to about 8 updates a second.

## Config (env vars)

| Var | Default | |
|---|---|---|
| `PI_WEBSESSION_PORT` | `7878` | |
| `PI_WEBSESSION_HOST` | `tailscale,lan` | comma list of `tailscale` (100.64/10 address), `lan` (private IPv4s on physical interfaces), `local` (loopback only), `all` (0.0.0.0), or IPs. Loopback is always on |
| `PI_WEBSESSION_TOKEN` | generated | fixed token instead of the token file |
| `PI_WEBSESSION_DIR` | `~/.pi/agent/websession` | state dir |
| `PI_WEBSESSION_SUBAGENTS_PATH` | auto | pi-subagents package dir, if it isn't found from settings |
| `PI_WEBSESSION_DEBUG` | off | log to `<dir>/debug.log` |

## Limits

- The file viewer reads files as they are now, not as they were at that point in the session. Up to 1 MB, text only.
- Images over ~3 MB are dropped. The hub keeps up to 96 MB of images in memory and drops the oldest past that.
- It's plain HTTP. On the tailnet that's encrypted by WireGuard, but on the LAN the token and transcript go over the wire in clear. Use `PI_WEBSESSION_HOST=tailscale` if you don't trust the network.
- LAN/Tailscale addresses are picked when the hub starts. If you switch networks, the next hub (or `/web off` + `/web` in the hub pi) picks up the new ones.
- On NixOS the firewall usually trusts `tailscale0` but not your wifi/ethernet, so open the port for LAN: `networking.firewall.allowedTCPPorts = [ 7878 ];`.
- Dialogs pi shows in the terminal (confirm/select from extensions) can't be answered from the web. The session shows "waiting on terminal".
- No QR code. Type the short URL once and bookmark it.
- If the hub process exits, the new hub only knows about live sessions. Ended subagents from the old hub drop off.

## Dev

`npm install && npm run typecheck`. Types come from the `@earendil-works/pi-coding-agent` dev dependency.
