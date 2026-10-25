# ARQ Beam

Real file transfer between devices on your Wi-Fi or Ethernet, built on the **Adaptive Selective
Repeat ARQ** protocol from `Adaptive-SR-ARQ`. The simulator's virtual network is replaced by
real UDP sockets, and the Swing window by a live dashboard styled like GitHub's dark theme.

One app does both jobs:

- **Send mode.** Drop any file (video, document, archive). It is cut into numbered packets with a
  CRC-32 each and sent with a sliding window that resizes itself while the transfer runs.
- **Receive mode.** Listens on the LAN, verifies every checksum, buffers out-of-order packets,
  sends ACKs / NAKs, writes the file to disk in order and checks its SHA-256 at the end.
- **Device radar.** Finds other devices running ARQ Beam automatically. Click one to target it.
  "This device" (loopback) is always listed, so you can try everything on one machine.

## Run it

Needs **Node.js 20+** (no `npm install`, there are no dependencies), or none at all with the
standalone `ARQBeam.exe` (see [Build a standalone exe](#build-a-standalone-exe)).

| Way | What to do |
|---|---|
| Windows, no Node.js | Double-click `ARQBeam.exe` |
| Windows | Double-click `start.bat` |
| macOS / Linux | `./start.sh` |
| Terminal | `node server.js` |

The dashboard opens in an app window (Edge app mode on Windows) at `http://127.0.0.1:47800`.
Received files go to `Downloads/ARQ Beam`.

**First run on Windows:** allow Node.js (or `ARQBeam.exe`) through the firewall on **private
networks** when Windows asks, or other devices cannot reach this one.

Options: `--port 47800` (dashboard; the data port is this + 1), `--data-port`, `--dir <folder>`,
`--name <device name>`, `--no-open`, `--phone` (start with the phone page on), `--phone-port`
(default dashboard port + 3).

### Two devices

1. Start ARQ Beam on both (same Wi-Fi / LAN).
2. On the sender, the other device appears on the radar within a couple of seconds. If your
   network blocks broadcast (some guest Wi-Fi does), use **Add it by IP** with the address shown in
   the receiver's top bar.
3. Drop a file, click the device, press **Start transfer**. The receiver gets an Accept / Decline
   prompt (or turn on *Accept files automatically*).

### Two instances on one machine

```bash
node server.js
```

```bash
node server.js --port 47810 --name Second-Device
```

They discover each other like two real devices do.

### From a phone (any browser, nothing to install)

1. On the PC, click **Phone** in the top bar. A QR code and a 6-digit PIN appear.
2. Scan the QR code with the phone's camera (phone on the same Wi-Fi), or type the link shown.
3. Tap **Choose files**. They land in `Downloads/ARQ Beam` and the PC shows a popup.

This works on iPhone and Android, but the upload is plain HTTP (TCP), not the ARQ protocol:
browsers can't send raw UDP. The page is only served while the toggle is on, every request needs
the PIN, and wrong PINs lock it for a while. If the phone can't open the link, Windows probably
has the Wi-Fi set to *Public*: switch it to *Private* (Settings → Network → Wi-Fi → your network)
or allow ARQ Beam through the firewall for that profile.

### Android phone (Termux)

A phone browser can't send raw UDP and phones can't run the exe, but an Android phone can run
ARQ Beam inside [Termux](https://f-droid.org/packages/com.termux/) (install it from F-Droid; the
Play Store build is outdated). iPhones can't.

1. Copy `dist/arq-beam-android.zip` to the phone's Download folder (USB cable or any file share).
2. In Termux:

   ```bash
   pkg install nodejs unzip
   termux-setup-storage
   unzip /sdcard/Download/arq-beam-android.zip -d ~
   cd ~/arq-beam
   node server.js --no-open --name Phone --dir "/sdcard/Download/ARQ Beam"
   ```

3. Open `http://127.0.0.1:47800` in Chrome on the phone. Keep Termux running.
4. Start ARQ Beam on the PC, on the same Wi-Fi. Android often drops broadcast packets, so if the PC
   isn't in the phone's device list, use **Add by IP** with the address in the PC's top bar.

Files the phone receives land in `Download/ARQ Beam`. Rebuild the zip after changing the code by
zipping `server.js`, `package.json`, `lib/` and `public/` inside an `arq-beam` folder.

## Build a standalone exe

Other laptops don't need Node.js: build one `ARQBeam.exe` here and copy just that file over.

```bash
npm run build
```

This writes `dist/ARQBeam.exe` (about 90 MB, because it contains the Node runtime). It uses Node's
[Single Executable Applications](https://nodejs.org/api/single-executable-applications.html):
`scripts/build-exe.js` bundles `server.js` and `lib/` into one script, embeds `public/` as SEA
assets, copies the `node.exe` you build with and injects both into it with
[postject](https://github.com/nodejs/postject), which `npx` downloads on the first build (needs
internet once). The app itself is unchanged: `node server.js` still reads `public/` from disk.

- Double-clicking the exe opens a console window and the dashboard, exactly like `start.bat`. All
  the options above work: `ARQBeam.exe --port 47810 --name Second-Device`. If it cannot start
  (port busy), the window stays open with the reason until you press Enter.
- **Windows Firewall asks about `ARQBeam.exe` the first time it runs** (and again if you move it to
  another folder). Allow it on **private networks**, or other devices cannot reach it.
- Build with Node 20.12 or newer. The exe runs on the OS and CPU it was built on (Windows x64
  here); for a Mac or Linux build, run `npm run build` on that system (it writes `dist/ARQBeam`).
- The exe is unsigned (injecting invalidates node's signature), so SmartScreen may show
  "Windows protected your PC" for a downloaded copy: **More info → Run anyway**. A copy from a USB
  stick usually doesn't trigger it.

## The dashboard

| Area | Shows |
|---|---|
| **Sender grid** | Every packet: not sent (grey), sent / awaiting ACK (blue), retransmitted (violet, dot), lost (red, slash), corrupted (orange, hatched), ACK lost (magenta, ring), ACKed (green). The glowing outline is the sliding window `[base, base + W − 1]`; it slides as ACKs arrive. Big files: the grid follows the window and the strip underneath maps the whole file (click it to jump, scroll the grid to browse). |
| **Receiver grid** | Delivered in order (green), buffered out of order (amber, hatched), rejected by the CRC check (red, slash), next expected (pulsing ring). On the sender it is rebuilt from ACK/NAK feedback; for loopback it is the real receiver. |
| **Window chart** | Window size over time, the network capacity (dashed), every timeout / NAK (ticks at the bottom) and every AIMD cut (red = halved, orange = −1). Hover for values. On the receiver: goodput. |
| **Metrics** | Delivery, reliability, delay and sliding-window state, defined as in the original project (below). |
| **Event stream** | Colour-coded, time-stamped events. At LAN speed thousands of packets fly per second, so routine sends / ACKs are sampled; failures and window changes are always listed. |
| **Impairments** | Packet loss, corruption, delay jitter, congestion limit (capacity) and severity, plus whether ACK/NAK frames can be lost. Presets *Clean LAN / Good / Moderate / Poor* match the original. Change them mid-transfer and watch the window react. |
| **Sliding window** | Packet payload size, initial / min / max window, adaptive on/off (works mid-transfer). |

## How it works

```
 Drop file ─► stage (SHA-256) ─► SendSession ──► impairment emulator ──► UDP ──► ReceiveSession ─► disk
                                   ▲  (SR ARQ,     (loss · corruption ·              (CRC check, buffer,
                                   │   per-packet    jitter · congestion)             in-order write,
                                   │   timers, RTO)                                   SHA-256 verify)
                                   │                                                        │
                 AdaptiveWindow ◄──┴──────────────── ACK / NAK (+ cumulative next-expected) ◄┘
```

### Frame format (UDP, big-endian, 28-byte header)

| Offset | Field | Notes |
|---|---|---|
| 0 | `u16` magic `0x4142` | |
| 2 | `u8` version, `u8` type | DATA, ACK, NAK, OFFER, ACCEPT, DECLINE, FIN, FIN_ACK, CANCEL |
| 4 | `u32` transfer id | random per transfer |
| 8 | `u32` sequence number | |
| 12 | `u32` aux | ACK/NAK: receiver's next expected seq (cumulative info) |
| 16 | `u32` timestamp (µs) | echoed in ACK/NAK, so every ACK gives an exact RTT sample, retransmissions included |
| 20 | `u16` payload length, `u16` flags | RETX, DUP |
| 24 | `u32` CRC-32 | over header + payload |

Control frames (OFFER with name/size/SHA-256, ACCEPT with the receive window, FIN, ...) carry JSON
and are retried until answered.

### Protocol

- **Selective Repeat.** Up to `W` packets outstanding; each has its own timer. On a timeout or a
  NAK **only that packet** is resent. RTO follows RFC 6298 (`SRTT + 4·RTTVAR`, 30 ms – 8 s); a
  packet's timer backs off only while the receiver is silent.
- **Receiver.** Corrupted packet → discarded, NAK sent at once. Correct packet → ACKed individually
  (duplicates too) and buffered if out of order, up to the receive window (64 MB worth). Gaps
  filled → delivered to disk in order.
- **Adaptive window.** Ported unchanged from `AdaptiveWindowController.java`: per round (one
  window of feedback) compare the failure rate with the network's normal rate and the round's RTT
  with the long-term RTT; halve on a spike, −1 when rising, +1 (×2 in slow start) when calm.
  One adaptation for real networks: the delay ratio adds a 4 ms floor to both RTTs, because a LAN
  round trip is sub-millisecond and OS scheduling noise alone would otherwise look like congestion.
  The controller's "normal failure rate" accepts a worse network slowly, so over a long transfer
  it gradually stops reacting to steady congestion loss and the window can drift above the
  capacity line. That is the original algorithm's behaviour, kept as-is.
- **Integrity.** The sender hashes the file while staging it; the receiver hashes what it writes;
  FIN compares the two. A mismatch is reported, never hidden.

### Impairment emulator

Runs on the sender before frames reach the real socket (so you can demo it without breaking your
network), using the original model:

- **Loss**: each data frame dropped with probability `loss`; ACK/NAK frames too if enabled.
- **Congestion**: with `n` frames in the network and `b = n − capacity > 0` over capacity, a new
  frame is dropped with probability `severity · b / n` and delayed by `severity · b · 4 ms`.
- **Corruption**: one random payload bit flipped after the CRC is computed.
- **Jitter**: each frame held back by a random `0 … jitter` ms, which also reorders them.

Real losses (Wi-Fi drops, full socket buffers) are handled the same way as emulated ones.

### Metrics

| Metric | Definition |
|---|---|
| Delivery rate | packets delivered in order at the receiver / packets in the file |
| Throughput | delivered packets per second (rolling 1 s), and MB/s |
| Packet loss rate | data transmissions dropped (random + congestion) / all data transmissions |
| Retransmissions | transmissions beyond the first of each packet |
| Avg. transmission delay | first transmission of a packet → first correct copy at the receiver |
| Network efficiency | unique packets received correctly / all data transmissions |
| Window stats | min / max / time-weighted average, increases / decreases, last-round failure rate, normal failure rate (moving average), last-round delay ratio |

## Test

```bash
node test/loopback-test.js 16
```

Two engines in one process send a random 16 MB file to each other over real UDP sockets under four
profiles (clean, 10 % loss + 5 % corruption + ACK loss, jitter with reordering, congestion) and
check the result byte for byte.

## Project structure

```
arq-beam/
├── server.js            dashboard server (127.0.0.1 only), API, live telemetry stream
├── lib/
│   ├── protocol.js      frame format, CRC-32, clocks
│   ├── sender.js        Selective Repeat sender, RTO, impairment emulator, metrics
│   ├── receiver.js      receiver: CRC check, buffering, in-order write, SHA-256
│   ├── adaptive.js      adaptive window controller (from the Java project)
│   ├── engine.js        UDP socket, session routing, presets
│   ├── discovery.js     device radar (UDP broadcast beacons on port 47802)
│   ├── phone.js         phone upload page server (LAN, PIN-protected HTTP)
│   └── telemetry.js     packet-state grids and the event stream
├── public/              dashboard (HTML, CSS, canvas rendering), phone.html, qr.js
├── scripts/
│   ├── build-exe.js     npm run build: standalone exe (Node SEA)
│   └── sea-entry.js     the exe's entry point (runs server.js)
├── test/loopback-test.js
└── start.bat / start.sh
```

## Notes

- The dashboard only listens on `127.0.0.1`; other devices talk to the app over UDP only, and
  every incoming file needs your Accept unless you enable auto-accept. File names from the network
  are sanitised and always land inside the download folder.
- Ports: 47800 (dashboard, local), 47801 (data, UDP), 47802 (discovery, UDP broadcast), 47803
  (phone page, TCP, only while it's turned on).
- Laptops and desktops run it: on Windows with just `ARQBeam.exe`, on macOS or Linux with Node.js
  (or an exe built on that system). Android phones run it in Termux (above); iPhones can't.
