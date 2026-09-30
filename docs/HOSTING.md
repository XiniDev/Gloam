# Hosting Gloam

Gloam runs on your own computer. Your players join from their browsers — through a Cloudflare tunnel from anywhere,
or on your home network. Everything (campaigns, maps, sheets, the log) stays in one folder on your machine.

## 1. Install once

1. **Node.js 24 LTS** (22.18 or later also works) and **Git**.
2. `corepack enable` (this gives you the right pnpm).
3. Get Gloam: `git clone <the repository>` (or unzip a build folder), then in that folder:

   ```sh
   pnpm install
   pnpm build
   ```

4. **cloudflared** — only needed for friends outside your home (see §4):
   - macOS: `brew install cloudflared`
   - Windows: `winget install --id Cloudflare.cloudflared`
   - Linux: Cloudflare's package repository (`.deb` / `.rpm`) or the binary from Cloudflare's releases page.
   - Check it: `cloudflared --version`

## 2. Start

```sh
pnpm start
```

The terminal shows the local address (`http://127.0.0.1:4747`) and, the first time, a **one-time admin link**.

**First run:** open the setup link, choose an admin password (at least 12 characters), and optionally create the
demo campaign (*The Lantern Crypt* — a small dungeon with monsters, lights, doors and a handout, ready to play).
The first-run checklist on the Table page walks you through the rest.

Gloam listens on your own machine only (`127.0.0.1`) until you open the table in a mode that lets players in.

## 3. Game night

1. **Admin → Table → Open table**, and pick how players reach you:
   - **Quick tunnel** (default) — a temporary `https://….trycloudflare.com` address, new each time. No account needed.
   - **Named tunnel** — your own stable address (see §5).
   - **LAN** — players on your home network open `http://<your PC's address>:4747`. You confirm first: anyone on
     the network can reach the join page while it's on, and a badge says so.
   - **Local only** — no doorway at all (testing, or players on this PC).
2. **Copy the invite message** (the address and the invite code) into your group chat.
3. **Admit people as they knock** — a knock card appears for each; returning players can be let in automatically
   (Admin → Settings → *Auto-admit returning players*).
4. **Appoint the DM** (Admin → People) if it isn't you, and **activate a scene**.

**Lock the door** on the Table page stops new knocks without closing the table. **Close table** (or Ctrl+C in the
terminal) ends the night — everything is already saved.

## 4. Quick vs named tunnels

| | Quick tunnel | Named tunnel |
|---|---|---|
| Setup | none | a free Cloudflare account and a domain |
| Address | new every time you open the table | the same every time |
| Good for | a one-off game | a regular group |

Gloam runs `cloudflared` for you and restarts it if it drops. It never logs your tunnel token.

## 5. A stable link (named tunnel)

1. Create a free Cloudflare account and add your domain.
2. In the Cloudflare dashboard: **Zero Trust → Networks → Tunnels → Create a tunnel**, with a public hostname
   (e.g. `table.example.com`) pointing to `http://127.0.0.1:4747`.
3. Copy the tunnel's token into **Admin → Settings → Tunnel (Named)** — or set it as the `TUNNEL_TOKEN`
   environment variable — and choose **Named** mode.

Tunnel, port, LAN and cloudflared-path settings can only be changed from the host PC itself.

## 6. Backups and moving campaigns

- **Automatic daily backups** go to `data/backups/`; **Admin → Saves & Backups → Back up now** makes one on demand.
- Copy the whole `data/` folder somewhere else now and then — that's everything.
- **Export a campaign** as a `.gloam` file (Admin → Campaigns) to move it to another machine, and import it there.

## 7. Updating

```sh
git pull
pnpm install
pnpm build
pnpm start
```

Database migrations run automatically, and a backup of the database is taken first.

## 8. Claude and other tools (optional)

**Admin → API & MCP → Connect Claude** creates an API token and shows the exact configuration for Claude Desktop
or Claude Code, with this folder's path filled in. Tokens work only from this computer unless you switch on
*Allow remote API* (Admin → Settings); each has its own scopes and can be revoked any time.

## 9. Troubleshooting

- **cloudflared is missing** — the Table page shows install instructions for your system and a **Re-check** button.
  If it's installed somewhere unusual, set its path in Admin → Settings. Local and LAN modes work without it.
- **Port 4747 is busy** — start on another port: `PORT=4750 pnpm start` (PowerShell: `$env:PORT=4750; pnpm start`),
  or set the port in Admin → Settings (used from the next start).
- **The quick tunnel won't start** — a `config.yaml` in `~/.cloudflared/` (from an earlier named tunnel) makes
  `cloudflared` ignore quick-tunnel requests. Rename it (e.g. to `config.yaml.off`) and open the table again.
- **A player sees "can't join"** — check the invite code (it changes when you make a new one), whether the door is
  locked, and the ban list (Admin → People).
- **A player can't connect at all** — make sure the table is open in Quick, Named or LAN mode (not Local only). In
  LAN mode, your firewall must allow Node on port 4747, and players must be on the same network.
- **No sound on an iPhone** — tap the **Tap to enable sound** chip (browsers block sound until you touch the page),
  and check the phone's silent switch.
- **Slow on a phone or an old laptop** — Settings (the cog) → Graphics → **Graphics quality → Low**. Gloam also lowers
  the quality on its own when frames get slow.
- **The board goes blank for a moment ("Restoring board…")** — the device took the graphics memory back (a phone
  short of memory, a graphics driver resetting). Gloam draws the board again by itself when the browser gives it back;
  if the browser doesn't, the board offers **Reload the page**.

## 10. Checking on real phones

Automated tests cover iPhone (WebKit) and Android (Chromium) emulation. Before a first game with phone players, try
it once on the real devices:

- [ ] **iPhone (Safari)** and **Android (Chrome)**: join with the invite link, get admitted, and see the board.
- [ ] Sound: the first tap anywhere enables it (a dice roll clatters); the silent switch mutes it.
- [ ] Rotate the phone: the board and HUD refit, nothing hides under the notch or the home indicator.
- [ ] Scroll the page: it doesn't bounce or pull down (the board takes every swipe); Safari's toolbars showing or
      hiding don't leave a gap or hide the bottom bar.
- [ ] Drag your token with one finger — including over the bottom bar — and let go: it moves there.
- [ ] Pinch to zoom, two fingers to turn the view; long-press a token for its menu.
- [ ] Open the sheet and the dice tray: they rise over the tab bar and close with a swipe down.
- [ ] Lock the phone for a minute and unlock it: the table reconnects by itself.

## 11. Measuring performance

`pnpm bench` measures the budgets of the specification on this machine and writes `artifacts/bench/report.json`
(with the CPU and GPU it ran on). One part opens a Chromium window on your GPU for a couple of minutes — leave it be.
