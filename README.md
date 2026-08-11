# FIHAS Bot

Watches [@F_I_H_A_S](https://x.com/F_I_H_A_S) and drops an **fxtwitter.com** link into a Discord
channel whenever they post, pinging whoever you configure.

Runs as a Docker container on Unraid. Set it up through a **web wizard** (click WebUI on the
container) or with **`/fihas` slash commands** in Discord — both drive the same config, and neither
needs a restart to take effect.

<p align="center"><img src="FIHAS.jpg" width="140" alt="FIHAS Bot"></p>

---

## Contents

- [Read this first: how detection works](#read-this-first-how-detection-works)
- [Quick start](#quick-start)
- [Unraid setup](#unraid-setup)
- [Unraid settings reference](#unraid-settings-reference)
- [The setup wizard](#the-setup-wizard)
- [Slash commands](#slash-commands)
- [Behaviour worth knowing](#behaviour-worth-knowing)
- [Troubleshooting](#troubleshooting)

---

## Read this first: how detection works

X shut off free API access to user timelines. There is no free, officially supported way to ask
"has this account posted?" — so the bot supports two sources and falls back between them:

| Source | Cost | Reliability |
| --- | --- | --- |
| **X API** (`X_BEARER_TOKEN`) | Paid — Basic tier, ~$200/mo | Excellent. The free tier **cannot** do this and returns 403. |
| **RSS mirrors** (RSSHub / Nitter) | Free | Varies. Public instances get rate-limited and go down. |

By default the bot runs in `auto` mode: it uses the X API if you give it a token, otherwise it walks
the RSS list in order until one responds. If a feed dies it transparently moves to the next, and
`/fihas test` (or **Test sources** in the web UI) shows you which are alive right now.

### Recommended: run your own RSSHub

Public mirrors are shared by the entire internet and are the single most likely thing to break.
A self-hosted RSSHub only serves you. It is bundled here behind a compose profile:

```sh
docker compose --profile rsshub up -d
```

Then point the bot at `http://<your-server-ip>:1200/twitter/user/F_I_H_A_S` on the **Source** step
of the wizard, and remove the public defaults.

> RSSHub's Twitter route needs credentials of its own (`TWITTER_AUTH_TOKEN`, an `auth_token` cookie
> from a logged-in session). X keeps tightening this, so check the current
> [RSSHub docs](https://docs.rsshub.app/deploy/config#x-twitter) — that requirement is outside this
> bot's control.

---

## Quick start

### 1. Create the Discord application

1. [Developer Portal](https://discord.com/developers/applications) → **New Application**.
2. **Bot** → **Reset Token** → copy it. This is `DISCORD_TOKEN`. Treat it like a password.
3. **General Information** → copy the **Application ID**. This is `DISCORD_CLIENT_ID`.
4. No privileged intents are needed — leave them all off.

### 2. Invite it to your server

Replace `YOUR_CLIENT_ID` and open in a browser (the wizard also generates this link for you):

```
https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=277025770496&scope=bot%20applications.commands
```

That grants: View Channels, Send Messages, Embed Links, Mention Everyone, Send Messages in Threads.
Drop **Mention Everyone** if you never plan to use `@everyone`.

### 3. Run it

**Docker Compose** (any machine):

```sh
cp .env.example .env     # fill in DISCORD_TOKEN and DISCORD_CLIENT_ID
docker compose up -d
docker compose logs -f   # note the generated web UI password
```

Then open `http://<host>:8080/` and follow the wizard. For Unraid, see below.

---

## Unraid setup

The image is not published to a registry, so build it on the Unraid box once.

### 1. Copy the project and build the image

Put the project folder somewhere persistent — `/mnt/user/appdata/fihas-bot-src` is a good spot —
then from the Unraid terminal (**Terminal** button, top right of the web UI):

```sh
cd /mnt/user/appdata/fihas-bot-src
docker build -t fihas-bot:latest .
```

### 2. Install the template

Copy `unraid/fihas-bot.xml` to:

```
/boot/config/plugins/dockerMan/templates-user/fihas-bot.xml
```

Then **Docker** tab → **Add Container** → pick **FIHAS-Bot** from the *Template* dropdown at the top.
Every field below is pre-filled with sensible defaults; you only have to supply the two Discord values.

Prefer not to use the template? **Add Container** → toggle **Advanced View** and enter the settings
from the reference table manually.

### 3. Fill in the required fields, then Apply

Only these two are mandatory:

- **Discord Bot Token**
- **Discord Application ID**

### 4. Get the web UI password

If you left **Setup UI Password** blank, one is generated on first start and printed to the log.
**Docker** tab → click the FIHAS-Bot icon → **Logs**, and look for:

```
  ┌─────────────────────────────────────────────────────────┐
  │  Setup UI password (generated — set WEB_PASSWORD to      │
  │  choose your own):                                       │
  │      k3Jq-x8Ff2Lm                                        │
  └─────────────────────────────────────────────────────────┘
```

### 5. Open the WebUI and finish setup

Click the container icon → **WebUI** (or browse to `http://<unraid-ip>:8080/`), log in, and walk
through the wizard.

---

## Unraid settings reference

Everything the template configures. **Show more settings** reveals the rows marked *Advanced*.

### Container settings

| Field | Value | Notes |
| --- | --- | --- |
| **Name** | `FIHAS-Bot` | |
| **Repository** | `fihas-bot:latest` | Must match the tag you built in step 1. |
| **Network Type** | `bridge` | Host mode also works; then the port mapping is ignored. |
| **Console shell** | `sh` | Alpine base — `bash` is not installed. |
| **Privileged** | off | Never needed. |
| **WebUI** | `http://[IP]:[PORT:8080]/` | What the WebUI button opens. |
| **Icon URL** | `http://[IP]:[PORT:8080]/logo.jpg` | Served by the container itself. |

### Port

| Field | Container port | Default host port | Notes |
| --- | --- | --- | --- |
| **WebUI Port** | `8080` | `8080` | Setup wizard, dashboard, and the unauthenticated `/healthz` used for the container health dot. Change the **host** side if 8080 is already taken — Unraid itself does not use it, but plenty of containers do. |

### Path

| Field | Container path | Default host path | Mode |
| --- | --- | --- | --- |
| **Config Storage** | `/config` | `/mnt/user/appdata/fihas-bot` | `rw` |

Holds `config.json`: every setting, plus the list of already-posted tweet IDs. **Losing this
directory makes the bot re-bootstrap** — it will silently re-record existing posts rather than
spamming, but your channel, pings, and password all reset.

### Variables

| Field | Variable | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| **Discord Bot Token** | `DISCORD_TOKEN` | **Yes** | — | Bot → Reset Token. Masked. |
| **Discord Application ID** | `DISCORD_CLIENT_ID` | **Yes** | — | General Information → Application ID. |
| **Discord Server ID** | `DISCORD_GUILD_ID` | No | — | Strongly recommended: slash commands register **instantly** instead of taking up to an hour. Enable Developer Mode in Discord, right-click your server → Copy Server ID. |
| **Setup UI Password** | `WEB_PASSWORD` | No | generated | Password for the WebUI. Leave blank to have one generated and printed in the log. Setting it here always overrides a stored one — that is how you recover from a lockout. Masked. |
| **X Handle** | `X_HANDLE` | No | `F_I_H_A_S` | Account to watch, without the `@`. |
| **Discord Channel ID** | `DISCORD_CHANNEL_ID` | No | — | Seeds the target channel on first boot only. Easier to pick in the wizard. |
| **Ping Role IDs** | `PING_ROLE_ID` | No | — | Comma-separated role IDs, first boot only. Easier in the wizard. |
| **Poll Interval (seconds)** | `POLL_INTERVAL_SECONDS` | No | `120` | Minimum 30. |
| **RSS Feed URLs** | `RSS_URLS` | No | built-ins | *Advanced.* Comma-separated, tried in order. Overrides the defaults. |
| **X API Bearer Token** | `X_BEARER_TOKEN` | No | — | *Advanced.* Paid X plans only. Tried before RSS when present. Masked. |
| **Timezone** | `TZ` | No | `Etc/UTC` | *Advanced.* e.g. `Europe/London`. Affects log timestamps only. |

Variables marked *first boot only* seed `config.json` and are then ignored — after that the wizard
and slash commands are the source of truth, so the bot never fights your saved settings.

### Recommended extras

- **Autostart:** on.
- **Restart policy:** the image sets `unless-stopped` via compose; Unraid manages this itself and
  restarts containers with autostart enabled after an array start.
- **CPU pinning:** unnecessary — the bot is idle between polls.

### Updating

```sh
cd /mnt/user/appdata/fihas-bot-src
git pull                                  # or re-copy the files
docker build -t fihas-bot:latest .
```

Then **Docker** tab → FIHAS-Bot → **Force Update**. Your `/config` survives; the container picks up
the new image with the same settings.

---

## The setup wizard

Six steps, about a minute. Open the WebUI and log in.

| Step | What it does |
| --- | --- |
| **Welcome** | Confirms the gateway connection, counts your servers, and generates an invite link if the bot is not in one yet. |
| **Channel** | Lists every text and announcement channel. Channels the bot **cannot post in are disabled**, so you can't pick a broken target. |
| **Pings** | Roles as checkboxes with their real colours. `@everyone` is disabled with a warning if the bot lacks Mention Everyone. Managed (bot/booster) roles are hidden. |
| **Source** | Choose the strategy, edit the RSS chain, and **Test these sources** live — each one reports works/failed with the reason. |
| **Options** | Handle, interval, post-type filters, link style, and the message template with a **live Discord-style preview**. |
| **Finish** | Summary plus **Run first check**, which bootstraps without posting. |

Afterwards the same URL becomes a dashboard: status tiles, last check/post/error, and buttons for
Check now, Post latest, Pause/Resume, Test sources, and Re-run setup.

### Security

The UI is password protected, sessions are HttpOnly + SameSite=Strict cookies lasting 12 hours,
and logins lock out for 15 minutes after 10 failures. `/healthz` is deliberately open so the
container health check works without credentials — it exposes status only, never secrets.

It is plain HTTP on your LAN. Don't port-forward it to the internet; if you need remote access, put
it behind your existing reverse proxy with TLS, or reach it over your VPN/Tailscale.

---

## Slash commands

All responses are ephemeral (only you see them) and require **Manage Server** by default. Change who
may use them in **Server Settings → Integrations → FIHAS Bot**.

| Command | What it does |
| --- | --- |
| `/fihas status` | State, interval, channel, last check/post, last error |
| `/fihas check` | Poll immediately, ignoring pause and backoff |
| `/fihas latest [ping]` | Post the most recent tweet on demand. Defaults to **no** ping |
| `/fihas pause` · `/fihas resume` | Stop and start polling |
| `/fihas test` | Try every source and report which work — start here when it's quiet |
| `/fihas settings` | Dump the raw config |
| `/fihas channel set #channel` | Set the destination. Verifies the bot can actually post there |
| `/fihas ping add \| remove` | Add/remove a role or user from the ping list |
| `/fihas ping list \| clear` | Show or empty the ping list |
| `/fihas ping everyone <bool>` | Toggle `@everyone`. Checks the bot has permission first |
| `/fihas source mode <auto\|xapi\|rss>` | Choose the fetch strategy |
| `/fihas source add \| remove <url>` | Manage the RSS fallback chain |
| `/fihas source list` | Show the chain in the order it is tried |
| `/fihas set interval <seconds>` | Polling interval, minimum 30 |
| `/fihas set handle <handle>` | Watch a different account (re-bootstraps, rewrites RSS URLs) |
| `/fihas set filter <type> <bool>` | Include/exclude `retweets`, `replies`, `quotes` |
| `/fihas set link <fxtwitter\|vxtwitter>` | Which embed-fixing mirror to link |
| `/fihas set template <text>` | Message format. Placeholders: `{pings}` `{handle}` `{link}` `{text}` |

Defaults: retweets **on**, replies **off**, quotes **on**, 120s interval, fxtwitter links.

---

## Behaviour worth knowing

- **The first check never posts.** It records existing posts as already-seen and bootstraps, so
  starting the bot cannot flood your channel. Everything after that is announced.
- **No double-posts.** Every posted tweet ID is written to `/config/config.json` along with a
  high-water mark, so a restart mid-burst never repeats itself.
- **If Discord rejects a post**, that tweet stays unseen and is retried next cycle rather than
  being silently dropped.
- **Mentions are scoped.** `allowedMentions` is restricted to exactly the roles and users you
  configured, so a tweet containing the text `@everyone` can never turn into a real mass ping.
- **Repeated source failures back off exponentially**, up to 15 minutes, then recover on their own.
- **Pausing stops polling entirely**, so anything posted while paused is announced when you resume.
  How far back that reaches depends on how many items the source still lists — typically 10–20 posts.
- **Announcement channels** are automatically crossposted to following servers.
- **The bot's avatar** is set from `FIHAS.jpg` on startup, but only when the file's hash changes —
  Discord rate-limits avatar changes hard, so re-uploading every restart would lock the bot out.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Container restarts in a loop | Check the log. A bad `DISCORD_TOKEN` prints an explicit message and exits 1. |
| `/fihas` doesn't appear in Discord | Set **Discord Server ID** and restart — global commands take up to an hour to propagate. |
| Can't get into the web UI | Set **Setup UI Password** in the template and restart; the env var always overrides the stored password. |
| WebUI button does nothing | Something else is on host port 8080. Change the host side of the port mapping. |
| Nothing ever posts | **Test sources**. If everything is ❌, all your RSS mirrors are down — self-host RSSHub. |
| `403` from the X API | Free tier can't read timelines. Upgrade to Basic, or set the source mode to RSS. |
| Pings don't notify anyone | The role may be un-mentionable, or the bot lacks **Mention Everyone** — which is also required to ping un-mentionable roles. |
| Posted the whole backlog at once | The `bootstrapped` flag was lost. Check `/config` is actually mapped to persistent storage. |
| Channel is greyed out in the wizard | The bot lacks **View Channel** or **Send Messages** there. Fix it in Discord, then reload the page. |

---

## Layout

```
src/index.js          startup, Discord wiring, command registration, lifecycle
src/commands.js       every /fihas subcommand
src/poller.js         polling loop, filters, dedupe, posting, backoff
src/store.js          config persistence, seen-ID tracking
src/avatar.js         hash-guarded bot profile picture upload
src/sources/xapi.js   official X API v2
src/sources/rss.js    RSS/Nitter/RSSHub feeds
src/web/server.js     setup UI HTTP server, auth, config API, /healthz
src/web/ui.html       the wizard and dashboard (self-contained)
unraid/fihas-bot.xml  Unraid container template
FIHAS.jpg             app icon and bot avatar
```
