# Hosted WatsonsTester: server setup and operation

For IT and the tool's admins. This sets up WatsonsTester on one Windows Server VM in the
intranet. Colleagues open it **by URL in Edge**, sign in, enter **their own staging accounts**
(testing, and backoffice if they approve orders) and run. The automation runs **on the VM**,
headless, with several people's runs at the same time; each person watches and can use their
run's browser in the page (**Live browser**), and everyone sees **one shared history**.

The desktop version (`WatsonsTester.exe`, `Start without exe.cmd`) stays as it is and is separate.

```
Laptop (Edge, LAN/VPN) ──HTTPS 443──▶ IIS (company certificate; empty site folder)
                                        └──▶ WatsonsTester service (Node.js 24, Windows service, 127.0.0.1:3000)
                                              • sign-in (users.json), session cookie, page key, rate limits
                                              • each person's testing and backoffice accounts: in memory for the session, and remembered
                                                sealed with a key from their own portal password
                                              • runs: Playwright + Edge, headless, up to N in parallel (one per person)
                                              • Live browser: each run's Edge on a debugging port on the VM only (127.0.0.1:9300–9899);
                                                its screen goes to the run's owner, their clicks and typing come back
                                              • shared history: SQLite (automation.db) + evidence folders by day
                                                    └──HTTPS──▶ Watsons STAGING · login · CyberSource TEST · Cardinal TEST · backoffice
```

## What is kept where

| What | Where | Who can read it |
|---|---|---|
| People who may sign in (bcrypt password hashes) | `C:\CentralAuth\config\users.json` | Service account and administrators |
| Each person's **testing account** (the staging shop) and **backoffice account**, while they are signed in | **Service memory**, for that person's session (until sign-out, 2 hours idle, 10 hours at most, or a service restart) | Nobody else |
| The same accounts, **remembered** for the person's next sign-in (unless they untick Remember) | `automation.db`, **sealed** (AES-256-GCM) with a key made from that person's portal password (scrypt), at sign-in | Only that person's sign-in opens them: not administrators, not a copy of the database. After their portal password is reset, they can't be opened: they are dropped at the next sign-in and entered once again |
| Shared history, audit trail, each person's last order | `D:\WatsonsAutomation\data\automation.db` (+ nightly copies in `data\backups\`) | Service account and administrators; people see the history in the app |
| Evidence of each run (screenshots, logs, report, error report) | `D:\WatsonsAutomation\evidence\<yyyy-mm-dd>\<run id>\` | Service account and administrators; signed-in people through the app |
| Service log | `D:\WatsonsAutomation\logs\service.log` | Administrators |
| Live browser pictures, and what people type into it | **Not kept**: passed between the run's browser and its owner's page while the run goes on | The run's owner only |

The app never sends the following to a browser, never writes them to the evidence or logs, and
never writes them to the database in readable form:
- passwords or password hashes
- the testing and backoffice accounts people enter (they see their own masked, e.g. `wi•••@g•••.com`)

After each run, the service also checks the run's text evidence for that run's passwords and
removes any it finds, noting it in the audit trail. The tests never write passwords, so this is a
second lock.

## 1. Requirements

- **VM:** Windows Server 2022 (Microsoft Edge included), 4 vCPU and 16 GB RAM for about 3 runs at
  the same time. Each headless Edge with its test runner uses about 1 GB.
- **Disk:** a data disk of about 100 GB. Each run's evidence is about 2 MB, more when it failed,
  and is kept 180 days.
- **Software:** Node.js 24 LTS, IIS with URL Rewrite and Application Request Routing (ARR), and
  NSSM or WinSW to run the service.
- **Network in:** HTTPS 443 from the company LAN and Palo Alto VPN (`hqvpn.watsons.com.sg`) only.
  No public IP (the PRD's scenario A).
- **Network out:** HTTPS 443 to:
  - the staging shop: `wtcsg.cmb8j9fjhz-apj3aswat1-s1-public.model-t.cc.commerce.ondemand.com`
  - its login service: `wtcsg-api.cmb8j9fjhz-apj3aswat1-s1-public.model-t.cc.commerce.ondemand.com`
  - the staging backoffice: `backoffice.cmb8j9fjhz-apj3aswat1-s1-public.model-t.cc.commerce.ondemand.com`
  - `testsecureacceptance.cybersource.com` and `0merchantacsstag.cardinalcommerce.com` /
    `1merchantacsstag.cardinalcommerce.com` (test payment)
  - and the page assets those sites load

  If the VM goes out through a proxy, it must allow these. **Check that the backoffice
  accepts the VM**: it may be limited to certain addresses.
- **Name and certificate:** a DNS name, e.g. `watsons-automation.<company>`, with a certificate
  from the company's internal certificate authority.
- **Time zone:** Asia/Singapore. Run ids, day folders and error reports use the VM's time.

## 2. Folders and the service account

1. Create a local or domain service account without admin rights, e.g. `svc-watsons-tester`.
2. Create the folders and give the account only what it needs:

   ```
   mkdir C:\CentralAuth\config  D:\WatsonsAutomation\app  D:\WatsonsAutomation\data  D:\WatsonsAutomation\evidence  D:\WatsonsAutomation\logs
   icacls C:\CentralAuth\config /inheritance:r /grant:r "Administrators:(OI)(CI)F" "SYSTEM:(OI)(CI)F" "svc-watsons-tester:(OI)(CI)R"
   icacls D:\WatsonsAutomation\data     /grant "svc-watsons-tester:(OI)(CI)M"
   icacls D:\WatsonsAutomation\evidence /grant "svc-watsons-tester:(OI)(CI)M"
   icacls D:\WatsonsAutomation\logs     /grant "svc-watsons-tester:(OI)(CI)M"
   icacls D:\WatsonsAutomation\app      /grant "svc-watsons-tester:(OI)(CI)RX"
   ```

   The config folder is outside every IIS site folder, so it can never be served.

## 3. Install the app

1. Install Node.js 24 LTS (all users). Check that Microsoft Edge is installed.
2. Copy the project to `D:\WatsonsAutomation\app`. Copy the whole folder, but never a `.env`
   with passwords: the server doesn't use `.env`.
3. In `D:\WatsonsAutomation\app`, run `npm install`. That installs Playwright; the runs use the
   installed Edge, so no browser download is needed.
4. In `D:\WatsonsAutomation\app\server`, run `npm install`. That installs express,
   express-rate-limit and bcryptjs, as pinned in `server\package-lock.json`.
5. Add the first admin and the users, in a command prompt in `D:\WatsonsAutomation\app`:

   ```
   set WATSONS_CONFIG_DIR=C:\CentralAuth\config
   node server\scripts\users.cjs add willy --display "Willy" --admin
   node server\scripts\users.cjs add meiling --display "Mei Ling"
   node server\scripts\users.cjs list
   ```

   Passwords are typed hidden, need 10+ characters, and are stored only as bcrypt hashes.

The server is set up without any staging account: each person enters their own testing account and
backoffice account (Customer Support Manager role) in the page, under **Accounts**, once. The server
remembers them for that person, sealed with a key made from their portal password. The backoffice
account is optional for placing orders (decision 2026-10-14): without it, a run ends on "Thank you
for your order" and the order shows **Awaiting approval** in Logs / History, where someone with a
backoffice account approves it (**Approve**).

## 4. Run it as a Windows service (NSSM)

| Setting (environment variable) | Value |
|---|---|
| `WATSONS_STAGING_URL` | The Watsons **staging** address (the same as in the desktop `.env`) |
| `WATSONS_CONFIG_DIR` | `C:\CentralAuth\config` |
| `WATSONS_DATA_DIR` | `D:\WatsonsAutomation\data` |
| `WATSONS_EVIDENCE_DIR` | `D:\WatsonsAutomation\evidence` |
| `WATSONS_PUBLIC_ORIGIN` | `https://watsons-automation.<company>`: the address people open (requests that change something must come from it) |
| `WATSONS_MAX_PARALLEL_RUNS` | `3` (more runs wait in line; raise it with the RAM) |
| Optional | `WATSONS_SERVER_PORT` (3000), `WATSONS_RETENTION_DAYS` (180), `WATSONS_BACKUPS_KEPT` (14), `WATSONS_SESSION_IDLE_HOURS` (2), `WATSONS_SESSION_MAX_HOURS` (10), `WATSONS_LOGIN_LIMIT_PER_MINUTE` (5), `WATSONS_LOGIN_FAILURES_PER_USER` (10 per 15 minutes) |

```
nssm install WatsonsTester "C:\Program Files\nodejs\node.exe" "D:\WatsonsAutomation\app\server\server.cjs"
nssm set WatsonsTester AppDirectory D:\WatsonsAutomation\app
nssm set WatsonsTester AppEnvironmentExtra WATSONS_STAGING_URL=https://<staging address>/ WATSONS_CONFIG_DIR=C:\CentralAuth\config WATSONS_DATA_DIR=D:\WatsonsAutomation\data WATSONS_EVIDENCE_DIR=D:\WatsonsAutomation\evidence WATSONS_PUBLIC_ORIGIN=https://watsons-automation.<company> WATSONS_MAX_PARALLEL_RUNS=3
nssm set WatsonsTester ObjectName .\svc-watsons-tester <password>
nssm set WatsonsTester AppStdout D:\WatsonsAutomation\logs\service.log
nssm set WatsonsTester AppStderr D:\WatsonsAutomation\logs\service.log
nssm set WatsonsTester AppRotateFiles 1
nssm set WatsonsTester AppRotateBytes 10485760
nssm set WatsonsTester Start SERVICE_AUTO_START
nssm start WatsonsTester
```

The service listens only on `127.0.0.1:3000`. When it stops, it stops the runs going on. Any run
it couldn't follow to the end shows as **Interrupted** in the history.

## 5. IIS in front (HTTPS)

1. Install the **URL Rewrite** and **Application Request Routing** modules.
2. In IIS Manager, open the server → **Application Request Routing Cache** → **Server Proxy
   Settings**:
   - tick **Enable proxy**
   - keep **Preserve client IP in X-Forwarded-For** on (the sign-in limits and the audit trail
     use the person's address)
   - set **Response buffer threshold** to `0`, or the live progress arrives late
3. Create a site, e.g. `WatsonsTester`:
   - **Physical path:** an empty folder, e.g. `D:\WatsonsAutomation\iis`, holding only a copy of
     `server\iis\web.config`.
   - **Binding:** HTTPS 443 with the company certificate and the DNS name.
   - **No HTTP binding:** or redirect HTTP to HTTPS.
4. Open `https://watsons-automation.<company>/api/health`. The answer is
   `{"ok":true,"running":0,"waiting":0}`.

## 6. Check it (the PRD's test matrix)

| Check | Do | Expected |
|---|---|---|
| VPN gate | Open the address with the VPN off, then on | Off: the page doesn't load. On: the sign-in page |
| Sign-in | Wrong password, then the right one | "Wrong user name or password.", then the app |
| Sign-in limit | 6 wrong passwords within a minute | "Too many sign-in attempts…" |
| Config not served | `https://…/users.json` | 404 |
| Removing a user | `users.cjs disable <name>` while they are signed in | Their next click asks them to sign in again |
| Accounts | Enter the testing and backoffice accounts, then reload the page | Shown masked (`wi•••@…`); never in Logs / History or the evidence |
| Remembered accounts | Sign out, then sign in again | Both accounts are set again ("remembered"); after **Forget**, the next sign-in no longer has that one |
| Two people at once | Two people run orders, each with their own testing account | Both run; each sees the other under "Also on the server now" |
| Shared history | The other person opens Logs / History | Sees both runs, with screenshots |
| A failure | A run with an unknown PLU | Failed, with its error report and screenshot |
| Live browser | Run **Approve existing order** with `00000000` (nothing changes on staging), and watch **Live browser** | The backoffice pages appear as the run goes; a click or typing in the picture reaches the page; another signed-in person doesn't see it. It ends after about 3 minutes with "not in the backoffice's Orders list" |
| The first real run | **Only with the owner's go-ahead:** one full order + approval | Completed with an order number (proves payment and backoffice work headless); the last pages stay in Live browser until **Close browser** |
| An order without a backoffice account | **Only with the owner's go-ahead:** a person with no backoffice account entered places an order | Ends on "Thank you for your order" in Live browser; **Awaiting approval** in Logs / History. Someone with a backoffice account clicks **Approve in Backoffice** on it and runs it: the approval completes and the order shows **Completed**, "approved later by …" |

## 7. Running it

- **People:**
  - `node server\scripts\users.cjs add|reset|disable|enable|remove|list <name>`.
  - Changes apply right away, with no restart; a disabled or removed person is signed out at their next click.
  - Their runs stay in the history.
- **Orders waiting for approval** (placed without a backoffice account): Logs / History →
  Status **Awaiting approval** → **Approve** (with your own backoffice account) → **Approve order**
  → confirm. The order then shows **Completed**, "approved later by" you.
- **Testing and backoffice accounts:** people enter their own, once; the server remembers them
  sealed with the person's portal password, unless they untick Remember.
  - Nobody can open them without that portal password, so nothing needs cleaning up when someone leaves.
  - A changed staging password: the person clicks **Change** under **Accounts**.
  - A reset portal password (`users.cjs reset`): their remembered accounts can't be opened any
    more, so they enter them once again.
  - Change a staging account's password if it was shared.
- **Earlier desktop runs into the shared history:** copy a desktop project's `reports\` folder to
  the VM, then run:

  ```
  node server\scripts\import-reports.cjs <copied reports folder> --operator <user name>
  ```

  Runs already there are skipped.
- **Retention and backups:**
  - Every 6 hours, evidence older than `WATSONS_RETENTION_DAYS` is deleted. Its runs stay in the history, marked as such.
  - A copy of the database is made once a day into `data\backups\` (14 kept).
  - IT's normal backup should cover `D:\WatsonsAutomation`.
- **Restoring the database:**
  1. Stop the service.
  2. Delete `automation.db-wal` and `automation.db-shm`.
  3. Copy a backup over `automation.db`.
  4. Start the service.
- **Monitoring:** `GET /api/health` (no sign-in needed; shows only the numbers of runs) and
  `logs\service.log`. The audit trail is the `audit_events` table in `automation.db`, readable
  with e.g. DB Browser for SQLite, read-only. It records:
  - sign-ins (also failed ones, with the person's address)
  - sign-outs
  - testing account set or cleared
  - run start, stop and end
  - exports, downloads and deletions
- **Updating the app:** `app` is a Git copy of the project's private repository (since
  2026-10-14). Push the changes from a development PC, then, in an administrator PowerShell on
  the VM, run:

  ```
  powershell -ExecutionPolicy Bypass -File C:\WatsonsAutomation\app\server\scripts\update-vm.ps1
  ```

  - It stops the service, runs `git pull`, starts the service again and checks `/api/health`.
  - It only runs as administrator (right-click Windows PowerShell → **Run as administrator**):
    without that, Windows doesn't let it stop the service.
  - It also checks that the server answering was started just now. **"An OLD server is still
    answering"** means the new files are not in use (seen 2026-10-14: the new page, but
    "Enter your backoffice account first" from the old rules). Run the `Stop-Process …` line it
    shows, then the script again.
  - The page is read when the service starts, so after an update without a restart it stays the
    old page: the page and the rules always come from the same version.
  - When `package.json` changed, it says so: then run `npm install` in `app` and `app\server`.
  - `.env`, `node_modules`, `reports` and the like are never in Git (`.gitignore`).
  - Sessions end, so people sign in again; their remembered accounts come back.

## 8. Things to know

- **Staging email on screenshots:** staging pages such as the order confirmation may show the
  testing account's **email** in screenshots that other signed-in people can see. Passwords never
  appear.
- **Backoffice accounts:** each person enters their own, or none (their orders then wait for
  approval). If several people use the same backoffice account at the same time, the pilot checks
  that staging's backoffice allows this.
- **Live browser:**
  - Each run's Edge listens on a debugging port on the VM itself only (127.0.0.1, a free port
    from 9300–9899 for each run). It can't be reached from the network, so the firewall needs no
    change, and IIS needs no change either (the pictures use the live-update connection, with
    Response buffer threshold `0`).
  - Only the run's owner sees it and can click, scroll or type in it. While a run goes on, a
    program on the VM itself could use that port too (see "Server admins").
  - The pictures are about 40–80 KB each, at most about 3 a second, and only while the page
    changes and its owner has it open.
  - When the order is placed (or approved), the run has passed but its browser stays open until
    the owner clicks **Close browser**, at most 5 minutes. Meanwhile that person can't start
    another run; a service restart closes it.
  - **Close browser** closes the run's tabs; the test then ends and closes the browser itself.
    (Until 2026-10-14 it closed the whole browser, so the test's clean-up failed and runs that
    had passed were saved as **Failed**. At its next start, the service corrects those from
    their evidence: an order placed without a backoffice account then shows **Awaiting
    approval**.)
  - A run counts by the test's own PASS line: something failing after it, while the browser is
    kept open, doesn't turn the run into a failure.
- **Server admins:** while a run goes on, an administrator of the VM could read that run's
  passwords from the test process, and while someone is signed in, from the service's memory.
  Only trusted people should administer the VM.
- **Portal passwords:** a person's portal password also unlocks their remembered staging accounts,
  so nobody should share theirs.
- **Not yet proven headless:** payment (CyberSource, OTP) and the backoffice approval. The first
  real run on the VM proves them; up to the Checkout button, headless runs have passed against
  staging.
