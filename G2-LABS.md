# G2 LABS — offline captions for Even Realities G2

G2 LABS is an accessibility-first build of the Mentra App (MentraOS, MIT) for
Even Realities G2 glasses: on-device Italian/English captions, an on-glasses
menu, and Bluetooth recovery tuned for all-day use by a deaf user.

Lineage: `g2-labs-golden-v3.1.8` → `g2-labs-golden-v3.1.10-submenu-executorch`
→ `g2-labs-golden-v3.1.11` → **`g2-labs-3.2-dev` (3.2.0)**. Older branches are
kept untouched as backups.

## Status

| Area | 3.2.0 state | Verified on hardware |
|---|---|---|
| On-glasses Home / Quick Settings / overlay | Implemented, 15 unit tests | **No — needs device test** |
| Long press back / home | Mapped (events 9/10) | **No** — firmware may not send it |
| Half-disconnect reconnection fix | Implemented | **No** |
| Mic re-arm after interruptions | Implemented | **No** |
| Sherpa crash-guard false rollbacks | Implemented | **No** |
| Unsigned IPA via GitHub Actions | Workflow builds `g2-labs-3.2-dev` | CI only |

Nothing above is marked verified until it has been exercised on real G2
glasses and an iPhone.

## Root causes fixed in 3.2.0

1. **Reconnect stuck after one arm drops** (`G2.swift`). Both peripheral
   references were cleared while the surviving arm's iOS link stayed up; a
   later `connect()` on an already-connected peripheral does not re-run
   discovery/auth, so the glasses never reached `fullyBooted`. Now the
   survivor is cancelled and both arms rejoin through one path.
2. **Captions silently dead after a call or Siri** (`PhoneMic.swift`).
   The mic was marked unavailable on interruption and only cleared when iOS
   sent `.shouldResume`, which it often omits. Now always re-armed; media
   server resets are handled too.
3. **Locked-phone G2 captions stop after a call** (`DeviceManager.swift`).
   The background keepalive engine died with the interruption but its
   reference blocked restarts. Now stopped/restarted around interruptions.
4. **Custom Sherpa model "fails" and reverts to Italian Built-in**
   (`STTTools.swift`). The crash guard stayed armed until the first non-empty
   transcript, so any iOS termination during quiet periods looked like a
   decoder crash. A model is now trusted after 150 returned live decodes.
5. **Opening the glasses menu stopped captions** (`G2SpeechQuickMenu`,
   `DeviceEventRouter`). Double tap during captions now opens an overlay;
   recognition keeps running and the newest caption is replayed on close.

Known, intentionally kept: switching to a *different* Sherpa model still
requires one app relaunch. ORT/Sherpa teardown + recreate inside one iOS
process previously crashed (`EXC_BAD_ACCESS` in `SetIntraOpNumThreads`). The
duplicate-ORT cause was addressed in 3.1.x by vendoring exactly ORT 1.26.0,
but in-process swap has not been re-proven on a device, so the guard stays.

## G2 capabilities this design relies on

From the Even Hub developer docs and the MentraOS G2 driver:

- Display: 576×288 per eye, 4-bit greenscale, one built-in font, **no font
  size, bold or alignment control**. Text pages ≈ 400–500 characters.
  So there is no "text size" setting; *caption lines* is the readability
  control.
- Input: single press, double press, swipe up/down from temple touchpads and
  R1 ring. Long press/release exist only on newer firmware. The OS reserves
  **tap-then-long-press** for its own menu.
- The G2 firmware dashboard itself is not replaced; G2 LABS draws its own
  pages while the app owns the display.

## On-glasses controls

| Where | Gesture | Result |
|---|---|---|
| Captions running | Double tap | Open G2 LABS menu over captions |
| Captions off | Double tap | Native G2 dashboard → "Captions" opens G2 LABS Home |
| In menu | Swipe up / down | Previous / next item |
| In menu | Tap | Select (Stop captions asks for a second tap) |
| In menu | Double tap | Back to Live Captions from any depth |
| In menu | Long press (if supported) | Back one level; at Home closes |
| In menu | No input for 12 s | Close and restore captions |

Every submenu also has a `< Back` row, so long press is never required.

Menu tree: Home → Live Captions · Quick Settings (Language, Lines, Caption
hold, Pause display, Stop captions) · Speech engine (Cloud / Sherpa /
ExecuTorch Whisper) · Apps · Status (link, battery, case).

## Hardware test checklist (required before a release is called stable)

1. Log `G2: SysEvent →` lines while doing tap, double tap, swipe up/down and
   long press on both temples and the R1 ring; record which arrive.
2. With captions running, double tap → menu appears; speak → after closing,
   the newest sentence is shown (proves recognition kept running).
3. Home → Quick Settings → Language → English → caption language changes
   without a restart; repeat for Lines and Caption hold.
4. Open a submenu, put one arm in the case (or walk out of range), bring it
   back → glasses reboot to the same submenu or to captions; never stuck.
5. Captions with phone mic → receive a call / trigger Siri → captions resume
   by themselves afterwards.
6. Lock the phone with G2 mic captions for 30 min, including one call.
7. Activate a downloaded Sherpa model, relaunch once, stay silent 1 min, swipe
   the app away, relaunch → the model is still selected.
8. Check that tap-then-long-press still opens the official G2 menu.

## Build

GitHub Actions workflow `G2 Glasses unsigned iOS IPA` builds an **unsigned**
IPA (plus `.sha256`) on push to `g2-labs-3.2-dev` or manually. Install it by
re-signing with your own Apple ID (e.g. Sideloadly/AltStore). Signed
distribution needs your Apple Developer credentials and is not automated.

## Licenses

- MentraOS: MIT. Sherpa-ONNX: Apache-2.0. ONNX Runtime: MIT.
- Speech models are **downloaded at runtime** from their publishers
  (k2-fsa/sherpa-onnx releases, Hugging Face); none are committed here.
  Check each model card before redistributing a model inside an IPA. The
  NVIDIA Nemotron ASR models are under NVIDIA's open model license, and the
  Kroko Italian model is fetched from a third-party Hugging Face mirror whose
  terms should be confirmed against the original Banafo/Kroko release.
