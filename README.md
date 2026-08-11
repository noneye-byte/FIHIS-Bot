# FIHAS Bot

Watches [@F_I_H_A_S](https://x.com/F_I_H_A_S) and drops an **fxtwitter.com** link into a Discord
channel whenever they post, pinging whoever you configure.

Runs as a Docker container on Unraid. Set it up through a **web wizard** (click WebUI on the
container), with **`/fihas` slash commands**, or with **`!fihas` text commands** in Discord — all
three drive the same config, and none of them needs a restart to take effect.

**RSSHub is built into the image**, so detection does not depend on public mirrors that everyone
else is hammering. Nothing extra to install.

<p align="center"><img src="FIHAS.jpg" width="140" alt="FIHAS Bot"></p>

---

## Contents

- [Read this first: how detection works](#read-this-first-how-detection-works)
- [Required permissions](#required-permissions)
- [Quick start](#quick-start)
- [Building with GitHub Actions](#building-with-github-actions)
- [Unraid setup](#unraid-setup)
- [Unraid settings reference](#unraid-settings-reference)
- [The setup wizard](#the-setup-wizard)
- [The dashboard: editing settings later](#the-dashboard-editing-settings-later)
- [Commands](#commands)
- [Behaviour worth knowing](#behaviour-worth-knowing)
- [Troubleshooting](#troubleshooting)

---

## Read this first: how detection works

X shut off free API access to user timelines. There is no free, officially supported way to ask
"has this account posted?" — so the bot supports two sources and falls back between them:

| Source | Cost | Reliability |
| --- | --- | --- |
| **Built-in RSSHub** | Free, ships in the image | Good. Private to your container, so nobody else can exhaust its rate limit. |
| **X API** (`X_BEARER_TOKEN`) | Paid — Basic tier, ~$200/mo | Excellent. The free tier **cannot** do this and returns 403. |
| **Public RSS mirrors** (rsshub.app / Nitter) | Free | Varies. Shared by the whole internet; they get rate-limited and go down. |

By default the bot runs in `auto` mode: it uses the X API if you give it a token, then walks the RSS
list in order until one responds. If a feed dies it transparently moves to the next, and
`/fihas test` (or **Test sources** in the web UI) shows you which are alive right now.

### The built-in RSSHub

This image is built **on top of** the official [RSSHub](https://docs.rsshub.app) image, and the bot
supervises RSSHub as a child process: it starts with the container, restarts with backoff if it
crashes, and logs under `[rsshub]`. On a fresh install its feed is placed first in the chain:

```
http://127.0.0.1:1200/twitter/user/F_I_H_A_S
```

That address is inside the container, so nothing needs publishing and nothing else on your network
can reach it. This is what makes it Unraid-friendly — Unraid runs one container per template, so a
compose sidecar was never an option there.

| | |
| --- | --- |
| **Cost** | ~150MB extra RAM, ~600MB extra image size |
| **Turn it off** | `RSSHUB_ENABLED=false` — the bot then uses the other feeds in the list |
| **Reach it from elsewhere** | Publish port `1200` (an *Advanced* row in the Unraid template) |
| **Restart it by hand** | **Restart RSSHub** under **Sources** in the web UI |
| **Configure it** | Any RSSHub environment variable set on the container is passed straight through |

> **It still needs X credentials.** RSSHub's X route requires `TWITTER_AUTH_TOKEN` — the
> `auth_token` cookie from a logged-in X session. X keeps tightening this, so check the current
> [RSSHub docs](https://docs.rsshub.app/deploy/config#x-twitter). That requirement is outside this
> bot's control, which is why the public mirrors stay in the chain as fallbacks.

Upgrading from an older version? Your saved feed list is left alone. Add the built-in one with
**Use built-in feed** under **Sources** in the web UI.

---

## Required permissions

### Discord — bot permissions

Granted by the invite link. The wizard generates one for you; this is the same link with
`permissions=277025770496`:

```
https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=277025770496&scope=bot%20applications.commands
```

| Permission | Needed for | Required? |
| --- | --- | --- |
| **View Channels** | Seeing the target channel at all | **Yes** |
| **Send Messages** | Posting the tweet link | **Yes** |
| **Embed Links** | Letting the fxtwitter link unfurl into a preview | **Yes** — without it you get a bare URL |
| **Read Message History** | Replying to a text command | Only for `!fihas` commands |
| **Send Messages in Threads** | Posting to a thread target | Only if the channel is a thread |
| **Mention @everyone** | `@everyone` pings, **and** pinging roles that are not "mentionable" | Only if you use those |
| **Manage Webhooks** | — | Never. Don't grant it. |
| **Administrator** | — | Never. Don't grant it. |

Both scopes matter: `bot` gets it into the server, `applications.commands` is what lets `/fihas`
register. **Re-inviting with the same link is how you fix missing permissions** — it updates the
existing bot rather than adding a second one.

Per-channel overrides beat server-wide grants, which is why the wizard greys out channels the bot
cannot post in: that check is done live against the real permissions.

### Discord — privileged intents

In the [Developer Portal](https://discord.com/developers/applications) → your app → **Bot** →
**Privileged Gateway Intents**:

| Intent | Needed for | Required? |
| --- | --- | --- |
| **Message Content** | Reading `!fihas ...` text commands | Only for text commands |
| Server Members | — | No |
| Presence | — | No |

Turn Message Content **on** if you want text commands. Without it the bot starts anyway, logs what
to fix, and the web UI shows the same warning under **Commands** — `/fihas` and the web UI are
unaffected. Set `PREFIX_ENABLED=false` if you would rather not grant it; the bot then never asks
for it.

### Discord — who may run commands

Both `/fihas` and `!fihas` require **Manage Server**. For slash commands you can change that in
**Server Settings → Integrations → FIHAS Bot**; text commands always check Manage Server.

### Container and host

| Thing | Value | Notes |
| --- | --- | --- |
| **Privileged mode** | Not needed | Leave it off. |
| **`/config` volume** | read-write | The only writable path the bot needs. |
| **Host path ownership** | writable by the container | The container runs as **root**, so the usual Unraid `nobody:users` appdata share works untouched. |
| **Port 8080/tcp** | inbound | Web UI and `/healthz`. Change the host side if it clashes. |
| **Port 1200/tcp** | optional | Bundled RSSHub. Only publish it if you want to use the feed bridge elsewhere. |
| **Outbound network** | required | `discord.com` + `gateway.discord.gg` (bot), `x.com` (RSSHub/API), any RSS mirrors you list. |
| **Capabilities** | none added | No `--cap-add`, no host networking, no device access. |

The bot needs no access to your array, your other containers, or the Docker socket.

---

## Quick start

### 1. Create the Discord application

1. [Developer Portal](https://discord.com/developers/applications) → **New Application**.
2. **Bot** → **Reset Token** → copy it. This is `DISCORD_TOKEN`. Treat it like a password.
3. **General Information** → copy the **Application ID**. This is `DISCORD_CLIENT_ID`.
4. **Bot** → **Privileged Gateway Intents** → turn on **MESSAGE CONTENT INTENT** if you want
   `!fihas` text commands. Leave the other two off. See
   [Required permissions](#required-permissions).

### 2. Invite it to your server

Replace `YOUR_CLIENT_ID` and open in a browser (the wizard also generates this link for you):

```
https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=277025770496&scope=bot%20applications.commands
```

That grants: View Channels, Send Messages, Embed Links, Read Message History, Mention Everyone,
Send Messages in Threads. Drop **Mention Everyone** if you never plan to use `@everyone`.

### 3. Run it

**Docker Compose** (any machine):

```sh
cp .env.example .env     # fill in DISCORD_TOKEN and DISCORD_CLIENT_ID
docker compose up -d
docker compose logs -f   # note the generated web UI password
```

Then open `http://<host>:8080/` and follow the wizard. For Unraid, see below.

---

## Building with GitHub Actions

[`.github/workflows/build.yml`](.github/workflows/build.yml) runs the test suite, then builds and
publishes a multi-arch image to the GitHub Container Registry. No Docker needed on your Unraid box.

### Push

```sh
git add .
git commit -m "Add setup UI, tests and CI"
git push
```

The workflow runs automatically on push to `main`. Nothing to configure — it authenticates with the
built-in `GITHUB_TOKEN`. The resulting image is:

```
ghcr.io/noneye-byte/fihas-bot:latest
```

| Trigger | What happens |
| --- | --- |
| Push to `main` | Tests, builds, pushes `:latest` and `:sha-abc1234` |
| Push a tag `v1.2.3` | Also pushes `:1.2.3` and `:1.2` |
| Pull request | Tests and builds, but does **not** push |
| Manual (**Run workflow**) | Same as a branch push |

Images are `linux/amd64` **and** `linux/arm64`, so the same tag works on Unraid, a Synology, or a Pi.
Layer caching is shared between runs, so repeat builds take well under a minute.

The image is built **on top of `diygod/rsshub`**, which is what puts a private feed bridge inside the
container. That makes it around 700MB — most of it the shared RSSHub base, pulled once. Pin a
different base with `--build-arg RSSHUB_IMAGE=diygod/rsshub:<tag>` if you would rather not track
their `latest`. The build fails loudly if RSSHub ever moves its entrypoint, rather than shipping a
container whose feed bridge silently never starts.

### Make the package pullable

**GHCR packages are private by default**, and Unraid cannot pull a private image without credentials.
After the first successful run:

**GitHub → your profile → Packages → `fihas-bot` → Package settings → Change visibility → Public**

Prefer to keep it private? Then log in on the Unraid box once, with a
[personal access token](https://github.com/settings/tokens) that has `read:packages`:

```sh
echo YOUR_TOKEN | docker login ghcr.io -u YOUR_USERNAME --password-stdin
```

### Run the tests locally

```sh
npm ci && npm test
```

Five suites, 150+ assertions: config/dedupe, the full polling and posting loop against a fake feed
and a stub Discord client, text-command parsing and dispatch against a stub guild, the web API
including auth and input validation, and the setup UI's markup and JavaScript.

---

## Unraid setup

### 1. Install the template

Use `unraid/fihas-bot.xml` from this repo — the image name is already set to
`ghcr.io/noneye-byte/fihas-bot:latest`. (Every Actions run also attaches an identical copy as the
**unraid-template** artifact, which is handy if you ever rename the repo.)

Put it on the Unraid box at:

```
/boot/config/plugins/dockerMan/templates-user/fihas-bot.xml
```

Then **Docker** tab → **Add Container** → pick **FIHAS-Bot** from the *Template* dropdown at the top.
Every field below is pre-filled with sensible defaults; you only have to supply the two Discord values.

> **Then delete `fihas-bot.xml`.** Once you have hit Apply, Unraid has written your real settings to
> `my-FIHAS-Bot.xml` in that same directory, and both files now claim `<Name>FIHAS-Bot</Name>`.
> Leaving the pristine one there means an **Apply** or **Force Update** can pick it up instead of
> yours and hand you a container with every field back at its default — blank token, port back to
> `8080`, appdata path back to `/mnt/user/appdata/fihas-bot`. Delete it and updates keep your
> settings:
>
> ```sh
> rm /boot/config/plugins/dockerMan/templates-user/fihas-bot.xml
> ls /boot/config/plugins/dockerMan/templates-user/   # only my-FIHAS-Bot.xml should remain
> ```
>
> Re-adding the template later is only ever needed to install the container again from scratch.

Prefer not to use the template? **Add Container** → toggle **Advanced View** and enter the settings
from the reference table manually.

<details>
<summary>Alternative: build on the Unraid box instead</summary>

If you would rather not use GitHub, copy the project to `/mnt/user/appdata/fihas-bot-src` and run
this from the Unraid **Terminal**, then set **Repository** to `fihas-bot:latest`:

```sh
cd /mnt/user/appdata/fihas-bot-src
docker build -t fihas-bot:latest .
```
</details>

### 2. Fill in the required fields, then Apply

Only these two are mandatory:

- **Discord Bot Token**
- **Discord Application ID**

### 3. Get the web UI password

If you left **Setup UI Password** blank, one is generated on first start and printed to the log.
**Docker** tab → click the FIHAS-Bot icon → **Logs**, and look for:

```
  ┌──────────────────────────────────────────────────────────────┐
  │                                                              │
  │ Setup UI password (generated).                               │
  │ Set WEB_PASSWORD to choose your own.                         │
  │                                                              │
  │     k3Jqx8Ff2Lm7                                             │
  │                                                              │
  └──────────────────────────────────────────────────────────────┘
```

### 4. Open the WebUI and finish setup

Click the container icon → **WebUI** (or browse to `http://<unraid-ip>:8080/`), log in, and walk
through the wizard.

---

## Unraid settings reference

Everything the template configures. **Show more settings** reveals the rows marked *Advanced*.

### Container settings

| Field | Value | Notes |
| --- | --- | --- |
| **Name** | `FIHAS-Bot` | |
| **Repository** | `ghcr.io/noneye-byte/fihas-bot:latest` | Published by the build workflow. Already set in the template. |
| **Network Type** | `bridge` | Host mode also works; then the port mapping is ignored. |
| **Console shell** | `sh` | Alpine base — `bash` is not installed. |
| **Privileged** | off | Never needed. |
| **WebUI** | `http://[IP]:[PORT:8080]/` | What the WebUI button opens. |
| **Icon URL** | `http://[IP]:[PORT:8080]/logo.jpg` | Served by the container itself. |

### Port

| Field | Container port | Default host port | Notes |
| --- | --- | --- | --- |
| **WebUI Port** | `8080` | `8080` | Setup wizard, dashboard, and the unauthenticated `/healthz` used for the container health dot. Change the **host** side if 8080 is already taken — Unraid itself does not use it, but plenty of containers do. |
| **RSSHub Port** | `1200` | `1200` | *Advanced, optional.* The built-in RSSHub. The bot reaches it over `127.0.0.1` inside the container, so **you can delete this row** — publish it only to use the feed bridge from elsewhere on your network. |

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
| **Text Command Prefix** | `COMMAND_PREFIX` | No | `!fihas` | Prefix for text commands. Needs **Message Content Intent** in the Developer Portal. |
| **Enable Text Commands** | `PREFIX_ENABLED` | No | `true` | `false` makes the bot ignore the prefix **and** never request the privileged intent. |
| **Built-in RSSHub** | `RSSHUB_ENABLED` | No | `true` | `false` skips starting the bundled RSSHub, saving ~150MB of RAM. |
| **X Handle** | `X_HANDLE` | No | `F_I_H_A_S` | Account to watch, without the `@`. |
| **Discord Channel ID** | `DISCORD_CHANNEL_ID` | No | — | Seeds the target channel on first boot only. Easier to pick in the wizard. |
| **Ping Role IDs** | `PING_ROLE_ID` | No | — | Comma-separated role IDs, first boot only. Easier in the wizard. |
| **Poll Interval (seconds)** | `POLL_INTERVAL_SECONDS` | No | `120` | Minimum 30. |
| **RSS Feed URLs** | `RSS_URLS` | No | built-ins | *Advanced.* Comma-separated, tried in order. Replaces the defaults **including the built-in RSSHub**, so list it yourself if you set this. |
| **RSSHub X Auth Token** | `TWITTER_AUTH_TOKEN` | No | — | *Advanced.* `auth_token` cookie from a logged-in X session, used by the built-in RSSHub. Masked. |
| **X API Bearer Token** | `X_BEARER_TOKEN` | No | — | *Advanced.* Paid X plans only. Tried before RSS when present. Masked. |
| **Timezone** | `TZ` | No | `Etc/UTC` | *Advanced.* e.g. `Europe/London`. Affects log timestamps only. |

Variables marked *first boot only* seed `config.json` and are then ignored — after that the wizard,
the dashboard and the commands are the source of truth, so the bot never fights your saved settings.
`COMMAND_PREFIX` and `PREFIX_ENABLED` are the exception: like `X_HANDLE`, they are applied on every
boot, so the template always wins over a value set in Discord.

Any other RSSHub variable can be added as an extra container variable — everything in the
container's environment is passed through to the bundled RSSHub as-is.

### Recommended extras

- **Autostart:** on.
- **Restart policy:** the image sets `unless-stopped` via compose; Unraid manages this itself and
  restarts containers with autostart enabled after an array start.
- **CPU pinning:** unnecessary — the bot is idle between polls.

### Updating

Push your change to `main` and wait for the Actions run to go green, then on Unraid:

**Docker** tab → FIHAS-Bot → **Force Update**

That re-pulls `:latest` and recreates the container. Your `/config` survives, so every setting,
the password, and the already-posted tweet IDs carry over.

**If an update resets the container's Docker settings**, the template directory has two files
claiming the same container name and Unraid loaded the wrong one. Check:

```sh
ls /boot/config/plugins/dockerMan/templates-user/
```

`my-FIHAS-Bot.xml` is yours and is the only one that should be there. If a bare `fihas-bot.xml`
(the copy from this repo) is sitting next to it, delete that one — see the note in
[Install the template](#1-install-the-template). Then re-enter your settings once and they will
stick from then on.

To pin a version instead of tracking `:latest`, tag a release (`git tag v1.0.0 && git push --tags`)
and set **Repository** to `ghcr.io/noneye-byte/fihas-bot:1.0.0`.

---

## The setup wizard

Six steps, about a minute. Open the WebUI and log in.

| Step | What it does |
| --- | --- |
| **Welcome** | Confirms the gateway connection, counts your servers, and generates an invite link if the bot is not in one yet. |
| **Channel** | Lists every text and announcement channel. Channels the bot **cannot post in are disabled**, so you can't pick a broken target. |
| **Pings** | Roles as checkboxes with their real colours. `@everyone` is disabled with a warning if the bot lacks Mention Everyone. Managed (bot/booster) roles are hidden. |
| **Source** | Choose the strategy, edit the RSS chain, and **Test these sources** live — each one reports works/failed with the reason. Shows the built-in RSSHub's state. |
| **Options** | Handle, interval, post-type filters, link style, and the message template with a **live Discord-style preview**. |
| **Finish** | Summary plus **Run first check**, which bootstraps without posting. |

---

## The dashboard: editing settings later

Once setup is done, the same URL becomes a dashboard. The top card is status — watching, channel,
pings, last check/post/error, source in use, active command styles — with buttons for **Check now**,
**Post latest**, **Pause/Resume**, **Test sources** and **Re-run setup**.

Below it, every setting the wizard collects is editable in place, in collapsible sections. No
re-running the wizard, no restart:

| Section | What you can change |
| --- | --- |
| **Destination** | Server and channel. Channels the bot cannot post in stay greyed out. |
| **Pings** | `@everyone` toggle and the role checkboxes. Users added via `/fihas ping add` are preserved. |
| **Sources** | Strategy, the RSS chain (add/edit/remove/reorder by editing), plus **Use built-in feed**, **Restart RSSHub** and **Test sources**. |
| **Posting options** | Handle, interval, post-type filters, link style, message template with the live preview. |
| **Commands** | Turn text commands on/off, change the prefix, and see whether Discord is actually granting the Message Content intent. |

Each section saves on its own, so one bad value never blocks the rest, and a section stays open
across a save. Invalid input is rejected with the reason rather than silently clamped.

### Security

The UI is password protected, sessions are HttpOnly + SameSite=Strict cookies lasting 12 hours,
and logins lock out for 15 minutes after 10 failures. `/healthz` is deliberately open so the
container health check works without credentials — it exposes status only, never secrets.

It is plain HTTP on your LAN. Don't port-forward it to the internet; if you need remote access, put
it behind your existing reverse proxy with TLS, or reach it over your VPN/Tailscale.

---

## Commands

Everything is available two ways. Slash command responses are ephemeral (only you see them); text
command replies are visible to the channel. Both require **Manage Server** — for slash commands you
can change that in **Server Settings → Integrations → FIHAS Bot**.

| | Slash | Text |
| --- | --- | --- |
| Looks like | `/fihas status` | `!fihas status` |
| Needs | `applications.commands` scope | **Message Content Intent** |
| Replies | ephemeral | visible in the channel |
| Turn off | remove the scope | `PREFIX_ENABLED=false` |

### When slash commands don't show up

They are registered on every start, but they can still be invisible: global registration takes up to
an hour, the bot may have been invited without `applications.commands`, or an integration permission
may be hiding them. Text commands are the fallback that does not depend on any of that.

```
!fihas help
```

- Set **Discord Server ID** (`DISCORD_GUILD_ID`) to make `/fihas` register **instantly** instead of
  globally — that fixes the common case.
- Enable **MESSAGE CONTENT INTENT** in the Developer Portal, or the bot cannot read `!fihas` at all.
  It logs exactly this on startup and the web UI shows it under **Commands**.
- Change the prefix in the web UI, with `/fihas prefix set !f`, or with `COMMAND_PREFIX`. Anything
  up to 16 characters with no spaces, `@`, `#` or backticks works — `!fihas`, `!f`, `fihas!`.
- Turn text commands off entirely with `/fihas prefix enabled false` or `PREFIX_ENABLED=false`. The
  bot then never requests the privileged intent.

Prefix matching is case-insensitive, and a prefix ending in a letter or digit must be followed by a
space, so `!fihas` never fires on `!fihasburger`.

### Reference

Replace `/fihas` with `!fihas` for the text version — the arguments are identical, except that
`#channel`, `@role` and `@user` are written as mentions or raw IDs.

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
| `/fihas prefix set <text>` | Change the text-command prefix |
| `/fihas prefix enabled <bool>` | Turn text commands on or off |
| `/fihas help` | Every command, including the text versions |

Defaults: retweets **on**, replies **off**, quotes **on**, 120s interval, fxtwitter links,
`!fihas` text commands on.

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
- **The bundled RSSHub is supervised, not required.** If it crashes it is restarted with backoff
  (2s, 5s, 15s, 30s, then a minute); while it is down the poller just falls through to the next
  feed. If the image ever ships without it, the bot logs that and carries on.
- **The privileged intent is only requested when text commands are on.** If Discord refuses it, the
  bot logs what to enable and reconnects without it rather than crash-looping, so `/fihas` and the
  web UI keep working.
- **Prefix replies never ping.** Several commands quote the ping list back at you; mentions in bot
  replies are disabled outright, so reading the config can't notify a role.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Container restarts in a loop | Check the log. A bad `DISCORD_TOKEN` prints an explicit message and exits 1. |
| `/fihas` doesn't appear in Discord | Set **Discord Server ID** and restart — global commands take up to an hour to propagate. Meanwhile use `!fihas status`. |
| `!fihas` does nothing | Enable **MESSAGE CONTENT INTENT** (Developer Portal → Bot) and restart. The log and the web UI's **Commands** section both say so when it is missing. Also check the bot has **Read Message History** and **Send Messages** in that channel. |
| `!fihas` says you need Manage Server | Text commands require it, same as slash commands. There is no separate setting. |
| Can't get into the web UI | Set **Setup UI Password** in the template and restart; the env var always overrides the stored password. |
| WebUI button does nothing | Something else is on host port 8080. Change the host side of the port mapping. |
| Nothing ever posts | **Test sources**. If everything is ❌, see the next two rows. |
| Built-in RSSHub shows ❌ | Almost always `Twitter API is not configured` — it needs `TWITTER_AUTH_TOKEN` for X routes. **Test sources** says so explicitly when the variable is unset. Then **Restart RSSHub** in the web UI. |
| Port 1200 already in use | Delete the **RSSHub Port** row from the container config — the bot does not need it published — or set `RSSHUB_PORT` to something free. |
| Container uses more RAM than expected | The bundled RSSHub accounts for ~150MB. Set `RSSHUB_ENABLED=false` if you would rather use external feeds. |
| `403` from the X API | Free tier can't read timelines. Upgrade to Basic, or set the source mode to RSS. |
| Pings don't notify anyone | The role may be un-mentionable, or the bot lacks **Mention Everyone** — which is also required to ping un-mentionable roles. |
| Posted the whole backlog at once | The `bootstrapped` flag was lost. Check `/config` is actually mapped to persistent storage. |
| Channel is greyed out in the wizard | The bot lacks **View Channel** or **Send Messages** there. Fix it in Discord, then reload the page. |

---

## Layout

```
src/index.js               startup, Discord wiring, intents, lifecycle
src/actions.js             every command's behaviour, shared by both command styles
src/commands.js            /fihas slash command definitions -> actions
src/prefix.js              !fihas text command parsing -> actions
src/poller.js              polling loop, filters, dedupe, posting, backoff
src/store.js               config persistence, seen-ID tracking, validation rules
src/rsshub.js              supervises the RSSHub bundled into the image
src/runtime.js             process-wide flags (is the message intent live?)
src/avatar.js              hash-guarded bot profile picture upload
src/sources/xapi.js        official X API v2
src/sources/rss.js         RSS/Nitter/RSSHub feeds
src/web/server.js          setup UI HTTP server, auth, config API, /healthz
src/web/ui.html            the wizard and dashboard (self-contained)
test/run.mjs               test runner — npm test
test/store.test.mjs        config, dedupe, link building, RSS parsing, fallback
test/poller.test.mjs       full polling loop against a fake feed + stub Discord
test/prefix.test.mjs       text command parsing, dispatch, permissions, rsshub helpers
test/web.test.mjs          web API, auth, input validation
test/ui.test.mjs           setup UI markup and JavaScript
.github/workflows/build.yml  test, build multi-arch, publish to GHCR
unraid/fihas-bot.xml       Unraid container template
Dockerfile                 multi-stage build on top of the official RSSHub image
FIHAS.jpg                  app icon and bot avatar
```
