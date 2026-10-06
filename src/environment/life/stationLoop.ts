// An agent at their station, animated in place from the room's own cut-out:
// the head nudged a pixel (breathing, a glance, a nod) and hands tapping keys.
// Pure timing; the renderer turns each pose into a shifted copy of the cut-out.
import type { Activity, HeadPose, StationView } from "./types";

type Rng = () => number;
const between = (rng: Rng, lo: number, hi: number) => lo + rng() * (hi - lo);

export class StationLoop {
  private head: HeadPose = "rest";
  private hand = -1;
  private headLeft = 0;
  private handLeft = 0;
  /** Typing comes in bursts; seconds left in this one (0 = between bursts). */
  private burst = 0;

  constructor(
    private readonly hands: number,
    private readonly rng: Rng,
  ) {
    this.headLeft = between(rng, 0.5, 3);
  }

  /** Advance by `dt` seconds. `attentive`: someone is talking to them, so they nod along. */
  update(dt: number, activity: Activity, attentive = false): StationView {
    this.headLeft -= dt;
    if (this.headLeft <= 0) this.nextHead(activity, attentive);
    this.updateHands(dt, activity, attentive);
    return { kind: "station", head: this.head, hand: this.hand };
  }

  private nextHead(activity: Activity, attentive: boolean): void {
    const rng = this.rng;
    const resting = this.head === "rest";
    if (attentive) {
      [this.head, this.headLeft] = resting ? ["down", 0.28] : ["rest", between(rng, 0.6, 1.4)];
      return;
    }
    switch (activity) {
      case "working":
        // Heads-down: an occasional glance at the keys.
        [this.head, this.headLeft] = resting && rng() < 0.3 ? ["down", between(rng, 0.4, 0.9)] : ["rest", between(rng, 1.5, 4)];
        break;
      case "thinking": {
        // Looking about while turning it over.
        const away: HeadPose[] = ["left", "right", "up", "up"];
        [this.head, this.headLeft] = resting ? [away[Math.floor(rng() * away.length)], between(rng, 0.8, 2.2)] : ["rest", between(rng, 1, 2.5)];
        break;
      }
      case "waiting":
        // Slow breaths: paused, waiting on you.
        [this.head, this.headLeft] = resting ? ["up", 1] : ["rest", between(rng, 3.5, 5)];
        break;
      default: {
        // Idle or off: breathing, and now and then a look around.
        if (!resting) [this.head, this.headLeft] = ["rest", between(rng, 1.8, 3.5)];
        else if (rng() < 0.18) [this.head, this.headLeft] = [rng() < 0.5 ? "left" : "right", between(rng, 0.8, 1.6)];
        else [this.head, this.headLeft] = ["up", between(rng, 0.7, 1)];
      }
    }
  }

  private updateHands(dt: number, activity: Activity, attentive: boolean): void {
    if (this.hands === 0) return;
    const rng = this.rng;
    this.handLeft -= dt;
    if (this.handLeft > 0) return;
    if (activity === "working" && !attentive) {
      if (this.burst > 0) {
        // Keystrokes: alternate hands, with short rests between them.
        this.hand = this.hand === -1 ? Math.floor(rng() * this.hands) : rng() < 0.35 ? -1 : (this.hand + 1) % this.hands;
        this.handLeft = between(rng, 0.07, 0.16);
        this.burst -= this.handLeft;
        if (this.burst <= 0) {
          // End of a burst: hands rest while they read what they wrote.
          this.hand = -1;
          this.handLeft = between(rng, 0.4, 1.8);
        }
        return;
      }
      this.burst = between(rng, 0.8, 2.6);
      this.hand = -1;
      this.handLeft = 0.05;
      return;
    }
    // Not typing: hands at rest, with the odd tap or fidget.
    if (this.hand !== -1) {
      this.hand = -1;
      this.handLeft = activity === "thinking" ? between(rng, 2.5, 6) : between(rng, 4, 10);
      return;
    }
    if (activity === "waiting" || attentive) {
      this.handLeft = 1;
      return;
    }
    this.hand = Math.floor(rng() * this.hands);
    this.handLeft = 0.15;
  }
}
